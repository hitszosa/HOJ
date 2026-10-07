//! HOJ is authoritative for imported identities. Never trust client identity headers.
use crate::{app::{db, cache, state::AppState, error::{AppError, Result}},
    identity::{auth::{CurrentUser, Admin}, password, users::UserInfo},
    schema::{users, courses, course_teachers, course_students, course_assistants, hoj_users, hoj_offerings}};
use axum::{Router, Json, extract::State, http::{HeaderMap, header}, routing::{get, post}};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Envelope<T> { data: T }
#[derive(Deserialize)]
struct Me { user: String, roles: Vec<String> }
#[derive(Deserialize)]
struct Member { username: String, real_name: String, role: String }
#[derive(Deserialize)]
struct Course { offering_id: i32, title: String, year: i32, term: i32, members: Vec<Member> }
#[derive(Deserialize)]
struct Context { username: String, role: i32, courses: Vec<Course> }
#[derive(Serialize)]
struct Link { course_id: i64, offering_id: i32 }

pub fn router() -> Router<AppState> {
    Router::new().route("/hoj/links", get(links)).route("/hoj/import", post(import))
}

fn credentials(headers: &HeaderMap) -> Option<String> {
    let cookies: Vec<_> = headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';')).filter_map(|c| c.trim().split_once('='))
        .filter(|(name, value)| ["course_session", "PHPSESSID"].contains(name) && !value.is_empty() && *value != "\"\"")
        .map(|(name,value)| format!("{name}={value}")).collect();
    (!cookies.is_empty()).then(|| cookies.join("; "))
}

pub(crate) fn credential_key(state: &AppState, headers: &HeaderMap) -> Option<String> {
    state.config.hoj_api_url.as_ref()?;
    credentials(headers).map(|c| format!("hoj:{}", hex::encode(Sha256::digest(c.as_bytes()))))
}

async fn fetch<T: serde::de::DeserializeOwned>(state: &AppState, headers: &HeaderMap, path: &str) -> Result<T> {
    let base = state.config.hoj_api_url.as_ref().ok_or_else(|| AppError::Auth("HOJ integration disabled".into()))?;
    let cookie = credentials(headers).ok_or_else(|| AppError::Auth("Login to HOJ first".into()))?;
    let reply = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8)).build()
        .map_err(|_| AppError::Internal("Identity client unavailable".into()))?
        .get(format!("{}{path}", base.trim_end_matches('/'))).header(header::COOKIE, cookie)
        .send().await.map_err(|_| AppError::Unavailable("HOJ identity service unavailable".into()))?;
    if reply.status() == reqwest::StatusCode::UNAUTHORIZED { return Err(AppError::Auth("HOJ session expired".into())); }
    if !reply.status().is_success() { return Err(AppError::Unavailable("HOJ identity service rejected request".into())); }
    let body = reply.bytes().await.map_err(|_| AppError::Unavailable("HOJ response unavailable".into()))?;
    if body.len() > 8 * 1024 * 1024 { return Err(AppError::Unavailable("HOJ snapshot too large".into())); }
    serde_json::from_slice::<Envelope<T>>(&body).map(|v| v.data)
        .map_err(|_| AppError::Unavailable("Invalid HOJ identity response".into()))
}

pub(crate) async fn write<T: serde::de::DeserializeOwned>(state: &AppState, headers: &HeaderMap,
    path: &str, body: serde_json::Value) -> Result<T> {
    let base = state.config.hoj_api_url.as_ref().ok_or_else(|| AppError::Unavailable("HOJ integration disabled".into()))?;
    let cookie = credentials(headers).ok_or_else(|| AppError::Auth("Login to the shared platform first".into()))?;
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        .filter(|o| state.config.cors_origins.iter().any(|v| v == o))
        .ok_or_else(|| AppError::Authorization("Trusted origin required".into()))?;
    let reply = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(if path.ends_with("/delete") { 120 } else { 10 })).build().map_err(|e| AppError::Internal(e.to_string()))?
        .post(format!("{}{path}",base.trim_end_matches('/'))).header(header::COOKIE,cookie)
        .header(header::ORIGIN,origin).json(&body).send().await
        .map_err(|_| AppError::Unavailable("编程教学同步暂时不可用".into()))?;
    let status = reply.status();
    let data: serde_json::Value = reply.json().await.map_err(|_| AppError::Unavailable("Invalid HOJ response".into()))?;
    if !status.is_success() {
        let message = data["message"].as_str().unwrap_or("编程教学同步失败").to_owned();
        return Err(match status.as_u16() { 401 => AppError::Auth(message), 403 => AppError::Authorization(message),
            400|422 => AppError::Validation(message), 409 => AppError::Conflict(message), _ => AppError::Unavailable(message) });
    }
    serde_json::from_value(data["data"].clone()).map_err(|_| AppError::Unavailable("Invalid HOJ response".into()))
}

