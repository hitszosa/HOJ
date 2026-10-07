mod search;

use crate::app::cache;
use crate::app::db::{Database, Db};
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::auth::{CurrentUser, Teacher, Admin, lock_teacher, lock_admin};
use crate::identity::password;
use crate::management::audit;
use crate::schema::{course_assistants, user_sessions, users};
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, HeaderMap};
use axum::routing::{get as route_get, post};
use axum::{Json, Router};
use chrono::{NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel::query_builder::{AstPass, QueryFragment, QueryId};
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

// Diesel's excluded() only supports PostgreSQL/SQLite. MariaDB uses VALUES
// with an unqualified column identifier; retain the column's exact SQL type.
#[derive(Clone, Copy, QueryId)]
struct Inserted<C>(C);

impl<C: diesel::Column> diesel::Expression for Inserted<C> {
    type SqlType = C::SqlType;
}

impl<C: diesel::Column> diesel::AppearsOnTable<C::Table> for Inserted<C> {}

impl<C: diesel::Column> QueryFragment<diesel::mysql::Mysql> for Inserted<C> {
    fn walk_ast<'b>(
        &'b self,
        mut out: AstPass<'_, 'b, diesel::mysql::Mysql>,
    ) -> diesel::QueryResult<()> {
        out.push_sql("VALUES(");
        out.push_identifier(C::NAME)?;
        out.push_sql(")");
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Queryable, Selectable)]
#[diesel(table_name = users)]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub real_name: String,
    pub role: i32,
    pub password_expired: bool,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct CreateUserRequest {
    username: String,
    real_name: String,
    role: i32,
    password_expired: bool,
}

#[derive(Insertable)]
#[diesel(table_name = users)]
struct NewUser {
    username: String,
    email: String,
    password: String,
    first_name: String,
    last_name: String,
    real_name: String,
    role: i32,
    date_joined: NaiveDateTime,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    password_expired: bool,
    is_active: bool,
}

fn validate(username: &str, real_name: &str, role: i32) -> Result<()> {
    if username.is_empty() {
        return Err(AppError::Validation("Username cannot be empty.".into()));
    }
    if username.chars().count() > 150 {
        return Err(AppError::Validation(
            "Username cannot exceed 150 characters.".into(),
        ));
    }
    if username
        .chars()
        .any(|ch| !ch.is_alphanumeric() && !['_', '@', '.', '-'].contains(&ch))
    {
        return Err(AppError::Validation(
            "Username can only contain alphanumeric characters and '_', '@', '.', '-'.".into(),
        ));
    }
    if real_name.is_empty() {
        return Err(AppError::Validation("Real name cannot be empty.".into()));
    }
    if real_name.chars().count() > 1000 {
        return Err(AppError::Validation(
            "Real name cannot exceed 1000 characters.".into(),
        ));
    }
    if !(0..=2).contains(&role) {
        return Err(AppError::Validation("Role must be between 0 and 2.".into()));
    }
    Ok(())
}

fn new_user(request: CreateUserRequest, iterations: u32) -> Result<NewUser> {
    let now = Utc::now().naive_utc();
    Ok(NewUser {
        email: format!("{}@stu.hit.edu.cn", request.username),
        password: password::hash(&request.username, iterations)?,
        username: request.username,
        real_name: request.real_name,
        role: request.role,
        first_name: String::new(),
        last_name: String::new(),
        date_joined: now,
        created_at: now,
        updated_at: now,
        password_expired: true,
        is_active: true,
    })
}

fn duplicate_user(error: diesel::result::Error) -> AppError {
    if matches!(
        error,
        diesel::result::Error::DatabaseError(diesel::result::DatabaseErrorKind::UniqueViolation, _)
    ) {
        AppError::Validation("Username already exists".into())
    } else {
        AppError::Database(error)
    }
}

pub async fn get(conn: &mut AsyncMysqlConnection, id: i64) -> Result<UserInfo> {
    users::table
        .find(id)
        .filter(users::is_active.eq(true))
        .select(UserInfo::as_select())
        .first(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("User not found".into()))
}

pub(crate) async fn invalidate_sessions(
    conn: &mut AsyncMysqlConnection,
    ids: &[i64],
) -> Result<()> {
    for chunk in ids.chunks(1000) {
        diesel::delete(user_sessions::table.filter(user_sessions::user_id.eq_any(chunk)))
            .execute(conn)
            .await?;
    }
    Ok(())
}

