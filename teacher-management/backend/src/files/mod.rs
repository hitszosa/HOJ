pub mod storage;

use std::collections::HashSet;

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use chrono::{Duration, Utc};
use diesel::{
    dsl::{exists, not},
    prelude::*,
};
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::app::db::Database;
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::files::storage::ObjectMetadata;
use crate::identity::auth::{CurrentUser, Teacher};
use crate::identity::permissions::{self, Permission};
use crate::management::audit;
use crate::schema::{
    assignments, code_grading_documents, course_students, file_info, grading_documents, submissions,
};

#[derive(Queryable, Selectable)]
#[diesel(table_name = file_info)]
struct File {
    id: i64,
    uploaded_by: Option<i64>,
    file_name: Option<String>,
    assignment_id: Option<i64>,
    file_ident: String,
    upload_state: String,
    upload_purpose: String,
}

#[derive(Deserialize)]
struct TouchRequest {
    original_file_name: String,
    ident: Purpose,
}

#[derive(Deserialize)]
struct Purpose {
    r#type: String,
    assignment_id: i64,
}

#[derive(Deserialize)]
struct IdentRequest {
    ident: String,
}

#[derive(Serialize)]
struct TouchResponse {
    ident: String,
    url: String,
    params: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
struct DownloadResponse {
    ident: String,
    url: String,
    original_file_name: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/files/touch", post(touch))
        .route("/files/finish", post(finish))
        .route("/files/download", post(download))
        .route("/file/cleanup_unused_uploads", post(cleanup))
}

async fn load(conn: &mut AsyncMysqlConnection, ident: &str) -> Result<File> {
    file_info::table
        .filter(file_info::file_ident.eq(ident))
        .select(File::as_select())
        .first(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("File not found".into()))
}

async fn upload_permission(
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    assignment: i64,
) -> Result<i64> {
    let (enrolled, max_size) = assignments::table
        .find(assignment)
        .select((
            exists(
                course_students::table
                    .filter(course_students::course_id.eq(assignments::course_id))
                    .filter(course_students::user_id.eq(user.id)),
            ),
            assignments::max_file_size,
        ))
        .first::<(bool, i32)>(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Assignment not found".into()))?;
    if !enrolled {
        return Err(AppError::Authorization(
            "You are not enrolled in this course".into(),
        ));
    }

    Ok(i64::from(max_size))
}

async fn touch(
    State(state): State<AppState>,
    user: CurrentUser,
    database: Database,
    Json(request): Json<TouchRequest>,
) -> Result<Json<TouchResponse>> {
    if request.ident.r#type != "submission" {
        return Err(AppError::BadRequest("Invalid file type".into()));
    }
    if request.original_file_name.trim().is_empty()
        || request.original_file_name.chars().count() > 500
    {
        return Err(AppError::Validation(
            "Original file name must contain 1–500 characters".into(),
        ));
    }
    let max_size = {
        let mut conn = database.connect().await?;
        upload_permission(&mut conn, &user, request.ident.assignment_id).await?
    };
    let ident = Uuid::new_v4().to_string();
    let now = Utc::now();
    let ttl = i64::try_from(state.config.upload_ttl_seconds)
        .ok()
        .filter(|ttl| *ttl > 0 && *ttl <= 604800)
        .ok_or_else(|| AppError::Internal("Invalid upload capability lifetime".into()))?;
    let expires = now + Duration::seconds(ttl);
    let (url, params) = state.storage.upload_form(&ident, max_size, expires).await?;
    let mut conn = database.connect().await?;
    diesel::insert_into(file_info::table)
        .values((
            file_info::file_ident.eq(&ident),
            file_info::uploaded_by.eq(Some(user.id)),
            file_info::file_name.eq(Some(&request.original_file_name)),
            file_info::assignment_id.eq(Some(request.ident.assignment_id)),
            file_info::created_at.eq(now.naive_utc()),
            file_info::upload_state.eq("pending"),
            file_info::upload_expires_at.eq(Some(expires.naive_utc())),
            file_info::upload_purpose.eq("submission"),
        ))
        .execute(&mut conn)
        .await?;
    Ok(Json(TouchResponse { ident, url, params }))
}

fn owned_assignment(file: &File, user: &CurrentUser) -> Result<i64> {
    if file.uploaded_by != Some(user.id) {
        return Err(AppError::Authorization(
            "You can only finish your own uploads".into(),
        ));
    }
    if file.upload_purpose != "submission" {
        return Err(AppError::Validation("Invalid upload purpose".into()));
    }
    file.assignment_id
        .ok_or_else(|| AppError::Validation("Upload has no assignment".into()))
}

fn verify_size(object: &ObjectMetadata, max_size: i64) -> Result<()> {
    if object.size < 0 || object.size > max_size {
        return Err(AppError::Validation(
            "Uploaded file exceeds assignment size limit".into(),
        ));
    }
    Ok(())
}

async fn finish(
    State(state): State<AppState>,
    user: CurrentUser,
    database: Database,
    Json(request): Json<IdentRequest>,
) -> Result<StatusCode> {
    let (file, max_size) = {
        let mut conn = database.connect().await?;
        let file = load(&mut conn, &request.ident).await?;
        let assignment = owned_assignment(&file, &user)?;
        let max_size = upload_permission(&mut conn, &user, assignment).await?;
        (file, max_size)
    };
    if !matches!(file.upload_state.as_str(), "pending" | "ready") {
        return Err(AppError::Validation("Upload is no longer available".into()));
    }
    let object = state
        .storage
        .head(&file.file_ident)
        .await?
        .ok_or_else(|| AppError::NotFound("Uploaded object not found".into()))?;
    verify_size(&object, max_size)?;
    let mut conn = database.connect().await?;
    let changed = diesel::update(
        file_info::table
            .find(file.id)
            .filter(file_info::upload_state.eq_any(["pending", "ready"])),
    )
    .set((
        file_info::upload_state.eq("ready"),
        file_info::file_size.eq(Some(object.size)),
        file_info::content_type.eq(object.content_type.as_deref()),
        file_info::upload_finished_at.eq(Some(Utc::now().naive_utc())),
    ))
    .execute(&mut conn)
    .await?;
    if changed == 0 && load(&mut conn, &request.ident).await?.upload_state != "ready" {
        return Err(AppError::Validation("Upload was removed".into()));
    }
    Ok(StatusCode::OK)
}

pub async fn download_object(
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    file_ident: &str,
) -> Result<(String, String)> {
    let file = load(conn, file_ident).await?;
    if file.upload_state != "ready" {
        return Err(AppError::NotFound("Finished file not found".into()));
    }
    if file.uploaded_by != Some(user.id) && user.role < 2 {
        let assignment = file
            .assignment_id
            .ok_or_else(|| AppError::Authorization("You do not have access to this file".into()))?;
        let submitted = diesel::select(exists(
            submissions::table
                .filter(submissions::file_ident.eq(file_ident))
                .filter(submissions::assignment_id.eq(assignment)),
        ))
        .get_result::<bool>(conn)
        .await?;
        if !submitted {
            return Err(AppError::Authorization(
                "File has not been submitted".into(),
            ));
        }
        let course = assignments::table
            .find(assignment)
            .select(assignments::course_id)
            .first::<i64>(conn)
            .await
            .optional()?
            .ok_or_else(|| AppError::NotFound("Assignment not found".into()))?;
        permissions::require(conn, user, course, Permission::Assist).await?;
    }
    Ok((file.file_ident, file.file_name.unwrap_or_default()))
}

async fn download(
    State(state): State<AppState>,
    user: CurrentUser,
    database: Database,
    Json(request): Json<IdentRequest>,
) -> Result<Json<DownloadResponse>> {
    let (key, original_file_name) = {
        let mut conn = database.connect().await?;
        download_object(&mut conn, &user, &request.ident).await?
    };
    let url = state.storage.download_url(&key, false).await?;
    Ok(Json(DownloadResponse {
        ident: request.ident,
        url,
        original_file_name,
    }))
}

#[derive(Queryable)]
struct CleanupFile {
    id: i64,
    ident: String,
}

async fn claim_cleanup(conn: &mut AsyncMysqlConnection, cursor: i64) -> Result<Vec<CleanupFile>> {
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let now = Utc::now().naive_utc();
            let old = now - Duration::hours(1);
            let candidates = file_info::table
                .filter(file_info::id.gt(cursor))
                .filter(
                    file_info::upload_state
                        .eq("deleting")
                        .or(file_info::upload_state
                            .eq("ready")
                            .and(file_info::upload_finished_at.lt(old)))
                        .or(file_info::upload_state
                            .eq("pending")
                            .and(file_info::upload_expires_at.lt(old))),
                )
                .filter(not(exists(submissions::table.filter(
                    submissions::file_ident.eq(file_info::file_ident.nullable()),
                ))))
                .filter(not(exists(grading_documents::table.filter(
                    grading_documents::preview_file_ident.eq(file_info::file_ident.nullable()),
                ))))
                .filter(not(exists(code_grading_documents::table.filter(
                    code_grading_documents::preview_file_ident.eq(file_info::file_ident),
                ))))
                .order(file_info::id.asc())
                .limit(250)
                .select((file_info::id, file_info::file_ident))
                .for_update()
                .load::<CleanupFile>(conn)
                .await?;
            if candidates.is_empty() {
                return Ok(candidates);
            }
            let identifiers: Vec<_> = candidates.iter().map(|file| &file.ident).collect();
            // Current locking read, not a repeatable-read snapshot: submitters lock the file
            // before inserting/updating submissions. No S3 call occurs under these locks.
            let mut referenced = submissions::table
                .filter(submissions::file_ident.eq_any(&identifiers))
                .select(submissions::file_ident)
                .for_update()
                .load::<Option<String>>(conn)
                .await?
                .into_iter()
                .flatten()
                .collect::<HashSet<_>>();
            referenced.extend(
                grading_documents::table
                    .filter(grading_documents::preview_file_ident.eq_any(&identifiers))
                    .select(grading_documents::preview_file_ident)
                    .for_update()
                    .load::<Option<String>>(conn)
                    .await?
                    .into_iter()
                    .flatten(),
            );
            referenced.extend(
                code_grading_documents::table
                    .filter(code_grading_documents::preview_file_ident.eq_any(&identifiers))
                    .select(code_grading_documents::preview_file_ident)
                    .for_update()
                    .load::<String>(conn)
                    .await?,
            );
            let claimed: Vec<_> = candidates
                .into_iter()
                .filter(|file| !referenced.contains(&file.ident))
                .collect();
            let ids: Vec<_> = claimed.iter().map(|file| file.id).collect();
            if !ids.is_empty() {
                diesel::update(file_info::table.filter(file_info::id.eq_any(ids)))
                    .set(file_info::upload_state.eq("deleting"))
                    .execute(conn)
                    .await?;
            }
            Ok(claimed)
        })
        .await
}

