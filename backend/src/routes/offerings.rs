//! 课程与教学班：列表、班级详情与学情、学生名单管理、开班与班级设置。

use std::{collections::HashMap, sync::LazyLock};

use axum::{
    Router,
    extract::State,
    routing::{delete, get, post},
};
use chrono::NaiveDateTime;
use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    access::{Batch, Need, Offering, Role, offering_access, offering_batches},
    auth::Identity,
    error::{AppError, AppResult},
    extract::{Json, Path},
    hustoj,
    response::{ApiOk, Empty, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/courses", get(courses))
        .route("/api/courses/{cid}/offerings", post(create_offering))
        .route("/api/offerings/{oid}", get(offering).patch(update_offering))
        .route("/api/offerings/{oid}/insights", get(insights))
        .route("/api/offerings/{oid}/students", get(students).post(add_students))
        .route("/api/offerings/{oid}/students/{uid}", delete(drop_student))
}

fn pct(part: i64, total: i64) -> f64 {
    if total > 0 { (part as f64 / total as f64 * 1000.0).round() / 10.0 } else { 0.0 }
}

// ---------------------------------------------------------------- GET /api/courses

#[derive(Serialize, TS)]
#[ts(export)]
pub struct CourseOffering {
    pub course_id: u32,
    pub code: String,
    pub name: String,
    pub credit: Option<f64>,
    pub hoa_repo: Option<String>,
    pub offering_id: u32,
    pub term: String,
    pub section: String,
    pub title: Option<String>,
    pub status: String,
    pub teacher_id: String,
    pub role: Option<Role>,
}

/// 当前用户参与的全部教学班（管理员为全部）。
async fn courses(State(s): State<AppState>, who: Identity) -> AppResult<ApiOk<Vec<CourseOffering>>> {
    let rows = sqlx::query!(
        r#"SELECT c.course_id, c.code, c.name, CAST(c.credit AS DOUBLE) AS credit, c.hoa_repo,
                  o.offering_id, o.term, o.section, o.title, o.status, o.teacher_id,
                  CASE WHEN o.teacher_id=? OR ?='admin' THEN 'teacher' ELSE e.role END AS "role?: String"
           FROM cm_course c JOIN cm_offering o ON o.course_id=c.course_id
           LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id=? AND e.status='active'
           WHERE ?='admin' OR o.teacher_id=? OR e.user_id IS NOT NULL
           ORDER BY o.term DESC, c.code"#,
        who.user, who.user, who.user, who.user, who.user
    )
    .fetch_all(&s.db)
    .await?;
    Ok(ok(rows
        .into_iter()
        .map(|r| CourseOffering {
            course_id: r.course_id,
            code: r.code,
            name: r.name,
            credit: r.credit,
            hoa_repo: r.hoa_repo,
            offering_id: r.offering_id,
            term: r.term,
            section: r.section,
            title: r.title,
            status: r.status,
            teacher_id: r.teacher_id,
            role: r.role.as_deref().and_then(Role::parse),
        })
        .collect()))
}