pub async fn ensure_sso(
    database: &Database,
    username: &str,
    real_name: &str,
    role: i32,
    iterations: u32,
) -> Result<UserInfo> {
    let mut conn = database.connect().await?;
    if let Some(user) = users::table
        .filter(users::username.eq(username))
        .filter(users::is_active.eq(true))
        .select(UserInfo::as_select())
        .first(&mut *conn)
        .await
        .optional()?
    {
        return Ok(user);
    }
    drop(conn);

    validate(username, real_name, role)?;
    let request = CreateUserRequest {
        username: username.to_owned(),
        real_name: real_name.to_owned(),
        role,
        password_expired: true,
    };
    let row = password::blocking(move || new_user(request, iterations)).await?;

    let mut conn = database.connect().await?;
    // A concurrent SSO callback may create this account. Never reactivate or
    // modify an existing account based on SSO-supplied profile fields.
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let inserted = diesel::insert_into(users::table)
                .values(&row)
                .on_conflict(diesel::dsl::DuplicatedKeys)
                .do_nothing()
                .execute(conn)
                .await?;
            let user = users::table
                .filter(users::username.eq(username))
                .filter(users::is_active.eq(true))
                .select(UserInfo::as_select())
                .first(conn)
                .await
                .optional()?
                .ok_or_else(|| AppError::Validation("Username already exists".into()))?;
            if inserted != 0 {
                cache::invalidate_auth(conn).await?;
            }
            Ok(user)
        })
        .await
}

async fn get_user(
    _current: CurrentUser,
    Db(mut conn): Db,
    Path(id): Path<i64>,
) -> Result<Json<UserInfo>> {
    Ok(Json(get(&mut conn, id).await?))
}

async fn create_user(
    State(state): State<AppState>,
    Teacher(current): Teacher,
    headers: HeaderMap,
    database: Database,
    Json(request): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<UserInfo>)> {
    validate(&request.username, &request.real_name, request.role)?;
    if current.role != 2 && request.role != 0 {
        return Err(AppError::Authorization("Teachers can create student accounts only".into()));
    }
    let iterations = state.config.password_iterations;
    let row = password::blocking(move || new_user(request, iterations)).await?;

    let mut conn = database.connect().await?;
    let user = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock_teacher(conn, current.id, &[]).await?;
            diesel::insert_into(users::table)
                .values(&row)
                .execute(conn)
                .await
                .map_err(duplicate_user)?;
            let user: UserInfo = users::table
                .filter(users::username.eq(&row.username))
                .select(UserInfo::as_select())
                .first(conn)
                .await?;
            if super::hoj::provision_user(&state, &headers, &user).await? {
                diesel::insert_into(crate::schema::hoj_users::table)
                    .values(crate::schema::hoj_users::user_id.eq(user.id)).execute(conn).await?;
            }
            audit::record(
                conn,
                &current,
                "CREATE",
                "users",
                Some(user.id),
                &format!("Created user: {}", user.username),
                (
                    None,
                    Some(json!({
                        "date": Utc::now(),
                        "action_type": "create_users",
                        "summary": "创建用户",
                        "users": [&user.username],
                        "course_id": null,
                        "course_title": null,
                    })),
                ),
            )
            .await?;
            cache::invalidate_auth(conn).await?;
            Ok(user)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(user)))
}

async fn update_user(
    Admin(current): Admin,
    database: Database,
    Path(id): Path<i64>,
    Json(mut request): Json<UserInfo>,
) -> Result<Json<UserInfo>> {
    validate(&request.username, &request.real_name, request.role)?;
    request.id = id;

    let mut conn = database.connect().await?;
    let user = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock_admin(conn, current.id, &[id]).await?;
            let old: UserInfo = users::table
                .find(id)
                .filter(users::is_active.eq(true))
                .select(UserInfo::as_select())
                .for_update()
                .first(conn)
                .await
                .optional()?
                .ok_or_else(|| AppError::NotFound("User not found".into()))?;
            diesel::update(users::table.find(id))
                .set((
                    users::username.eq(&request.username),
                    users::real_name.eq(&request.real_name),
                    users::role.eq(request.role),
                    users::password_expired.eq(request.password_expired),
                ))
                .execute(conn)
                .await
                .map_err(duplicate_user)?;
            if current.id != id {
                audit::record(
                    conn,
                    &current,
                    "UPDATE",
                    "users",
                    Some(id),
                    &format!("Updated user {}", request.username),
                    (Some(json!(old)), Some(json!(request))),
                )
                .await?;
            }
            cache::invalidate_auth(conn).await?;
            Ok(request)
        })
        .await?;
    Ok(Json(user))
}

