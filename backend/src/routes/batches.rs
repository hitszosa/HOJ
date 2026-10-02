//! 题单（批次）：学生做题、提交、自测；教师调整设置、复制为草稿、公开导出。

use std::collections::HashMap;

use axum::{
    Router,
    extract::State,
    routing::{get, post},
};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    access::{Batch, Need, Offering, Role, batch_access},
    auth::Identity,
    authoring::{self, DraftCreated, Origin},
    document,
    error::{AppError, AppResult},
    extract::{Json, Path},
    hustoj::{self, CourseLink},
    response::{ApiOk, Empty, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/batches/{bid}", get(batch).patch(settings))
        .route("/api/batches/{bid}/problems/{pid}", get(problem))
        .route("/api/batches/{bid}/problems/{pid}/submissions", post(submit))
        .route("/api/batches/{bid}/problems/{pid}/trials", post(run_trial))
        .route("/api/trials/{run_id}", get(trial_result))
        .route("/api/batches/{bid}/copy", post(copy))
        .route("/api/batches/{bid}/export", post(export))
}

// ---------------------------------------------------------------- 历史通过记录

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PreviousAc {
    pub solution_id: u32,
    pub language: String,
    pub language_name: &'static str,
    pub code: String,
    pub time: i32,
    pub memory: i32,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub in_date: NaiveDateTime,
    /// 该语言是否被本题单允许（不允许时前端只展示、不一键复用）。
    pub is_language_allowed: bool,
}

/// 同一道题（同 id，或同题库 slug，或同标题）本人最近的通过记录，优先返回题单允许的语言。
pub async fn previous_ac(s: &AppState, user: &str, pid: i32, source: Option<&str>, title: &str, allowed: &[String]) -> AppResult<Option<PreviousAc>> {
    let source = source.unwrap_or("").trim();
    let slug = source.strip_prefix("codemind:authoring/").and_then(|r| r.rsplit('/').next()).or_else(|| source.strip_prefix("bank:"));
    let title = title.trim();
    let rows = sqlx::query!(
        r#"SELECT s.solution_id, s.language, s.time, s.memory, s.in_date, sc.source AS code
           FROM jol.solution s
           JOIN jol.source_code sc ON sc.solution_id=s.solution_id
           JOIN jol.problem p ON p.problem_id=s.problem_id
           WHERE s.user_id=? AND s.result=4
             AND (p.problem_id=? OR (? IS NOT NULL AND (p.source=? OR p.source LIKE ?)) OR (?<>'' AND p.title=?))
           ORDER BY s.solution_id DESC LIMIT 10"#,
        user,
        pid,
        slug,
        slug.map(|s| format!("bank:{s}")),
        slug.map(|s| format!("%/{s}")),
        title,
        title
    )
    .fetch_all(&s.db)
    .await?;
    let mut parsed: Vec<PreviousAc> = rows
        .into_iter()
        .map(|r| {
            let key = hustoj::language_key(r.language).unwrap_or(if r.language == 1 { "cpp" } else { "c" });
            PreviousAc {
                solution_id: r.solution_id,
                language: key.to_owned(),
                language_name: hustoj::language_name(r.language),
                code: hustoj::strip_python_prefix(&r.code).to_owned(),
                time: r.time,
                memory: r.memory,
                in_date: r.in_date,
                is_language_allowed: allowed.is_empty() || allowed.iter().any(|a| a == key),
            }
        })
        .collect();
    let pick = parsed.iter().position(|p| p.is_language_allowed).unwrap_or(0);
    Ok((!parsed.is_empty()).then(|| parsed.swap_remove(pick)))
}

// ---------------------------------------------------------------- 题单与题目

