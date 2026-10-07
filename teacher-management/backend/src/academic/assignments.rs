use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::{
    academic::courses,
    app::cache::{self, ReadCache},
    app::db::{self, Database, Db},
    app::error::{AppError, Result},
    app::state::AppState,
    identity::auth::CurrentUser,
    identity::permissions::{self, Permission},
    management::audit,
    schema::{assignments, submissions},
};

diesel::define_sql_function! { fn last_insert_id() -> diesel::sql_types::BigInt; }

#[derive(Queryable, Selectable)]
#[diesel(table_name = assignments)]
pub(crate) struct Assignment {
    pub id: i64,
    pub title: String,
    pub course_id: i64,
    pub published: bool,
    pub start_time: NaiveDateTime,
    pub due_time: NaiveDateTime,
    pub description: Option<String>,
    pub allowed_extension: Option<String>,
    pub score: i32,
    pub show_score: bool,
    pub max_file_size: i32,
}

#[derive(Serialize)]
pub struct AssignmentResponse {
    pub id: i64,
    pub title: String,
    pub course: i64,
    pub published: bool,
    pub start_time: DateTime<Utc>,
    pub due_time: DateTime<Utc>,
    pub description: String,
    pub allowed_extension: String,
    pub submit_allowed: bool,
    pub submit_count: Option<i64>,
    pub score: i32,
    pub show_score: bool,
    pub max_file_size: u64,
}

impl Assignment {
    pub(crate) fn response(self, count: Option<i64>, now: NaiveDateTime) -> AssignmentResponse {
        AssignmentResponse {
            id: self.id,
            title: self.title,
            course: self.course_id,
            published: self.published,
            start_time: self.start_time.and_utc(),
            due_time: self.due_time.and_utc(),
            description: self.description.unwrap_or_default(),
            allowed_extension: self.allowed_extension.unwrap_or_default(),
            submit_allowed: self.published && self.start_time < now && now < self.due_time,
            submit_count: count,
            score: self.score,
            show_score: self.show_score,
            max_file_size: self.max_file_size as u64,
        }
    }
}

#[derive(Deserialize)]
struct CreateAssignment {
    #[serde(deserialize_with = "course_id")]
    course: i64,
    due_time: DateTime<Utc>,
    start_time: Option<DateTime<Utc>>,
    title: String,
    max_file_size: u64,
    #[serde(default)]
    show_score: bool,
}

fn course_id<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<i64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Id {
        Number(i64),
        Text(String),
    }
    match Id::deserialize(d)? {
        Id::Number(id) => Ok(id),
        Id::Text(text) => text.parse().map_err(serde::de::Error::custom),
    }
}

#[derive(Default, Deserialize)]
struct UpdateAssignment {
    title: Option<String>,
    start_time: Option<DateTime<Utc>>,
    due_time: Option<DateTime<Utc>>,
    description: Option<String>,
    allowed_extension: Option<String>,
    score: Option<i32>,
    published: Option<bool>,
    show_score: Option<bool>,
    max_file_size: Option<u64>,
}

#[derive(Deserialize)]
struct ListQuery {
    course: i64,
    submit_allowed: Option<bool>,
}

pub(crate) struct AssignmentContext {
    pub conn: db::Connection,
    pub row: Assignment,
}

pub(crate) struct AssignmentAccess(pub AssignmentContext);

impl FromRequestParts<AppState> for AssignmentAccess {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let user = CurrentUser::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let Path(id) = Path::<i64>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let mut conn = db::connect(state)
            .await
            .map_err(IntoResponse::into_response)?;
        let row = get_row(&mut conn, id)
            .await
            .map_err(IntoResponse::into_response)?;
        let permissions = permissions::read(state, &mut conn, &user, row.course_id)
            .await
            .map_err(IntoResponse::into_response)?;
        permissions
            .require(Permission::Access)
            .map_err(IntoResponse::into_response)?;

