//! 公开题库练习：HUSTOJ 已开放题目（数字题号）与本地题库题目（slug，首次访问时落库）。
//! 自由练习不进入 cm_submission，不计入任何教学班统计。

use axum::{
    Router,
    extract::State,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    auth::Identity,
    document::Case,
    error::{AppError, AppResult},
    extract::{Json, Path, Query},
    hustoj,
    problem_bank::ensure_bank_problem,
    response::{ApiOk, ok},
    routes::{
        batches::{SubmitRequest, SubmitResponse},
        problem_sets::SolvedStatus,
        ranking::limit_offset,
    },
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/public-problems", get(list))
        .route("/api/public-problems/{key}", get(detail))
        .route("/api/public-problems/{key}/submissions", post(submit))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ListQuery {
    /// 纯数字时同时匹配题号；否则匹配标题或来源。
    #[serde(default)]
    #[ts(optional)]
    pub keyword: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub page: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub page_size: Option<u32>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PublicProblemItem {
    pub problem_id: i32,
    pub title: String,
    pub source: Option<String>,
    pub accepted: i32,
    pub submit: i32,
    pub pass_rate: f64,
    pub solved_status: SolvedStatus,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PublicProblemPage {
    pub items: Vec<PublicProblemItem>,
    #[ts(type = "number")]
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

fn status_of(passed: Option<bool>, tries: i64) -> SolvedStatus {
    match passed {
        Some(true) => SolvedStatus::Passed,
        _ if tries > 0 => SolvedStatus::Tried,
        _ => SolvedStatus::Unattempted,
    }
}

async fn list(State(s): State<AppState>, who: Identity, Query(q): Query<ListQuery>) -> AppResult<ApiOk<PublicProblemPage>> {
    let (limit, offset) = limit_offset(q.page, q.page_size, 20);
    let kw = q.keyword.as_deref().map(str::trim).filter(|k| !k.is_empty()).unwrap_or("");
    let pattern = format!("%{}%", kw.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let numeric: Option<i32> = if kw.bytes().all(|b| b.is_ascii_digit()) { kw.parse().ok() } else { None };
    let rows = sqlx::query!(
        r#"SELECT p.problem_id, p.title, p.source, COALESCE(p.accepted,0) AS "accepted!: i32", COALESCE(p.submit,0) AS "submit!: i32",
                  MAX(s.result=4) AS "passed?: bool", COUNT(s.solution_id) AS "tries!: i64"
           FROM jol.problem p
           LEFT JOIN jol.solution s ON s.problem_id=p.problem_id AND s.user_id=?
           WHERE p.defunct='N' AND p.problem_id>0
             AND (?='' OR p.problem_id=? OR p.title LIKE ? OR (? IS NULL AND p.source LIKE ?))
           GROUP BY p.problem_id, p.title, p.source, p.accepted, p.submit
           ORDER BY p.problem_id ASC LIMIT ? OFFSET ?"#,
        who.user,
        kw,
        numeric,
        pattern,
        numeric,
        pattern,
        limit,
        offset
    )
    .fetch_all(&s.db)
    .await?;
    let total = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM jol.problem p WHERE p.defunct='N' AND p.problem_id>0
           AND (?='' OR p.problem_id=? OR p.title LIKE ? OR (? IS NULL AND p.source LIKE ?))",
        kw,
        numeric,
        pattern,
        numeric,
        pattern
    )
    .fetch_one(&s.db)
    .await?;
    let items = rows
        .into_iter()
        .map(|r| PublicProblemItem {
            pass_rate: if r.submit > 0 { (r.accepted as f64 / r.submit as f64 * 1000.0).round() / 10.0 } else { 0.0 },
            solved_status: status_of(r.passed, r.tries),
            problem_id: r.problem_id,
            title: r.title,
            source: r.source,
            accepted: r.accepted,
            submit: r.submit,
        })
        .collect();
    Ok(ok(PublicProblemPage { items, total, page: q.page.unwrap_or(1).max(1), page_size: limit }))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PublicProblem {
    /// 请求路径里的标识（题号或 slug）。
    pub key: String,
    /// HUSTOJ 题号；题库题目落库失败时为 null。
    pub numeric_pid: Option<i32>,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub input: String,
    pub output: String,
    pub samples: Vec<Case>,
    pub hint: String,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub provenance: Option<String>,
    pub category_name: Option<String>,
    pub time_limit: f64,
    pub memory_limit: i32,
    pub accepted: i32,
    pub submit: i32,
    pub solved_status: SolvedStatus,
}

async fn my_status(s: &AppState, pid: i32, user: &str) -> AppResult<SolvedStatus> {
    let r = sqlx::query!(
        r#"SELECT MAX(result=4) AS "passed?: bool", COUNT(*) AS "tries!: i64" FROM jol.solution WHERE problem_id=? AND user_id=?"#,
        pid,
        user
    )
    .fetch_one(&s.db)
    .await?;
    Ok(status_of(r.passed, r.tries))
}

async fn detail(State(s): State<AppState>, who: Identity, Path(key): Path<String>) -> AppResult<ApiOk<PublicProblem>> {
    let key = key.trim().to_owned();
    if let Ok(pid) = key.parse::<i32>() {
        let p = sqlx::query!(
            r#"SELECT problem_id, title, description, input, output, sample_input, sample_output, hint, source,
                      CAST(time_limit AS DOUBLE) AS "time_limit!: f64", memory_limit,
                      COALESCE(accepted,0) AS "accepted!: i32", COALESCE(submit,0) AS "submit!: i32"
               FROM jol.problem WHERE problem_id=? AND defunct='N'"#,
            pid
        )
        .fetch_optional(&s.db)
        .await?;
        if let Some(p) = p {
            let slug = p.source.as_deref().and_then(|src| src.strip_prefix("bank:")).map(str::to_owned).unwrap_or_else(|| key.clone());
            let samples = match (p.sample_input, p.sample_output) {
                (Some(i), o) if !i.is_empty() => vec![Case { input: i, output: o.unwrap_or_default() }],
                _ => Vec::new(),
            };
            return Ok(ok(PublicProblem {
                solved_status: my_status(&s, pid, &who.user).await?,
                key,
                numeric_pid: Some(p.problem_id),
                slug,
                title: p.title,
                description: p.description.unwrap_or_default(),
                input: p.input.unwrap_or_default(),
                output: p.output.unwrap_or_default(),
                samples,
                hint: p.hint.unwrap_or_default(),
                difficulty: None,
                tags: Vec::new(),
                provenance: None,
                category_name: None,
                time_limit: p.time_limit,
                memory_limit: p.memory_limit,
                accepted: p.accepted,
                submit: p.submit,
            }));
        }
    }
    let (set, prob) = s.bank.find(&key).ok_or_else(|| AppError::not_found("题目不存在或未开放"))?;
    let (set_title, prob) = (set.title.clone(), prob.clone());
    let numeric_pid = ensure_bank_problem(&s, &key).await?;
    let solved_status = match numeric_pid {
        Some(pid) => my_status(&s, pid, &who.user).await?,
        None => SolvedStatus::Unattempted,
    };
    let hint_src = if prob.tags.is_empty() { &prob.knowledge } else { &prob.tags };
    Ok(ok(PublicProblem {
        hint: hint_src.iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join("、"),
        key: key.clone(),
        numeric_pid,
        slug: key,
        title: prob.title,
        description: prob.statement,
        input: String::new(),
        output: String::new(),
        samples: prob.samples.iter().map(|c| Case { input: c.input.clone(), output: c.output.clone() }).collect(),
        difficulty: Some(prob.difficulty),
        tags: prob.tags,
        provenance: Some(prob.provenance),
        category_name: Some(set_title),
        time_limit: 1.0,
        memory_limit: 128,
        accepted: 0,
        submit: 0,
        solved_status,
    }))
}

async fn submit(State(s): State<AppState>, who: Identity, Path(key): Path<String>, Json(body): Json<SubmitRequest>) -> AppResult<ApiOk<SubmitResponse>> {
    let key = key.trim();
    let missing = || AppError::not_found("题目不存在或未开放");
    let pid = match key.parse::<i32>() {
        Ok(pid) => sqlx::query_scalar!("SELECT problem_id FROM jol.problem WHERE problem_id=? AND defunct='N'", pid)
            .fetch_optional(&s.db)
            .await?
            .ok_or_else(missing)?,
        Err(_) => ensure_bank_problem(&s, key).await?.ok_or_else(missing)?,
    };
    let lang = hustoj::language_id(&body.language).ok_or_else(|| AppError::validation("无效的编程语言，请在 python / cpp / c / java 中选择"))?;
    if body.code.trim().is_empty() {
        return Err(AppError::validation("代码不能为空"));
    }
    if body.code.len() > 65536 {
        return Err(AppError::validation("代码长度超出 64KB 限制"));
    }
    let code = hustoj::prepare_code(lang, &body.code);
    // 旧版先以 result=0 写 solution 再写源码（判题机可能读到空源码），并用 MAX(solution_id) 反查 id；这里走两阶段写入。
    let sid = hustoj::insert_submission(&s.db, pid, &who.user, lang, &code, None).await?;
    Ok(ok(SubmitResponse { submission_id: sid }))
}
