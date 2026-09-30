//! 草稿 → 批次发布。draft 发布、教师题库多班部署、题库直发三条入口共用 `publish`。
//!
//! 幂等性：批次按 authoring_key（= draft_id，唯一键）找回；题目按 source=`codemind:authoring/<draft>/<slug>` 找回。
//! 顺序保证学生永远看不到半成品：批次先以 draft 就位 → 题目与测试点写好 → 放开题目可见 → 教学域事务内切 published。

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::MySqlPool;
use ts_rs::TS;

use crate::{
    auth::Identity,
    document::{Document, Problem},
    error::{AppError, AppResult},
    hustoj::{self, TestCase},
    state::AppState,
};

/// 发布参数。`read_only` 只增不减；`source_ref` 为 None 时保留批次原值。
pub struct PublishOptions {
    pub due_at: Option<NaiveDateTime>,
    pub ai_enabled: bool,
    pub allowed_languages: Option<String>,
    pub read_only: bool,
    pub source_ref: Option<String>,
    /// 升级前遗留的“草稿已挂批次但批次无 authoring_key”，认领原批次而不是新建。
    pub legacy_batch_id: Option<u32>,
}

/// 截止时间：`YYYY-MM-DD HH:MM` 或 `YYYY-MM-DDTHH:MM`；空串视为不设截止。
pub fn parse_due(raw: Option<&str>) -> AppResult<Option<NaiveDateTime>> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => NaiveDateTime::parse_from_str(&s.replace('T', " "), "%Y-%m-%d %H:%M")
            .map(Some)
            .map_err(|_| AppError::unprocessable("截止时间格式无效")),
    }
}

pub async fn ensure_batch(db: &MySqlPool, oid: u32, title: &str, key: &str, opts: &PublishOptions) -> AppResult<u32> {
    let ro = opts.read_only as i8;
    if let Some(bid) = sqlx::query_scalar!("SELECT batch_id FROM cm_batch WHERE authoring_key=?", key).fetch_optional(db).await? {
        sqlx::query!(
            "UPDATE cm_batch SET title=?,read_only=GREATEST(read_only,?),source_ref=COALESCE(?,source_ref),updated_at=NOW() WHERE batch_id=?",
            title, ro, opts.source_ref, bid
        )
        .execute(db)
        .await?;
        return Ok(bid);
    }
    if let Some(legacy) = opts.legacy_batch_id {
        sqlx::query!(
            "UPDATE cm_batch SET authoring_key=?,title=?,read_only=GREATEST(read_only,?),source_ref=COALESCE(?,source_ref),updated_at=NOW()
             WHERE batch_id=? AND offering_id=? AND authoring_key IS NULL",
            key, title, ro, opts.source_ref, legacy, oid
        )
        .execute(db)
        .await?;
        if let Some(bid) = sqlx::query_scalar!("SELECT batch_id FROM cm_batch WHERE authoring_key=?", key).fetch_optional(db).await? {
            return Ok(bid);
        }
    }
    for _ in 0..3 {
        // 命中 uk_batch_seq（并发占用同一 seq）时 INSERT IGNORE 不插入，换下一个序号重试。
        sqlx::query!(
            "INSERT IGNORE INTO cm_batch(offering_id,seq,title,status,read_only,source_ref,authoring_key,created_at,updated_at)
             SELECT ?,COALESCE(MAX(seq),0)+1,?,'draft',?,?,?,NOW(),NOW() FROM cm_batch WHERE offering_id=?",
            oid, title, ro, opts.source_ref, key, oid
        )
        .execute(db)
        .await?;
        if let Some(bid) = sqlx::query_scalar!("SELECT batch_id FROM cm_batch WHERE authoring_key=?", key).fetch_optional(db).await? {
            return Ok(bid);
        }
    }
    Err(AppError::conflict("批次序号冲突，请稍后重试发布"))
}

/// 题面/样例/hint 每次按草稿重写；新题先以 defunct='Y' 建出，统一放开。
async fn sync_problem(state: &AppState, key: &str, p: &Problem) -> AppResult<i32> {
    let source = format!("codemind:authoring/{key}/{}", p.slug);
    let knowledge = p.knowledge.join("、");
    let sample = &p.samples[0];
    let existing = sqlx::query_scalar!("SELECT problem_id FROM jol.problem WHERE source=?", source).fetch_optional(&state.ops).await?;
    let pid = match existing {
        Some(pid) => {
            sqlx::query!(
                "UPDATE jol.problem SET title=?,description=?,sample_input=?,sample_output=?,hint=? WHERE problem_id=?",
                p.title, p.statement, sample.input, sample.output, knowledge, pid
            )
            .execute(&state.ops)
            .await?;
            pid
        }
        None => sqlx::query!(
            "INSERT INTO jol.problem(title,description,input,output,sample_input,sample_output,hint,source,in_date,defunct,time_limit,memory_limit)
             VALUES(?,?,'','',?,?,?,?,NOW(),'Y',1,128)",
            p.title, p.statement, sample.input, sample.output, knowledge, source
        )
        .execute(&state.ops)
        .await?
        .last_insert_id() as i32,
    };
    let tests: Vec<TestCase> = p.tests.iter().map(|t| TestCase { input: &t.input, output: &t.output }).collect();
    hustoj::write_test_files(state, pid, &tests).await?;
    Ok(pid)
}

