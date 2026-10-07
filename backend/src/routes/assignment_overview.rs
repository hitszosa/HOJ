//! 教学管理总览、课程卡片使用实际发布的编程作业；与学生可见范围一致。
use std::collections::BTreeMap;
use axum::{Router, extract::State, routing::get};
use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::FromRow;
use crate::{auth::Identity, error::AppResult, response::{ApiOk,ok}, state::AppState};

pub fn router()->Router<AppState>{Router::new().route("/api/management/assignment-overview",get(overview))}
#[derive(Serialize)]
struct Work {
 batch_id:u32,title:String,status:String,
 #[serde(with="crate::dt::opt")] open_at:Option<NaiveDateTime>,
 #[serde(with="crate::dt::opt")] due_at:Option<NaiveDateTime>,
 accepting:bool,
}
#[derive(Serialize)]
struct Summary {offering_id:u32,assignment_count:i64,open_count:i64,recent:Vec<Work>}
#[derive(FromRow)]
struct Row {offering_id:u32,batch_id:u32,title:String,status:String,open_at:Option<NaiveDateTime>,due_at:Option<NaiveDateTime>,accepting:i8,assignment_count:i64,open_count:i64}
async fn overview(State(s):State<AppState>,who:Identity)->AppResult<ApiOk<Vec<Summary>>>{
 let rows=sqlx::query_as::<_,Row>(r#"
  WITH visible AS (
   SELECT o.offering_id,b.batch_id,b.title,b.status,b.open_at,b.due_at,b.created_at,
    CAST(b.status='published' AND (b.open_at IS NULL OR b.open_at<=NOW()) AND (b.allow_late=1 OR b.due_at IS NULL OR b.due_at>=NOW()) AS SIGNED) AS accepting
   FROM cm_batch b JOIN cm_offering o ON o.offering_id=b.offering_id
   LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id=? AND e.status='active'
   WHERE o.status='active' AND b.status IN ('published','closed')
    AND (?=1 OR o.teacher_id=? OR e.user_id IS NOT NULL)
    AND (?=1 OR o.teacher_id=? OR e.role IN ('teacher','ta') OR b.open_at IS NULL OR b.open_at<=NOW())
  ), numbered AS (
   SELECT visible.*,CAST(COUNT(*) OVER(PARTITION BY offering_id) AS SIGNED) AS assignment_count,
    CAST(SUM(accepting) OVER(PARTITION BY offering_id) AS SIGNED) AS open_count,
    ROW_NUMBER() OVER(PARTITION BY offering_id ORDER BY created_at DESC,batch_id DESC) AS position
   FROM visible
  ) SELECT offering_id,batch_id,title,status,open_at,due_at,accepting,assignment_count,open_count FROM numbered WHERE position<=3 ORDER BY offering_id,position
 "#).bind(&who.user).bind(who.is_admin()).bind(&who.user).bind(who.is_admin()).bind(&who.user).fetch_all(&s.db).await?;
 let mut summaries:BTreeMap<u32,Summary>=BTreeMap::new();
 for row in rows {
  let summary=summaries.entry(row.offering_id).or_insert_with(||Summary{offering_id:row.offering_id,assignment_count:row.assignment_count,open_count:row.open_count,recent:vec![]});
  summary.recent.push(Work{batch_id:row.batch_id,title:row.title,status:row.status,open_at:row.open_at,due_at:row.due_at,accepting:row.accepting!=0});
 }
 Ok(ok(summaries.into_values().collect()))
}