pub(crate) async fn provision_user(state: &AppState, headers: &HeaderMap, user: &UserInfo) -> Result<bool> {
    if credential_key(state,headers).is_none() || user.role == 2 { return Ok(false); }
    let _: serde_json::Value = write(state,headers,"/api/management/users",serde_json::json!({
        "username":user.username,"real_name":user.real_name,"role":user.role
    })).await?;
    Ok(true)
}

pub(crate) async fn sync_course(state: &AppState, headers: &HeaderMap, conn: &mut diesel_async::AsyncMysqlConnection,
    id: i64, title: &str, year: i32, term: i32) -> Result<()> {
    if credential_key(state,headers).is_none() { return Ok(()); }
    let offering = hoj_offerings::table.filter(hoj_offerings::course_id.eq(id))
        .select(hoj_offerings::offering_id).first::<i32>(conn).await.optional()?;
    let teachers = course_teachers::table.inner_join(users::table).filter(course_teachers::course_id.eq(id))
        .select(users::username).load::<String>(conn).await?;
    let students = course_students::table.inner_join(users::table).filter(course_students::course_id.eq(id))
        .select(users::username).load::<String>(conn).await?;
    let assistants = course_assistants::table.inner_join(users::table).filter(course_assistants::course_id.eq(id))
        .select(users::username).load::<String>(conn).await?;
    let result: serde_json::Value = write(state,headers,"/api/management/courses",serde_json::json!({
        "management_id":id,"offering_id":offering,"title":title,"year":year,"term":term,
        "teacher_ids":teachers,"student_ids":students,"assistant_ids":assistants
    })).await?;
    if offering.is_none() {
        let oid = result["offering_id"].as_i64().ok_or_else(|| AppError::Unavailable("Invalid course mapping".into()))? as i32;
        diesel::insert_into(hoj_offerings::table).values((hoj_offerings::course_id.eq(id),hoj_offerings::offering_id.eq(oid))).execute(conn).await?;
    }
    Ok(())
}

pub(crate) async fn delete_course(state: &AppState, headers: &HeaderMap,
    conn: &mut diesel_async::AsyncMysqlConnection, id: i64) -> Result<()> {
    let offering = hoj_offerings::table.filter(hoj_offerings::course_id.eq(id))
        .select(hoj_offerings::offering_id).first::<i32>(conn).await.optional()?;
    if let Some(oid) = offering {
        let _: serde_json::Value = write(state, headers, &format!("/api/management/courses/{oid}/delete"),
            serde_json::json!({"management_id":id})).await?;
    }
    Ok(())
}

async fn ensure_user(state: &AppState, username: &str, real_name: &str, role: i32, refresh: bool) -> Result<UserInfo> {
    let mut conn = db::connect(state).await?;
    let existing = users::table.filter(users::username.eq(username)).select(UserInfo::as_select())
        .first::<UserInfo>(&mut *conn).await.optional()?;
    let secret = if existing.is_none() {
        let iterations = state.config.password_iterations;
        Some(password::blocking(move || password::hash(&uuid::Uuid::new_v4().to_string(), iterations)).await?)
    } else { None };
    (*conn).transaction::<_, AppError, _>(async |conn| {
        if let Some(secret) = secret {
            diesel::insert_into(users::table).values((users::username.eq(username), users::real_name.eq(real_name),
                users::password.eq(secret),users::role.eq(role),users::password_expired.eq(false)))
                .on_conflict(diesel::dsl::DuplicatedKeys).do_nothing().execute(conn).await?;
        }
        let user = users::table.filter(users::username.eq(username)).filter(users::is_active.eq(true))
            .select(UserInfo::as_select()).for_update().first::<UserInfo>(conn).await.optional()?
            .ok_or_else(|| AppError::Auth("This management account is disabled".into()))?;
        diesel::insert_into(hoj_users::table).values(hoj_users::user_id.eq(user.id))
            .on_conflict(diesel::dsl::DuplicatedKeys).do_nothing().execute(conn).await?;
        if (refresh && user.role != role) || (real_name != username && user.real_name != real_name) {
            diesel::update(users::table.find(user.id)).set((users::role.eq(if refresh { role } else { user.role }), users::real_name.eq(if real_name != username { real_name } else { &user.real_name })))
                .execute(conn).await?;
            cache::invalidate_auth(conn).await?;
        }
        users::table.find(user.id).select(UserInfo::as_select()).first(conn).await.map_err(Into::into)
    }).await
}

