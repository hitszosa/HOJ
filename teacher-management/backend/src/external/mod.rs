mod extraction;

use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::dsl::exists;
use diesel::expression::{AppearsOnTable, SelectableExpression, ValidGrouping};
use diesel::mysql::Mysql;
use diesel::prelude::*;
use diesel::query_builder::{AstPass, QueryFragment, QueryId};
use diesel::sql_types::{Nullable, Text};
use diesel_async::{AsyncMysqlConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};

use crate::app::db::Database;
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::oauth::OAuthContext;
use crate::identity::permissions::{self, Permission};
use crate::schema::{
    assignments, course_assistants, course_students, course_teachers, courses,
    oauth_access_token_course_grants as grants, submissions, users,
};

diesel::define_sql_function! {
    fn lower(value: Text) -> Text;
}

diesel::define_sql_function! {
    #[sql_name = "LOWER"]
    fn lower_nullable(value: Nullable<Text>) -> Nullable<Text>;
}

#[derive(Debug, Clone, Copy, QueryId, ValidGrouping)]
struct AsChar<T>(T);

impl<T: Expression> Expression for AsChar<T> {
    type SqlType = Text;
}

impl<T, QS> AppearsOnTable<QS> for AsChar<T> where T: AppearsOnTable<QS> {}

impl<T, QS> SelectableExpression<QS> for AsChar<T> where T: SelectableExpression<QS> {}

impl<T: QueryFragment<Mysql>> QueryFragment<Mysql> for AsChar<T> {
    fn walk_ast<'b>(&'b self, mut out: AstPass<'_, 'b, Mysql>) -> diesel::QueryResult<()> {
        out.push_sql("CAST(");
        self.0.walk_ast(out.reborrow())?;
        out.push_sql(" AS CHAR)");
        Ok(())
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/external/v1/courses/search", post(search_courses))
        .route("/external/v1/assignments/search", post(search_assignments))
        .route("/external/v1/submissions/search", post(search_submissions))
        .route(
            "/external/v1/submissions/{submission_id}/suggestions/extract",
            post(extraction::extract),
        )
}

#[derive(Deserialize)]
struct CourseSearchRequest {
    #[serde(default)]
    q: Vec<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
struct AssignmentSearchRequest {
    #[serde(default)]
    q: Vec<String>,
    course_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
struct SubmissionSearchRequest {
    #[serde(default)]
    q: Vec<String>,
    assignment_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
struct SearchResponse<T> {
    items: Vec<T>,
    has_more: bool,
    query: QueryInfo,
}

#[derive(Serialize)]
struct QueryInfo {
    tokens: Vec<String>,
    limit: i64,
    offset: i64,
}

impl QueryInfo {
    fn new(q: Vec<String>, limit: Option<i64>, offset: Option<i64>) -> Self {
        let mut tokens = Vec::new();
        for value in q {
            let value: String = value.trim().to_lowercase().chars().take(64).collect();
            if !value.is_empty() && !tokens.contains(&value) {
                tokens.push(value);
                if tokens.len() == 5 {
                    break;
                }
            }
        }
        Self {
            tokens,
            limit: limit.unwrap_or(20).clamp(1, 100),
            offset: offset.unwrap_or(0).max(0),
        }
    }

    fn patterns(&self) -> impl Iterator<Item = String> + '_ {
        self.tokens.iter().map(|token| {
            let escaped = token
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            format!("%{escaped}%")
        })
    }

