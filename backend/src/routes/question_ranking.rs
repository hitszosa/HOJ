//! 每道作业题的班级成绩排名，仅任课教师可读；先排名再搜索，避免页码改变名次。
use axum::{Router, extract::State, routing::get};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use crate::{access::{Need, batch_access}, auth::Identity, error::{AppError, AppResult}, extract::{Path, Query}, hustoj, response::{ApiOk, ok}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/batches/{bid}/problems/{pid}/teacher-ranking", get(ranking))
}

#[derive(Default, Deserialize)]
struct RankingQuery { page: Option<u32>, page_size: Option<u32>, search: Option<String> }
#[derive(Serialize, FromRow)]
struct Entry {
    user_id: String, student_no: String, nick: String,
    rank: Option<i64>, score: Option<f64>, submission_id: Option<u32>, result: Option<i16>,
    attempts: i64, time: Option<i32>, memory: Option<i32>,
    #[sqlx(skip)]
    label: String,
}
#[derive(Serialize)]
struct Ranking { batch_id: u32, problem_id: i32, title: String, page: u32, page_size: u32, total: i64, students: Vec<Entry> }

async fn ranking(State(s): State<AppState>, who: Identity, Path((bid,pid)): Path<(u32,i32)>, Query(q): Query<RankingQuery>) -> AppResult<ApiOk<Ranking>> {
    let (_, off) = batch_access(&s.db, &who, bid, Need::TEACH).await?;
    let title = sqlx::query_scalar::<_,String>("SELECT p.title FROM cm_batch_problem bp JOIN jol.problem p ON p.problem_id=bp.problem_id WHERE bp.batch_id=? AND bp.problem_id=?")
        .bind(bid).bind(pid).fetch_optional(&s.db).await?.ok_or_else(||AppError::not_found("本作业中没有这道题"))?;
    let search=q.search.unwrap_or_default(); let search=search.trim();
    if search.chars().count()>100 {return Err(AppError::validation("搜索内容不能超过 100 个字符"));}
    let pattern=format!("%{}%", search.replace('=',"==").replace('%',"=%").replace('_',"=_"));
    let total=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM cm_enrollment e JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci WHERE e.offering_id=? AND e.role='student' AND (e.status='active' OR ?=1) AND u.defunct='N' AND (e.user_id LIKE ? ESCAPE '=' OR e.student_no LIKE ? ESCAPE '=' OR u.nick LIKE ? ESCAPE '=')")
        .bind(off.offering_id).bind(off.archived()).bind(&pattern).bind(&pattern).bind(&pattern).fetch_one(&s.db).await?;
    let page_size=q.page_size.unwrap_or(20).clamp(1,50);
    let page=q.page.unwrap_or(1).max(1).min((total as u64).div_ceil(page_size as u64).max(1) as u32);
    // 与学生详情使用同一最佳提交规则：AC 优先，其次最新已完成评测，最后等待中的提交。
    // 仅本班、本作业、本题且已正式提交的记录参与，题库练习不能带入排名。
    let mut students=sqlx::query_as::<_,Entry>(r#"
        WITH best AS (
          SELECT cs.user_id,cs.submission_id,s.result,s.time,s.memory,
            COUNT(*) OVER(PARTITION BY cs.user_id) AS attempts,
            ROW_NUMBER() OVER(PARTITION BY cs.user_id ORDER BY CASE WHEN s.result=4 THEN 0 WHEN s.result IN (0,1,2,3,14) THEN 2 ELSE 1 END,s.solution_id DESC) AS position
          FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id AND s.user_id=cs.user_id COLLATE utf8mb4_general_ci
          WHERE cs.offering_id=? AND cs.batch_id=? AND s.problem_id=? AND cs.submit_state='promoted'
        ), scored AS (
          SELECT e.user_id,COALESCE(NULLIF(e.student_no,''),e.user_id) AS student_no,COALESCE(NULLIF(u.nick,''),e.user_id) AS nick,
            best.submission_id,best.result,CAST(COALESCE(best.attempts,0) AS SIGNED) AS attempts,best.time,best.memory,
            CAST(CASE WHEN best.result=4 THEN 100 WHEN best.result IS NULL OR best.result IN (0,1,2,3,14) THEN NULL ELSE 0 END AS DOUBLE) AS score
          FROM cm_enrollment e JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci
          LEFT JOIN best ON best.user_id=e.user_id COLLATE utf8mb4_general_ci AND best.position=1
          WHERE e.offering_id=? AND e.role='student' AND (e.status='active' OR ?=1) AND u.defunct='N'
        ), ranked AS (
          SELECT scored.*,CASE WHEN score IS NULL THEN NULL ELSE CAST(DENSE_RANK() OVER(ORDER BY score DESC) AS SIGNED) END AS `rank` FROM scored
        )
        SELECT * FROM ranked WHERE user_id LIKE ? ESCAPE '=' OR student_no LIKE ? ESCAPE '=' OR nick LIKE ? ESCAPE '='
        ORDER BY score IS NULL,score DESC,student_no,user_id LIMIT ? OFFSET ?
    "#).bind(off.offering_id).bind(bid).bind(pid).bind(off.offering_id).bind(off.archived())
        .bind(&pattern).bind(&pattern).bind(&pattern).bind(page_size).bind((page as u64-1)*page_size as u64).fetch_all(&s.db).await?;
    for student in &mut students { student.label=student.result.map(hustoj::result_label).unwrap_or("未提交").to_owned(); }
    Ok(ok(Ranking {batch_id:bid,problem_id:pid,title,page,page_size,total,students}))
}
