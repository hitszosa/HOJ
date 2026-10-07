//! Course assignment edits and physical deletion, including judge data and grading.
use std::path::PathBuf;
use sha2::{Digest,Sha256};
use tokio::io::AsyncWriteExt;
use crate::{access::{self,Need},auth::Identity,authoring,course_deletion as cleanup,document::{self,Document},error::{AppError,AppResult},hustoj,state::AppState};

pub async fn document(s:&AppState,who:&Identity,bid:u32)->AppResult<Document>{
    let (b,_)=access::batch_access(&s.db,who,bid,Need::TEACH_WRITE).await?;
    #[derive(sqlx::FromRow)]
    struct Row{problem_id:i32,title:String,description:Option<String>,sample_input:Option<String>,sample_output:Option<String>,hint:Option<String>,source:Option<String>,score:f64}
    let rows=sqlx::query_as::<_,Row>("SELECT p.problem_id,p.title,p.description,p.sample_input,p.sample_output,p.hint,p.source,CAST(bp.score AS DOUBLE) AS score FROM cm_batch_problem bp JOIN jol.problem p USING(problem_id) WHERE bp.batch_id=? ORDER BY bp.seq").bind(bid).fetch_all(&s.db).await?;
    let mut problems=Vec::new();
    for p in rows{
        let slug=p.source.as_deref().filter(|x|x.starts_with("codemind:authoring/")).and_then(|x|x.rsplit('/').next()).map(str::to_owned).unwrap_or_else(||format!("problem-{}",p.problem_id));
        problems.push(serde_json::json!({"problem_id":p.problem_id,"slug":slug,"title":p.title,"statement":p.description.filter(|x|!x.trim().is_empty()).unwrap_or_else(||"请核对题目描述".into()),"score":p.score,"knowledge":p.hint.unwrap_or_default().split('、').filter(|x|!x.is_empty()).collect::<Vec<_>>(),"samples":[{"input":p.sample_input.unwrap_or_default(),"output":p.sample_output.unwrap_or_default()}],"tests":hustoj::read_test_files(s,p.problem_id).await?}));
    }
    // Imported sets may contain repeated slugs from different source sets.
    let mut seen=std::collections::HashSet::new();
    for p in &mut problems{let slug=p["slug"].as_str().unwrap().to_owned();if !seen.insert(slug){p["slug"]=serde_json::json!(format!("problem-{}",p["problem_id"]));}}
    let mut doc=document::validate(serde_json::json!({"title":b.title,"read_only":b.read_only,"source_ref":b.source_ref,"allowed_languages":b.allowed_languages.join(","),"problems":problems}))?;
    let revision=format!("{:x}",Sha256::digest(serde_json::to_vec(&doc).map_err(|e|AppError::internal(e.to_string()))?));
    doc.extra.insert("revision".into(),serde_json::json!(revision));Ok(doc)
}

pub async fn require_idle(s:&AppState,bid:u32)->AppResult<()> {
    let n=sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.batch_id=? AND (s.result BETWEEN 0 AND 3 OR s.result=14)").bind(bid).fetch_one(&s.db).await?;
    if n>0{return Err(AppError::conflict("作业还有评测正在执行，请等评测完成后重试删改"));}Ok(())
}

