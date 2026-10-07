//! 班级 → 学生 → 题单 → 每题最好结果；代码通过既有提交权限接口读取。
use std::collections::BTreeMap;
use axum::{Router,extract::State,routing::get};
use serde::{Deserialize,Serialize};
use sqlx::{FromRow,MySql,QueryBuilder};
use crate::{access::{Need,offering_access},auth::Identity,error::{AppError,AppResult},extract::{Path,Query},hustoj,response::{ApiOk,ok},state::AppState};

pub fn router()->Router<AppState>{Router::new().route("/api/offerings/{oid}/students/{uid}/progress",get(progress)).route("/api/offerings/{oid}/student-roster",get(roster))}
#[derive(Serialize,FromRow)]
struct Student{user_id:String,student_no:String,nick:String}
#[derive(Default,Deserialize)]
struct RosterQuery{page:Option<u32>,page_size:Option<u32>,search:Option<String>,batch_id:Option<u32>}
#[derive(Serialize,FromRow)]
struct AssignmentGrade{score:f64,passed:i64,problem_count:i64,attempts:i64,pending:i64}
#[derive(Serialize)]
struct RosterStudent{#[serde(flatten)]student:Student,grade:Option<AssignmentGrade>}
#[derive(FromRow)]
struct GradeRow{user_id:String,score:f64,passed:i64,problem_count:i64,attempts:i64,pending:i64,total_weight:f64,passed_weight:f64}
#[derive(Serialize)]
struct Roster{offering_id:u32,batch_id:Option<u32>,page:u32,page_size:u32,total:i64,students:Vec<RosterStudent>}
async fn roster(State(s):State<AppState>,who:Identity,Path(oid):Path<u32>,Query(query):Query<RosterQuery>)->AppResult<ApiOk<Roster>>{
 let off=offering_access(&s.db,&who,oid,Need::TEACH).await?;
 if let Some(bid)=query.batch_id{
  let valid=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM cm_batch WHERE batch_id=? AND offering_id=? AND status IN ('published','closed')").bind(bid).bind(oid).fetch_one(&s.db).await?;
  if valid!=1{return Err(AppError::not_found("本班没有这次已发布作业"));}
 }
 let page_size=query.page_size.unwrap_or(20).clamp(1,50);
 let search=query.search.unwrap_or_default();let search=search.trim();
 if search.chars().count()>100{return Err(AppError::validation("搜索内容不能超过 100 个字符"));}
 // Treat LIKE wildcards as literal student-name characters, using an explicit escape.
 let pattern=format!("%{}%",search.replace('=',"==").replace('%',"=%").replace('_',"=_"));
 let filter=" FROM cm_enrollment e JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci WHERE e.offering_id=? AND e.role='student' AND (e.status='active' OR ?=1) AND u.defunct='N' AND (e.user_id LIKE ? ESCAPE '=' OR e.student_no LIKE ? ESCAPE '=' OR u.nick LIKE ? ESCAPE '=')";
 let count=sqlx::query_scalar::<_,i64>(&format!("SELECT COUNT(*){filter}"))
  .bind(oid).bind(off.archived()).bind(&pattern).bind(&pattern).bind(&pattern).fetch_one(&s.db).await?;
 let last=((count as u64).div_ceil(page_size as u64)).max(1) as u32;
 let page=query.page.unwrap_or(1).max(1).min(last);
 let students=sqlx::query_as::<_,Student>(&format!("SELECT e.user_id,COALESCE(NULLIF(e.student_no,''),e.user_id) AS student_no,COALESCE(NULLIF(u.nick,''),e.user_id) AS nick{filter} ORDER BY COALESCE(NULLIF(e.student_no,''),e.user_id),e.user_id LIMIT ? OFFSET ?"))
  .bind(oid).bind(off.archived()).bind(&pattern).bind(&pattern).bind(&pattern).bind(page_size).bind((page as u64-1)*page_size as u64).fetch_all(&s.db).await?;
 let mut grades=BTreeMap::new();
 if let Some(bid)=query.batch_id.filter(|_|!students.is_empty()){
  // 只计算当前页学生、所选作业，不加载全班全部作业，也不逐个请求学生详情。
  let mut q=QueryBuilder::<MySql>::new("WITH progress AS (SELECT cs.user_id,s.problem_id,MAX(s.result=4) AS passed,MAX(s.result NOT IN (0,1,2,3,14)) AS completed,COUNT(*) AS attempts FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id AND s.user_id=cs.user_id COLLATE utf8mb4_general_ci WHERE cs.submit_state='promoted' AND cs.offering_id=");
  q.push_bind(oid).push(" AND cs.batch_id=").push_bind(bid).push(" AND cs.user_id IN (");
  let mut ids=q.separated(",");for student in &students{ids.push_bind(&student.user_id);}ids.push_unseparated(") GROUP BY cs.user_id,s.problem_id) ");
  q.push("SELECT e.user_id,CAST(0 AS DOUBLE) AS score,CAST(COUNT(CASE WHEN bp.required=1 AND bp.score>0 AND progress.passed=1 THEN bp.problem_id END) AS SIGNED) AS passed,CAST(COUNT(CASE WHEN bp.required=1 AND bp.score>0 THEN bp.problem_id END) AS SIGNED) AS problem_count,CAST(COALESCE(SUM(progress.attempts),0) AS SIGNED) AS attempts,CAST(COUNT(CASE WHEN progress.attempts>0 AND progress.completed=0 THEN bp.problem_id END) AS SIGNED) AS pending,CAST(COALESCE(SUM(CASE WHEN bp.required=1 THEN bp.score ELSE 0 END),0) AS DOUBLE) AS total_weight,CAST(COALESCE(SUM(CASE WHEN bp.required=1 AND progress.passed=1 THEN bp.score ELSE 0 END),0) AS DOUBLE) AS passed_weight FROM cm_enrollment e JOIN cm_batch b ON b.offering_id=e.offering_id AND b.batch_id=").push_bind(bid);
  q.push(" LEFT JOIN cm_batch_problem bp ON bp.batch_id=b.batch_id LEFT JOIN progress ON progress.user_id=e.user_id COLLATE utf8mb4_general_ci AND progress.problem_id=bp.problem_id WHERE e.offering_id=").push_bind(oid).push(" AND e.user_id IN (");
  let mut ids=q.separated(",");for student in &students{ids.push_bind(&student.user_id);}ids.push_unseparated(") GROUP BY e.user_id");
  for mut row in q.build_query_as::<GradeRow>().fetch_all(&s.db).await?{
   row.score=if row.total_weight>0.0{(row.passed_weight*10000.0/row.total_weight).round()/100.0}else{0.0};
   grades.insert(row.user_id,AssignmentGrade{score:row.score,passed:row.passed,problem_count:row.problem_count,attempts:row.attempts,pending:row.pending});
  }
 }
 let students=students.into_iter().map(|student|RosterStudent{grade:grades.remove(&student.user_id),student}).collect();
 Ok(ok(Roster{offering_id:oid,batch_id:query.batch_id,page,page_size,total:count,students}))
}
#[derive(FromRow)]
struct Row{batch_id:u32,batch_title:String,batch_seq:u32,problem_id:i32,problem_title:String,weight:f64,required:i8,submission_id:Option<u32>,result:Option<i16>,attempts:i64}
#[derive(Serialize)]
struct ProblemProgress{problem_id:i32,title:String,weight:f64,score:Option<f64>,contribution:f64,submission_id:Option<u32>,result:Option<i16>,label:&'static str,attempts:i64}
#[derive(Serialize)]
struct BatchProgress{batch_id:u32,title:String,score:f64,total_weight:f64,problems:Vec<ProblemProgress>}
#[derive(Serialize)]
struct Progress{offering_id:u32,student:Student,batches:Vec<BatchProgress>}

fn best_score(result:Option<i16>)->Option<f64>{match result{Some(4)=>Some(100.0),Some(0|1|2|3|14)|None=>None,Some(_)=>Some(0.0)}}
async fn progress(State(s):State<AppState>,who:Identity,Path((oid,uid)):Path<(u32,String)>)->AppResult<ApiOk<Progress>>{
 let off=offering_access(&s.db,&who,oid,Need::TEACH).await?;
 let student=sqlx::query_as::<_,Student>("SELECT e.user_id,COALESCE(NULLIF(e.student_no,''),e.user_id) AS student_no,COALESCE(NULLIF(u.nick,''),e.user_id) AS nick FROM cm_enrollment e JOIN jol.users u ON u.user_id=e.user_id COLLATE utf8mb4_general_ci WHERE e.offering_id=? AND e.user_id=? AND e.role='student' AND (e.status='active' OR ?=1) AND u.defunct='N'")
  .bind(oid).bind(&uid).bind(off.archived()).fetch_optional(&s.db).await?.ok_or_else(||AppError::not_found("本班学生不存在或已退出"))?;
 // 一次查询所有题单：AC 优先，之后选最新已完成判题，再选尚在判题的提交。
 // 同分取较新提交；每道题的代码按钮使用同一条 submission_id。
 let rows=sqlx::query_as::<_,Row>(r#"
 SELECT b.batch_id,b.title AS batch_title,b.seq AS batch_seq,bp.problem_id,p.title AS problem_title,
 CAST(bp.score AS DOUBLE) AS weight,CAST(bp.required AS SIGNED) AS required,
 best.submission_id,best.result,CAST(COALESCE(best.attempts,0) AS SIGNED) AS attempts
 FROM cm_batch b JOIN cm_batch_problem bp ON bp.batch_id=b.batch_id JOIN jol.problem p ON p.problem_id=bp.problem_id
 LEFT JOIN (
  SELECT cs.batch_id,s.problem_id,cs.submission_id,s.result,
   COUNT(*) OVER(PARTITION BY cs.batch_id,s.problem_id) AS attempts,
   ROW_NUMBER() OVER(PARTITION BY cs.batch_id,s.problem_id ORDER BY CASE WHEN s.result=4 THEN 0 WHEN s.result IN (0,1,2,3,14) THEN 2 ELSE 1 END,s.solution_id DESC) AS position
  FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id
  WHERE cs.offering_id=? AND cs.user_id=? AND s.user_id=? AND cs.submit_state='promoted'
 ) best ON best.batch_id=b.batch_id AND best.problem_id=bp.problem_id AND best.position=1
 WHERE b.offering_id=? AND b.status IN ('published','closed') ORDER BY b.seq,b.batch_id,bp.seq
 "#).bind(oid).bind(&uid).bind(&uid).bind(oid).fetch_all(&s.db).await?;
 let mut batches:BTreeMap<(u32,u32),BatchProgress>=BTreeMap::new();
 for row in rows{
  let batch=batches.entry((row.batch_seq,row.batch_id)).or_insert_with(||BatchProgress{batch_id:row.batch_id,title:row.batch_title.clone(),score:0.0,total_weight:0.0,problems:vec![]});
  let weight=if row.required!=0{row.weight}else{0.0};
  batch.total_weight+=weight;
  batch.problems.push(ProblemProgress{problem_id:row.problem_id,title:row.problem_title,weight,score:best_score(row.result),contribution:0.0,submission_id:row.submission_id,result:row.result,label:row.result.map(hustoj::result_label).unwrap_or("未提交"),attempts:row.attempts});
 }
 for batch in batches.values_mut(){
  let passed:f64=batch.problems.iter().filter(|p|p.result==Some(4)).map(|p|p.weight).sum();
  batch.score=if batch.total_weight>0.0{(passed*10000.0/batch.total_weight).round()/100.0}else{0.0};
  for p in &mut batch.problems{p.contribution=if p.result==Some(4)&&batch.total_weight>0.0{(p.weight*10000.0/batch.total_weight).round()/100.0}else{0.0};}
 }
 Ok(ok(Progress{offering_id:oid,student,batches:batches.into_values().collect()}))
}

#[cfg(test)]mod tests{use super::*;#[test]fn pending_and_missing_are_not_final_zero_scores(){assert_eq!(best_score(None),None);for r in [0,1,2,3,14]{assert_eq!(best_score(Some(r)),None);}assert_eq!(best_score(Some(4)),Some(100.0));assert_eq!(best_score(Some(6)),Some(0.0));}}
