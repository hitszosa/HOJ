//! Teaching assignment score export; documents are ordinary downloadable attachments.
use crate::{
    academic::assignments::{AssignmentAssist, AssignmentContext},
    app::{error::{AppError, Result}, state::AppState},
    schema::{course_students, submissions, users},
};
use axum::{Json, Router, routing::get};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
struct ReportRow {
    user_id: i64,
    username: String,
    real_name: String,
    submission_id: Option<i64>,
    score: Option<f64>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/assignments/{id}/grading/report", get(report))
}

async fn report(
    AssignmentAssist(AssignmentContext { mut conn, row }): AssignmentAssist,
) -> Result<Json<Vec<ReportRow>>> {
    let result = (*conn).transaction::<_, AppError, _>(async |conn| {
        let enrolled = users::table.inner_join(course_students::table)
            .filter(course_students::course_id.eq(row.course_id))
            .filter(users::is_active.eq(true))
            .select((users::id, users::username, users::real_name))
            .load::<(i64, String, String)>(conn).await?;
        let submitted = submissions::table.inner_join(users::table)
            .filter(submissions::assignment_id.eq(row.id))
            .select((users::id, users::username, users::real_name,
                submissions::id, submissions::status, submissions::score))
            .load::<(i64, String, String, i64, i32, f64)>(conn).await?;
        let mut rows: HashMap<i64, ReportRow> = enrolled.into_iter().map(|(user_id, username, real_name)| {
            (user_id, ReportRow {user_id, username, real_name, submission_id: None, score: None})
        }).collect();
        for (user_id, username, real_name, submission_id, status, score) in submitted {
            rows.insert(user_id, ReportRow {user_id, username, real_name,
                submission_id: Some(submission_id), score: (status == 1).then_some(score)});
        }
        let mut rows: Vec<_> = rows.into_values().collect();
        rows.sort_by(|a,b| a.username.cmp(&b.username).then(a.user_id.cmp(&b.user_id)));
        Ok(rows)
    }).await?;
    Ok(Json(result))
}