async fn backup(s:&AppState,bid:u32,pids:&[i32],sids:&[u32])->AppResult<PathBuf>{
    let dir=s.cfg.root.join("data/local/assignment-backups").join(format!("{bid}-{}",authoring::new_draft_id()));tokio::fs::create_dir_all(&dir).await.map_err(cleanup::io_error)?;
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;tokio::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700)).await.map_err(cleanup::io_error)?;}
    let mut out=tokio::fs::File::create(dir.join("rows.jsonl")).await.map_err(cleanup::io_error)?;
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;out.set_permissions(std::fs::Permissions::from_mode(0o600)).await.map_err(cleanup::io_error)?;}
    for (t,filter) in [("cm_batch",format!("batch_id={bid}")),("cm_batch_problem",format!("batch_id={bid}")),("cm_submission",format!("batch_id={bid}")),("cm_authoring_draft",format!("batch_id={bid} OR draft_id IN (SELECT authoring_key FROM cm_batch WHERE batch_id={bid})"))]{cleanup::snapshot(&s.db,"codemind_course",t,&filter,&mut out).await?;}
    if !sids.is_empty(){let ids=cleanup::numbers(sids);for t in ["solution","source_code","source_code_user","compileinfo","runtimeinfo","custominput","solution_ai_answer","openai_task_queue"]{cleanup::snapshot(&s.ops,"jol",t,&format!("solution_id IN ({ids})"),&mut out).await?;}cleanup::snapshot(&s.ops,"jol","sim",&format!("s_id IN ({ids}) OR sim_s_id IN ({ids})"),&mut out).await?;}
    for pid in pids{cleanup::snapshot(&s.ops,"jol","problem",&format!("problem_id={pid}"),&mut out).await?;cleanup::backup_tests(s,*pid,&dir).await?;}
    out.write_all(b"{\"backup_complete\":true}\n").await.map_err(cleanup::io_error)?;out.sync_all().await.map_err(cleanup::io_error)?;Ok(dir)
}

pub async fn delete_submissions(s:&AppState,sids:&[u32])->AppResult<()> {
    if sids.is_empty(){return Ok(());}let ids=cleanup::numbers(sids);
    for t in ["source_code","source_code_user","compileinfo","runtimeinfo","custominput","solution_ai_answer","openai_task_queue"]{if cleanup::exists(&s.ops,"jol",t).await?{sqlx::query(&format!("DELETE FROM jol.`{t}` WHERE solution_id IN ({ids})")).execute(&s.ops).await?;}}
    if cleanup::exists(&s.ops,"jol","sim").await?{sqlx::query(&format!("DELETE FROM jol.sim WHERE s_id IN ({ids}) OR sim_s_id IN ({ids})")).execute(&s.ops).await?;}
    sqlx::query(&format!("DELETE FROM jol.solution WHERE solution_id IN ({ids})")).execute(&s.ops).await?;Ok(())
}
async fn clear_feedback(s:&AppState,sids:&[u32])->AppResult<()> {
    if sids.is_empty(){return Ok(());}let ids=cleanup::numbers(sids);
    for t in ["compileinfo","runtimeinfo","solution_ai_answer","openai_task_queue"]{if cleanup::exists(&s.ops,"jol",t).await?{sqlx::query(&format!("DELETE FROM jol.`{t}` WHERE solution_id IN ({ids})")).execute(&s.ops).await?;}}
    if cleanup::exists(&s.ops,"jol","sim").await?{sqlx::query(&format!("DELETE FROM jol.sim WHERE s_id IN ({ids}) OR sim_s_id IN ({ids})")).execute(&s.ops).await?;}Ok(())
}
pub async fn clean_problem(s:&AppState,pid:i32)->AppResult<()> {
    authoring::with_lock(&s.db,&format!("hoj:problem:{pid}"),async{
        let source=sqlx::query_scalar::<_,Option<String>>("SELECT source FROM jol.problem WHERE problem_id=?").bind(pid).fetch_optional(&s.ops).await?.flatten();
        let refs=sqlx::query_scalar::<_,i64>("SELECT (SELECT COUNT(*) FROM cm_batch_problem WHERE problem_id=?)+(SELECT COUNT(*) FROM jol.solution WHERE problem_id=?)+(SELECT COUNT(*) FROM cm_problem_knowledge WHERE problem_id=?)").bind(pid).bind(pid).bind(pid).fetch_one(&s.db).await?;
        if refs==0&&source.is_some_and(|x|x.starts_with("codemind:authoring/")){cleanup::remove_tests(s,pid).await?;sqlx::query("DELETE FROM jol.problem WHERE problem_id=?").bind(pid).execute(&s.ops).await?;}
        else{sqlx::query("UPDATE jol.problem SET submit=(SELECT COUNT(*) FROM jol.solution WHERE problem_id=?),accepted=(SELECT COUNT(*) FROM jol.solution WHERE problem_id=? AND result=4) WHERE problem_id=?").bind(pid).bind(pid).bind(pid).execute(&s.ops).await?;}Ok(())
    }).await
}
async fn recount_users(s:&AppState,users:&[String])->AppResult<()>{for user in users{sqlx::query("UPDATE jol.users SET submit=(SELECT COUNT(*) FROM jol.solution WHERE user_id=? AND problem_id>0),solved=(SELECT COUNT(DISTINCT problem_id) FROM jol.solution WHERE user_id=? AND problem_id>0 AND result=4) WHERE user_id=?").bind(user).bind(user).bind(user).execute(&s.ops).await?;}Ok(())}

