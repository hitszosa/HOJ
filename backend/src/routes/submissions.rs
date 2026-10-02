//! 提交：判题结果、学习建议、全站状态流、源码查看。

use axum::{Router, extract::State, routing::get};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, MySqlPool, QueryBuilder};
use ts_rs::TS;

use crate::{
    access::{Need, Role, batch_access, offering_access},
    ai::{self, HintFailure, HintInput},
    auth::Identity,
    error::{AppError, AppResult},
    extract::{Path, Query},
    hustoj,
    response::{ApiOk, ok},
    routes::{batches::load_problem, ranking::limit_offset},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/submissions/{sid}", get(result))
        .route("/api/submissions/{sid}/analysis", get(analysis))
        .route("/api/submissions/{sid}/code", get(code))
        .route("/api/status", get(status))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SubmissionResult {
    pub submission_id: u32,
    pub problem_id: i32,
    pub user_id: String,
    pub result: i16,
    pub label: &'static str,
    pub time: i32,
    pub memory: i32,
    pub language: u32,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub in_date: NaiveDateTime,
    /// 教学域归属；自由练习为 null。
    pub offering_id: Option<u32>,
    pub batch_id: Option<u32>,
    /// 编译错误，否则运行错误信息。
    pub error: Option<String>,
}

async fn judge_error(db: &MySqlPool, sid: u32) -> AppResult<Option<String>> {
    let ce = sqlx::query_scalar!("SELECT error FROM jol.compileinfo WHERE solution_id=?", sid).fetch_optional(db).await?.flatten();
    if ce.is_some() {
        return Ok(ce);
    }
    Ok(sqlx::query_scalar!("SELECT error FROM jol.runtimeinfo WHERE solution_id=?", sid).fetch_optional(db).await?.flatten())
}

/// 读取并鉴权：教学域提交按教学班授权（学生只能看自己的），自由练习只有本人或管理员。
pub async fn load_result(s: &AppState, who: &Identity, sid: u32) -> AppResult<SubmissionResult> {
    let row = sqlx::query!(
        r#"SELECT s.solution_id, s.problem_id, s.user_id, s.result, s.time, s.memory, s.language, s.in_date,
                  cs.offering_id AS "offering_id?", cs.batch_id
           FROM jol.solution s LEFT JOIN cm_submission cs ON cs.submission_id=s.solution_id
           WHERE s.solution_id=?"#,
        sid
    )
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| AppError::not_found("提交不存在"))?;
    match row.offering_id {
        Some(oid) => {
            let off = offering_access(&s.db, who, oid, Need::READ).await?;
            if off.role == Role::Student && row.user_id != who.user {
                return Err(AppError::not_found("提交不存在"));
            }
        }
        None if !who.is_admin() && row.user_id != who.user => return Err(AppError::not_found("提交不存在")),
        None => {}
    }
    Ok(SubmissionResult {
        submission_id: row.solution_id,
        problem_id: row.problem_id,
        label: hustoj::result_label(row.result),
        user_id: row.user_id,
        result: row.result,
        time: row.time,
        memory: row.memory,
        language: row.language,
        in_date: row.in_date,
        offering_id: row.offering_id,
        batch_id: row.batch_id,
        error: judge_error(&s.db, sid).await?,
    })
}

async fn result(State(s): State<AppState>, who: Identity, Path(sid): Path<u32>) -> AppResult<ApiOk<SubmissionResult>> {
    Ok(ok(load_result(&s, &who, sid).await?))
}