pub async fn publish(state: &AppState, oid: u32, key: &str, doc: &Document, opts: &PublishOptions) -> AppResult<u32> {
    let bid = ensure_batch(&state.db, oid, &doc.title, key, opts).await?;
    let mut pids = Vec::with_capacity(doc.problems.len());
    for p in &doc.problems {
        pids.push(sync_problem(state, key, p).await?);
    }
    // HUSTOJ 侧（MyISAM，无事务）先放开题目；失败时批次仍是 draft，学生看不到。
    let ids = pids.iter().map(i32::to_string).collect::<Vec<_>>().join(",");
    let prefix = format!("codemind:authoring/{key}/%");
    sqlx::query(&format!("UPDATE jol.problem SET defunct='Y' WHERE source LIKE ? AND problem_id NOT IN ({ids})"))
        .bind(&prefix)
        .execute(&state.ops)
        .await?;
    sqlx::query(&format!("UPDATE jol.problem SET defunct='N' WHERE problem_id IN ({ids})")).execute(&state.ops).await?;

    // 关联整体重建：(batch_id,seq) 与 (batch_id,problem_id) 均唯一，增量 upsert 在“换题不换序号”时会失败。
    let mut tx = state.db.begin().await?;
    sqlx::query!("DELETE FROM cm_batch_problem WHERE batch_id=?", bid).execute(&mut *tx).await?;
    let mut insert = sqlx::QueryBuilder::new("INSERT INTO cm_batch_problem(batch_id,problem_id,seq,score,created_at,updated_at) ");
    insert.push_values(pids.iter().enumerate(), |mut b, (i, pid)| {
        b.push_bind(bid).push_bind(pid).push_bind(i as u32 + 1).push("100,NOW(),NOW()");
    });
    insert.build().execute(&mut *tx).await?;
    sqlx::query!(
        "UPDATE cm_batch SET status='published',due_at=?,ai_enabled=?,allowed_languages=?,read_only=GREATEST(read_only,?),
                source_ref=COALESCE(?,source_ref),updated_at=NOW() WHERE batch_id=?",
        opts.due_at, opts.ai_enabled, opts.allowed_languages, opts.read_only as i8, opts.source_ref, bid
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("UPDATE cm_authoring_draft SET batch_id=?,status='published',updated_at=NOW() WHERE draft_id=?", bid, key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(bid)
}

// ---------------------------------------------------------------- 草稿存取

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Origin {
    Teacher,
    Ai,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Teacher => "teacher",
            Self::Ai => "ai",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "ai" { Self::Ai } else { Self::Teacher }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Draft {
    pub draft_id: String,
    pub offering_id: u32,
    pub owner_id: String,
    pub title: String,
    pub status: String,
    pub origin: Origin,
    pub batch_id: Option<u32>,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub updated_at: NaiveDateTime,
    pub document: Document,
}

pub fn new_draft_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub async fn insert_draft(db: &MySqlPool, oid: u32, owner: &str, doc: &Document, origin: Origin) -> AppResult<String> {
    let id = new_draft_id();
    let payload = serde_json::to_string(doc).map_err(|e| AppError::internal(e.to_string()))?;
    sqlx::query!(
        "INSERT INTO cm_authoring_draft(draft_id,offering_id,owner_id,title,payload,status,origin,updated_at) VALUES(?,?,?,?,?,'draft',?,NOW())",
        id, oid, owner, doc.title, payload, origin.as_str()
    )
    .execute(db)
    .await?;
    Ok(id)
}

/// 读草稿并校验：须为该草稿所属教学班的教师。
pub async fn get_draft(db: &MySqlPool, who: &Identity, id: &str, write: bool) -> AppResult<Draft> {
    let row = sqlx::query!(
        "SELECT draft_id,offering_id,owner_id,title,payload,status,origin,batch_id,updated_at FROM cm_authoring_draft WHERE draft_id=?",
        id
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("草稿不存在"))?;
    let need = if write { crate::access::Need::TEACH_WRITE } else { crate::access::Need::TEACH };
    crate::access::offering_access(db, who, row.offering_id, need).await?;
    let document = serde_json::from_str(&row.payload).map_err(|e| AppError::internal(format!("draft payload: {e}")))?;
    Ok(Draft {
        draft_id: row.draft_id,
        offering_id: row.offering_id,
        owner_id: row.owner_id,
        title: row.title,
        status: row.status,
        origin: Origin::parse(&row.origin),
        batch_id: row.batch_id,
        updated_at: row.updated_at,
        document,
    })
}

/// 新建草稿的统一返回。
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct DraftCreated {
    pub id: String,
    pub status: &'static str,
    pub document: Document,
}

pub async fn create_draft(db: &MySqlPool, oid: u32, owner: &str, doc: Document, origin: Origin) -> AppResult<DraftCreated> {
    let id = insert_draft(db, oid, owner, &doc, origin).await?;
    Ok(DraftCreated { id, status: "draft", document: doc })
}

/// 以 MySQL 命名锁串行化一段逻辑（跨进程有效，替代旧版进程内 MUTEX）。
/// 命名锁绑定会话：持锁连接在整个过程中独占，结束后显式释放。
pub async fn with_lock<T>(db: &MySqlPool, name: &str, work: impl std::future::Future<Output = AppResult<T>>) -> AppResult<T> {
    let mut conn = db.acquire().await?;
    let got: Option<i32> = sqlx::query_scalar!("SELECT GET_LOCK(?, 30)", name).fetch_one(&mut *conn).await?;
    if got != Some(1) {
        return Err(AppError::conflict("操作正在进行中，请稍后重试"));
    }
    let result = work.await;
    if sqlx::query!("DO RELEASE_LOCK(?)", name).execute(&mut *conn).await.is_err() {
        // 释放失败时丢弃连接，避免把持锁会话还回连接池。
        let _ = conn.close().await;
    }
    result
}