pub async fn remove(s:&AppState,who:&Identity,bid:u32)->AppResult<()> {
    let (_,off)=access::batch_access(&s.db,who,bid,Need::TEACH_WRITE).await?;
    authoring::with_lock(&s.db,&format!("hoj:offering:{}",off.offering_id),async{
        access::batch_access(&s.db,who,bid,Need::TEACH_WRITE).await?;require_idle(s,bid).await?;
        let pids=sqlx::query_scalar::<_,i32>("SELECT problem_id FROM cm_batch_problem WHERE batch_id=?").bind(bid).fetch_all(&s.db).await?;
        let sids=sqlx::query_scalar::<_,u32>("SELECT submission_id FROM cm_submission WHERE batch_id=?").bind(bid).fetch_all(&s.db).await?;
        let users=sqlx::query_scalar::<_,String>("SELECT DISTINCT user_id FROM cm_submission WHERE batch_id=?").bind(bid).fetch_all(&s.db).await?;
        backup(s,bid,&pids,&sids).await?;
        sqlx::query("UPDATE cm_batch SET status='closed' WHERE batch_id=?").bind(bid).execute(&s.db).await?;
        delete_submissions(s,&sids).await?;
        let mut tx=s.db.begin().await?;
        sqlx::query("DELETE FROM cm_submission WHERE batch_id=?").bind(bid).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM cm_batch_problem WHERE batch_id=?").bind(bid).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM cm_authoring_draft WHERE batch_id=? OR draft_id IN (SELECT authoring_key FROM cm_batch WHERE batch_id=?)").bind(bid).bind(bid).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM cm_batch WHERE batch_id=?").bind(bid).execute(&mut *tx).await?;tx.commit().await?;
        for pid in pids{clean_problem(s,pid).await?;}recount_users(s,&users).await?;Ok(())
    }).await
}