async fn deactivate_user(
    Admin(current): Admin,
    Db(mut conn): Db,
    Path(id): Path<i64>,
) -> Result<StatusCode> {
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock_admin(conn, current.id, &[id]).await?;
            let user = get(conn, id).await?;
            diesel::update(users::table.find(id))
                .set((
                    users::is_active.eq(false),
                    users::updated_at.eq(Utc::now().naive_utc()),
                ))
                .execute(conn)
                .await?;
            invalidate_sessions(conn, &[id]).await?;
            audit::record(
                conn,
                &current,
                "DEACTIVATE",
                "users",
                Some(id),
                &format!("Deactivated user {}", user.username),
                (None, None),
            )
            .await?;
            cache::invalidate_auth(conn).await
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn batch_create_users(
    State(state): State<AppState>,
    Teacher(current): Teacher,
    headers: HeaderMap,
    database: Database,
    Json(request): Json<Vec<CreateUserRequest>>,
) -> Result<Json<Vec<UserInfo>>> {
    for user in &request {
        validate(&user.username, &user.real_name, user.role)?;
        if current.role != 2 && user.role != 0 {
            return Err(AppError::Authorization("Teachers can import student accounts only".into()));
        }
    }
    let iterations = state.config.password_iterations;
    let rows = password::blocking(move || {
        request
            .into_iter()
            .map(|request| new_user(request, iterations))
            .collect::<Result<Vec<_>>>()
    })
    .await?;

    let mut conn = database.connect().await?;
    let users = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let mut target_ids = Vec::<i64>::new();
            for chunk in rows.chunks(1000) {
                let names: Vec<&str> = chunk.iter().map(|row| row.username.as_str()).collect();
                target_ids.extend(
                    users::table
                        .filter(users::username.eq_any(names))
                        .select(users::id)
                        .load::<i64>(conn)
                        .await?,
                );
            }
            lock_teacher(conn, current.id, &target_ids).await?;
            if current.role != 2 && !target_ids.is_empty() {
                return Err(AppError::Authorization("Teachers cannot overwrite existing accounts".into()));
            }
            for chunk in rows.chunks(1000) {
                diesel::insert_into(users::table)
                    .values(chunk)
                    .on_conflict(diesel::dsl::DuplicatedKeys)
                    .do_update()
                    .set((
                        users::password.eq(Inserted(users::password)),
                        users::real_name.eq(Inserted(users::real_name)),
                        users::role.eq(Inserted(users::role)),
                        users::updated_at.eq(Inserted(users::updated_at)),
                        users::password_expired.eq(true),
                        users::is_active.eq(true),
                    ))
                    .execute(conn)
                    .await?;
            }
            let mut result = Vec::<UserInfo>::new();
            for chunk in rows.chunks(1000) {
                let names: Vec<&str> = chunk.iter().map(|row| row.username.as_str()).collect();
                let mut found = users::table
                    .filter(users::username.eq_any(names))
                    .select(UserInfo::as_select())
                    .order(users::id.asc())
                    .load(conn)
                    .await?;
                result.append(&mut found);
            }
            let ids: Vec<i64> = result.iter().map(|user| user.id).collect();
            for user in &result {
                if super::hoj::provision_user(&state, &headers, user).await? {
                    diesel::insert_into(crate::schema::hoj_users::table)
                        .values(crate::schema::hoj_users::user_id.eq(user.id))
                        .on_conflict(diesel::dsl::DuplicatedKeys).do_nothing().execute(conn).await?;
                }
            }
            invalidate_sessions(conn, &ids).await?;
            for chunk in result.chunks(1000) {
                let names: Vec<&str> = chunk.iter().map(|user| user.username.as_str()).collect();
                audit::record(
                    conn,
                    &current,
                    "BATCH_CREATE",
                    "users",
                    None,
                    &format!("Batch created {} users: {}", chunk.len(), names.join(", ")),
                    (
                        None,
                        Some(json!({
                            "date": Utc::now(),
                            "action_type": "create_users",
                            "summary": "创建用户",
                            "users": names,
                            "course_id": null,
                            "course_title": null,
                        })),
                    ),
                )
                .await?;
            }
            cache::invalidate_auth(conn).await?;
            Ok(result)
        })
        .await?;
    Ok(Json(users))
}

#[derive(Deserialize)]
struct AdminPasswordRequest {
    username: String,
    password: Option<String>,
}

