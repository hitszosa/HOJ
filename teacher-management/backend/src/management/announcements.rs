use crate::{
    app::cache::{self, ReadCache},
    app::db::{Database, Db},
    app::error::{AppError, Result},
    app::state::AppState,
    identity::auth::{Teacher, lock_teacher},
    management::audit,
    schema::announcements,
};
use axum::{Json, Router, response::Response, routing::get};
use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};

use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct Announcement {
    pub enable: bool,
    pub publish_date: DateTime<Utc>,
    pub effective_until: DateTime<Utc>,
    pub display: String,
    pub title: String,
    pub content: String,
}

#[derive(Queryable, Selectable)]
#[diesel(table_name = announcements)]
struct Row {
    enable: bool,
    publish_date: NaiveDateTime,
    effective_until: NaiveDateTime,
    display: String,
    title: String,
    content: String,
}

async fn latest(cache: ReadCache, Db(mut conn): Db) -> Result<Response> {
    let key = "announcement:latest";
    if let Some(response) = cache.get(key, &mut conn).await? {
        return Ok(response);
    }

    let row = announcements::table
        .order((announcements::created_at.desc(), announcements::id.desc()))
        .select(Row::as_select())
        .first(&mut conn)
        .await
        .optional()?;
    let result = row.map(|r| Announcement {
        enable: r.enable,
        publish_date: r.publish_date.and_utc(),
        effective_until: r.effective_until.and_utc(),
        display: r.display,
        title: r.title,
        content: r.content,
    });
    cache.json(key, &result, None).await
}

async fn create(
    Teacher(user): Teacher,
    database: Database,
    Json(request): Json<Announcement>,
) -> Result<Json<Announcement>> {
    if request.title.chars().count() > 255
        || request.display.chars().count() > 100
        || request.content.len() > 65535
    {
        return Err(AppError::Validation(
            "Announcement field exceeds maximum length".into(),
        ));
    }

    let mut conn = database.connect().await?;
    let result = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock_teacher(conn, user.id, &[]).await?;
            diesel::insert_into(announcements::table)
                .values((
                    announcements::enable.eq(request.enable),
                    announcements::publish_date.eq(request.publish_date.naive_utc()),
                    announcements::effective_until.eq(request.effective_until.naive_utc()),
                    announcements::display.eq(&request.display),
                    announcements::title.eq(&request.title),
                    announcements::content.eq(&request.content),
                    announcements::created_by.eq(user.id),
                ))
                .execute(conn)
                .await?;
            audit::record(
                conn,
                &user,
                "CREATE",
                "announcement",
                None,
                "Created announcement",
                (
                    None,
                    Some(
                        serde_json::to_value(&request)
                            .map_err(|e| AppError::Internal(e.to_string()))?,
                    ),
                ),
            )
            .await?;
            cache::invalidate(conn).await?;
            Ok(request)
        })
        .await?;
    Ok(Json(result))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/manage/announcement", get(latest).post(create))
}