// ---------------------------------------------------------------- GET /api/offerings/{oid}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct BatchSummary {
    #[serde(flatten)]
    pub batch: Batch,
    #[ts(type = "number")]
    pub problem_count: i64,
    /// 当前用户已通过的题数。
    #[ts(type = "number")]
    pub done: i64,
    #[ts(type = "number")]
    pub student_count: i64,
    /// 以下仅教师 / 助教可见。
    pub staff: Option<BatchStaffStats>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct BatchStaffStats {
    #[ts(type = "number")]
    pub submitted_count: i64,
    #[ts(type = "number")]
    pub completed_count: i64,
    pub submission_rate: f64,
    pub completion_rate: f64,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct StudentStat {
    pub user_id: String,
    pub nick: String,
    pub student_no: Option<String>,
    #[ts(type = "number")]
    pub passed: i64,
    #[ts(type = "number")]
    pub attempts: i64,
    #[serde(with = "crate::dt::opt")]
    #[ts(type = "string | null")]
    pub last_active: Option<NaiveDateTime>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct ResultCount {
    pub result: i16,
    pub label: &'static str,
    #[ts(type = "number")]
    pub count: i64,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct OfferingInsights {
    pub students: Vec<StudentStat>,
    pub results: Vec<ResultCount>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct OfferingDetail {
    pub offering: Offering,
    pub batches: Vec<BatchSummary>,
    #[ts(type = "number")]
    pub total_students: i64,
    /// 仅教师 / 助教可见。
    pub insights: Option<OfferingInsights>,
}

async fn student_count(s: &AppState, oid: u32) -> AppResult<i64> {
    Ok(sqlx::query_scalar!("SELECT COUNT(*) FROM cm_enrollment WHERE offering_id=? AND role='student' AND status='active'", oid)
        .fetch_one(&s.db)
        .await?)
}

async fn student_stats(s: &AppState, oid: u32) -> AppResult<Vec<StudentStat>> {
    let rows = sqlx::query_as!(
        StudentStat,
        r#"SELECT e.user_id, COALESCE(NULLIF(u.nick,''), e.user_id) AS "nick!: String", e.student_no,
                  COUNT(DISTINCT CASE WHEN s.result=4 THEN s.problem_id END) AS "passed!: i64",
                  COUNT(s.solution_id) AS "attempts!: i64", MAX(s.in_date) AS "last_active?: NaiveDateTime"
           FROM cm_enrollment e
           LEFT JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci
           LEFT JOIN cm_submission cs ON cs.offering_id=e.offering_id AND cs.user_id=e.user_id
           LEFT JOIN jol.solution s ON s.solution_id=cs.submission_id
           WHERE e.offering_id=? AND e.role='student' AND e.status='active'
           GROUP BY e.user_id, u.nick, e.student_no
           ORDER BY 4 DESC, 5 ASC"#,
        oid
    )
    .fetch_all(&s.db)
    .await?;
    Ok(rows)
}

async fn result_counts(s: &AppState, oid: u32) -> AppResult<Vec<ResultCount>> {
    let rows = sqlx::query!(
        r#"SELECT s.result, COUNT(*) AS "count!: i64" FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id
           WHERE cs.offering_id=? GROUP BY s.result"#,
        oid
    )
    .fetch_all(&s.db)
    .await?;
    Ok(rows.into_iter().map(|r| ResultCount { result: r.result, label: hustoj::result_label(r.result), count: r.count }).collect())
}

async fn offering(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>) -> AppResult<ApiOk<OfferingDetail>> {
    let off = offering_access(&s.db, &who, oid, Need::READ).await?;
    let student = off.role == Role::Student;
    // 题单与统计各一次查询，按 batch_id 合并，避免逐题单 N+1。学生只看已开放题单与已放开的题目。
    let list = offering_batches(&s.db, oid, student).await?;
    let stats: HashMap<u32, (i64, i64, i64)> = sqlx::query!(
        r#"SELECT b.batch_id,
                  (SELECT COUNT(*) FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id)
                    WHERE bp.batch_id=b.batch_id AND (? = 0 OR p.defunct='N')) AS "problem_count!: i64",
                  (SELECT COUNT(DISTINCT s.problem_id) FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id
                    JOIN jol.problem p ON p.problem_id=s.problem_id
                    WHERE cs.batch_id=b.batch_id AND cs.user_id=? AND s.result=4 AND p.defunct='N') AS "done!: i64",
                  (SELECT COUNT(DISTINCT cs.user_id) FROM cm_submission cs WHERE cs.batch_id=b.batch_id) AS "submitted!: i64"
           FROM cm_batch b WHERE b.offering_id=?"#,
        student as i8,
        who.user,
        oid
    )
    .fetch_all(&s.db)
    .await?
    .into_iter()
    .map(|r| (r.batch_id, (r.problem_count, r.done, r.submitted)))
    .collect();
    let total = student_count(&s, oid).await?;
    let completed: HashMap<u32, i64> = if off.role.is_staff() {
        // 完成人数：通过题数 ≥ 题单题数的学生数。
        sqlx::query!(
            r#"SELECT t.batch_id AS "batch_id!: u32", COUNT(*) AS "n!: i64" FROM (
                 SELECT cs.batch_id, cs.user_id, COUNT(DISTINCT s.problem_id) AS passed
                 FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id
                 JOIN cm_batch_problem bp ON bp.batch_id=cs.batch_id AND bp.problem_id=s.problem_id
                 WHERE cs.offering_id=? AND s.result=4 GROUP BY cs.batch_id, cs.user_id) t
               JOIN (SELECT batch_id, COUNT(*) AS total FROM cm_batch_problem GROUP BY batch_id) q ON q.batch_id=t.batch_id
               WHERE t.passed >= q.total GROUP BY t.batch_id"#,
            oid
        )
        .fetch_all(&s.db)
        .await?
        .into_iter()
        .map(|r| (r.batch_id, r.n))
        .collect()
    } else {
        HashMap::new()
    };
    let batches = list
        .into_iter()
        .map(|batch| {
            let (problem_count, done, submitted) = stats.get(&batch.batch_id).copied().unwrap_or_default();
            let staff = off.role.is_staff().then(|| {
                let completed = completed.get(&batch.batch_id).copied().unwrap_or(0);
                BatchStaffStats {
                    submitted_count: submitted,
                    completed_count: completed,
                    submission_rate: pct(submitted, total),
                    completion_rate: pct(completed, total),
                }
            });
            BatchSummary { batch, problem_count, done, student_count: total, staff }
        })
        .collect();
    let insights = if off.role.is_staff() {
        Some(OfferingInsights { students: student_stats(&s, oid).await?, results: result_counts(&s, oid).await? })
    } else {
        None
    };
    Ok(ok(OfferingDetail { offering: off, batches, total_students: total, insights }))
}

// ---------------------------------------------------------------- GET /api/offerings/{oid}/insights

#[derive(Serialize, TS)]
#[ts(export)]
pub struct InsightsResponse {
    pub offering: Offering,
    pub students: Vec<StudentStat>,
    pub results: Vec<ResultCount>,
    pub source: &'static str,
}

async fn insights(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>) -> AppResult<ApiOk<InsightsResponse>> {
    let off = offering_access(&s.db, &who, oid, Need::READ).await?;
    if !off.role.is_staff() {
        return Err(AppError::forbidden("仅任课教师与助教可查看班级学情"));
    }
    Ok(ok(InsightsResponse {
        students: student_stats(&s, oid).await?,
        results: result_counts(&s, oid).await?,
        offering: off,
        source: "HUSTOJ 实际提交，按结果码统计",
    }))
}

// ---------------------------------------------------------------- 学生名单

#[derive(Serialize, TS)]
#[ts(export)]
pub struct EnrolledStudent {
    pub enrollment_id: u32,
    pub offering_id: u32,
    pub user_id: String,
    pub role: String,
    pub student_no: Option<String>,
    pub status: String,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub created_at: NaiveDateTime,
    pub nick: String,
    pub school: String,
    #[ts(type = "number")]
    pub passed: i64,
    #[ts(type = "number")]
    pub attempts: i64,
    #[serde(with = "crate::dt::opt")]
    #[ts(type = "string | null")]
    pub last_active: Option<NaiveDateTime>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct StudentsResponse {
    pub offering: Offering,
    pub students: Vec<EnrolledStudent>,
}

async fn students(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>) -> AppResult<ApiOk<StudentsResponse>> {
    let off = offering_access(&s.db, &who, oid, Need::TEACH).await?;
    let students = sqlx::query_as!(
        EnrolledStudent,
        r#"SELECT e.enrollment_id, e.offering_id, e.user_id, e.role, e.student_no, e.status, e.created_at,
                  COALESCE(NULLIF(u.nick,''), e.user_id) AS "nick!: String", COALESCE(NULLIF(u.school,''), 'HITSZ') AS "school!: String",
                  COUNT(DISTINCT CASE WHEN s.result=4 THEN s.problem_id END) AS "passed!: i64",
                  COUNT(s.solution_id) AS "attempts!: i64", MAX(s.in_date) AS "last_active?: NaiveDateTime"
           FROM cm_enrollment e
           LEFT JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci
           LEFT JOIN cm_submission cs ON cs.offering_id=e.offering_id AND cs.user_id=e.user_id
           LEFT JOIN jol.solution s ON s.solution_id=cs.submission_id
           WHERE e.offering_id=?
           GROUP BY e.enrollment_id, e.offering_id, e.user_id, e.role, e.student_no, e.status, e.created_at, u.nick, u.school
           ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.student_no ASC, e.user_id ASC"#,
        oid
    )
    .fetch_all(&s.db)
    .await?;
    Ok(ok(StudentsResponse { offering: off, students }))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct StudentEntry {
    #[serde(default)]
    #[ts(optional)]
    pub user_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub student_no: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub nick: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub role: Option<String>,
    /// 批量粘贴：每行 `账号[,学号[,昵称]]`，分隔符可为逗号、制表符或空白。
    #[serde(default)]
    #[ts(optional)]
    pub raw_text: Option<String>,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct AddStudentsRequest {
    pub students: Vec<StudentEntry>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct AddStudentsResponse {
    pub count: usize,
}

static ENROLL_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]{1,48}$").unwrap());
static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[,，\t\s]+").unwrap());

struct NewStudent {
    user_id: String,
    student_no: String,
    nick: String,
    role: &'static str,
}

fn enrollment_role(r: Option<&str>) -> &'static str {
    match r {
        Some("ta") => "ta",
        Some("teacher") => "teacher",
        _ => "student",
    }
}

fn expand(entries: Vec<StudentEntry>) -> Vec<NewStudent> {
    let mut out = Vec::new();
    for e in entries {
        let role = enrollment_role(e.role.as_deref());
        if let Some(text) = &e.raw_text {
            for line in text.lines() {
                let parts: Vec<&str> = SPLIT.split(line.trim()).filter(|p| !p.is_empty()).collect();
                let Some(uid) = parts.first() else { continue };
                out.push(NewStudent {
                    user_id: (*uid).to_owned(),
                    student_no: parts.get(1).unwrap_or(uid).to_string(),
                    nick: parts.get(2).unwrap_or(uid).to_string(),
                    role,
                });
            }
            continue;
        }
        let clean = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        let (uid, no, nick) = (clean(e.user_id), clean(e.student_no), clean(e.nick));
        if let Some(uid) = uid.or_else(|| no.clone()) {
            out.push(NewStudent { student_no: no.unwrap_or_else(|| uid.clone()), nick: nick.unwrap_or_else(|| uid.clone()), user_id: uid, role });
        }
    }
    out
}

async fn add_students(
    State(s): State<AppState>,
    who: Identity,
    Path(oid): Path<u32>,
    Json(body): Json<AddStudentsRequest>,
) -> AppResult<ApiOk<AddStudentsResponse>> {
    offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?;
    let entries = expand(body.students);
    if entries.is_empty() {
        return Err(AppError::unprocessable("有效学生名单不能为空"));
    }
    let mut count = 0;
    for st in entries.iter().filter(|st| ENROLL_ID.is_match(&st.user_id)) {
        sqlx::query!(
            "INSERT IGNORE INTO jol.users(user_id,email,ip,nick,school,reg_time) VALUES(?,?,'127.0.0.1',?,'HITSZ',NOW())",
            st.user_id,
            format!("{}@hitsz.edu.cn", st.user_id),
            st.nick
        )
        .execute(&s.ops)
        .await?;
        sqlx::query!(
            "INSERT INTO cm_enrollment(offering_id,user_id,role,student_no,status,created_at,updated_at) VALUES(?,?,?,?,'active',NOW(),NOW())
             ON DUPLICATE KEY UPDATE status='active', role=VALUES(role), student_no=COALESCE(VALUES(student_no),student_no), updated_at=NOW()",
            oid,
            st.user_id,
            st.role,
            st.student_no
        )
        .execute(&s.db)
        .await?;
        count += 1;
    }
    Ok(ok(AddStudentsResponse { count }))
}

async fn drop_student(State(s): State<AppState>, who: Identity, Path((oid, uid)): Path<(u32, String)>) -> AppResult<ApiOk<Empty>> {
    offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?;
    if !ENROLL_ID.is_match(&uid) {
        return Err(AppError::validation("用户标识不合法"));
    }
    sqlx::query!("UPDATE cm_enrollment SET status='dropped', updated_at=NOW() WHERE offering_id=? AND user_id=?", oid, uid)
        .execute(&s.db)
        .await?;
    Ok(ok(Empty {}))
}

// ---------------------------------------------------------------- 开班与设置

static SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_\-\p{Han}]{1,32}$").unwrap());

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CreateOfferingRequest {
    #[serde(default)]
    #[ts(optional)]
    pub term: Option<String>,
    pub section: String,
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub teacher_id: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct CreateOfferingResponse {
    pub offering_id: u32,
}

async fn create_offering(
    State(s): State<AppState>,
    who: Identity,
    Path(cid): Path<u32>,
    Json(body): Json<CreateOfferingRequest>,
) -> AppResult<ApiOk<CreateOfferingResponse>> {
    let course = sqlx::query!("SELECT name FROM cm_course WHERE course_id=?", cid)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| AppError::not_found("课程不存在"))?;
    if !crate::access::is_teacher(&s.db, &who).await? {
        return Err(AppError::forbidden("仅教师或管理员可开设新班级"));
    }
    let trimmed = |v: Option<String>| v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let section = body.section.trim().to_owned();
    if section.is_empty() {
        return Err(AppError::unprocessable("请填写教学班编号（如 01, 02）"));
    }
    if !SECTION.is_match(&section) {
        return Err(AppError::unprocessable("班级编号格式不合法"));
    }
    let term = trimmed(body.term).unwrap_or_else(|| "2026-春".into());
    let title = trimmed(body.title).unwrap_or_else(|| format!("{} {section}班", course.name));
    // 只有管理员可以替他人开班。
    let teacher = match trimmed(body.teacher_id) {
        Some(t) if who.is_admin() => t,
        _ => who.user.clone(),
    };
    let result = sqlx::query!(
        "INSERT IGNORE INTO cm_offering(course_id,term,section,title,teacher_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',NOW(),NOW())",
        cid,
        term,
        section,
        title,
        teacher
    )
    .execute(&s.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::conflict(format!("该学期已存在 {section} 班")));
    }
    Ok(ok(CreateOfferingResponse { offering_id: result.last_insert_id() as u32 }))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct UpdateOfferingRequest {
    #[serde(default)]
    #[ts(optional)]
    pub status: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub section: Option<String>,
}

async fn update_offering(
    State(s): State<AppState>,
    who: Identity,
    Path(oid): Path<u32>,
    Json(body): Json<UpdateOfferingRequest>,
) -> AppResult<ApiOk<Empty>> {
    offering_access(&s.db, &who, oid, Need::TEACH).await?;
    if body.status.as_deref().is_some_and(|st| !matches!(st, "draft" | "active" | "archived")) {
        return Err(AppError::unprocessable("状态无效"));
    }
    let section = body.section.map(|v| v.trim().to_owned());
    if section.as_deref().is_some_and(|v| !SECTION.is_match(v)) {
        return Err(AppError::unprocessable("班级编号格式不合法"));
    }
    let title = body.title.map(|v| v.trim().to_owned());
    if body.status.is_none() && title.is_none() && section.is_none() {
        return Ok(ok(Empty {}));
    }
    sqlx::query!(
        "UPDATE cm_offering SET status=COALESCE(?,status), title=COALESCE(?,title), section=COALESCE(?,section), updated_at=NOW() WHERE offering_id=?",
        body.status,
        title,
        section,
        oid
    )
    .execute(&s.db)
    .await?;
    Ok(ok(Empty {}))
}
