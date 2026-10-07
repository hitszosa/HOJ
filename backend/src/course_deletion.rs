//! Physical deletion of one teaching offering. Back up exact scoped rows before mutation.
use std::{path::Path};
use sqlx::MySqlPool;
use tokio::io::AsyncWriteExt;
use crate::{authoring, error::{AppError, AppResult}, response::Empty, state::AppState};

pub async fn remove(s: &AppState, oid: u32, management_id: i64) -> AppResult<Empty> {
    authoring::with_lock(&s.db, &format!("hoj:offering:{oid}"), async {
        let course = sqlx::query_as::<_, (u32, String)>("SELECT c.course_id,c.code FROM cm_offering o JOIN cm_course c USING(course_id) WHERE o.offering_id=?")
            .bind(oid).fetch_optional(&s.db).await?;
        let Some((cid, code)) = course else { return Ok(Empty {}); };
        if code.starts_with("MGMT-") && code != format!("MGMT-{management_id}") {
            return Err(AppError::conflict("课程关联不一致，已取消删除"));
        }
        let busy = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cm_submission cs JOIN jol.solution s ON s.solution_id=cs.submission_id WHERE cs.offering_id=? AND (s.result BETWEEN 0 AND 3 OR s.result=14)")
            .bind(oid).fetch_one(&s.db).await?;
        if busy > 0 { return Err(AppError::conflict("课程还有评测正在执行，请等评测完成后重试删除")); }
        let sids = sqlx::query_scalar::<_, u32>("SELECT submission_id FROM cm_submission WHERE offering_id=? ORDER BY submission_id")
            .bind(oid).fetch_all(&s.db).await?;
        let users = sqlx::query_scalar::<_, String>("SELECT DISTINCT user_id FROM cm_submission WHERE offering_id=?")
            .bind(oid).fetch_all(&s.db).await?;
        let mut pids = sqlx::query_scalar::<_, i32>("SELECT DISTINCT bp.problem_id FROM cm_batch_problem bp JOIN cm_batch b USING(batch_id) WHERE b.offering_id=?")
            .bind(oid).fetch_all(&s.db).await?;
        // Include staged/unlinked questions from interrupted publication as well.
        pids.extend(sqlx::query_scalar::<_, i32>("SELECT p.problem_id FROM jol.problem p WHERE EXISTS(SELECT 1 FROM cm_authoring_draft d WHERE d.offering_id=? AND p.source LIKE CONCAT('codemind:authoring/',d.draft_id,'/%')) OR EXISTS(SELECT 1 FROM cm_batch b WHERE b.offering_id=? AND p.source LIKE CONCAT('codemind:authoring/',b.authoring_key,'/%'))")
            .bind(oid).bind(oid).fetch_all(&s.db).await?);
        pids.sort_unstable();pids.dedup();
        let ids = numbers(&sids);
        let dir = s.cfg.root.join("data/local/course-delete-backups").join(format!("{oid}-{}", uuid::Uuid::new_v4().simple()));
        tokio::fs::create_dir_all(&dir).await.map_err(io_error)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await.map_err(io_error)?; }
        let mut dump = tokio::fs::File::create(dir.join("rows.jsonl")).await.map_err(io_error)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; dump.set_permissions(std::fs::Permissions::from_mode(0o600)).await.map_err(io_error)?; }
        let scopes = [
            ("cm_course", format!("course_id={cid}")), ("cm_offering",format!("offering_id={oid}")),
            ("cm_enrollment",format!("offering_id={oid}")), ("cm_authoring_draft",format!("offering_id={oid}")),
            ("cm_batch",format!("offering_id={oid}")), ("cm_batch_problem",format!("batch_id IN (SELECT batch_id FROM cm_batch WHERE offering_id={oid})")),
            ("cm_submission",format!("offering_id={oid}")), ("cm_knowledge_point",format!("course_id={cid}")),
            ("cm_problem_knowledge",format!("kp_id IN (SELECT kp_id FROM cm_knowledge_point WHERE course_id={cid})")),
        ];
        for (table, condition) in scopes { snapshot(&s.db, "codemind_course", table, &condition, &mut dump).await?; }
        if !sids.is_empty() {
            for table in ["solution","source_code","source_code_user","compileinfo","runtimeinfo","custominput","solution_ai_answer","openai_task_queue"] {
                snapshot(&s.ops,"jol",table,&format!("solution_id IN ({ids})"),&mut dump).await?;
            }
            snapshot(&s.ops,"jol","sim",&format!("s_id IN ({ids}) OR sim_s_id IN ({ids})"),&mut dump).await?;
        }
        for pid in &pids { snapshot(&s.ops,"jol","problem",&format!("problem_id={pid}"),&mut dump).await?; }
        for pid in &pids {
            let source = sqlx::query_scalar::<_, Option<String>>("SELECT source FROM jol.problem WHERE problem_id=?")
                .bind(pid).fetch_optional(&s.ops).await?.flatten();
            if source.as_deref().is_some_and(|v| v.starts_with("codemind:authoring/")) {
                backup_tests(s,*pid,&dir).await?;
            }
        }
        dump.write_all(b"{\"backup_complete\":true}\n").await.map_err(io_error)?;
        dump.sync_all().await.map_err(io_error)?;
        // MyISAM rows cannot roll back. A failed cleanup stays closed and can be retried.
        sqlx::query("UPDATE cm_offering SET status='archived',updated_at=NOW() WHERE offering_id=?").bind(oid).execute(&s.db).await?;
        let mut tx = s.db.begin().await?;
        sqlx::query("SELECT offering_id FROM cm_offering WHERE offering_id=? FOR UPDATE").bind(oid).execute(&mut *tx).await?;
        if !sids.is_empty() {
            for table in ["source_code","source_code_user","compileinfo","runtimeinfo","custominput","solution_ai_answer","openai_task_queue"] {
                if exists(&s.ops,"jol",table).await? {
                    sqlx::query(&format!("DELETE FROM jol.`{table}` WHERE solution_id IN ({ids})")).execute(&s.ops).await?;
                }
            }
            if exists(&s.ops,"jol","sim").await? {
                sqlx::query(&format!("DELETE FROM jol.sim WHERE s_id IN ({ids}) OR sim_s_id IN ({ids})")).execute(&s.ops).await?;
            }
            sqlx::query(&format!("DELETE FROM jol.solution WHERE solution_id IN ({ids})")).execute(&s.ops).await?;
        }
        for user in &users {
            sqlx::query("UPDATE jol.users SET submit=(SELECT COUNT(*) FROM jol.solution WHERE user_id=? AND problem_id>0),solved=(SELECT COUNT(DISTINCT problem_id) FROM jol.solution WHERE user_id=? AND problem_id>0 AND result=4) WHERE user_id=?")
                .bind(user).bind(user).bind(user).execute(&s.ops).await?;
        }
        for pid in &pids {
            authoring::with_lock(&s.db, &format!("hoj:problem:{pid}"), async {
                let source = sqlx::query_scalar::<_, Option<String>>("SELECT source FROM jol.problem WHERE problem_id=?")
                    .bind(pid).fetch_optional(&s.ops).await?.flatten();
                let shared = sqlx::query_scalar::<_, i64>("SELECT (SELECT COUNT(*) FROM cm_batch_problem bp JOIN cm_batch b USING(batch_id) WHERE bp.problem_id=? AND b.offering_id<>?) + (SELECT COUNT(*) FROM jol.solution WHERE problem_id=?) + (SELECT COUNT(*) FROM cm_problem_knowledge pk JOIN cm_knowledge_point kp USING(kp_id) WHERE pk.problem_id=? AND kp.course_id<>?)")
                    .bind(pid).bind(oid).bind(pid).bind(pid).bind(cid).fetch_one(&s.db).await?;
                if source.as_deref().is_some_and(|v| v.starts_with("codemind:authoring/")) && shared == 0 {
                    remove_tests(s,*pid).await?;
                    sqlx::query("DELETE FROM jol.problem WHERE problem_id=?").bind(pid).execute(&s.ops).await?;
                } else {
                    sqlx::query("UPDATE jol.problem SET submit=(SELECT COUNT(*) FROM jol.solution WHERE problem_id=?),accepted=(SELECT COUNT(*) FROM jol.solution WHERE problem_id=? AND result=4) WHERE problem_id=?")
                        .bind(pid).bind(pid).bind(pid).execute(&s.ops).await?;
                }
                Ok(())
            }).await?;
        }
        for sql in [
            "DELETE FROM cm_submission WHERE offering_id=?",
            "DELETE bp FROM cm_batch_problem bp JOIN cm_batch b USING(batch_id) WHERE b.offering_id=?",
            "DELETE FROM cm_authoring_draft WHERE offering_id=?",
            "DELETE FROM cm_batch WHERE offering_id=?",
            "DELETE FROM cm_enrollment WHERE offering_id=?",
            "DELETE FROM cm_offering WHERE offering_id=?",
        ] { sqlx::query(sql).bind(oid).execute(&mut *tx).await?; }
        let remaining = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cm_offering WHERE course_id=?").bind(cid).fetch_one(&mut *tx).await?;
        if remaining == 0 {
            sqlx::query("DELETE pk FROM cm_problem_knowledge pk JOIN cm_knowledge_point kp USING(kp_id) WHERE kp.course_id=?").bind(cid).execute(&mut *tx).await?;
            // Unlink the self-referencing hierarchy before removing course knowledge points.
            sqlx::query("UPDATE cm_knowledge_point SET parent_id=NULL WHERE course_id=?").bind(cid).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM cm_knowledge_point WHERE course_id=?").bind(cid).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM cm_course WHERE course_id=?").bind(cid).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        tracing::info!(offering_id=oid,management_id,submissions=sids.len(),"Course physically deleted; scoped backup saved");
        Ok(Empty {})
    }).await
}