pub(crate) async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<CurrentUser> {
    let me: Me = fetch(state, headers, "/api/me").await?;
    let role = if me.roles.iter().any(|r| r == "admin") { 2 }
        else if me.roles.iter().any(|r| r == "teacher") { 1 } else { 0 };
    let profile = ensure_user(state, &me.user, &me.user, role, true).await?;
    Ok(CurrentUser { id:profile.id,username:profile.username.clone(),role:profile.role,
        auth_epoch:None,profile:Some(profile) })
}

async fn links(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Link>>> {
    let mut conn = db::connect(&state).await?;
    let rows = hoj_offerings::table.select((hoj_offerings::course_id, hoj_offerings::offering_id))
        .load::<(i64,i32)>(&mut *conn).await?;
    let mut visible = Vec::new();
    for (course_id,offering_id) in rows {
        if crate::identity::permissions::require(&mut conn, &user, course_id,
            crate::identity::permissions::Permission::Access).await.is_ok() {
            visible.push(Link {course_id,offering_id});
        }
    }
    Ok(Json(visible))
}

async fn import(State(state): State<AppState>, Admin(user): Admin, headers: HeaderMap) -> Result<Json<Vec<Link>>> {
    let snapshot: Context = fetch(&state, &headers, "/api/management/context").await?;
    if snapshot.username != user.username || snapshot.role != 2 { return Err(AppError::Authorization("Super administrator required".into())); }
    let mut result = Vec::new();
    for course in snapshot.courses {
        let mut members = Vec::new();
        for member in &course.members {
            let role = if member.role == "teacher" { 1 } else { 0 };
            let profile = ensure_user(&state,&member.username,&member.real_name,role,false).await?;
            members.push((profile.id,member.role.as_str()));
        }
        let mut conn = db::connect(&state).await?;
        let id = (*conn).transaction::<_, AppError, _>(async |conn| {
            let mapped = hoj_offerings::table.find(course.offering_id).select(hoj_offerings::course_id)
                .first::<i64>(conn).await.optional()?;
            let id = if let Some(id) = mapped { id } else {
                diesel::insert_into(courses::table).values((courses::title.eq(&course.title),
                    courses::year.eq(course.year),courses::term.eq(course.term))).execute(conn).await?;
                diesel::define_sql_function! { fn last_insert_id() -> diesel::sql_types::BigInt; }
                let id = diesel::select(last_insert_id()).get_result::<i64>(conn).await?;
                diesel::insert_into(hoj_offerings::table).values((hoj_offerings::offering_id.eq(course.offering_id),
                    hoj_offerings::course_id.eq(id))).execute(conn).await?;
                id
            };
            // Explicit import refreshes the roster; file assignments and reviews are untouched.
            diesel::delete(course_teachers::table.filter(course_teachers::course_id.eq(id))).execute(conn).await?;
            diesel::delete(course_students::table.filter(course_students::course_id.eq(id))).execute(conn).await?;
            diesel::delete(course_assistants::table.filter(course_assistants::course_id.eq(id))).execute(conn).await?;
            for (uid,role) in members {
                match role {
                    "teacher" => { diesel::insert_into(course_teachers::table).values((course_teachers::course_id.eq(id),course_teachers::user_id.eq(uid))).execute(conn).await?; }
                    "ta" => { diesel::insert_into(course_assistants::table).values((course_assistants::course_id.eq(id),course_assistants::user_id.eq(uid))).execute(conn).await?; }
                    _ => { diesel::insert_into(course_students::table).values((course_students::course_id.eq(id),course_students::user_id.eq(uid))).execute(conn).await?; }
                }
            }
            cache::invalidate_auth(conn).await?;
            Ok(id)
        }).await?;
        result.push(Link {course_id:id,offering_id:course.offering_id});
    }
    Ok(Json(result))
}