#[derive(Serialize, TS)]
#[ts(export)]
pub struct BatchProblem {
    pub batch_problem_id: u32,
    pub problem_id: i32,
    pub seq: u8,
    pub score: f64,
    pub required: bool,
    pub title: String,
    pub hint: Option<String>,
    pub defunct: String,
    pub source: Option<String>,
    #[ts(type = "number")]
    pub attempts: i64,
    pub passed: bool,
    /// 学生未通过本题但在别处通过过同一题。
    pub has_previous_ac: bool,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct BatchDetail {
    pub batch: Batch,
    pub offering: Offering,
    pub problems: Vec<BatchProblem>,
}

async fn batch(State(s): State<AppState>, who: Identity, Path(bid): Path<u32>) -> AppResult<ApiOk<BatchDetail>> {
    let (batch, off) = batch_access(&s.db, &who, bid, Need::READ).await?;
    let student = off.role == Role::Student;
    let rows = sqlx::query!(
        r#"SELECT bp.batch_problem_id, bp.problem_id, bp.seq, CAST(bp.score AS DOUBLE) AS "score!: f64", bp.required AS "required: bool",
                  p.title, p.hint, p.defunct, p.source
           FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id)
           WHERE bp.batch_id=? AND (? = 0 OR p.defunct='N') ORDER BY bp.seq"#,
        bid,
        student as i8
    )
    .fetch_all(&s.db)
    .await?;
    // 本人在本题单内的进度，一次查出。
    let progress: HashMap<i32, (i64, bool)> = sqlx::query!(
        r#"SELECT s.problem_id, COUNT(*) AS "attempts!: i64", MAX(s.result=4) AS "passed!: bool"
           FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id
           WHERE cs.batch_id=? AND cs.user_id=? GROUP BY s.problem_id"#,
        bid,
        who.user
    )
    .fetch_all(&s.db)
    .await?
    .into_iter()
    .map(|r| (r.problem_id, (r.attempts, r.passed)))
    .collect();
    let mut problems = Vec::with_capacity(rows.len());
    for r in rows {
        let (attempts, passed) = progress.get(&r.problem_id).copied().unwrap_or((0, false));
        let has_previous_ac = student
            && !passed
            && previous_ac(&s, &who.user, r.problem_id, r.source.as_deref(), &r.title, &batch.allowed_languages).await?.is_some();
        problems.push(BatchProblem {
            batch_problem_id: r.batch_problem_id,
            problem_id: r.problem_id,
            seq: r.seq,
            score: r.score,
            required: r.required,
            title: r.title,
            hint: r.hint,
            defunct: r.defunct,
            source: r.source,
            attempts,
            passed,
            has_previous_ac,
        });
    }
    Ok(ok(BatchDetail { batch, offering: off, problems }))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct ProblemStatement {
    pub problem_id: i32,
    pub title: String,
    pub description: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub sample_input: Option<String>,
    pub sample_output: Option<String>,
    pub hint: Option<String>,
    pub time_limit: f64,
    pub memory_limit: i32,
    pub source: Option<String>,
}

/// 题单内的题目（学生只能看到已放开的题）。其他接口复用它做可见性校验。
pub async fn load_problem(s: &AppState, who: &Identity, bid: u32, pid: i32) -> AppResult<(ProblemStatement, Batch, Offering)> {
    let (batch, off) = batch_access(&s.db, who, bid, Need::READ).await?;
    let student = off.role == Role::Student;
    let p = sqlx::query_as!(
        ProblemStatement,
        r#"SELECT p.problem_id, p.title, p.description, p.input, p.output, p.sample_input, p.sample_output, p.hint,
                  CAST(p.time_limit AS DOUBLE) AS "time_limit!: f64", p.memory_limit, p.source
           FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id)
           WHERE bp.batch_id=? AND p.problem_id=? AND (? = 0 OR p.defunct='N')"#,
        bid,
        pid,
        student as i8
    )
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| AppError::not_found("题目不存在或未发布"))?;
    Ok((p, batch, off))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct ProblemDetail {
    pub problem: ProblemStatement,
    pub batch: Batch,
    pub role: Role,
    pub archived: bool,
    pub previous_ac: Option<PreviousAc>,
}

async fn problem(State(s): State<AppState>, who: Identity, Path((bid, pid)): Path<(u32, i32)>) -> AppResult<ApiOk<ProblemDetail>> {
    let (p, batch, off) = load_problem(&s, &who, bid, pid).await?;
    let previous_ac = if off.role == Role::Student {
        previous_ac(&s, &who.user, p.problem_id, p.source.as_deref(), &p.title, &batch.allowed_languages).await?
    } else {
        None
    };
    Ok(ok(ProblemDetail { archived: off.archived(), role: off.role, problem: p, batch, previous_ac }))
}

