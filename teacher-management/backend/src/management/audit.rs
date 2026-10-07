use crate::{
    app::db::Db,
    app::error::{AppError, Result},
    app::state::AppState,
    identity::auth::{CurrentUser, Teacher},
    schema::audit_logs,
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, Request},
    middleware::Next,
    response::Response,
    routing::get,
};
use chrono::NaiveDateTime;
use diesel::prelude::*;
use diesel_async::{AsyncMysqlConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;

#[derive(Clone, Default)]
struct RequestContext {
    ip_address: Option<String>,
    user_agent: Option<String>,
}

tokio::task_local! {
    static CONTEXT: RequestContext;
}

pub async fn request_context(request: Request, next: Next) -> Response {
    if matches!(
        *request.method(),
        http::Method::GET | http::Method::HEAD | http::Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let context = RequestContext {
        ip_address: request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|peer| peer.0.ip().to_string()),
        user_agent: request
            .headers()
            .get(http::header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    };
    CONTEXT.scope(context, next.run(request)).await
}

#[derive(Queryable, Selectable, Serialize)]
#[diesel(table_name = audit_logs)]
#[diesel(check_for_backend(diesel::mysql::Mysql))]
pub struct AuditLog {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub user_role: i32,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Option<i64>,
    pub created_at: NaiveDateTime,
    pub description: String,
    pub old_values: Option<String>,
    pub new_values: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub session_id: Option<String>,
    pub affected_user_id: Option<i64>,
    pub course_id: Option<i64>,
    pub assignment_id: Option<i64>,
}

pub async fn record(
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    action: &str,
    resource_type: &str,
    resource_id: Option<i64>,
    description: &str,
    changes: (Option<Value>, Option<Value>),
) -> Result<()> {
    let (old_values, new_values) = changes;
    let old = old_values.map(|v| v.to_string());
    let new = new_values.map(|v| v.to_string());

    let mut end = description.len().min(65535);
    while !description.is_char_boundary(end) {
        end -= 1;
    }
    let description = &description[..end];

    let context = CONTEXT.try_with(Clone::clone).unwrap_or_default();
    diesel::insert_into(audit_logs::table)
        .values((
            audit_logs::user_id.eq(user.id),
            audit_logs::username.eq(&user.username),
            audit_logs::user_role.eq(user.role),
            audit_logs::action.eq(action),
            audit_logs::resource_type.eq(resource_type),
            audit_logs::resource_id.eq(resource_id),
            audit_logs::description.eq(description),
            audit_logs::old_values.eq(old),
            audit_logs::new_values.eq(new),
            audit_logs::ip_address.eq(context.ip_address),
            audit_logs::user_agent.eq(context.user_agent),
            audit_logs::affected_user_id.eq(if matches!(resource_type, "user" | "users") {
                resource_id
            } else {
                None
            }),
            audit_logs::course_id.eq(
                if matches!(resource_type, "course" | "courses" | "course_permissions") {
                    resource_id
                } else {
                    None
                },
            ),
            audit_logs::assignment_id.eq(
                if matches!(resource_type, "assignment" | "assignments") {
                    resource_id
                } else {
                    None
                },
            ),
        ))
        .execute(conn)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct RecentQuery {
    limit: Option<i64>,
}

async fn recent(
    Teacher(_user): Teacher,
    Db(mut conn): Db,
    Query(query): Query<RecentQuery>,
) -> Result<Json<Vec<AuditLog>>> {
    let limit = query.limit.unwrap_or(10);
    if !(1..=1000).contains(&limit) {
        return Err(AppError::Validation(
            "Limit must be between 1 and 1000".into(),
        ));
    }

    Ok(Json(
        audit_logs::table
            .order((audit_logs::created_at.desc(), audit_logs::id.desc()))
            .limit(limit)
            .select(AuditLog::as_select())
            .load(&mut conn)
            .await?,
    ))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/manage/recent_actions", get(recent))
}