async fn cleanup(
    State(state): State<AppState>,
    Teacher(user): Teacher,
    database: Database,
) -> Result<StatusCode> {
    let mut cursor = 0;
    for _ in 0..16 {
        let claimed = {
            let mut conn = database.connect().await?;
            claim_cleanup(&mut conn, cursor).await?
        };
        if claimed.is_empty() {
            break;
        }
        cursor = claimed.last().unwrap().id;
        let keys: Vec<_> = claimed.iter().map(|file| file.ident.as_str()).collect();
        state.storage.delete_batch(&keys).await?;
        let ids: Vec<_> = claimed.iter().map(|file| file.id).collect();
        let mut conn = database.connect().await?;
        diesel::delete(
            file_info::table
                .filter(file_info::id.eq_any(ids))
                .filter(file_info::upload_state.eq("deleting"))
                .filter(not(exists(submissions::table.filter(
                    submissions::file_ident.eq(file_info::file_ident.nullable()),
                ))))
                .filter(not(exists(grading_documents::table.filter(
                    grading_documents::preview_file_ident.eq(file_info::file_ident.nullable()),
                ))))
                .filter(not(exists(code_grading_documents::table.filter(
                    code_grading_documents::preview_file_ident.eq(file_info::file_ident),
                )))),
        )
        .execute(&mut conn)
        .await?;
    }

    let mut conn = database.connect().await?;
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            audit::record(
                conn,
                &user,
                "cleanup_files",
                "file",
                None,
                "Cleaned unused uploads",
                (None, None),
            )
            .await
        })
        .await?;
    Ok(StatusCode::OK)
}
