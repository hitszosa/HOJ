use axum::Json;
use axum::extract::{Path, State};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use serde::Serialize;

use crate::app::db::Database;
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::oauth::OAuthContext;
use crate::identity::permissions::{self, Permission};
use crate::proto::{self, suggest_extractor_client::SuggestExtractorClient};
use crate::schema::{assignments, courses, file_info, submissions, users};

#[derive(Serialize)]
pub(super) struct ExtractionResponse {
    submission_id: i64,
    course_id: i64,
    course_title: String,
    assignment_id: i64,
    assignment_title: String,
    file_ident: String,
    file_name: String,
    files: Vec<ExtractedFile>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct ExtractedFile {
    source_path: String,
    file_type: String,
    status: String,
    sections: Vec<ExtractedSection>,
    errors: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct ExtractedSection {
    heading: String,
    text: String,
    kind: String,
    confidence: f32,
    start_line: u64,
    end_line: u64,
}

#[derive(Queryable)]
struct Target {
    owner: i64,
    course_id: i64,
    course_title: String,
    assignment_id: i64,
    assignment_title: String,
    file_ident: Option<String>,
    file_name: Option<String>,
    upload_state: Option<String>,
}

pub(super) async fn extract(
    State(state): State<AppState>,
    oauth: OAuthContext,
    database: Database,
    Path(submission_id): Path<i64>,
) -> Result<Json<ExtractionResponse>> {
    oauth.require_scope("submissions:read")?;
    oauth.require_scope("files:read")?;

    let mut conn = database.connect().await?;
    let target: Target = submissions::table
        .inner_join(assignments::table.on(submissions::assignment_id.eq(assignments::id)))
        .inner_join(courses::table.on(assignments::course_id.eq(courses::id)))
        .inner_join(users::table.on(submissions::user_id.eq(users::id)))
        .left_join(
            file_info::table.on(submissions::file_ident.eq(file_info::file_ident.nullable())),
        )
        .filter(submissions::id.eq(submission_id))
        .filter(users::is_active.eq(true))
        .select((
            submissions::user_id,
            courses::id,
            courses::title,
            assignments::id,
            assignments::title,
            submissions::file_ident,
            file_info::file_name.nullable(),
            file_info::upload_state.nullable(),
        ))
        .first::<Target>(&mut *conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Submission not found".to_owned()))?;
    let permissions = permissions::load(&mut conn, &oauth.user, target.course_id).await?;
    permissions.require(Permission::Access)?;
    super::require_course_grant(&mut conn, &oauth, target.course_id).await?;
    if target.owner != oauth.user.id {
        permissions.require(Permission::Assist)?;
    }
    drop(conn);

    let file_ident = target
        .file_ident
        .ok_or_else(|| AppError::BadRequest("Submission has no file".to_owned()))?;
    if target.upload_state.as_deref() != Some("ready") {
        return Err(AppError::NotFound(
            "Submission file is unavailable".to_owned(),
        ));
    }
    let file_name = target.file_name.unwrap_or_else(|| file_ident.clone());

    let url = state.storage.download_url(&file_ident, true).await?;
    // The generated client is a lightweight wrapper around the shared HTTP/2 channel.
    let mut client = SuggestExtractorClient::new(state.extractor.clone())
        .max_decoding_message_size(128 * 1024 * 1024);
    let extracted = client
        .extract_from_url(proto::ExtractFromUrlRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            url,
            filename: file_name.clone(),
            options: None,
        })
        .await
        .map_err(|_| AppError::Unavailable("Suggest extractor failed".to_owned()))?
        .into_inner();
    Ok(Json(ExtractionResponse {
        submission_id,
        course_id: target.course_id,
        course_title: target.course_title,
        assignment_id: target.assignment_id,
        assignment_title: target.assignment_title,
        file_ident,
        file_name,
        files: extracted.files.into_iter().map(Into::into).collect(),
        warnings: extracted.warnings,
    }))
}

impl From<proto::FileResult> for ExtractedFile {
    fn from(file: proto::FileResult) -> Self {
        Self {
            source_path: file.source_path,
            file_type: file.file_type,
            status: file.status,
            sections: file.sections.into_iter().map(Into::into).collect(),
            errors: file.errors,
            warnings: file.warnings,
        }
    }
}

impl From<proto::ExtractedSection> for ExtractedSection {
    fn from(section: proto::ExtractedSection) -> Self {
        Self {
            heading: section.heading,
            text: section.text,
            kind: section.kind,
            confidence: section.confidence,
            start_line: section.start_line,
            end_line: section.end_line,
        }
    }
}