// ---------------------------------------------------------------- 学习建议

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct AnalysisQuery {
    #[serde(default)]
    #[ts(optional)]
    pub level: Option<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AnalysisMode {
    Model,
    Rules,
}

/// F = 服务端判题事实（原文），A = 建议（只能引用 F）。
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Evidence {
    pub id: &'static str,
    pub kind: &'static str,
    pub text: String,
    pub url: Option<String>,
    pub basis: Vec<&'static str>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Analysis {
    pub mode: AnalysisMode,
    pub label: &'static str,
    pub level: u8,
    pub evidence: Vec<Evidence>,
    /// 规则建议的原因；模型建议时为 null。
    pub reason: Option<HintFailure>,
    /// AI 服务故障导致的降级。
    pub degraded: bool,
}

async fn analysis(
    State(s): State<AppState>,
    who: Identity,
    Path(sid): Path<u32>,
    Query(q): Query<AnalysisQuery>,
) -> AppResult<ApiOk<Analysis>> {
    let r = load_result(&s, &who, sid).await?;
    let bid = r.batch_id.ok_or_else(|| AppError::not_found("该提交不属于任何题单"))?;
    let (batch, _) = batch_access(&s.db, &who, bid, Need::READ).await?;
    if !batch.ai_enabled {
        return Err(AppError::forbidden("本批次已关闭 AI 辅助"));
    }
    let level = q.level.unwrap_or(1);
    if !(1..=3).contains(&level) {
        return Err(AppError::validation("提示级别为 1–3"));
    }
    // F1 永远是服务端判题事实原文，模型只能补充 A1，不能覆盖任何事实字段。
    let fact = Evidence {
        id: "F1",
        kind: "F",
        text: format!("提交 #{sid}：{}，用时 {} ms，内存 {} KB", r.label, r.time, r.memory),
        url: Some(format!("/api/submissions/{sid}")),
        basis: vec![],
    };
    let hint = if r.result == hustoj::RESULT_AC {
        Err(HintFailure::AlreadyPassed)
    } else if !s.cfg.ai.configured() {
        Err(HintFailure::NotConfigured)
    } else {
        let (p, ..) = load_problem(&s, &who, bid, r.problem_id).await?;
        let code = sqlx::query_scalar!(
            "SELECT COALESCE((SELECT source FROM jol.source_code_user WHERE solution_id=?),(SELECT source FROM jol.source_code WHERE solution_id=?))",
            sid,
            sid
        )
        .fetch_one(&s.db)
        .await?
        .unwrap_or_default();
        let compile_error =
            sqlx::query_scalar!("SELECT error FROM jol.compileinfo WHERE solution_id=?", sid).fetch_optional(&s.db).await?.flatten().unwrap_or_default();
        let input = HintInput {
            title: &p.title,
            statement: p.description.as_deref().unwrap_or(""),
            input: p.input.as_deref().unwrap_or(""),
            output: p.output.as_deref().unwrap_or(""),
            sample_input: p.sample_input.as_deref().unwrap_or(""),
            sample_output: p.sample_output.as_deref().unwrap_or(""),
            result: r.result,
            label: r.label,
            time_ms: r.time,
            memory_kb: r.memory,
            compile_error: &compile_error,
            language: r.language,
            code: &code,
        };
        ai::analysis_hint(&s, &input, level).await
    };
    let (mode, label, text, reason) = match hint {
        Ok(text) => (AnalysisMode::Model, "模型学习建议（已调用配置的 AI 服务）", text, None),
        Err(why) => {
            let label = match why {
                HintFailure::NotConfigured => "规则学习建议（未配置 AI 服务，未调用模型）",
                HintFailure::ModelUnavailable => "规则学习建议（AI 服务暂不可用，已降级）",
                HintFailure::InvalidResponse => "规则学习建议（AI 返回不可用，已降级）",
                HintFailure::AlreadyPassed => "规则学习建议（本次已通过，未调用模型）",
            };
            let text = if r.result == hustoj::RESULT_AC { "本次提交已通过，可回顾解题过程。" } else { ai::rule_hints(r.result)[level as usize - 1] };
            (AnalysisMode::Rules, label, text.to_owned(), Some(why))
        }
    };
    let degraded = matches!(reason, Some(HintFailure::ModelUnavailable | HintFailure::InvalidResponse));
    Ok(ok(Analysis {
        mode,
        label,
        level,
        evidence: vec![fact, Evidence { id: "A1", kind: "A", text, url: None, basis: vec!["F1"] }],
        reason,
        degraded,
    }))
}

// ---------------------------------------------------------------- 状态流

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct StatusQuery {
    #[serde(default)]
    #[ts(optional)]
    pub page: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub page_size: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub problem_id: Option<i32>,
    /// 按账号或昵称模糊搜索。
    #[serde(default)]
    #[ts(optional)]
    pub user_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub language: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub result: Option<i16>,
    #[serde(default)]
    #[ts(optional)]
    pub offering_id: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub only_mine: Option<bool>,
}

#[derive(FromRow)]
struct StatusRow {
    solution_id: u32,
    problem_id: i32,
    user_id: String,
    nick: String,
    result: i16,
    time: i32,
    memory: i32,
    language: u32,
    code_length: i32,
    in_date: NaiveDateTime,
    problem_title: Option<String>,
    offering_id: Option<u32>,
    batch_id: Option<u32>,
    offering_title: Option<String>,
    sim: Option<i32>,
    sim_s_id: Option<i32>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct StatusItem {
    pub solution_id: u32,
    pub problem_id: i32,
    pub problem_title: String,
    pub user_id: String,
    pub nick: String,
    pub result: i16,
    pub result_label: &'static str,
    pub time: i32,
    pub memory: i32,
    pub language: u32,
    pub language_name: &'static str,
    pub code_length: i32,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub in_date: NaiveDateTime,
    pub offering_id: Option<u32>,
    pub offering_title: String,
    pub batch_id: Option<u32>,
    pub can_view_code: bool,
    /// 查重相似度（0–100）与相似的提交号；无查重记录为 null。
    pub sim: Option<i32>,
    pub sim_solution_id: Option<i32>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct StatusPage {
    pub items: Vec<StatusItem>,
    #[ts(type = "number")]
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

fn like_pattern(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// 两段查询共用的 WHERE：自测（problem_id=0）永不出现在状态流里。
fn push_filters(qb: &mut QueryBuilder<'_, sqlx::MySql>, q: &StatusQuery, who: &Identity) {
    qb.push(" WHERE s.problem_id > 0");
    if q.only_mine == Some(true) {
        qb.push(" AND s.user_id = ").push_bind(who.user.clone());
    } else if let Some(u) = q.user_id.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        let pattern = like_pattern(u);
        qb.push(" AND (s.user_id LIKE ").push_bind(pattern.clone()).push(" OR u.nick LIKE ").push_bind(pattern).push(")");
    }
    if let Some(pid) = q.problem_id.filter(|&p| p > 0) {
        qb.push(" AND s.problem_id = ").push_bind(pid);
    }
    if let Some(lang) = q.language {
        qb.push(" AND s.language = ").push_bind(lang);
    }
    if let Some(res) = q.result {
        qb.push(" AND s.result = ").push_bind(res);
    }
    if let Some(oid) = q.offering_id.filter(|&o| o > 0) {
        qb.push(" AND cs.offering_id = ").push_bind(oid);
    }
}

async fn status(State(s): State<AppState>, who: Identity, Query(q): Query<StatusQuery>) -> AppResult<ApiOk<StatusPage>> {
    let (limit, offset) = limit_offset(q.page, q.page_size, 20);
    if let Some(oid) = q.offering_id.filter(|&o| o > 0) {
        offering_access(&s.db, &who, oid, Need::READ).await?;
    }
    let mut qb = QueryBuilder::new(
        "SELECT s.solution_id, s.problem_id, s.user_id, COALESCE(NULLIF(u.nick,''), NULLIF(s.nick,''), s.user_id) AS nick,
                s.result, s.time, s.memory, s.language, s.code_length, s.in_date, p.title AS problem_title,
                cs.offering_id, cs.batch_id, o.title AS offering_title, sm.sim, sm.sim_s_id
         FROM jol.solution s
         LEFT JOIN jol.sim sm ON sm.s_id=s.solution_id
         LEFT JOIN jol.problem p ON p.problem_id=s.problem_id
         LEFT JOIN jol.users u ON u.user_id=s.user_id
         LEFT JOIN cm_submission cs ON cs.submission_id=s.solution_id
         LEFT JOIN cm_offering o ON o.offering_id=cs.offering_id",
    );
    push_filters(&mut qb, &q, &who);
    qb.push(" ORDER BY s.solution_id DESC LIMIT ").push_bind(limit).push(" OFFSET ").push_bind(offset);
    let rows: Vec<StatusRow> = qb.build_query_as().fetch_all(&s.db).await?;

    let mut count = QueryBuilder::new(
        "SELECT COUNT(*) FROM jol.solution s LEFT JOIN jol.users u ON u.user_id=s.user_id
         LEFT JOIN cm_submission cs ON cs.submission_id=s.solution_id",
    );
    push_filters(&mut count, &q, &who);
    let total: i64 = count.build_query_scalar().fetch_one(&s.db).await?;

    let items = rows
        .into_iter()
        .map(|r| StatusItem {
            problem_title: r.problem_title.unwrap_or_else(|| format!("题目 #{}", r.problem_id)),
            result_label: hustoj::result_label(r.result),
            language_name: hustoj::language_name(r.language),
            can_view_code: who.is_admin() || r.user_id == who.user,
            offering_title: r.offering_title.unwrap_or_default(),
            solution_id: r.solution_id,
            problem_id: r.problem_id,
            user_id: r.user_id,
            nick: r.nick,
            result: r.result,
            time: r.time,
            memory: r.memory,
            language: r.language,
            code_length: r.code_length,
            in_date: r.in_date,
            offering_id: r.offering_id,
            batch_id: r.batch_id,
            sim: r.sim,
            sim_solution_id: r.sim_s_id,
        })
        .collect();
    Ok(ok(StatusPage { items, total, page: q.page.unwrap_or(1).max(1), page_size: limit }))
}

// ---------------------------------------------------------------- 源码

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Similarity {
    pub s_id: i32,
    pub sim_s_id: Option<i32>,
    pub sim: Option<i32>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SubmissionCode {
    pub solution_id: u32,
    pub user_id: String,
    pub nick: String,
    pub code_length: i32,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub in_date: NaiveDateTime,
    pub problem_id: i32,
    pub problem_title: Option<String>,
    pub result: i16,
    pub result_label: &'static str,
    pub time: i32,
    pub memory: i32,
    pub language: u32,
    pub language_name: &'static str,
    pub code: String,
    pub compile_error: Option<String>,
    pub runtime_error: Option<String>,
    /// 查重结果（HUSTOJ sim 表）。
    pub sim: Option<Similarity>,
}

/// 本人、管理员、该提交所属教学班的教师，或该学生任一教学班的主讲教师可看源码。
async fn code(State(s): State<AppState>, who: Identity, Path(sid): Path<u32>) -> AppResult<ApiOk<SubmissionCode>> {
    let row = sqlx::query!(
        r#"SELECT s.solution_id, s.user_id, s.problem_id, p.title AS "problem_title?", s.result, s.time, s.memory, s.language,
                  s.code_length, s.in_date, COALESCE(NULLIF(u.nick,''), NULLIF(s.nick,''), s.user_id) AS "nick!: String",
                  cs.offering_id AS "offering_id?"
           FROM jol.solution s LEFT JOIN jol.problem p ON p.problem_id=s.problem_id
           LEFT JOIN jol.users u ON u.user_id=s.user_id
           LEFT JOIN cm_submission cs ON cs.submission_id=s.solution_id
           WHERE s.solution_id=?"#,
        sid
    )
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| AppError::not_found("提交记录不存在"))?;
    let mut allowed = row.user_id == who.user || who.is_admin();
    if !allowed && let Some(oid) = row.offering_id {
        allowed = offering_access(&s.db, &who, oid, Need::TEACH).await.is_ok();
    }
    if !allowed {
        allowed = sqlx::query_scalar!(
            r#"SELECT 1 AS "x!: i32" FROM cm_enrollment e JOIN cm_offering o ON o.offering_id=e.offering_id
               WHERE e.user_id=? AND o.teacher_id=? LIMIT 1"#,
            row.user_id,
            who.user
        )
        .fetch_optional(&s.db)
        .await?
        .is_some();
    }
    if !allowed {
        return Err(AppError::forbidden("仅提交者本人或授课教师可以查看源代码"));
    }
    let source = sqlx::query_scalar!("SELECT source FROM jol.source_code WHERE solution_id=?", sid).fetch_optional(&s.db).await?.unwrap_or_default();
    let compile_error = sqlx::query_scalar!("SELECT error FROM jol.compileinfo WHERE solution_id=?", sid).fetch_optional(&s.db).await?.flatten();
    let runtime_error = sqlx::query_scalar!("SELECT error FROM jol.runtimeinfo WHERE solution_id=?", sid).fetch_optional(&s.db).await?.flatten();
    let sid_i = sid as i32;
    let sim = sqlx::query_as!(Similarity, "SELECT s_id, sim_s_id, sim FROM jol.sim WHERE s_id=? OR sim_s_id=? LIMIT 1", sid_i, sid_i)
        .fetch_optional(&s.db)
        .await?;
    Ok(ok(SubmissionCode {
        solution_id: row.solution_id,
        user_id: row.user_id,
        nick: row.nick,
        code_length: row.code_length,
        in_date: row.in_date,
        problem_id: row.problem_id,
        problem_title: row.problem_title,
        result: row.result,
        result_label: hustoj::result_label(row.result),
        time: row.time,
        memory: row.memory,
        language: row.language,
        language_name: hustoj::language_name(row.language),
        code: hustoj::strip_python_prefix(&source).to_owned(),
        compile_error,
        runtime_error,
        sim,
    }))
}