    fn page<T>(&self, mut items: Vec<T>) -> (Vec<T>, bool) {
        let has_more = items.len() > self.limit as usize;
        items.truncate(self.limit as usize);
        (items, has_more)
    }
}

#[derive(Serialize)]
struct CourseResponse {
    id: i64,
    title: String,
    year: i32,
    term: i32,
    term_name: &'static str,
}

#[derive(Queryable)]
struct CourseRow {
    id: i64,
    title: String,
    year: i32,
    term: i32,
}

#[derive(Serialize)]
struct AssignmentResponse {
    id: i64,
    course_id: i64,
    course_title: String,
    title: String,
    description: String,
    published: bool,
    start_time: DateTime<Utc>,
    due_time: DateTime<Utc>,
    submit_allowed: bool,
    score_max: i32,
    show_score: bool,
    max_file_size: u64,
}

#[derive(Queryable)]
struct AssignmentRow {
    id: i64,
    title: String,
    description: Option<String>,
    published: bool,
    start: NaiveDateTime,
    due: NaiveDateTime,
    score: i32,
    show_score: bool,
    max_file_size: i32,
}

#[derive(Queryable, Serialize)]
struct UserSummary {
    id: i64,
    username: String,
    real_name: String,
    role: i32,
}

#[derive(Serialize)]
struct SubmissionResponse {
    id: i64,
    course_id: i64,
    course_title: String,
    assignment_id: i64,
    assignment_title: String,
    user: UserSummary,
    submit_time: DateTime<Utc>,
    status: i32,
    score: Option<f64>,
    file_ident: Option<String>,
}

#[derive(Serialize)]
struct SubmissionSearchResponse {
    items: Vec<SubmissionResponse>,
    unsubmitted: Vec<UserSummary>,
    has_more: bool,
    query: QueryInfo,
}

#[derive(Queryable)]
struct SubmissionRow {
    id: i64,
    user_id: i64,
    username: String,
    real_name: String,
    role: i32,
    submitted: NaiveDateTime,
    status: i32,
    score: f64,
    file_ident: Option<String>,
}

async fn require_course_grant(
    conn: &mut AsyncMysqlConnection,
    oauth: &OAuthContext,
    course: i64,
) -> Result<()> {
    let (restricted, granted) = diesel::select((
        exists(grants::table.filter(grants::access_token_id.eq(oauth.access_token_id))),
        exists(
            grants::table
                .filter(grants::access_token_id.eq(oauth.access_token_id))
                .filter(grants::course_id.eq(course)),
        ),
    ))
    .get_result::<(bool, bool)>(conn)
    .await?;
    if restricted && !granted {
        return Err(AppError::Authorization(
            "Token does not grant access to this course".to_owned(),
        ));
    }
    Ok(())
}

async fn search_courses(
    oauth: OAuthContext,
    database: Database,
    Json(request): Json<CourseSearchRequest>,
) -> Result<Json<SearchResponse<CourseResponse>>> {
    oauth.require_scope("courses:read")?;
    let mut conn = database.connect().await?;
    let query = QueryInfo::new(request.q, request.limit, request.offset);
    let mut selection = courses::table
        .select((courses::id, courses::title, courses::year, courses::term))
        .into_boxed();
    for pattern in query.patterns() {
        selection = selection
            .or_filter(lower(courses::title).like(pattern.clone()).escape('\\'))
            .or_filter(AsChar(courses::id).like(pattern.clone()).escape('\\'))
            .or_filter(AsChar(courses::year).like(pattern).escape('\\'));
    }
    if oauth.user.role < 2 {
        if oauth.user.role >= 1 {
            selection = selection.filter(exists(
                course_teachers::table
                    .filter(course_teachers::course_id.eq(courses::id))
                    .filter(course_teachers::user_id.eq(oauth.user.id)),
            ));
        } else {
            selection = selection.filter(
                exists(
                    course_students::table
                        .filter(course_students::course_id.eq(courses::id))
                        .filter(course_students::user_id.eq(oauth.user.id)),
                )
                .or(exists(
                    course_assistants::table
                        .filter(course_assistants::course_id.eq(courses::id))
                        .filter(course_assistants::user_id.eq(oauth.user.id)),
                )),
            );
        }
    }
    selection = selection.filter(
        diesel::dsl::not(exists(
            grants::table.filter(grants::access_token_id.eq(oauth.access_token_id)),
        ))
        .or(exists(
            grants::table
                .filter(grants::access_token_id.eq(oauth.access_token_id))
                .filter(grants::course_id.eq(courses::id)),
        )),
    );
    let rows = selection
        .order((
            courses::year.desc(),
            courses::term.desc(),
            courses::title.asc(),
            courses::id.asc(),
        ))
        .offset(query.offset)
        .limit(query.limit + 1)
        .load::<CourseRow>(&mut *conn)
        .await?;
    let (rows, has_more) = query.page(rows);
    let items = rows
        .into_iter()
        .map(|row| CourseResponse {
            id: row.id,
            title: row.title,
            year: row.year,
            term: row.term,
            term_name: match row.term {
                0 => "Spring",
                1 => "Summer",
                2 => "Fall",
                _ => "Unknown",
            },
        })
        .collect();
    Ok(Json(SearchResponse {
        items,
        has_more,
        query,
    }))
}

async fn search_assignments(
    oauth: OAuthContext,
    database: Database,
    Json(request): Json<AssignmentSearchRequest>,
) -> Result<Json<SearchResponse<AssignmentResponse>>> {
    oauth.require_scope("assignments:read")?;
    let mut conn = database.connect().await?;
    let course_title = courses::table
        .find(request.course_id)
        .select(courses::title)
        .first::<String>(&mut *conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Course not found".to_owned()))?;
    require_course_grant(&mut conn, &oauth, request.course_id).await?;
    let permissions = permissions::load(&mut conn, &oauth.user, request.course_id).await?;
    permissions.require(Permission::Access)?;
    let staff = permissions.assist;

    let query = QueryInfo::new(request.q, request.limit, request.offset);
    let now = Utc::now().naive_utc();
    let mut selection = assignments::table
        .inner_join(courses::table)
        .select((
            assignments::id,
            assignments::title,
            assignments::description,
            assignments::published,
            assignments::start_time,
            assignments::due_time,
            assignments::score,
            assignments::show_score,
            assignments::max_file_size,
        ))
        .into_boxed();
    for pattern in query.patterns() {
        selection = selection
            .or_filter(AsChar(assignments::id).like(pattern.clone()).escape('\\'))
            .or_filter(
                AsChar(assignments::course_id)
                    .like(pattern.clone())
                    .escape('\\'),
            )
            .or_filter(lower(courses::title).like(pattern.clone()).escape('\\'))
            .or_filter(lower(assignments::title).like(pattern.clone()).escape('\\'))
            .or_filter(
                lower_nullable(assignments::description)
                    .like(pattern.clone())
                    .escape('\\'),
            )
            .or_filter(AsChar(assignments::score).like(pattern).escape('\\'));
    }
    selection = selection.filter(assignments::course_id.eq(request.course_id));
    if !staff {
        selection = selection
            .filter(assignments::published.eq(true))
            .filter(assignments::start_time.le(now));
    }
    let rows = selection
        .order((assignments::due_time.asc(), assignments::id.asc()))
        .offset(query.offset)
        .limit(query.limit + 1)
        .load::<AssignmentRow>(&mut *conn)
        .await?;
    let (rows, has_more) = query.page(rows);
    let items = rows
        .into_iter()
        .map(|row| AssignmentResponse {
            id: row.id,
            course_id: request.course_id,
            course_title: course_title.clone(),
            title: row.title,
            description: row.description.unwrap_or_default(),
            published: row.published,
            start_time: row.start.and_utc(),
            due_time: row.due.and_utc(),
            submit_allowed: row.published && row.start < now && now < row.due,
            score_max: row.score,
            show_score: row.show_score,
            max_file_size: row.max_file_size as u64,
        })
        .collect();
    Ok(Json(SearchResponse {
        items,
        has_more,
        query,
    }))
}

async fn search_submissions(
    oauth: OAuthContext,
    database: Database,
    Json(request): Json<SubmissionSearchRequest>,
) -> Result<Json<SubmissionSearchResponse>> {
    oauth.require_scope("submissions:read")?;
    let mut conn = database.connect().await?;
    let scores = oauth.has_scope("grades:read");
    let files = oauth.has_scope("files:read");
    let (course_id, course_title, assignment_title) = assignments::table
        .inner_join(courses::table.on(assignments::course_id.eq(courses::id)))
        .filter(assignments::id.eq(request.assignment_id))
        .select((courses::id, courses::title, assignments::title))
        .first::<(i64, String, String)>(&mut *conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Assignment not found".to_owned()))?;
    require_course_grant(&mut conn, &oauth, course_id).await?;
    permissions::require(&mut conn, &oauth.user, course_id, Permission::Assist).await?;
    let query = QueryInfo::new(request.q, request.limit, request.offset);
    let mut selection = submissions::table
        .inner_join(users::table)
        .inner_join(assignments::table.inner_join(courses::table))
        .select((
            submissions::id,
            users::id,
            users::username,
            users::real_name,
            users::role,
            submissions::submit_time,
            submissions::status,
            submissions::score,
            submissions::file_ident,
        ))
        .into_boxed();
    for pattern in query.patterns() {
        selection = selection
            .or_filter(AsChar(submissions::id).like(pattern.clone()).escape('\\'))
            .or_filter(AsChar(courses::id).like(pattern.clone()).escape('\\'))
            .or_filter(lower(courses::title).like(pattern.clone()).escape('\\'))
            .or_filter(AsChar(assignments::id).like(pattern.clone()).escape('\\'))
            .or_filter(lower(assignments::title).like(pattern.clone()).escape('\\'))
            .or_filter(AsChar(users::id).like(pattern.clone()).escape('\\'))
            .or_filter(lower(users::username).like(pattern.clone()).escape('\\'))
            .or_filter(lower(users::real_name).like(pattern.clone()).escape('\\'))
            .or_filter(
                AsChar(submissions::status)
                    .like(pattern.clone())
                    .escape('\\'),
            );
        if scores {
            selection = selection.or_filter(
                AsChar(submissions::score)
                    .like(pattern.clone())
                    .escape('\\'),
            );
        }
        if files {
            selection = selection.or_filter(
                lower_nullable(submissions::file_ident)
                    .like(pattern)
                    .escape('\\'),
            );
        }
    }
    let rows = selection
        .filter(submissions::assignment_id.eq(request.assignment_id))
        .filter(users::is_active.eq(true))
        .order((submissions::submit_time.desc(), submissions::id.desc()))
        .offset(query.offset)
        .limit(query.limit + 1)
        .load::<SubmissionRow>(&mut *conn)
        .await?;
    let (rows, has_more) = query.page(rows);
    let items = rows
        .into_iter()
        .map(|row| SubmissionResponse {
            id: row.id,
            course_id,
            course_title: course_title.clone(),
            assignment_id: request.assignment_id,
            assignment_title: assignment_title.clone(),
            user: UserSummary {
                id: row.user_id,
                username: row.username,
                real_name: row.real_name,
                role: row.role,
            },
            submit_time: row.submitted.and_utc(),
            status: row.status,
            score: scores.then_some(row.score),
            file_ident: if files { row.file_ident } else { None },
        })
        .collect();
    // The legacy response includes every matching unsubmitted student, independently
    // of the submitted-record page. Token count/length caps still apply to this list.
    let mut missing = users::table
        .inner_join(course_students::table)
        .select((users::id, users::username, users::real_name, users::role))
        .into_boxed();
    for pattern in query.patterns() {
        missing = missing
            .or_filter(AsChar(users::id).like(pattern.clone()).escape('\\'))
            .or_filter(lower(users::username).like(pattern.clone()).escape('\\'))
            .or_filter(lower(users::real_name).like(pattern.clone()).escape('\\'))
            .or_filter(AsChar(users::role).like(pattern).escape('\\'));
    }
    let unsubmitted = missing
        .filter(course_students::course_id.eq(course_id))
        .filter(users::is_active.eq(true))
        .filter(diesel::dsl::not(exists(
            submissions::table
                .filter(submissions::assignment_id.eq(request.assignment_id))
                .filter(submissions::user_id.eq(users::id)),
        )))
        .order(users::username.asc())
        .load::<UserSummary>(&mut *conn)
        .await?;
    Ok(Json(SubmissionSearchResponse {
        items,
        unsubmitted,
        has_more,
        query,
    }))
}
