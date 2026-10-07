use crate::{
    academic::assignments::{Assignment, AssignmentResponse},
    app::cache::{self, ReadCache},
    app::db::{Database, Db},
    app::error::{AppError, Result},
    app::state::AppState,
    identity::auth::{CurrentUser, Teacher},
    identity::permissions::{self, CourseAccess, CourseContext, Permission},
    identity::users::UserInfo,
    management::audit,
    schema::{
        assignments, course_assistants as ca, course_students as cs, course_teachers as ct,
        courses as c, users as u,
    },
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{StatusCode, HeaderMap},
    response::Response,
    routing::get,
};
use chrono::{DateTime, Datelike, NaiveDateTime, Utc};
use diesel::Column;
use diesel::expression::ValidGrouping;
use diesel::mysql::Mysql;
use diesel::query_builder::{AstPass, Query as SqlQuery, QueryFragment, QueryId};
use diesel::sql_types::BigInt;
use diesel::{dsl::exists, prelude::*};
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

diesel::define_sql_function! { fn last_insert_id() -> diesel::sql_types::BigInt; }

// Diesel types the window expression and selected record; only the derived-table
// boundary is rendered here because Diesel has no FROM-subquery DSL.
#[derive(QueryId)]
struct RankColumn<E>(E);

impl<E: Expression<SqlType = BigInt>> Expression for RankColumn<E> {
    type SqlType = BigInt;
}

impl<QS, E: AppearsOnTable<QS, SqlType = BigInt>> AppearsOnTable<QS> for RankColumn<E> {}
impl<QS, E: SelectableExpression<QS, SqlType = BigInt>> SelectableExpression<QS> for RankColumn<E> {}

impl<GB, E: ValidGrouping<GB>> ValidGrouping<GB> for RankColumn<E> {
    type IsAggregate = E::IsAggregate;
}

impl<E: QueryFragment<Mysql>> QueryFragment<Mysql> for RankColumn<E> {
    fn walk_ast<'b>(&'b self, mut out: AstPass<'_, 'b, Mysql>) -> diesel::QueryResult<()> {
        self.0.walk_ast(out.reborrow())?;
        out.push_sql(" AS `__rank`");
        Ok(())
    }
}

#[derive(QueryId)]
struct RecentAssignments<Q, S> {
    ranked: Q,
    selection: S,
}

impl<Q, S: Expression> SqlQuery for RecentAssignments<Q, S> {
    type SqlType = S::SqlType;
}

impl<Q: QueryFragment<Mysql>, S: QueryFragment<Mysql>> QueryFragment<Mysql>
    for RecentAssignments<Q, S>
{
    fn walk_ast<'b>(&'b self, mut out: AstPass<'_, 'b, Mysql>) -> diesel::QueryResult<()> {
        // Rank only IDs. Including TEXT descriptions forces MariaDB's window
        // materialization onto disk; fetch the selected records after ranking.
        out.push_sql("SELECT ");
        self.selection.walk_ast(out.reborrow())?;
        out.push_sql(" FROM ");
        assignments::table.walk_ast(out.reborrow())?;
        out.push_sql(" INNER JOIN (");
        self.ranked.walk_ast(out.reborrow())?;
        out.push_sql(") ranked ON ");
        assignments::id.walk_ast(out.reborrow())?;
        out.push_sql(" = ranked.");
        out.push_identifier(assignments::id::NAME)?;
        out.push_sql(" WHERE ranked.`__rank` <= 3 ORDER BY ranked.");
        out.push_identifier(assignments::course_id::NAME)?;
        out.push_sql(", ranked.`__rank`");
        Ok(())
    }
}

