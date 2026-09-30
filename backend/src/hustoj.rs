//! HUSTOJ 适配层：状态码、语言编号、提交写入链路、判题数据目录。
//! 只有这里允许依赖 HUSTOJ 的判题协议细节。

use std::process::Stdio;

use sqlx::{MySql, MySqlPool, pool::PoolConnection};
use tokio::io::AsyncWriteExt;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub const RESULT_AC: i16 = 4;
pub const RESULT_CE: i16 = 11;
/// 写入中：源码落库前的占位状态，判题机不会拾取。
pub const RESULT_SAVING: i16 = 14;
/// 仍在判题中的状态（等待、重判、编译、运行、写入中）。
pub const RUNNING_RESULTS: [i16; 5] = [0, 1, 2, 3, 14];

pub fn result_label(code: i16) -> &'static str {
    match code {
        0 => "等待判题",
        1 => "等待重判",
        2 => "编译中",
        3 => "运行中",
        4 => "通过",
        5 => "格式错误",
        6 => "答案错误",
        7 => "时间超限",
        8 => "内存超限",
        9 => "输出超限",
        10 => "运行错误",
        11 => "编译错误",
        14 => "正在保存",
        _ => "其他结果",
    }
}

/// 平台开放的语言：前端键 ↔ HUSTOJ 语言编号。
pub const LANGUAGES: [(&str, u32); 4] = [("c", 0), ("cpp", 1), ("java", 3), ("python", 6)];
pub const DEFAULT_LANGUAGES: [&str; 4] = ["c", "cpp", "java", "python"];
pub const PYTHON: u32 = 6;
/// HUSTOJ 的 Python 判题需要编码声明；存库时加上，展示时去掉。
pub const PYTHON_PREFIX: &str = "# coding=utf-8\n";

pub fn language_id(key: &str) -> Option<u32> {
    LANGUAGES.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn language_key(id: u32) -> Option<&'static str> {
    LANGUAGES.iter().find(|(_, v)| *v == id).map(|(k, _)| *k)
}

pub fn language_name(id: u32) -> &'static str {
    const NAMES: [&str; 21] = [
        "C", "C++", "Pascal", "Java", "Ruby", "Bash", "Python", "PHP", "Perl", "C#", "Objective-C", "FreeBasic", "Schema",
        "Clang", "Clang++", "Lua", "JavaScript", "Go", "SQL", "Fortran", "MATLAB",
    ];
    NAMES.get(id as usize).copied().unwrap_or("其他")
}

/// 逗号分隔的语言串 → 合法语言键列表（保序、去非法项）。
pub fn parse_languages(raw: &str) -> Vec<String> {
    raw.split(',').map(|s| s.trim().to_lowercase()).filter(|s| language_id(s).is_some()).collect()
}

/// 题单允许的语言；未设置时全部允许。
pub fn allowed_languages(column: Option<&str>) -> Vec<String> {
    match column.map(parse_languages) {
        Some(v) if !v.is_empty() => v,
        _ => DEFAULT_LANGUAGES.iter().map(|s| (*s).to_owned()).collect(),
    }
}

pub fn strip_python_prefix(code: &str) -> &str {
    code.strip_prefix(PYTHON_PREFIX).unwrap_or(code)
}

pub fn prepare_code(lang: u32, code: &str) -> String {
    if lang == PYTHON { format!("{PYTHON_PREFIX}{code}") } else { code.to_owned() }
}

/// 教学域的提交归属（cm_submission）；自由练习与自测为 None。
pub struct CourseLink {
    pub offering_id: u32,
    pub batch_id: u32,
    pub batch_problem_id: u32,
}

/// 两阶段写入：先以 result=14（写入中）占位，源码与归属落库后再放行为 result=0。
/// jol 是 MyISAM 无事务；中途失败留下的 14 与 cm_submission.placeholder 由对账任务处理。
pub async fn insert_submission(
    db: &MySqlPool,
    problem_id: i32,
    user: &str,
    lang: u32,
    code: &str,
    link: Option<CourseLink>,
) -> AppResult<u32> {
    let len = code.len() as i64;
    let sid = sqlx::query!(
        "INSERT INTO jol.solution(problem_id,user_id,language,in_date,result,code_length,ip) VALUES(?,?,?,NOW(),14,?,'127.0.0.1')",
        problem_id,
        user,
        lang,
        len
    )
    .execute(db)
    .await?
    .last_insert_id() as u32;
    if let Some(l) = &link {
        sqlx::query!(
            "INSERT INTO cm_submission(submission_id,offering_id,batch_id,batch_problem_id,user_id,language,submit_state,created_at) VALUES(?,?,?,?,?,?,'placeholder',NOW())",
            sid, l.offering_id, l.batch_id, l.batch_problem_id, user, lang
        )
        .execute(db)
        .await?;
    }
    sqlx::query!("INSERT INTO jol.source_code(solution_id,source) VALUES(?,?)", sid, code).execute(db).await?;
    sqlx::query!("INSERT INTO jol.source_code_user(solution_id,source) VALUES(?,?)", sid, code).execute(db).await?;
    sqlx::query!("UPDATE jol.solution SET result=0 WHERE solution_id=? AND result=14", sid).execute(db).await?;
    if link.is_some() {
        sqlx::query!("UPDATE cm_submission SET submit_state='promoted',promoted_at=NOW() WHERE submission_id=?", sid)
            .execute(db)
            .await?;
    }
    Ok(sid)
}