        if !permissions.assist && (!row.published || row.start_time > Utc::now().naive_utc()) {
            return Err(
                AppError::Authorization("Assignment is not available yet".into()).into_response(),
            );
        }

        Ok(Self(AssignmentContext { conn, row }))
    }
}

pub(crate) struct AssignmentAssist(pub AssignmentContext);

impl FromRequestParts<AppState> for AssignmentAssist {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let user = CurrentUser::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let Path(id) = Path::<i64>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let mut conn = db::connect(state)
            .await
            .map_err(IntoResponse::into_response)?;
        let row = get_row(&mut conn, id)
            .await
            .map_err(IntoResponse::into_response)?;
        permissions::read(state, &mut conn, &user, row.course_id)
            .await
            .map_err(IntoResponse::into_response)?
            .require(Permission::Assist)
            .map_err(IntoResponse::into_response)?;

        Ok(Self(AssignmentContext { conn, row }))
    }
}

struct AssignmentList {
    conn: db::Connection,
    query: ListQuery,
    staff: bool,
}

impl FromRequestParts<AppState> for AssignmentList {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let user = CurrentUser::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let Query(query) = Query::<ListQuery>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let mut conn = db::connect(state)
            .await
            .map_err(IntoResponse::into_response)?;
        let permissions = permissions::read(state, &mut conn, &user, query.course)
            .await
            .map_err(IntoResponse::into_response)?;
        permissions
            .require(Permission::Access)
            .map_err(IntoResponse::into_response)?;

        Ok(Self {
            conn,
            query,
            staff: permissions.assist,
        })
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/assignments", get(list).post(create))
        .route(
            "/assignments/{id}",
            get(get_one).put(update).patch(update).delete(delete),
        )
        .route("/assignments/{id}/publish", post(publish))
}