fn content(p:&document::Problem)->serde_json::Value{serde_json::json!({"title":p.title,"statement":p.statement,"samples":p.samples,"tests":p.tests,"knowledge":p.knowledge})}
pub async fn update(s:&AppState,who:&Identity,bid:u32,mut doc:Document)->AppResult<()> {
    let (batch,off)=access::batch_access(&s.db,who,bid,Need::TEACH_WRITE).await?;document::check_publishable(&doc)?;
    authoring::with_lock(&s.db,&format!("hoj:offering:{}",off.offering_id),async{
        access::batch_access(&s.db,who,bid,Need::TEACH_WRITE).await?;require_idle(s,bid).await?;
        let old=document(s,who,bid).await?;
        if doc.extra.get("revision")!=old.extra.get("revision"){return Err(AppError::conflict("作业已被修改，请重新加载后再编辑"));}
        let pid_of=|p:&document::Problem|p.extra.get("problem_id").and_then(serde_json::Value::as_i64).map(|v|v as i32);
        let originals:std::collections::HashMap<i32,&document::Problem>=old.problems.iter().filter_map(|p|Some((pid_of(p)?,p))).collect();
        let mut seen=std::collections::HashSet::new();
        for p in &doc.problems{if let Some(pid)=pid_of(p){if !originals.contains_key(&pid)||!seen.insert(pid){return Err(AppError::unprocessable("作业题目关联无效"));}}}
        let submissions=sqlx::query_as::<_,(u32,i32,String)>("SELECT cs.submission_id,s.problem_id,cs.user_id FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.batch_id=?").bind(bid).fetch_all(&s.db).await?;
        let oldids=originals.keys().copied().collect::<Vec<_>>();let sids=submissions.iter().map(|x|x.0).collect::<Vec<_>>();backup(s,bid,&oldids,&sids).await?;
        sqlx::query("UPDATE cm_batch SET status='closed' WHERE batch_id=?").bind(bid).execute(&s.db).await?;
        let revision_key=authoring::new_draft_id();let mut newids=Vec::new();let mut rejudges=Vec::new();
        for p in &doc.problems{
            let prior=pid_of(p).and_then(|pid|originals.get(&pid).map(|q|(pid,*q)));
            let pid=if let Some((pid,q))=prior.filter(|(_,q)|content(q)==content(p)){let _=q;pid}else{
                let fresh=authoring::sync_problem(s,&revision_key,p).await?;
                if let Some((pid,_))=prior{for (sid,oldpid,_) in &submissions{if *oldpid==pid{sqlx::query("UPDATE jol.solution SET problem_id=?,result=14 WHERE solution_id=?").bind(fresh).bind(sid).execute(&s.ops).await?;rejudges.push(*sid);}}}
                sqlx::query("UPDATE jol.problem SET defunct='N' WHERE problem_id=?").bind(fresh).execute(&s.ops).await?;fresh
            };newids.push(pid);
        }
        let removed=submissions.iter().filter(|(_,pid,_)|!seen.contains(pid)).map(|x|x.0).collect::<Vec<_>>();delete_submissions(s,&removed).await?;clear_feedback(s,&rejudges).await?;
        doc.read_only|=batch.read_only;doc.source_ref=batch.source_ref.clone();doc.extra.remove("revision");
        for (p,pid) in doc.problems.iter_mut().zip(&newids){p.extra.insert("problem_id".into(),serde_json::json!(pid));}
        let mut tx=s.db.begin().await?;
        if !removed.is_empty(){sqlx::query(&format!("DELETE FROM cm_submission WHERE submission_id IN ({})",cleanup::numbers(&removed))).execute(&mut *tx).await?;}
        sqlx::query("DELETE FROM cm_batch_problem WHERE batch_id=?").bind(bid).execute(&mut *tx).await?;
        for (i,(p,pid)) in doc.problems.iter().zip(&newids).enumerate(){sqlx::query("INSERT INTO cm_batch_problem(batch_id,problem_id,seq,score,created_at,updated_at) VALUES(?,?,?,?,NOW(),NOW())").bind(bid).bind(pid).bind(i as u32+1).bind(p.score).execute(&mut *tx).await?;}
        sqlx::query("UPDATE cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id JOIN cm_batch_problem bp ON bp.batch_id=cs.batch_id AND bp.problem_id=s.problem_id SET cs.batch_problem_id=bp.batch_problem_id WHERE cs.batch_id=?").bind(bid).execute(&mut *tx).await?;
        sqlx::query("UPDATE cm_batch SET title=?,status=?,updated_at=NOW() WHERE batch_id=?").bind(&doc.title).bind(&batch.status).bind(bid).execute(&mut *tx).await?;
        sqlx::query("UPDATE cm_authoring_draft SET title=?,payload=?,updated_at=NOW() WHERE batch_id=?").bind(&doc.title).bind(serde_json::to_string(&doc).map_err(|e|AppError::internal(e.to_string()))?).bind(bid).execute(&mut *tx).await?;tx.commit().await?;
        for pid in oldids{clean_problem(s,pid).await?;}
        if !rejudges.is_empty(){sqlx::query(&format!("UPDATE jol.solution SET result=0 WHERE solution_id IN ({}) AND result=14",cleanup::numbers(&rejudges))).execute(&s.ops).await?;}
        for pid in newids{clean_problem(s,pid).await?;}recount_users(s,&submissions.into_iter().map(|x|x.2).collect::<Vec<_>>()).await?;Ok(())
    }).await
}
