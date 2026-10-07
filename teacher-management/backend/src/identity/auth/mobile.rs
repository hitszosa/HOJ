use super::{CurrentUser, insert_session, session_key, set_cookies};
use crate::app::db::{Database, Db};
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::oauth::random_token;
use crate::identity::users::UserInfo;
use crate::schema::{mobile_sso_tickets as tickets, user_sessions, users};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/mobile_bridge", get(bridge))
        .route("/auth/mobile_exchange", post(exchange))
        .layer(middleware::from_fn(private_response))
}

async fn private_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

#[derive(Deserialize)]
struct BridgeQuery {
    state: String,
}

#[derive(Deserialize)]
struct ExchangeRequest {
    ticket: String,
}

fn invalid_ticket() -> AppError {
    AppError::Auth("Invalid or expired mobile login ticket".into())
}

async fn bridge(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<BridgeQuery>,
    headers: HeaderMap,
    Db(mut conn): Db,
) -> Result<Response> {
    if query.state.is_empty()
        || query.state.len() > 128
        || !query
            .state
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
    {
        return Err(AppError::BadRequest("Invalid mobile login state".into()));
    }
    let source_key = session_key(&state, &headers)?;
    let ticket = random_token();
    let ticket_hash = hex::encode(Sha256::digest(ticket.as_bytes()));
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            // Cached identity is not authority for issuing a login credential.
            users::table
                .find(user.id)
                .filter(users::is_active.eq(true))
                .select(users::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?
                .ok_or_else(invalid_ticket)?;
            let session_id = user_sessions::table
                .filter(user_sessions::session_key.eq(&source_key))
                .filter(user_sessions::user_id.eq(user.id))
                .filter(user_sessions::expires_at.gt(Utc::now().naive_utc()))
                .select(user_sessions::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?
                .ok_or_else(invalid_ticket)?;
            // Keep at most one ticket per browser session, including expired tickets.
            diesel::delete(tickets::table.find(session_id))
                .execute(conn)
                .await?;
            diesel::insert_into(tickets::table)
                .values((
                    tickets::session_id.eq(session_id),
                    tickets::ticket_hash.eq(&ticket_hash),
                    tickets::expires_at.eq(Utc::now().naive_utc() + Duration::seconds(60)),
                ))
                .execute(conn)
                .await?;
            Ok(())
        })
        .await?;

    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("ticket", &ticket)
        .append_pair("state", &query.state)
        .finish();
    // Never accept a caller-selected scheme/host or put session cookies in the URL.
    Ok(Redirect::to(&format!("grader://auth/callback?{query}")).into_response())
}

async fn exchange(
    State(state): State<AppState>,
    database: Database,
    Json(request): Json<ExchangeRequest>,
) -> Result<(HeaderMap, Json<UserInfo>)> {
    if request.ticket.len() != 43
        || !request
            .ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err(invalid_ticket());
    }
    let hash = hex::encode(Sha256::digest(request.ticket.as_bytes()));
    let mut conn = database.connect().await?;
    // Discover the actor without taking ticket locks ahead of user/session locks.
    let (session_id, user_id) = tickets::table
        .inner_join(user_sessions::table)
        .filter(tickets::ticket_hash.eq(&hash))
        .filter(tickets::expires_at.gt(Utc::now().naive_utc()))
        .select((tickets::session_id, user_sessions::user_id))
        .first::<(i64, i64)>(&mut *conn)
        .await
        .optional()?
        .ok_or_else(invalid_ticket)?;
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let user = users::table
                .find(user_id)
                .filter(users::is_active.eq(true))
                .select(UserInfo::as_select())
                .for_update()
                .first::<UserInfo>(conn)
                .await
                .optional()?
                .ok_or_else(invalid_ticket)?;
            user_sessions::table
                .find(session_id)
                .filter(user_sessions::user_id.eq(user_id))
                .filter(user_sessions::expires_at.gt(Utc::now().naive_utc()))
                .select(user_sessions::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?
                .ok_or_else(invalid_ticket)?;
            let consumed = diesel::delete(
                tickets::table
                    .find(session_id)
                    .filter(tickets::ticket_hash.eq(&hash))
                    .filter(tickets::expires_at.gt(Utc::now().naive_utc())),
            )
            .execute(conn)
            .await?;
            if consumed != 1 {
                return Err(invalid_ticket());
            }
            // Consumption and the new native session commit together. The browser
            // keeps its own session; later native logout does not log it out.
            let (key, expires) = insert_session(conn, user_id).await?;
            let mut headers = HeaderMap::new();
            set_cookies(&state, &key, expires, None, &mut headers)?;
            Ok((headers, Json(user)))
        })
        .await
}