pub(crate) async fn get_row(conn: &mut AsyncMysqlConnection, id: i64) -> Result<Assignment> {
    assignments::table
        .find(id)
        .select(Assignment::as_select())
        .first(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Assignment not found".into()))
}

pub(crate) async fn lock_row(conn: &mut AsyncMysqlConnection, id: i64) -> Result<Assignment> {
    let course = assignments::table
        .find(id)
        .select(assignments::course_id)
        .first::<i64>(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Assignment not found".into()))?;

    courses::lock(conn, course).await?;

    assignments::table
        .find(id)
        .select(Assignment::as_select())
        .for_update()
        .first(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Assignment not found".into()))
}

pub(crate) async fn responses(
    conn: &mut AsyncMysqlConnection,
    rows: Vec<Assignment>,
    counts: bool,
    now: NaiveDateTime,
) -> Result<Vec<AssignmentResponse>> {
    let mut grouped = HashMap::new();

    if counts && !rows.is_empty() {
        let ids: Vec<_> = rows.iter().map(|row| row.id).collect();
        for chunk in ids.chunks(1000) {
            let values = submissions::table
                .filter(submissions::assignment_id.eq_any(chunk))
                .group_by(submissions::assignment_id)
                .select((submissions::assignment_id, diesel::dsl::count_star()))
                .load::<(i64, i64)>(conn)
                .await?;
            grouped.extend(values);
        }
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let count = counts.then(|| grouped.get(&row.id).copied().unwrap_or(0));
            row.response(count, now)
        })
        .collect())
}

async fn response(conn: &mut AsyncMysqlConnection, row: Assignment) -> Result<AssignmentResponse> {
    let count = submissions::table
        .filter(submissions::assignment_id.eq(row.id))
        .count()
        .get_result(conn)
        .await?;
    Ok(row.response(Some(count), Utc::now().naive_utc()))
}

// Include hidden and filtered-out assignments: an opening can change list membership.
pub(super) async fn next_boundary(
    conn: &mut AsyncMysqlConnection,
    course_ids: &[i64],
    now: NaiveDateTime,
) -> Result<Option<NaiveDateTime>> {
    let (start, due) = assignments::table
        .filter(assignments::course_id.eq_any(course_ids))
        .select((
            diesel::dsl::min(diesel::dsl::case_when(
                assignments::start_time.ge(now),
                assignments::start_time.nullable(),
            )),
            diesel::dsl::min(diesel::dsl::case_when(
                assignments::due_time.ge(now),
                assignments::due_time.nullable(),
            )),
        ))
        .first::<(Option<NaiveDateTime>, Option<NaiveDateTime>)>(conn)
        .await?;
    Ok(start.into_iter().chain(due).min())
}

async fn list(
    cache: ReadCache,
    AssignmentList {
        mut conn,
        query,
        staff,
    }: AssignmentList,
) -> Result<Response> {
    let key = format!(
        "assignments:list:{}:{}:{:?}",
        query.course, staff, query.submit_allowed
    );
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let now = Utc::now().naive_utc();
    let valid_until = if cache.enabled() {
        next_boundary(&mut conn, &[query.course], now).await?
    } else {
        None
    };
    let mut select = assignments::table
        .filter(assignments::course_id.eq(query.course))
        .select(Assignment::as_select())
        .into_boxed();

    if !staff {
        select = select.filter(
            assignments::published
                .eq(true)
                .and(assignments::start_time.le(now)),
        );
    }

    if query.submit_allowed == Some(true) {
        select = select.filter(
            assignments::start_time
                .le(now)
                .and(assignments::due_time.gt(now)),
        );
    }

    let rows = select
        .order((assignments::due_time.asc(), assignments::id.asc()))
        .load(&mut conn)
        .await?;
    let result = responses(&mut conn, rows, staff, now).await?;
    cache.json(&key, &result, valid_until).await
}

async fn get_one(
    cache: ReadCache,
    user: CurrentUser,
    AssignmentAccess(AssignmentContext { mut conn, row }): AssignmentAccess,
) -> Result<Response> {
    let key = format!("assignments:detail:{}:{}:{}", row.id, user.id, user.role);
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let now = Utc::now().naive_utc();
    let valid_until = [row.start_time, row.due_time]
        .into_iter()
        .filter(|boundary| *boundary >= now)
        .min();
    let result = response(&mut conn, row).await?;
    cache.json(&key, &result, valid_until).await
}

fn validate(
    title: Option<&str>,
    description: Option<&str>,
    extension: Option<&str>,
    size: Option<u64>,
) -> Result<()> {
    if title.is_some_and(|v| v.chars().count() > 60)
        || description.is_some_and(|v| v.len() > 65_535)
        || extension.is_some_and(|v| v.chars().count() > 100)
        || size.is_some_and(|v| v > i32::MAX as u64)
    {
        return Err(AppError::Validation(
            "Assignment field exceeds its allowed length or size".into(),
        ));
    }

    Ok(())
}

async fn create(
    user: CurrentUser,
    database: Database,
    Json(request): Json<CreateAssignment>,
) -> Result<(StatusCode, Json<AssignmentResponse>)> {
    validate(
        Some(&request.title),
        None,
        None,
        Some(request.max_file_size),
    )?;

    let mut conn = database.connect().await?;
    let value = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            courses::lock(conn, request.course).await?;
            permissions::require(conn, &user, request.course, Permission::Assist).await?;

            let now = Utc::now().naive_utc();
            diesel::insert_into(assignments::table)
                .values((
                    assignments::title.eq(&request.title),
                    assignments::course_id.eq(request.course),
                    assignments::creator_id.eq(Some(user.id)),
                    assignments::published.eq(false),
                    assignments::start_time
                        .eq(request.start_time.map(|v| v.naive_utc()).unwrap_or(now)),
                    assignments::due_time.eq(request.due_time.naive_utc()),
                    assignments::description.eq(Some("")),
                    assignments::allowed_extension.eq(Some("")),
                    assignments::score.eq(100),
                    assignments::show_score.eq(request.show_score),
                    assignments::max_file_size.eq(request.max_file_size as i32),
                    assignments::created_at.eq(now),
                    assignments::updated_at.eq(now),
                ))
                .execute(conn)
                .await?;
            let id = diesel::select(last_insert_id())
                .get_result::<i64>(conn)
                .await?;

            let row = get_row(conn, id).await?;
            let result = response(conn, row).await?;
            audit::record(
                conn,
                &user,
                "CREATE",
                "assignment",
                Some(id),
                &request.title,
                (None, Some(serde_json::json!(result))),
            )
            .await?;
            cache::invalidate(conn).await?;
            Ok(result)
        })
        .await?;

    Ok((StatusCode::CREATED, Json(value)))
}