async fn admin_change_password(
    State(state): State<AppState>,
    Admin(current): Admin,
    database: Database,
    Json(request): Json<AdminPasswordRequest>,
) -> Result<Json<UserInfo>> {
    let iterations = state.config.password_iterations;
    let username = request.username.clone();
    let hashed = password::blocking(move || {
        request
            .password
            .map(|value| {
                password::require_strength(&value, &[&request.username])?;
                password::hash(&value, iterations)
            })
            .transpose()
    })
    .await?;

    let mut conn = database.connect().await?;
    let user = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let target_id = users::table
                .filter(users::username.eq(&username))
                .select(users::id)
                .first::<i64>(conn)
                .await
                .optional()?;
            lock_admin(conn, current.id, target_id.as_slice()).await?;
            let mut user: UserInfo = users::table
                .filter(users::id.eq_any(target_id))
                .filter(users::username.eq(&username))
                .filter(users::is_active.eq(true))
                .select(UserInfo::as_select())
                .for_update()
                .first(conn)
                .await
                .optional()?
                .ok_or_else(|| {
                    if hashed.is_some() {
                        AppError::NotFound("User not found".into())
                    } else {
                        AppError::Auth("Authenticate failed.".into())
                    }
                })?;
            if let Some(hashed) = hashed {
                diesel::update(users::table.find(user.id))
                    .set((
                        users::password.eq(hashed),
                        users::password_expired.eq(true),
                        users::updated_at.eq(Utc::now().naive_utc()),
                    ))
                    .execute(conn)
                    .await?;
                user.password_expired = true;
                invalidate_sessions(conn, &[user.id]).await?;
            }
            audit::record(
                conn,
                &current,
                "PASSWORD_CHANGE",
                "users",
                Some(user.id),
                &format!("Admin reset password for user: {}", user.username),
                (
                    None,
                    Some(json!({
                        "date": Utc::now(),
                        "action_type": "reset_password",
                        "summary": "重置密码",
                        "users": [&user.username],
                        "course_id": null,
                        "course_title": null,
                    })),
                ),
            )
            .await?;
            cache::invalidate_auth(conn).await?;
            Ok(user)
        })
        .await?;
    Ok(Json(user))
}

#[derive(Deserialize)]
struct AssistantRequest {
    user_id: i64,
    course_id: i64,
}

async fn change_assistant(
    conn: &mut AsyncMysqlConnection,
    current: CurrentUser,
    request: AssistantRequest,
    add: bool,
) -> Result<Json<UserInfo>> {
    let user = conn
        .transaction::<_, AppError, _>(async |conn| {
            crate::academic::courses::lock(conn, request.course_id).await?;
            crate::identity::permissions::require(conn, &current, request.course_id, crate::identity::permissions::Permission::Manage).await?;
            lock_teacher(conn, current.id, &[request.user_id]).await?;
            let user = get(conn, request.user_id).await?;
            if add {
                if user.role != 0 {
                    return Err(AppError::Validation(
                        "Assistant must have student role".into(),
                    ));
                }
                diesel::insert_into(course_assistants::table)
                    .values((
                        course_assistants::course_id.eq(request.course_id),
                        course_assistants::user_id.eq(request.user_id),
                        course_assistants::created_at.eq(Utc::now().naive_utc()),
                    ))
                    .on_conflict(diesel::dsl::DuplicatedKeys)
                    .do_nothing()
                    .execute(conn)
                    .await?;
            } else {
                let changed = diesel::delete(
                    course_assistants::table
                        .filter(course_assistants::course_id.eq(request.course_id))
                        .filter(course_assistants::user_id.eq(request.user_id)),
                )
                .execute(conn)
                .await?;
                if changed == 0 {
                    return Err(AppError::NotFound(
                        "Assistant relationship not found".into(),
                    ));
                }
            }
            audit::record(
                conn,
                &current,
                if add {
                    "ADD_PERMISSION"
                } else {
                    "REMOVE_PERMISSION"
                },
                "course_permissions",
                Some(request.course_id),
                &format!(
                    "{} assistant {} for course {}",
                    if add { "Added" } else { "Removed" },
                    user.username,
                    request.course_id
                ),
                (
                    None,
                    Some(json!({"course_id": request.course_id, "permission_type": "assistant"})),
                ),
            )
            .await?;
            cache::invalidate_auth(conn).await?;
            Ok(user)
        })
        .await?;
    Ok(Json(user))
}

async fn set_assistant(
    Teacher(current): Teacher,
    database: Database,
    Json(request): Json<AssistantRequest>,
) -> Result<Json<UserInfo>> {
    let mut conn = database.connect().await?;
    change_assistant(&mut conn, current, request, true).await
}

async fn remove_assistant(
    Teacher(current): Teacher,
    database: Database,
    Json(request): Json<AssistantRequest>,
) -> Result<Json<UserInfo>> {
    let mut conn = database.connect().await?;
    change_assistant(&mut conn, current, request, false).await
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", post(create_user))
        .route(
            "/users/{user_id}",
            route_get(get_user)
                .put(update_user)
                .patch(update_user)
                .delete(deactivate_user),
        )
        .route("/users/batch_create", post(batch_create_users))
        .route("/users/change_password", post(admin_change_password))
        .route("/users/set_assistant", post(set_assistant))
        .route("/users/remove_assistant", post(remove_assistant))
        .merge(search::router())
}
