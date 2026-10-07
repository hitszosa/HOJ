use crate::{
    academic::assignments::{self, AssignmentContext},
    app::cache::{self, ReadCache},
    app::db::{self, Database, Db},
    app::error::{AppError, Result},
    app::state::AppState,
    identity::auth::CurrentUser,
    identity::permissions::{self, Permission},
    identity::users::UserInfo,
    schema::{
        assignments as a, course_assistants, course_students, course_teachers, file_info,
        submissions as s, users,
    },
};
use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::{
    dsl::{exists, not},
    prelude::*,
};
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};

use serde::{Deserialize, Serialize};

#[derive(Queryable, Selectable)]
#[diesel(table_name = s)]
struct Submission {
    id: i64,
    assignment_id: i64,
    submit_time: NaiveDateTime,
    status: i32,
    score: f64,
    file_ident: Option<String>,
}

#[derive(Queryable, Selectable)]
#[diesel(table_name = users)]
struct Student {
    id: i64,
    username: String,
    real_name: String,
    role: i32,
    password_expired: bool,
}

impl From<Student> for UserInfo {
    fn from(value: Student) -> Self {
        Self {
            id: value.id,
            username: value.username,
            real_name: value.real_name,
            role: value.role,
            password_expired: value.password_expired,
        }
    }
}

#[derive(Serialize)]
struct SubmissionResponse {
    id: i64,
    submit_time: DateTime<Utc>,
    status: i32,
    score: Option<f64>,
    assignment: i64,
    user: UserInfo,
    file: Option<String>,
}

fn response((row, user): (Submission, Student), show_score: bool) -> SubmissionResponse {
    SubmissionResponse {
        id: row.id,
        submit_time: row.submit_time.and_utc(),
        status: row.status,
        score: show_score.then_some(row.score),
        assignment: row.assignment_id,
        user: user.into(),
        file: row.file_ident,
    }
}

#[derive(Deserialize)]
struct ListQuery {
    assignment: Option<i64>,
    course: Option<i64>,
}

#[derive(Deserialize)]
struct CreateQuery {
    assignment: i64,
    file_ident: String,
}

#[derive(Deserialize)]
struct ScoreRequest {
    submission: i64,
    score: f64,
}

#[derive(Deserialize)]
struct AssignmentQuery {
    assignment: i64,
}

struct SubmissionList {
    conn: db::Connection,
    user: CurrentUser,
    params: ListQuery,
    own_only: bool,
}

impl FromRequestParts<AppState> for SubmissionList {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let user = CurrentUser::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let Query(params) = Query::<ListQuery>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let mut conn = db::connect(state)
            .await
            .map_err(IntoResponse::into_response)?;
        let mut own_only = false;
        let mut assignment_course = None;

        if let Some(id) = params.assignment {
            let course = a::table
                .find(id)
                .select(a::course_id)
                .first::<i64>(&mut conn)
                .await
                .optional()
                .map_err(AppError::from)
                .map_err(IntoResponse::into_response)?
                .ok_or_else(|| AppError::NotFound("Assignment not found".into()).into_response())?;
            let permissions = permissions::read(state, &mut conn, &user, course)
                .await
                .map_err(IntoResponse::into_response)?;
            permissions
                .require(Permission::Access)
                .map_err(IntoResponse::into_response)?;
            own_only = !permissions.assist;
            assignment_course = Some(course);
        }

        if let Some(id) = params.course.filter(|id| Some(*id) != assignment_course) {
            let permissions = permissions::read(state, &mut conn, &user, id)
                .await
                .map_err(IntoResponse::into_response)?;
            permissions
                .require(Permission::Access)
                .map_err(IntoResponse::into_response)?;
            own_only |= !permissions.assist;
        }

        Ok(Self {
            conn,
            user,
            params,
            own_only,
        })
    }
}

struct SubmissionAccess(SubmissionResponse);

impl FromRequestParts<AppState> for SubmissionAccess {
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
        let (row, student, course, show_score) = s::table
            .inner_join(users::table)
            .inner_join(a::table)
            .filter(s::id.eq(id))
            .select((
                Submission::as_select(),
                Student::as_select(),
                a::course_id,
                a::show_score,
            ))
            .first::<(Submission, Student, i64, bool)>(&mut conn)
            .await
            .optional()
            .map_err(AppError::from)
            .map_err(IntoResponse::into_response)?
            .ok_or_else(|| AppError::NotFound("Submission not found".into()).into_response())?;
        let permissions = permissions::read(state, &mut conn, &user, course)
            .await
            .map_err(IntoResponse::into_response)?;
        permissions
            .require(Permission::Access)
            .map_err(IntoResponse::into_response)?;