pub(crate) fn numbers<T: ToString>(ids: &[T]) -> String { ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(",") }
pub(crate) fn io_error(e: std::io::Error) -> AppError { AppError::unavailable(format!("删除备份或评测文件处理失败：{e}")) }
pub(crate) async fn exists(db: &MySqlPool, schema: &str, table: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?")
        .bind(schema).bind(table).fetch_one(db).await? == 1)
}
pub(crate) async fn snapshot(db: &MySqlPool, schema: &str, table: &str, condition: &str, file: &mut tokio::fs::File) -> AppResult<()> {
    let cols = sqlx::query_scalar::<_, String>("SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position")
        .bind(schema).bind(table).fetch_all(db).await?;
    if cols.is_empty() { return Ok(()); }
    let pairs = cols.iter().map(|c| format!("'{c}',`{c}`")).collect::<Vec<_>>().join(",");
    let order = cols.iter().map(|c| format!("`{c}`")).take(1).collect::<Vec<_>>().join(",");
    let mut offset = 0;
    loop {
        let rows = sqlx::query_scalar::<_, String>(&format!("SELECT CAST(JSON_OBJECT({pairs}) AS CHAR) FROM `{schema}`.`{table}` WHERE {condition} ORDER BY {order} LIMIT 100 OFFSET {offset}"))
            .fetch_all(db).await?;
        if rows.is_empty() { break; }
        for row in &rows {
            let value = serde_json::json!({"table":format!("{schema}.{table}"),"row":serde_json::from_str::<serde_json::Value>(row).map_err(|e| AppError::internal(e.to_string()))?});
            file.write_all(value.to_string().as_bytes()).await.map_err(io_error)?;file.write_all(b"\n").await.map_err(io_error)?;
        }
        offset += rows.len();
    }
    Ok(())
}
pub(crate) async fn backup_tests(s: &AppState, pid: i32, dir: &Path) -> AppResult<()> {
    if let Some(root) = &s.cfg.judge_data_dir {
        if !tokio::fs::try_exists(root.join(pid.to_string())).await.map_err(io_error)? { return Ok(()); }
        let status = tokio::process::Command::new("tar").arg("-czf").arg(dir.join(format!("problem-{pid}.tar.gz"))).arg("-C").arg(root).arg(pid.to_string()).status().await.map_err(io_error)?;
        if !status.success() { return Err(AppError::unavailable("隐藏测试备份失败，删除未完成")); }
    } else {
        let present = tokio::process::Command::new("docker").args(["exec",&s.cfg.hustoj_container,"test","-d",&format!("/home/judge/data/{pid}")]).status().await.map_err(io_error)?;
        if present.code() == Some(1) { return Ok(()); }
        if !present.success() { return Err(AppError::unavailable("无法检查隐藏测试目录")); }
        let out = std::fs::File::create(dir.join(format!("problem-{pid}.tar.gz"))).map_err(io_error)?;
        let status = tokio::process::Command::new("docker").args(["exec",&s.cfg.hustoj_container,"tar","-czf","-","-C","/home/judge/data",&pid.to_string()]).stdout(out).status().await.map_err(io_error)?;
        if !status.success() { return Err(AppError::unavailable("隐藏测试备份失败，删除未完成")); }
    }
    Ok(())
}
pub(crate) async fn remove_tests(s: &AppState, pid: i32) -> AppResult<()> {
    if let Some(root) = &s.cfg.judge_data_dir {
        let path = root.join(pid.to_string());
        if tokio::fs::try_exists(&path).await.map_err(io_error)? { tokio::fs::remove_dir_all(path).await.map_err(io_error)?; }
    } else {
        let status = tokio::process::Command::new("docker").args(["exec",&s.cfg.hustoj_container,"rm","-rf","--",&format!("/home/judge/data/{pid}")]).status().await.map_err(io_error)?;
        if !status.success() { return Err(AppError::unavailable("隐藏测试清理失败，删除未完成")); }
    }
    Ok(())
}