// ---------------------------------------------------------------- 提交与自测

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct SubmitRequest {
    pub code: String,
    /// 语言键：c / cpp / java / python。
    pub language: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SubmitResponse {
    pub submission_id: u32,
}

/// 学生本人、题单仍接收提交、语言在允许范围内；返回 HUSTOJ 语言编号。
fn check_student_code(batch: &Batch, off: &Offering, language: &str, action: &str) -> AppResult<u32> {
    if off.role != Role::Student {
        return Err(AppError::forbidden(format!("仅学生本人可以{action}")));
    }
    if !batch.accepting() {
        return Err(AppError::conflict("此题单已停止接收提交"));
    }
    let lang = hustoj::language_id(language).ok_or_else(|| AppError::validation("请选择支持的语言"))?;
    if batch.languages_restricted && !batch.allowed_languages.iter().any(|l| l == language) {
        let names: Vec<&str> =
            batch.allowed_languages.iter().filter_map(|l| hustoj::language_id(l)).map(hustoj::language_name).collect();
        return Err(AppError::validation(format!("该作业限制仅允许使用以下语言{action}：{}", names.join(", "))));
    }
    Ok(lang)
}

async fn submit(
    State(s): State<AppState>,
    who: Identity,
    Path((bid, pid)): Path<(u32, i32)>,
    Json(body): Json<SubmitRequest>,
) -> AppResult<ApiOk<SubmitResponse>> {
    let (_, batch, off) = load_problem(&s, &who, bid, pid).await?;
    if off.archived() {
        return Err(AppError::conflict("历史教学班为只读，不能修改、发布或提交"));
    }
    let lang = check_student_code(&batch, &off, &body.language, "提交")?;
    if body.code.trim().is_empty() || body.code.len() > 65536 {
        return Err(AppError::validation("请选择支持的语言并填写 64KB 以内的代码"));
    }
    let bp = sqlx::query_scalar!("SELECT batch_problem_id FROM cm_batch_problem WHERE batch_id=? AND problem_id=?", bid, pid)
        .fetch_one(&s.db)
        .await?;
    let code = hustoj::prepare_code(lang, &body.code);
    let link = CourseLink { offering_id: off.offering_id, batch_id: bid, batch_problem_id: bp };
    let sid = hustoj::insert_submission(&s.db, pid, &who.user, lang, &code, Some(link)).await?;
    Ok(ok(SubmitResponse { submission_id: sid }))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct TrialRequest {
    pub code: String,
    pub language: String,
    #[serde(default)]
    #[ts(optional)]
    pub input: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TrialStarted {
    /// 签名令牌，轮询 `/api/trials/{run_id}` 取结果。
    pub run_id: String,
}

async fn run_trial(
    State(s): State<AppState>,
    who: Identity,
    Path((bid, pid)): Path<(u32, i32)>,
    Json(body): Json<TrialRequest>,
) -> AppResult<ApiOk<TrialStarted>> {
    let (_, batch, off) = load_problem(&s, &who, bid, pid).await?;
    if off.archived() {
        return Err(AppError::conflict("历史教学班为只读，不能修改、发布或提交"));
    }
    let lang = check_student_code(&batch, &off, &body.language, "自测")?;
    let stdin = body.input.unwrap_or_default();
    if body.code.trim().is_empty() || body.code.len() > 65536 || stdin.len() > 16384 || stdin.contains('\0') {
        return Err(AppError::validation("代码须为64KB以内的UTF-8文本，输入须为16KB以内且不含空字符的UTF-8文本"));
    }
    let code = hustoj::prepare_code(lang, &body.code);
    if code.len() > 65535 {
        return Err(AppError::validation("代码连同运行所需编码头须小于64KB"));
    }
    let sid = hustoj::insert_trial(&s.ops, &who.user, lang, &code, &stdin).await?;
    Ok(ok(TrialStarted { run_id: s.key.trial_token(sid, bid, pid, &who.user) }))
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrialState {
    Running,
    Finished,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TrialResult {
    pub state: TrialState,
    pub result: i16,
    pub label: &'static str,
    pub time: i32,
    pub memory: i32,
    pub output: String,
    pub compile_error: String,
    /// 输出超过 16KB 被截断。
    pub truncated: bool,
}

async fn trial_result(State(s): State<AppState>, who: Identity, Path(run_id): Path<String>) -> AppResult<ApiOk<TrialResult>> {
    let token = s.key.read_trial_token(&run_id, &who.user)?;
    let (_, _, off) = load_problem(&s, &who, token.bid, token.pid).await?;
    let missing = || AppError::not_found("自测记录不存在");
    if off.role != Role::Student {
        return Err(missing());
    }
    let row = sqlx::query!(
        "SELECT result, time, memory FROM jol.solution WHERE solution_id=? AND user_id=? AND problem_id=0",
        token.sid,
        who.user
    )
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(missing)?;
    let running = hustoj::RUNNING_RESULTS.contains(&row.result);
    let (mut output, mut compile_error, mut truncated) = (String::new(), String::new(), false);
    if !running {
        let text = if row.result == hustoj::RESULT_CE {
            sqlx::query_scalar!("SELECT error FROM jol.compileinfo WHERE solution_id=?", token.sid).fetch_optional(&s.db).await?
        } else {
            sqlx::query_scalar!("SELECT error FROM jol.runtimeinfo WHERE solution_id=?", token.sid).fetch_optional(&s.db).await?
        }
        .flatten()
        .unwrap_or_default();
        truncated = text.len() > 16384;
        let clipped = if truncated {
            let mut end = 16384;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text[..end].to_owned()
        } else {
            text
        };
        if row.result == hustoj::RESULT_CE { compile_error = clipped } else { output = clipped }
    }
    // 原生 result=13 合并了 stdout 与运行诊断，不代表样例或隐藏测试通过；4 同理只表示运行结束。
    let label = if matches!(row.result, 4 | 13) { "自测结束" } else { hustoj::result_label(row.result) };
    let label = if label == "其他结果" { "自测结束" } else { label };
    Ok(ok(TrialResult {
        state: if running { TrialState::Running } else { TrialState::Finished },
        result: row.result,
        label,
        time: row.time,
        memory: row.memory,
        output,
        compile_error,
        truncated,
    }))
}

// ---------------------------------------------------------------- 教师操作

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct BatchSettings {
    #[serde(default)]
    #[ts(optional)]
    pub ai_enabled: Option<bool>,
    /// 语言限制：数组或逗号串；null / 空串 / 全部非法 表示不限制。缺省表示不修改。
    #[serde(default, deserialize_with = "some_or_null")]
    #[ts(optional, type = "string | Array<string> | null")]
    pub allowed_languages: Option<Option<document::LanguageList>>,
}

/// 区分“字段缺省”（None）与“显式 null”（Some(None)）。
fn some_or_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<document::LanguageList>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

async fn settings(State(s): State<AppState>, who: Identity, Path(bid): Path<u32>, Json(body): Json<BatchSettings>) -> AppResult<ApiOk<Empty>> {
    batch_access(&s.db, &who, bid, Need::TEACH_WRITE).await?;
    let languages = body.allowed_languages.as_ref().map(|l| l.as_ref().and_then(document::LanguageList::normalize));
    if body.ai_enabled.is_none() && languages.is_none() {
        return Ok(ok(Empty {}));
    }
    sqlx::query!(
        "UPDATE cm_batch SET ai_enabled=COALESCE(?,ai_enabled),
                allowed_languages=IF(?, ?, allowed_languages), updated_at=NOW() WHERE batch_id=?",
        body.ai_enabled,
        languages.is_some(),
        languages.flatten(),
        bid
    )
    .execute(&s.db)
    .await?;
    Ok(ok(Empty {}))
}

async fn batch_problems_full(s: &AppState, bid: u32) -> AppResult<Vec<(i32, String, Option<String>, Option<String>, Option<String>)>> {
    Ok(sqlx::query!(
        "SELECT p.problem_id, p.title, p.description, p.sample_input, p.sample_output
         FROM jol.problem p JOIN cm_batch_problem bp USING(problem_id) WHERE bp.batch_id=? ORDER BY bp.seq",
        bid
    )
    .fetch_all(&s.db)
    .await?
    .into_iter()
    .map(|r| (r.problem_id, r.title, r.description, r.sample_input, r.sample_output))
    .collect())
}

/// 复制为新草稿（不含隐藏测试，发布前需补齐）；只读来源与来源引用随之保留。
async fn copy(State(s): State<AppState>, who: Identity, Path(bid): Path<u32>) -> AppResult<ApiOk<DraftCreated>> {
    let (batch, off) = batch_access(&s.db, &who, bid, Need::TEACH_WRITE).await?;
    let problems: Vec<serde_json::Value> = batch_problems_full(&s, bid)
        .await?
        .into_iter()
        .map(|(pid, title, desc, si, so)| {
            serde_json::json!({
                "slug": format!("problem-{pid}"), "title": title, "statement": desc.unwrap_or_default(),
                "samples": [{"input": si.unwrap_or_default(), "output": so.unwrap_or_default()}], "tests": [],
            })
        })
        .collect();
    let doc = document::validate(serde_json::json!({
        "title": format!("{}（副本）", batch.title),
        "read_only": batch.read_only,
        "source_ref": batch.source_ref.filter(|r| !r.is_empty()),
        "problems": problems,
    }))?;
    Ok(ok(authoring::create_draft(&s.db, off.offering_id, &who.user, doc, Origin::Teacher).await?))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ExportRequest {
    /// 逐题勾选的 problem_id，默认全不选。
    pub selected: Vec<i32>,
    /// 调用方声明只读时同样拒绝导出。
    #[serde(default)]
    #[ts(optional)]
    pub read_only: Option<bool>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct ExportResponse {
    pub filename: String,
    pub content: String,
    pub published_to_hoa: bool,
}

#[derive(Serialize)]
struct ExportCase {
    input: String,
    output: String,
}

#[derive(Serialize)]
struct ExportProblem {
    slug: String,
    title: String,
    statement: String,
    samples: Vec<ExportCase>,
    seq: usize,
}

/// 公开导出（HOA 仓库）的白名单文档：只含题面与样例，结构上不可能带出隐藏测试或代码。
#[derive(Serialize)]
struct ExportDocument {
    course: String,
    batch: String,
    seq: u32,
    title: String,
    problems: Vec<ExportProblem>,
}

async fn export(State(s): State<AppState>, who: Identity, Path(bid): Path<u32>, Json(body): Json<ExportRequest>) -> AppResult<ApiOk<ExportResponse>> {
    // 只读下载：历史教学班也允许查看与导出。
    let (batch, off) = batch_access(&s.db, &who, bid, Need::TEACH).await?;
    // 题单自身的只读来源优先于调用者参数。
    if batch.read_only || body.read_only == Some(true) {
        return Err(AppError::conflict("该题单来源为只读，不允许公开导出"));
    }
    if batch.status != "published" {
        return Err(AppError::conflict("只能导出已发布题单"));
    }
    if body.selected.is_empty() {
        return Err(AppError::unprocessable("请逐题选择公开导出的题目"));
    }
    let problems = batch_problems_full(&s, bid).await?;
    if body.selected.iter().any(|id| !problems.iter().any(|p| p.0 == *id)) {
        return Err(AppError::unprocessable("选择的题目不属于此题单"));
    }
    let course = sqlx::query_scalar!("SELECT code FROM cm_course WHERE course_id=?", off.course_id).fetch_one(&s.db).await?;
    let doc = ExportDocument {
        course: course.clone(),
        batch: format!("batch-{bid}"),
        seq: batch.seq,
        title: batch.title,
        problems: problems
            .into_iter()
            .filter(|p| body.selected.contains(&p.0))
            .enumerate()
            .map(|(i, (pid, title, desc, si, so))| ExportProblem {
                slug: format!("problem-{pid}"),
                title,
                statement: desc.unwrap_or_default(),
                samples: vec![ExportCase { input: si.unwrap_or_default(), output: so.unwrap_or_default() }],
                seq: i + 1,
            })
            .collect(),
    };
    let content = serde_yaml::to_string(&doc).map_err(|e| AppError::internal(e.to_string()))?;
    Ok(ok(ExportResponse { filename: format!("{course}-batch-{bid}.yml"), content, published_to_hoa: false }))
}
