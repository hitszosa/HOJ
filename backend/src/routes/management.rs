//! Authoritative, cookie-authenticated snapshot for the local grading service.
use axum::{Router, extract::State, http::{HeaderMap, header::ORIGIN}, routing::{get, post}};
use serde::{Serialize, Deserialize};
use sqlx::{MySql, QueryBuilder};
use crate::{auth::Identity, error::{AppError, AppResult}, extract::{Json, Path}, response::{ApiOk, Empty, ok}, state::AppState};
use super::session::{self, PortalRole};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/management/context", get(context))
        .route("/api/management/users", post(provision_user))
        .route("/api/management/courses", post(sync_course))
        .route("/api/management/courses/{oid}/archive", post(archive_course))
        .route("/api/management/courses/{oid}/delete", post(delete_course))
}

#[derive(Deserialize)]
struct ArchiveCourse { management_id: i64 }

/// Deleting a management course retires its programming class; retain assessed work.
async fn archive_course(State(s): State<AppState>, who: Identity, headers: HeaderMap,
    Path(oid): Path<u32>, Json(body): Json<ArchiveCourse>) -> AppResult<ApiOk<Empty>> {
    if !who.is_admin() { return Err(AppError::forbidden("只有超级管理员可以删除课程")); }
    if !headers.get(ORIGIN).and_then(|v| v.to_str().ok()).is_some_and(|o| s.cfg.allowed_origins.iter().any(|v| v == o)) {
        return Err(AppError::forbidden("跨站请求被拒绝"));
    }
    if body.management_id <= 0 { return Err(AppError::validation("课程关联无效")); }
    let mut tx = s.db.begin().await?;
    let code = sqlx::query_scalar::<_, String>("SELECT c.code FROM cm_offering o JOIN cm_course c USING(course_id) WHERE o.offering_id=? FOR UPDATE")
        .bind(oid).fetch_optional(&mut *tx).await?.ok_or_else(|| AppError::not_found("教学班不存在"))?;
    if code.starts_with("MGMT-") && code != format!("MGMT-{}", body.management_id) {
        return Err(AppError::conflict("课程关联不一致，已取消删除"));
    }
    sqlx::query("UPDATE cm_offering SET status='archived',updated_at=NOW() WHERE offering_id=? AND status!='archived'")
        .bind(oid).execute(&mut *tx).await?;
    sqlx::query("UPDATE cm_batch SET status='closed',updated_at=NOW() WHERE offering_id=? AND status!='closed'")
        .bind(oid).execute(&mut *tx).await?;
    sqlx::query("UPDATE cm_enrollment SET status='dropped',updated_at=NOW() WHERE offering_id=? AND status!='dropped'")
        .bind(oid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(ok(Empty {}))
}

async fn delete_course(State(s): State<AppState>, who: Identity, headers: HeaderMap,
    Path(oid): Path<u32>, Json(body): Json<ArchiveCourse>) -> AppResult<ApiOk<Empty>> {
    if !who.is_admin() { return Err(AppError::forbidden("只有超级管理员可以删除课程")); }
    if !headers.get(ORIGIN).and_then(|v| v.to_str().ok()).is_some_and(|o| s.cfg.allowed_origins.iter().any(|v| v == o)) {
        return Err(AppError::forbidden("跨站请求被拒绝"));
    }
    if body.management_id <= 0 { return Err(AppError::validation("课程关联无效")); }
    Ok(ok(crate::course_deletion::remove(&s,oid,body.management_id).await?))
}

#[derive(Deserialize)]
struct ProvisionUser { username: String, real_name: String, role: i32 }

async fn provision_user(State(s): State<AppState>, who: Identity, headers: HeaderMap,
    Json(body): Json<ProvisionUser>) -> AppResult<ApiOk<super::account::Account>> {
    if !crate::access::is_teacher(&s.db, &who).await? || (body.role != 0 && !who.is_admin()) {
        return Err(AppError::forbidden("教师只能创建学生，教师账号由管理员创建"));
    }
    let (_, account) = super::account::exchange(&s, &headers, "provision", serde_json::json!({
        "username":body.username, "real_name":body.real_name, "role":body.role
    })).await?;
    Ok(ok(account))
}

#[derive(Deserialize)]
struct SyncCourse {
    management_id: i64, offering_id: Option<u32>, title: String, year: i32, term: i32,
    teacher_ids: Vec<String>, student_ids: Vec<String>, assistant_ids: Vec<String>,
}
#[derive(Serialize)]
struct SyncedCourse { offering_id: u32 }

async fn sync_course(State(s): State<AppState>, who: Identity, headers: HeaderMap,
    Json(body): Json<SyncCourse>) -> AppResult<ApiOk<SyncedCourse>> {
    if !headers.get(ORIGIN).and_then(|v| v.to_str().ok()).is_some_and(|o| s.cfg.allowed_origins.iter().any(|v| v == o)) {
        return Err(AppError::forbidden("跨站请求被拒绝"));
    }
    if !crate::access::is_teacher(&s.db, &who).await? { return Err(AppError::forbidden("仅教师可管理班级")); }
    if body.management_id <= 0 || body.title.trim().is_empty() || body.title.chars().count() > 60
        || !(2019..=2100).contains(&body.year) || !(0..=2).contains(&body.term)
        || body.teacher_ids.is_empty() || body.student_ids.len() + body.assistant_ids.len() > 10000 {
        return Err(AppError::validation("课程或名单格式不合法"));
    }
    if !who.is_admin() && body.teacher_ids != vec![who.user.clone()] && body.offering_id.is_none() {
        return Err(AppError::forbidden("教师仅可为自己开班"));
    }
    let oid = if let Some(oid) = body.offering_id {
        crate::access::offering_access(&s.db, &who, oid, crate::access::Need::TEACH_WRITE).await?;
        oid
    } else {
        let code = format!("MGMT-{}", body.management_id);
        let existing = sqlx::query_as::<_,(u32,)>("SELECT o.offering_id FROM cm_offering o JOIN cm_course c USING(course_id) WHERE c.code=?")
            .bind(&code).fetch_optional(&s.db).await?;
        if let Some((oid,)) = existing {
            crate::access::offering_access(&s.db, &who, oid, crate::access::Need::TEACH_WRITE).await?;
            oid
        } else {
            let mut tx = s.db.begin().await?;
            let cid = sqlx::query("INSERT INTO cm_course(code,name,created_at,updated_at) VALUES(?,?,NOW(),NOW())")
                .bind(code).bind(&body.title).execute(&mut *tx).await?.last_insert_id();
            let oid = sqlx::query("INSERT INTO cm_offering(course_id,term,section,title,teacher_id,status,created_at,updated_at) VALUES(?,?,'01',?,?,'active',NOW(),NOW())")
                .bind(cid).bind(format!("{}-{}",body.year,["春","夏","秋"][body.term as usize]))
                .bind(&body.title).bind(&body.teacher_ids[0]).execute(&mut *tx).await?.last_insert_id() as u32;
            tx.commit().await?;
            oid
        }
    };
    // A roster replacement never grants new teacher membership. Only the administrator
    // may configure teachers; an assigned teacher can replace students and assistants.
    let mut tx = s.db.begin().await?;
    let status = sqlx::query_scalar::<_, String>("SELECT status FROM cm_offering WHERE offering_id=? FOR UPDATE")
        .bind(oid).fetch_optional(&mut *tx).await?;
    if status.as_deref() != Some("active") {
        return Err(AppError::conflict("教学班已关闭，不能更新名单"));
    }
    for uid in body.student_ids.iter().chain(&body.assistant_ids) {
        if !crate::auth::is_valid_user_id(uid) { return Err(AppError::validation("学生账号不合法")); }
        let active = sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM jol.users WHERE user_id=? AND defunct='N' AND NOT EXISTS(SELECT 1 FROM jol.privilege p WHERE p.user_id=jol.users.user_id AND p.rightstr IN ('teacher','administrator'))")
            .bind(uid).fetch_one(&mut *tx).await?;
        if active != 1 { return Err(AppError::validation("学生或助教账号不存在、已停用或角色错误")); }
    }
    sqlx::query("UPDATE cm_enrollment SET status='dropped',updated_at=NOW() WHERE offering_id=? AND role IN ('student','ta')")
        .bind(oid).execute(&mut *tx).await?;
    for (members,role) in [(&body.student_ids,"student"),(&body.assistant_ids,"ta")] {
        for uid in members {
            sqlx::query("INSERT INTO cm_enrollment(offering_id,user_id,role,student_no,status,created_at,updated_at) VALUES(?,?,?,?,'active',NOW(),NOW()) ON DUPLICATE KEY UPDATE role=VALUES(role),status='active',updated_at=NOW()")
                .bind(oid).bind(uid).bind(role).bind(uid).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(ok(SyncedCourse{offering_id:oid}))
}

#[derive(Serialize)]
struct Member { username: String, real_name: String, role: String }
#[derive(Serialize)]
struct Course { offering_id: u32, title: String, year: i32, term: i32, members: Vec<Member> }
#[derive(Serialize)]
struct Context { username: String, role: i32, courses: Vec<Course> }

async fn context(State(s): State<AppState>, who: Identity) -> AppResult<ApiOk<Context>> {
    let me = session::me(State(s.clone()), who.clone()).await?.0;
    let role = if me.roles.contains(&PortalRole::Admin) { 2 }
        else if me.roles.contains(&PortalRole::Teacher) { 1 } else { 0 };
    let mut courses = Vec::new();
    // Only teachers import whole rosters. Students and assistants cannot enumerate other classes.
    if role >= 1 {
        let mut q = QueryBuilder::<MySql>::new(
            "SELECT o.offering_id, CONCAT(c.name,' · ',o.section,'班'), o.term FROM cm_offering o JOIN cm_course c ON c.course_id=o.course_id WHERE o.status='active' AND ("
        );
        q.push_bind(&who.user).push("='admin' OR o.teacher_id=").push_bind(&who.user)
            .push(" OR EXISTS(SELECT 1 FROM cm_enrollment e WHERE e.offering_id=o.offering_id AND e.user_id=")
            .push_bind(&who.user).push(" AND e.role='teacher' AND e.status='active')) ORDER BY o.offering_id");
        let rows = q.build_query_as::<(u32, String, String)>().fetch_all(&s.db).await?;
        for (oid, title, semester) in rows {
            let mut q = QueryBuilder::<MySql>::new(
                "SELECT o.teacher_id, COALESCE(NULLIF(u.nick,''),o.teacher_id), 'teacher' FROM cm_offering o LEFT JOIN jol.users u ON u.user_id=o.teacher_id COLLATE utf8mb4_general_ci WHERE o.offering_id="
            );
            q.push_bind(oid).push(" UNION SELECT e.user_id, COALESCE(NULLIF(u.nick,''),e.user_id), e.role FROM cm_enrollment e LEFT JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci WHERE e.status='active' AND e.offering_id=").push_bind(oid);
            let members = q.build_query_as::<(String, String, String)>().fetch_all(&s.db).await?
                .into_iter().map(|(username, real_name, role)| Member {username,real_name,role}).collect();
            let year = semester.get(..4).and_then(|s| s.parse().ok()).unwrap_or(2026);
            let term = if semester.contains('春') { 0 } else if semester.contains('夏') { 1 } else { 2 };
            courses.push(Course { offering_id:oid, title:title.chars().take(60).collect(), year, term, members });
        }
    }
    Ok(ok(Context {username:who.user,role,courses}))
}