#[derive(Queryable, Selectable)]
#[diesel(table_name = c)]
struct Course {
    id: i64,
    title: String,
    year: i32,
    term: i32,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

#[derive(Serialize)]
struct CourseResponse {
    id: i64,
    title: String,
    year: i32,
    term: i32,
    term_name: &'static str,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    teachers: Vec<UserInfo>,
    students: Vec<i64>,
    assistants: Vec<i64>,
    last_3_assignments: Option<Vec<AssignmentResponse>>,
}

#[derive(Serialize)]
struct RecentCourse {
    id: i64,
    title: String,
    teachers: Vec<UserInfo>,
    recent_assignments: Vec<AssignmentResponse>,
    year: i32,
    term: i32,
    assistants: Vec<i64>,
}

#[derive(Deserialize)]
struct CreateCourse {
    title: String,
    year: Option<i32>,
    term: Option<i32>,
    teacher_ids: Vec<i64>,
    student_ids: Vec<i64>,
    assistant_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct UpdateCourse {
    title: Option<String>,
    year: Option<i32>,
    term: Option<i32>,
    teacher_ids: Option<Vec<i64>>,
    student_ids: Option<Vec<i64>>,
    assistant_ids: Option<Vec<i64>>,
}

#[derive(Default, Deserialize)]
struct ListQuery {
    #[serde(default)]
    all: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/courses", get(list).post(create))
        .route("/courses/with_recent_assignments", get(recent))
        .route(
            "/courses/{id}",
            get(get_one).put(update).patch(update).delete(delete),
        )
}

pub(crate) async fn lock(conn: &mut AsyncMysqlConnection, id: i64) -> Result<()> {
    c::table
        .find(id)
        .select(c::id)
        .for_update()
        .first::<i64>(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Course not found".into()))?;
    Ok(())
}

async fn fetch(
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    all: bool,
) -> Result<Vec<Course>> {
    let mut select = c::table.select(Course::as_select()).into_boxed();
    if user.role == 0 {
        select = select.filter(
            exists(
                cs::table
                    .filter(cs::course_id.eq(c::id))
                    .filter(cs::user_id.eq(user.id)),
            )
            .or(exists(
                ca::table
                    .filter(ca::course_id.eq(c::id))
                    .filter(ca::user_id.eq(user.id)),
            )),
        );
    } else if user.role == 1 && !all {
        select = select.filter(exists(
            ct::table
                .filter(ct::course_id.eq(c::id))
                .filter(ct::user_id.eq(user.id)),
        ));
    } else if user.role < 0 {
        return Err(AppError::Authorization("Invalid user role".into()));
    }

    Ok(select
        .order((c::year.desc(), c::term.desc(), c::title.asc(), c::id.asc()))
        .load(conn)
        .await?)
}

async fn responses(
    conn: &mut AsyncMysqlConnection,
    rows: Vec<Course>,
    include_students: bool,
) -> Result<Vec<CourseResponse>> {
    let ids: Vec<_> = rows.iter().map(|v| v.id).collect();
    let mut teachers: HashMap<i64, Vec<UserInfo>> = HashMap::new();
    let mut students: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut assistants: HashMap<i64, Vec<i64>> = HashMap::new();

    for chunk in ids.chunks(1000) {
        let values = ct::table
            .inner_join(u::table)
            .filter(ct::course_id.eq_any(chunk))
            .filter(u::is_active.eq(true))
            .select((
                ct::course_id,
                u::id,
                u::username,
                u::real_name,
                u::role,
                u::password_expired,
            ))
            .order((ct::course_id.asc(), u::username.asc(), u::id.asc()))
            .load::<(i64, i64, String, String, i32, bool)>(conn)
            .await?;

        for (course, id, username, real_name, role, password_expired) in values {
            teachers.entry(course).or_default().push(UserInfo {
                id,
                username,
                real_name,
                role,
                password_expired,
            });
        }

        if include_students {
            let values = cs::table
                .inner_join(u::table)
                .filter(cs::course_id.eq_any(chunk))
                .filter(u::is_active.eq(true))
                .select((cs::course_id, cs::user_id))
                .order((cs::course_id.asc(), cs::user_id.asc()))
                .load::<(i64, i64)>(conn)
                .await?;
            for (course, user) in values {
                students.entry(course).or_default().push(user);
            }
        }

        let values = ca::table
            .inner_join(u::table)
            .filter(ca::course_id.eq_any(chunk))
            .filter(u::is_active.eq(true))
            .select((ca::course_id, ca::user_id))
            .order((ca::course_id.asc(), ca::user_id.asc()))
            .load::<(i64, i64)>(conn)
            .await?;

        for (course, user) in values {
            assistants.entry(course).or_default().push(user);
        }
    }

    Ok(rows
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
            created_at: row.created_at.and_utc(),
            updated_at: row.updated_at.and_utc(),
            teachers: teachers.remove(&row.id).unwrap_or_default(),
            students: students.remove(&row.id).unwrap_or_default(),
            assistants: assistants.remove(&row.id).unwrap_or_default(),
            last_3_assignments: None,
        })
        .collect())
}

async fn response(conn: &mut AsyncMysqlConnection, id: i64) -> Result<CourseResponse> {
    let row = c::table
        .find(id)
        .select(Course::as_select())
        .first::<Course>(conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::NotFound("Course not found".into()))?;
    Ok(responses(conn, vec![row], true).await?.remove(0))
}

async fn list(
    cache: ReadCache,
    user: CurrentUser,
    Db(mut conn): Db,
    Query(query): Query<ListQuery>,
) -> Result<Response> {
    if user.role < 0 {
        return Err(AppError::Authorization("Invalid user role".into()));
    }
    let key = format!("courses:list:{}:{}:{}", user.id, user.role, query.all);
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let rows = fetch(&mut conn, &user, query.all).await?;
    let result = responses(&mut conn, rows, true).await?;
    cache.json(&key, &result, None).await
}

async fn get_one(
    cache: ReadCache,
    user: CurrentUser,
    CourseAccess(CourseContext { mut conn, id, .. }): CourseAccess,
) -> Result<Response> {
    let key = format!("courses:detail:{}:{}:{}", id, user.id, user.role);
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let result = response(&mut conn, id).await?;
    cache.json(&key, &result, None).await
}

async fn recent(cache: ReadCache, user: CurrentUser, Db(mut conn): Db) -> Result<Response> {
    if user.role < 0 {
        return Err(AppError::Authorization("Invalid user role".into()));
    }
    let key = format!("courses:recent:{}:{}:false", user.id, user.role);
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let rows = fetch(&mut conn, &user, false).await?;
    let ids: Vec<_> = rows.iter().map(|v| v.id).collect();
    let mut recent: HashMap<i64, Vec<AssignmentResponse>> = HashMap::new();
    let now = Utc::now().naive_utc();
    let valid_until = if cache.enabled() {
        crate::academic::assignments::next_boundary(&mut conn, &ids, now).await?
    } else {
        None
    };

    for chunk in ids.chunks(1000) {
        let rank = diesel::dsl::row_number()
            .partition_by(assignments::course_id)
            .window_order((assignments::due_time.desc(), assignments::id.desc()));
        let selected = assignments::table
            .filter(assignments::course_id.eq_any(chunk))
            .filter(assignments::published.eq(true))
            .filter(assignments::start_time.le(now))
            .select((assignments::id, assignments::course_id, RankColumn(rank)));
        let values = RecentAssignments {
            ranked: selected,
            selection: Assignment::as_select(),
        }
        .load::<Assignment>(&mut conn)
        .await?;

        for row in values {
            recent
                .entry(row.course_id)
                .or_default()
                .push(row.response(None, now));
        }
    }

    let rows = responses(&mut conn, rows, false).await?;
    let result: Vec<_> = rows
        .into_iter()
        .map(|row| RecentCourse {
            id: row.id,
            title: row.title,
            teachers: row.teachers,
            recent_assignments: recent.remove(&row.id).unwrap_or_default(),
            year: row.year,
            term: row.term,
            assistants: row.assistants,
        })
        .collect();
    cache.json(&key, &result, valid_until).await
}

fn validate(title: Option<&str>, year: Option<i32>, term: Option<i32>) -> Result<()> {
    if title.is_some_and(|v| v.chars().count() > 60)
        || year.is_some_and(|v| !(2017..=2099).contains(&v))
        || term.is_some_and(|v| !(0..=2).contains(&v))
    {
        return Err(AppError::Validation(
            "Invalid course title, academic year or term".into(),
        ));
    }

    Ok(())
}

async fn validate_members(
    conn: &mut AsyncMysqlConnection,
    teachers: Option<&[i64]>,
    students: Option<&[i64]>,
    assistants: Option<&[i64]>,
    creator: Option<i64>,
) -> Result<Vec<i64>> {
    let mut ids: Vec<_> = teachers
        .into_iter()
        .chain(students)
        .chain(assistants)
        .flat_map(|v| v.iter().copied())
        .chain(creator)
        .collect();
    ids.sort_unstable();
    // Lock the creator and all requested members together in global user-ID order.
    ids.dedup();
    let mut roles = HashMap::new();

    for chunk in ids.chunks(1000) {
        let rows = u::table
            .filter(u::id.eq_any(chunk))
            .select((u::id, u::role, u::is_active))
            .order(u::id.asc())
            .for_update()
            .load::<(i64, i32, bool)>(conn)
            .await?;

        for (id, role, active) in rows {
            roles.insert(id, (role, active));
        }
    }

    if let Some(id) = creator {
        match roles.get(&id) {
            Some((1..=2, true)) => {}
            _ => return Err(AppError::Authorization("Super administrator role required".into())),
        }
    }
    if roles.values().any(|(_, active)| !active) {
        return Err(AppError::BadRequest(
            "Course members must be active users".into(),
        ));
    }

    for (members, teacher) in [(teachers, true), (students, false), (assistants, false)] {
        if let Some(members) = members {
            for id in members {
                match roles.get(id) {
                    Some((role, _)) if (teacher && *role >= 1) || (!teacher && *role == 0) => {}
                    _ => {
                        return Err(AppError::BadRequest(
                            "Course member does not exist or has the wrong role".into(),
                        ));
                    }
                }
            }
        }
    }

    let mut real_teachers: Vec<_> = teachers
        .unwrap_or_default()
        .iter()
        .copied()
        .filter(|id| matches!(roles.get(id), Some((1..=2, true))))
        .collect();
    if let Some(id) = creator.filter(|id| roles.get(id) == Some(&(1, true))) {
        real_teachers.push(id);
    }
    real_teachers.sort_unstable();
    real_teachers.dedup();
    Ok(real_teachers)
}

async fn replace_teachers(conn: &mut AsyncMysqlConnection, course: i64, ids: &[i64]) -> Result<()> {
    diesel::delete(
        ct::table
            .filter(ct::course_id.eq(course))
            .filter(ct::user_id.ne_all(ids)),
    )
    .execute(conn)
    .await?;

    for chunk in ids.chunks(1000) {
        let rows: Vec<_> = chunk
            .iter()
            .map(|id| (ct::course_id.eq(course), ct::user_id.eq(id)))
            .collect();
        diesel::insert_into(ct::table)
            .values(rows)
            .on_conflict(diesel::dsl::DuplicatedKeys)
            .do_update()
            .set(ct::course_id.eq(course))
            .execute(conn)
            .await?;
    }

    Ok(())
}

async fn replace_students(conn: &mut AsyncMysqlConnection, course: i64, ids: &[i64]) -> Result<()> {
    diesel::delete(
        cs::table
            .filter(cs::course_id.eq(course))
            .filter(cs::user_id.ne_all(ids)),
    )
    .execute(conn)
    .await?;

    for chunk in ids.chunks(1000) {
        let rows: Vec<_> = chunk
            .iter()
            .map(|id| (cs::course_id.eq(course), cs::user_id.eq(id)))
            .collect();
        diesel::insert_into(cs::table)
            .values(rows)
            .on_conflict(diesel::dsl::DuplicatedKeys)
            .do_update()
            .set(cs::course_id.eq(course))
            .execute(conn)
            .await?;
    }

    Ok(())
}

async fn replace_assistants(
    conn: &mut AsyncMysqlConnection,
    course: i64,
    ids: &[i64],
) -> Result<()> {
    diesel::delete(
        ca::table
            .filter(ca::course_id.eq(course))
            .filter(ca::user_id.ne_all(ids)),
    )
    .execute(conn)
    .await?;

    for chunk in ids.chunks(1000) {
        let rows: Vec<_> = chunk
            .iter()
            .map(|id| (ca::course_id.eq(course), ca::user_id.eq(id)))
            .collect();
        diesel::insert_into(ca::table)
            .values(rows)
            .on_conflict(diesel::dsl::DuplicatedKeys)
            .do_update()
            .set(ca::course_id.eq(course))
            .execute(conn)
            .await?;
    }

    Ok(())
}

async fn create(
    State(state): State<AppState>,
    Teacher(user): Teacher,
    headers: HeaderMap,
    database: Database,
    Json(mut request): Json<CreateCourse>,
) -> Result<(StatusCode, Json<CourseResponse>)> {
    validate(Some(&request.title), request.year, request.term)?;
    if user.role == 1 {
        if !request.teacher_ids.is_empty() && request.teacher_ids != vec![user.id] {
            return Err(AppError::Authorization("Teachers may open their own classes only".into()));
        }
        request.teacher_ids = vec![user.id];
    }

    let mut conn = database.connect().await?;
    let result = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let teachers = validate_members(
                conn,
                Some(&request.teacher_ids),
                Some(&request.student_ids),
                Some(&request.assistant_ids),
                Some(user.id),
            )
            .await?;

            let now = Utc::now();
            let year = request
                .year
                .unwrap_or(now.year() - i32::from(now.month() < 7));
            let term = request.term.unwrap_or(match now.month() {
                1..=6 => 0,
                7..=8 => 1,
                _ => 2,
            });

            diesel::insert_into(c::table)
                .values((
                    c::title.eq(&request.title),
                    c::year.eq(year),
                    c::term.eq(term),
                    c::created_at.eq(now.naive_utc()),
                    c::updated_at.eq(now.naive_utc()),
                ))
                .execute(conn)
                .await?;
            let id = diesel::select(last_insert_id())
                .get_result::<i64>(conn)
                .await?;

            replace_teachers(conn, id, &teachers).await?;
            replace_students(conn, id, &request.student_ids).await?;
            replace_assistants(conn, id, &request.assistant_ids).await?;

            let result = response(conn, id).await?;
            crate::identity::hoj::sync_course(&state, &headers, conn, id, &result.title, result.year, result.term).await?;
            audit::record(
                conn,
                &user,
                "CREATE",
                "course",
                Some(id),
                &request.title,
                (None, Some(serde_json::json!(result))),
            )
            .await?;
            cache::invalidate_auth(conn).await?;
            Ok(result)
        })
        .await?;

    Ok((StatusCode::CREATED, Json(result)))
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    database: Database,
    Path(id): Path<i64>,
    Json(request): Json<UpdateCourse>,
) -> Result<Json<CourseResponse>> {
    validate(request.title.as_deref(), request.year, request.term)?;

    let mut conn = database.connect().await?;
    let result = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock(conn, id).await?;
            permissions::require(conn, &user, id, Permission::Manage).await?;

            if request.title.is_some() || request.year.is_some() || request.term.is_some()
                || request.teacher_ids.is_some() {
                permissions::require(conn, &user, id, Permission::Administer).await?;
            }

            let old = response(conn, id).await?;
            let teachers = validate_members(
                conn,
                request.teacher_ids.as_deref(),
                request.student_ids.as_deref(),
                request.assistant_ids.as_deref(),
                None,
            )
            .await?;

            if request.title.is_some() || request.year.is_some() || request.term.is_some() {
                diesel::update(c::table.find(id))
                    .set((
                        request.title.as_ref().map(|v| c::title.eq(v)),
                        request.year.map(|v| c::year.eq(v)),
                        request.term.map(|v| c::term.eq(v)),
                        c::updated_at.eq(Utc::now().naive_utc()),
                    ))
                    .execute(conn)
                    .await?;
            }

            if request.teacher_ids.is_some() {
                replace_teachers(conn, id, &teachers).await?;
            }
            if let Some(ids) = request.student_ids {
                replace_students(conn, id, &ids).await?;
            }
            if let Some(ids) = request.assistant_ids {
                replace_assistants(conn, id, &ids).await?;
            }

            let result = response(conn, id).await?;
            crate::identity::hoj::sync_course(&state, &headers, conn, id, &result.title, result.year, result.term).await?;
            audit::record(
                conn,
                &user,
                "UPDATE",
                "course",
                Some(id),
                &result.title,
                (
                    Some(serde_json::json!(old)),
                    Some(serde_json::json!(result)),
                ),
            )
            .await?;
            cache::invalidate_auth(conn).await?;
            Ok(result)
        })
        .await?;

    Ok(Json(result))
}

async fn delete(State(state): State<AppState>, user: CurrentUser, headers: HeaderMap,
    Db(mut conn): Db, Path(id): Path<i64>) -> Result<StatusCode> {
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock(conn, id).await?;
            permissions::require(conn, &user, id, Permission::Administer).await?;

            let old = response(conn, id).await?;
            crate::identity::hoj::delete_course(&state, &headers, conn, id).await?;
            diesel::delete(c::table.find(id)).execute(conn).await?;
            audit::record(
                conn,
                &user,
                "DELETE",
                "course",
                Some(id),
                &old.title,
                (Some(serde_json::json!(old)), None),
            )
            .await?;
            cache::invalidate_auth(conn).await?;
            Ok(())
        })
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