        if student.id != user.id && !permissions.assist {
            return Err(
                AppError::Authorization("You can only view your own submissions".into())
                    .into_response(),
            );
        }

        Ok(Self(response(
            (row, student),
            permissions.assist || show_score,
        )))
    }
}

struct AssignmentStudents(pub AssignmentContext);

impl FromRequestParts<AppState> for AssignmentStudents {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let user = CurrentUser::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let Query(query) = Query::<AssignmentQuery>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let mut conn = db::connect(state)
            .await
            .map_err(IntoResponse::into_response)?;
        let row = assignments::get_row(&mut conn, query.assignment)
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/submissions", get(list).post(create))
        .route("/submissions/{id}", get(get_one))
        .route("/submissions/score_update", post(score))
        .route("/submissions/no_submission_students", get(missing))
}

async fn get_response(conn: &mut AsyncMysqlConnection, id: i64) -> Result<SubmissionResponse> {
    s::table
        .inner_join(users::table)
        .filter(s::id.eq(id))
        .select((Submission::as_select(), Student::as_select()))
        .first::<(Submission, Student)>(conn)
        .await
        .optional()?
        .map(|row| response(row, true))
        .ok_or_else(|| AppError::NotFound("Submission not found".into()))
}

async fn list(
    cache: ReadCache,
    SubmissionList {
        mut conn,
        user,
        params,
        own_only,
    }: SubmissionList,
) -> Result<Response> {
    let key = format!(
        "submissions:list:user:{}:role:{}:assignment:{:?}:course:{:?}:own:{}",
        user.id, user.role, params.assignment, params.course, own_only
    );
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let unfiltered = params.assignment.is_none() && params.course.is_none();
    let mut select = s::table
        .inner_join(users::table)
        .inner_join(a::table)
        .filter(users::is_active.eq(true))
        .select((
            Submission::as_select(),
            Student::as_select(),
            a::show_score.or(exists(
                course_assistants::table
                    .filter(course_assistants::course_id.eq(a::course_id))
                    .filter(course_assistants::user_id.eq(user.id)),
            )),
        ))
        .into_boxed();

    if let Some(id) = params.assignment {
        select = select.filter(s::assignment_id.eq(id));
    }
    if let Some(id) = params.course {
        select = select.filter(a::course_id.eq(id));
    }

    if own_only || (unfiltered && user.role == 0) {
        select = select.filter(s::user_id.eq(user.id));
    }
    if unfiltered && user.role == 1 {
        select = select.filter(exists(
            course_teachers::table
                .filter(course_teachers::course_id.eq(a::course_id))
                .filter(course_teachers::user_id.eq(user.id)),
        ));
    }

    if unfiltered {
        select = select.limit(1000);
    }

    let rows = select
        .order((s::submit_time.desc(), s::id.desc()))
        .load::<(Submission, Student, bool)>(&mut conn)
        .await?;
    let values: Vec<_> = rows
        .into_iter()
        .map(|(row, student, visible)| response((row, student), user.role >= 1 || visible))
        .collect();
    cache.json(&key, &values, None).await
}

async fn get_one(SubmissionAccess(value): SubmissionAccess) -> Result<Json<SubmissionResponse>> {
    Ok(Json(value))
}