async fn update(
    user: CurrentUser,
    database: Database,
    Path(id): Path<i64>,
    Json(request): Json<UpdateAssignment>,
) -> Result<Json<AssignmentResponse>> {
    validate(
        request.title.as_deref(),
        request.description.as_deref(),
        request.allowed_extension.as_deref(),
        request.max_file_size,
    )?;

    let mut conn = database.connect().await?;
    let result = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let old = lock_row(conn, id).await?;
            permissions::require(conn, &user, old.course_id, Permission::Assist).await?;

            let before = serde_json::json!(response(conn, old).await?);

            diesel::update(assignments::table.find(id))
                .set((
                    request.title.as_ref().map(|v| assignments::title.eq(v)),
                    request
                        .start_time
                        .map(|v| assignments::start_time.eq(v.naive_utc())),
                    request
                        .due_time
                        .map(|v| assignments::due_time.eq(v.naive_utc())),
                    request
                        .description
                        .as_ref()
                        .map(|v| assignments::description.eq(Some(v))),
                    request
                        .allowed_extension
                        .as_ref()
                        .map(|v| assignments::allowed_extension.eq(Some(v))),
                    request.score.map(|v| assignments::score.eq(v)),
                    request.published.map(|v| assignments::published.eq(v)),
                    request.show_score.map(|v| assignments::show_score.eq(v)),
                    request
                        .max_file_size
                        .map(|v| assignments::max_file_size.eq(v as i32)),
                    assignments::updated_at.eq(Utc::now().naive_utc()),
                ))
                .execute(conn)
                .await?;

            let row = get_row(conn, id).await?;
            let result = response(conn, row).await?;
            audit::record(
                conn,
                &user,
                "UPDATE",
                "assignment",
                Some(id),
                &result.title,
                (Some(before), Some(serde_json::json!(result))),
            )
            .await?;
            cache::invalidate(conn).await?;
            Ok(result)
        })
        .await?;

    Ok(Json(result))
}

async fn delete(user: CurrentUser, Db(mut conn): Db, Path(id): Path<i64>) -> Result<StatusCode> {
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let row = lock_row(conn, id).await?;
            permissions::require(conn, &user, row.course_id, Permission::Assist).await?;

            let before = serde_json::json!(row.response(None, Utc::now().naive_utc()));
            diesel::delete(assignments::table.find(id))
                .execute(conn)
                .await?;
            audit::record(
                conn,
                &user,
                "DELETE",
                "assignment",
                Some(id),
                "Deleted assignment",
                (Some(before), None),
            )
            .await?;
            cache::invalidate(conn).await?;
            Ok(())
        })
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn publish(
    user: CurrentUser,
    Db(mut conn): Db,
    Path(id): Path<i64>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let row = lock_row(conn, id).await?;
            permissions::require(conn, &user, row.course_id, Permission::Assist).await?;

            diesel::update(assignments::table.find(id))
                .set((
                    assignments::published.eq(true),
                    assignments::updated_at.eq(Utc::now().naive_utc()),
                ))
                .execute(conn)
                .await?;

            audit::record(
                conn,
                &user,
                "PUBLISH",
                "assignment",
                Some(id),
                &row.title,
                (
                    Some(serde_json::json!({"published": row.published})),
                    Some(serde_json::json!({"published": true})),
                ),
            )
            .await?;
            cache::invalidate(conn).await?;
            Ok(())
        })
        .await?;

    Ok((StatusCode::CREATED, Json(serde_json::json!({}))))
}
