//! 排行榜：全站（排除教师 / 管理员 / 测试账号）或单个教学班。

use axum::{Router, extract::State, routing::get};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    access::{Need, offering_access},
    auth::Identity,
    error::AppResult,
    extract::Query,
    response::{ApiOk, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/ranklist", get(ranklist))
}

/// 分页：page 从 1 开始，page_size 取 1–100。返回 (limit, offset)。
/// 查询结构体不能用 serde(flatten)：urlencoded 下数字字段会解析失败。
pub fn limit_offset(page: Option<u32>, page_size: Option<u32>, default_size: u32) -> (u32, u32) {
    let limit = page_size.unwrap_or(default_size).clamp(1, 100);
    (limit, (page.unwrap_or(1).max(1) - 1) * limit)
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct RankQuery {
    #[serde(default)]
    #[ts(optional)]
    pub offering_id: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub page: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub page_size: Option<u32>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct RankItem {
    pub rank: u32,
    pub user_id: String,
    pub nick: String,
    #[ts(type = "number")]
    pub solved: i64,
    #[ts(type = "number")]
    pub submit: i64,
    pub pass_rate: f64,
    #[serde(with = "crate::dt::opt")]
    #[ts(type = "string | null")]
    pub last_submit: Option<NaiveDateTime>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct RankList {
    pub items: Vec<RankItem>,
    #[ts(type = "number")]
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    /// 当前用户在本页的名次；不在本页为 null。
    pub my_rank: Option<u32>,
}

struct Row {
    user_id: String,
    nick: String,
    solved: i64,
    submit: i64,
    last_submit: Option<NaiveDateTime>,
}

async fn ranklist(State(s): State<AppState>, who: Identity, Query(q): Query<RankQuery>) -> AppResult<ApiOk<RankList>> {
    let (limit, offset) = limit_offset(q.page, q.page_size, 50);
    let (rows, total) = match q.offering_id.filter(|&o| o > 0) {
        Some(oid) => {
            offering_access(&s.db, &who, oid, Need::READ).await?;
            let rows = sqlx::query_as!(
                Row,
                r#"SELECT e.user_id, COALESCE(NULLIF(u.nick,''), e.user_id) AS "nick!: String",
                          COUNT(DISTINCT CASE WHEN s.result=4 AND s.problem_id>0 THEN s.problem_id END) AS "solved!: i64",
                          COUNT(CASE WHEN s.problem_id>0 THEN s.solution_id END) AS "submit!: i64",
                          MAX(s.in_date) AS "last_submit?: NaiveDateTime"
                   FROM cm_enrollment e
                   LEFT JOIN jol.users u ON u.user_id=e.user_id
                   LEFT JOIN cm_submission cs ON cs.user_id=e.user_id AND cs.offering_id=?
                   LEFT JOIN jol.solution s ON s.solution_id=cs.submission_id
                   WHERE e.offering_id=? AND e.role='student' AND e.status='active'
                   GROUP BY e.user_id, u.nick
                   ORDER BY 3 DESC, 4 ASC, 5 DESC
                   LIMIT ? OFFSET ?"#,
                oid,
                oid,
                limit,
                offset
            )
            .fetch_all(&s.db)
            .await?;
            let total = sqlx::query_scalar!(
                "SELECT COUNT(*) FROM cm_enrollment WHERE offering_id=? AND role='student' AND status='active'",
                oid
            )
            .fetch_one(&s.db)
            .await?;
            (rows, total)
        }
        None => {
            let rows = sqlx::query_as!(
                Row,
                r#"SELECT u.user_id, COALESCE(NULLIF(u.nick,''), u.user_id) AS "nick!: String",
                          COUNT(DISTINCT CASE WHEN s.result=4 AND s.problem_id>0 THEN s.problem_id END) AS "solved!: i64",
                          COUNT(CASE WHEN s.problem_id>0 THEN s.solution_id END) AS "submit!: i64",
                          MAX(s.in_date) AS "last_submit?: NaiveDateTime"
                   FROM jol.users u
                   LEFT JOIN jol.solution s ON s.user_id=u.user_id
                   WHERE u.defunct='N' AND u.user_id<>'admin'
                     AND u.user_id NOT LIKE 'teacher\_%' AND u.user_id NOT LIKE 'test\_%'
                     AND u.user_id NOT IN ('cm_pilot_teacher','cm_pilot_ta','cm_pilot_outsider')
                     AND u.user_id NOT IN (SELECT user_id FROM jol.privilege WHERE rightstr IN ('administrator','teacher'))
                   GROUP BY u.user_id, u.nick
                   ORDER BY 3 DESC, 4 ASC, 5 DESC
                   LIMIT ? OFFSET ?"#,
                limit,
                offset
            )
            .fetch_all(&s.db)
            .await?;
            let total = sqlx::query_scalar!(
                r"SELECT COUNT(*) FROM jol.users u
                  WHERE u.defunct='N' AND u.user_id<>'admin'
                    AND u.user_id NOT LIKE 'teacher\_%' AND u.user_id NOT LIKE 'test\_%'
                    AND u.user_id NOT IN ('cm_pilot_teacher','cm_pilot_ta','cm_pilot_outsider')
                    AND u.user_id NOT IN (SELECT user_id FROM jol.privilege WHERE rightstr IN ('administrator','teacher'))"
            )
            .fetch_one(&s.db)
            .await?;
            (rows, total)
        }
    };
    let items: Vec<RankItem> = rows
        .into_iter()
        .enumerate()
        .map(|(i, r)| RankItem {
            rank: offset + i as u32 + 1,
            pass_rate: if r.submit > 0 { (r.solved as f64 / r.submit as f64 * 1000.0).round() / 10.0 } else { 0.0 },
            user_id: r.user_id,
            nick: r.nick,
            solved: r.solved,
            submit: r.submit,
            last_submit: r.last_submit,
        })
        .collect();
    let my_rank = items.iter().find(|r| r.user_id == who.user).map(|r| r.rank);
    Ok(ok(RankList { items, total, page: q.page.unwrap_or(1).max(1), page_size: limit, my_rank }))
}