/// 自测：HUSTOJ 约定 problem_id=0 为自定义输入运行，不进入 cm_submission，不影响任何统计。
/// 用 MySQL 命名锁按用户串行化“检查频率 → 写入”，多进程部署下同样有效。
pub async fn insert_trial(ops: &MySqlPool, user: &str, lang: u32, code: &str, stdin: &str) -> AppResult<u32> {
    let mut conn: PoolConnection<MySql> = ops.acquire().await?;
    let lock = format!("hoj:trial:{user}");
    let got: Option<i32> = sqlx::query_scalar!("SELECT GET_LOCK(?, 5)", lock).fetch_one(&mut *conn).await?;
    if got != Some(1) {
        return Err(too_fast());
    }
    let result = insert_trial_locked(&mut conn, user, lang, code, stdin).await;
    let _ = sqlx::query!("DO RELEASE_LOCK(?)", lock).execute(&mut *conn).await;
    result
}

fn too_fast() -> AppError {
    AppError::TooManyRequests { message: "自测正在处理或操作过快，请稍后再试".into(), retry_after: 3 }
}

async fn insert_trial_locked(conn: &mut PoolConnection<MySql>, user: &str, lang: u32, code: &str, stdin: &str) -> AppResult<u32> {
    let pending = sqlx::query_scalar!(
        "SELECT solution_id FROM jol.solution WHERE user_id=? AND problem_id=0
           AND in_date>DATE_SUB(NOW(),INTERVAL 10 MINUTE)
           AND (result IN (0,1,2,3,14) OR in_date>DATE_SUB(NOW(),INTERVAL 3 SECOND)) LIMIT 1",
        user
    )
    .fetch_optional(&mut **conn)
    .await?;
    if pending.is_some() {
        return Err(too_fast());
    }
    let len = code.len() as i64;
    let sid = sqlx::query!(
        "INSERT INTO jol.solution(problem_id,user_id,language,in_date,result,code_length,ip) VALUES(0,?,?,NOW(),14,?,'127.0.0.1')",
        user,
        lang,
        len
    )
    .execute(&mut **conn)
    .await?
    .last_insert_id() as u32;
    sqlx::query!("INSERT INTO jol.source_code(solution_id,source) VALUES(?,?)", sid, code).execute(&mut **conn).await?;
    sqlx::query!("INSERT INTO jol.source_code_user(solution_id,source) VALUES(?,?)", sid, code).execute(&mut **conn).await?;
    sqlx::query!("INSERT INTO jol.custominput(solution_id,input_text) VALUES(?,?)", sid, stdin).execute(&mut **conn).await?;
    sqlx::query!("UPDATE jol.solution SET result=0 WHERE solution_id=? AND problem_id=0 AND result=14", sid)
        .execute(&mut **conn)
        .await?;
    Ok(sid)
}

pub struct TestCase<'a> {
    pub input: &'a str,
    pub output: &'a str,
}

/// 先清掉该题旧的编号测试点再整体重写，重试不会遗留多余测试。
/// 配置了共享卷（COURSE_JUDGE_DATA_DIR）时直接写文件，否则经 docker exec 写入 HUSTOJ 容器。
pub async fn write_test_files(state: &AppState, pid: i32, tests: &[TestCase<'_>]) -> AppResult<()> {
    let failed = |_| AppError::unavailable("测试点写入判题机失败，本次发布未放开可见，可安全重试");
    match &state.cfg.judge_data_dir {
        Some(root) => write_local(&root.join(pid.to_string()), tests).await.map_err(failed),
        None => write_docker(&state.cfg.hustoj_container, pid, tests).await.map_err(failed),
    }
}

fn is_numbered_case(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) && matches!(ext, "in" | "out")
}

async fn write_local(dir: &std::path::Path, tests: &[TestCase<'_>]) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_file() && entry.file_name().to_str().is_some_and(is_numbered_case) {
            tokio::fs::remove_file(entry.path()).await?;
        }
    }
    for (n, t) in tests.iter().enumerate() {
        tokio::fs::write(dir.join(format!("{}.in", n + 1)), t.input).await?;
        tokio::fs::write(dir.join(format!("{}.out", n + 1)), t.output).await?;
    }
    Ok(())
}

async fn docker(args: &[&str], stdin: Option<&str>) -> std::io::Result<()> {
    let mut child = tokio::process::Command::new("docker")
        .args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .spawn()?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data.as_bytes()).await?;
    }
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
        .await
        .map_err(|_| std::io::Error::other("docker exec timeout"))??;
    if status.success() { Ok(()) } else { Err(std::io::Error::other("docker exec failed")) }
}

async fn write_docker(container: &str, pid: i32, tests: &[TestCase<'_>]) -> std::io::Result<()> {
    let dir = format!("/home/judge/data/{pid}");
    docker(&["exec", container, "mkdir", "-p", &dir], None).await?;
    docker(
        &["exec", container, "find", &dir, "-maxdepth", "1", "-type", "f", "-regextype", "posix-extended", "-regex", r".*/[0-9]+\.(in|out)", "-delete"],
        None,
    )
    .await?;
    for (n, t) in tests.iter().enumerate() {
        for (ext, body) in [("in", t.input), ("out", t.output)] {
            let target = format!("{dir}/{}.{ext}", n + 1);
            docker(&["exec", "-i", container, "tee", &target], Some(body)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_case_matcher() {
        assert!(is_numbered_case("1.in") && is_numbered_case("12.out"));
        assert!(!is_numbered_case("a.in") && !is_numbered_case(".in") && !is_numbered_case("1.ans"));
    }

    #[test]
    fn language_helpers() {
        assert_eq!(parse_languages(" C, cpp ,rust"), vec!["c", "cpp"]);
        assert_eq!(allowed_languages(Some("")), DEFAULT_LANGUAGES.to_vec());
        assert_eq!(strip_python_prefix(&prepare_code(PYTHON, "x")), "x");
    }
}