async fn create(
    user: CurrentUser,
    Db(mut conn): Db,
    Query(request): Query<CreateQuery>,
) -> Result<(StatusCode, Json<SubmissionResponse>)> {
    let value = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let assignment = assignments::lock_row(conn, request.assignment).await?;
            let permissions = permissions::load(conn, &user, assignment.course_id).await?;
            permissions.require(Permission::Access)?;

            let enrolled = course_students::table
                .filter(course_students::course_id.eq(assignment.course_id))
                .filter(course_students::user_id.eq(user.id))
                .select(course_students::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?;
            if enrolled.is_none() {
                return Err(AppError::Authorization(
                    "You are not enrolled in this course".into(),
                ));
            }

            let file = file_info::table
                .filter(file_info::file_ident.eq(&request.file_ident))
                .select((
                    file_info::uploaded_by,
                    file_info::assignment_id,
                    file_info::upload_state,
                    file_info::upload_finished_at,
                    file_info::upload_purpose,
                ))
                .for_update()
                .first::<(
                    Option<i64>,
                    Option<i64>,
                    String,
                    Option<NaiveDateTime>,
                    String,
                )>(conn)
                .await
                .optional()?
                .ok_or_else(|| AppError::NotFound("File not found".into()))?;
            if file.0 != Some(user.id)
                || file.1 != Some(request.assignment)
                || file.4 != "submission"
            {
                return Err(AppError::Authorization(
                    "File is not uploaded by you for this assignment".into(),
                ));
            }
            if file.2 != "ready" || file.3.is_none() {
                return Err(AppError::Validation("File upload is not finished".into()));
            }

            // Evaluate the deadline after acquiring all locks, not before waiting on an upload.
            let now = Utc::now().naive_utc();
            if !assignment.published || assignment.start_time >= now || now >= assignment.due_time {
                return Err(AppError::Authorization(
                    "Assignment submission is not allowed".into(),
                ));
            }

            diesel::insert_into(s::table)
                .values((
                    s::assignment_id.eq(request.assignment),
                    s::user_id.eq(user.id),
                    s::file_ident.eq(Some(&request.file_ident)),
                    s::submit_time.eq(now),
                    s::status.eq(0),
                    s::score.eq(0.0),
                    s::created_at.eq(now),
                    s::updated_at.eq(now),
                ))
                .on_conflict(diesel::dsl::DuplicatedKeys)
                .do_update()
                .set((
                    s::file_ident.eq(Some(&request.file_ident)),
                    s::submit_time.eq(now),
                    s::status.eq(0),
                    s::score.eq(0.0),
                    s::updated_at.eq(now),
                ))
                .execute(conn)
                .await?;
            let row = s::table
                .inner_join(users::table)
                .filter(s::assignment_id.eq(request.assignment))
                .filter(s::user_id.eq(user.id))
                .select((Submission::as_select(), Student::as_select()))
                .first::<(Submission, Student)>(conn)
                .await?;
            // A resubmission is a new grading source, even when the student reused the UUID.
            diesel::delete(crate::schema::grading_documents::table.find(row.0.id))
                .execute(conn)
                .await?;
            diesel::delete(crate::schema::code_grading_reviews::table.find(row.0.id))
                .execute(conn)
                .await?;
            diesel::delete(
                crate::schema::code_grading_documents::table
                    .filter(crate::schema::code_grading_documents::submission_id.eq(row.0.id)),
            )
            .execute(conn)
            .await?;
            cache::invalidate(conn).await?;

            Ok(response(row, permissions.assist || assignment.show_score))
        })
        .await?;

    Ok((StatusCode::CREATED, Json(value)))
}

async fn score(
    user: CurrentUser,
    database: Database,
    Json(request): Json<ScoreRequest>,
) -> Result<Json<SubmissionResponse>> {
    if !request.score.is_finite() {
        return Err(AppError::Validation("Score must be finite".into()));
    }

    let mut conn = database.connect().await?;
    let result = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let assignment = s::table
                .find(request.submission)
                .select(s::assignment_id)
                .first::<i64>(conn)
                .await
                .optional()?
                .ok_or_else(|| AppError::NotFound("Submission not found".into()))?;
            let assignment = assignments::lock_row(conn, assignment).await?;
            permissions::require(conn, &user, assignment.course_id, Permission::Assist).await?;

            s::table
                .find(request.submission)
                .select(s::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?
                .ok_or_else(|| AppError::NotFound("Submission not found".into()))?;
            diesel::update(s::table.find(request.submission))
                .set((
                    s::score.eq(request.score),
                    s::status.eq(1),
                    s::updated_at.eq(Utc::now().naive_utc()),
                ))
                .execute(conn)
                .await?;

            let result = get_response(conn, request.submission).await?;
            cache::invalidate(conn).await?;
            Ok(result)
        })
        .await?;

    Ok(Json(result))
}

async fn missing(
    cache: ReadCache,
    AssignmentStudents(AssignmentContext { mut conn, row }): AssignmentStudents,
) -> Result<Response> {
    let key = format!("submissions:missing:assignment:{}", row.id);
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let students = users::table
        .inner_join(course_students::table)
        .filter(course_students::course_id.eq(row.course_id))
        .filter(users::is_active.eq(true))
        .filter(not(exists(
            s::table
                .filter(s::assignment_id.eq(row.id))
                .filter(s::user_id.eq(users::id)),
        )))
        .select(Student::as_select())
        .order((users::username.asc(), users::id.asc()))
        .load::<Student>(&mut conn)
        .await?;
    let values: Vec<_> = students.into_iter().map(UserInfo::from).collect();
    cache.json(&key, &values, None).await
}
