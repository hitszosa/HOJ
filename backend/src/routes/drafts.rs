//! 教师草稿：新建（自编 / 导入 / AI 生成）、编辑、删除、审核后发布为题单。

use axum::{
    Router,
    extract::State,
    routing::{get, post},
};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{
    access::{Need, offering_access},
    ai,
    auth::Identity,
    authoring::{self, Draft, DraftCreated, Origin, PublishOptions},
    document::{self, LanguageList},
    error::{AppError, AppResult},
    extract::{Json, Path},
    response::{ApiOk, Empty, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/offerings/{oid}/drafts", get(list).post(create))
        .route("/api/offerings/{oid}/generate", post(generate))
        .route("/api/drafts/{id}", get(read).put(update).delete(remove))
        .route("/api/drafts/{id}/publish", post(publish))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DraftSummary {
    pub draft_id: String,
    pub title: String,
    pub status: String,
    pub origin: Origin,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub updated_at: NaiveDateTime,
}

async fn list(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>) -> AppResult<ApiOk<Vec<DraftSummary>>> {
    offering_access(&s.db, &who, oid, Need::TEACH).await?;
    let rows = sqlx::query!(
        "SELECT draft_id,title,status,origin,updated_at FROM cm_authoring_draft WHERE offering_id=? ORDER BY updated_at DESC",
        oid
    )
    .fetch_all(&s.db)
    .await?;
    Ok(ok(rows
        .into_iter()
        .map(|r| DraftSummary { draft_id: r.draft_id, title: r.title, status: r.status, origin: Origin::parse(&r.origin), updated_at: r.updated_at })
        .collect()))
}

/// 新建草稿：`content` 为上传的 YAML / JSON / FPS XML 文本，否则用结构化的 `document`。
#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CreateDraftRequest {
    #[serde(default)]
    #[ts(optional)]
    pub content: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "unknown")]
    pub document: Option<Value>,
}

pub fn document_from(content: Option<String>, doc: Option<Value>) -> AppResult<document::Document> {
    match content {
        Some(text) => document::parse(&text),
        None => document::validate(doc.unwrap_or(Value::Null)),
    }
}

async fn create(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>, Json(body): Json<CreateDraftRequest>) -> AppResult<ApiOk<DraftCreated>> {
    offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?;
    let doc = document_from(body.content, body.document)?;
    Ok(ok(authoring::create_draft(&s.db, oid, &who.user, doc, Origin::Teacher).await?))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct GenerateRequest {
    /// 教学目标（最多 500 字）。
    pub topic: String,
}

pub fn clean_topic(topic: &str) -> AppResult<String> {
    let t: String = topic.trim().chars().take(500).collect();
    if t.is_empty() { Err(AppError::unprocessable("请填写教学目标")) } else { Ok(t) }
}

async fn generate(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>, Json(body): Json<GenerateRequest>) -> AppResult<ApiOk<DraftCreated>> {
    offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?;
    let topic = clean_topic(&body.topic)?;
    let doc = ai::generate_document(&s, &topic).await?;
    Ok(ok(authoring::create_draft(&s.db, oid, &who.user, doc, Origin::Ai).await?))
}

async fn read(State(s): State<AppState>, who: Identity, Path(id): Path<String>) -> AppResult<ApiOk<Draft>> {
    Ok(ok(authoring::get_draft(&s.db, &who, &id, false).await?))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct UpdateDraftRequest {
    #[ts(type = "unknown")]
    pub document: Value,
}

async fn update(State(s): State<AppState>, who: Identity, Path(id): Path<String>, Json(body): Json<UpdateDraftRequest>) -> AppResult<ApiOk<Empty>> {
    let row = authoring::get_draft(&s.db, &who, &id, true).await?;
    if row.status != "draft" {
        return Err(AppError::conflict("已发布题单不可覆盖，请复制为新草稿"));
    }
    let mut doc = document::validate(body.document)?;
    // 既有只读来源不可被更新洗掉；来源引用缺失时沿用原值。
    doc.read_only |= row.document.read_only;
    if doc.source_ref.as_deref().is_none_or(str::is_empty) {
        doc.source_ref = row.document.source_ref;
    }
    let payload = serde_json::to_string(&doc).map_err(|e| AppError::internal(e.to_string()))?;
    sqlx::query!("UPDATE cm_authoring_draft SET title=?,payload=?,updated_at=NOW() WHERE draft_id=?", doc.title, payload, id)
        .execute(&s.db)
        .await?;
    Ok(ok(Empty {}))
}

async fn remove(State(s): State<AppState>, who: Identity, Path(id): Path<String>) -> AppResult<ApiOk<Empty>> {
    let row = authoring::get_draft(&s.db, &who, &id, true).await?;
    if row.status == "published" {
        return Err(AppError::conflict("已发布的题单不可直接从题库删除，请在班级作业中管理"));
    }
    sqlx::query!("DELETE FROM cm_authoring_draft WHERE draft_id=? AND status='draft'", id).execute(&s.db).await?;
    Ok(ok(Empty {}))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct PublishRequest {
    /// 教师确认已审核题面、样例与隐藏测试，必须为 true。
    #[serde(default)]
    pub reviewed: bool,
    /// `YYYY-MM-DD HH:MM` 或 `YYYY-MM-DDTHH:MM`。
    #[serde(default)]
    #[ts(optional)]
    pub due_at: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub ai_enabled: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub allowed_languages: Option<LanguageList>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PublishResponse {
    pub batch_id: u32,
}

/// 幂等：已发布的草稿直接返回原题单。
async fn publish(State(s): State<AppState>, who: Identity, Path(id): Path<String>, Json(body): Json<PublishRequest>) -> AppResult<ApiOk<PublishResponse>> {
    let lock = format!("hoj:publish:{id}");
    authoring::with_lock(&s.db, &lock, async {
        // 历史只读在幂等分支之前就拦下。
        let row = authoring::get_draft(&s.db, &who, &id, true).await?;
        if row.status == "published"
            && let Some(bid) = row.batch_id
        {
            return Ok(ok(PublishResponse { batch_id: bid }));
        }
        let doc = row.document;
        if !body.reviewed {
            return Err(AppError::unprocessable("发布前请确认已审核题面、样例与隐藏测试"));
        }
        document::check_publishable(&doc)?;
        let opts = PublishOptions {
            due_at: authoring::parse_due(body.due_at.as_deref())?,
            ai_enabled: body.ai_enabled.unwrap_or(true),
            allowed_languages: body
                .allowed_languages
                .as_ref()
                .and_then(LanguageList::normalize)
                .or_else(|| doc.allowed_languages.as_deref().and_then(|l| LanguageList::Csv(l.to_owned()).normalize())),
            read_only: doc.read_only,
            source_ref: doc.source_ref.clone().filter(|r| !r.is_empty()),
            legacy_batch_id: row.batch_id,
        };
        let batch_id = authoring::publish(&s, row.offering_id, &id, &doc, &opts).await?;
        Ok(ok(PublishResponse { batch_id }))
    })
    .await
}
