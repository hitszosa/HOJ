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
    let lock=format!("hoj:publish:{id}");
    authoring::with_lock(&s.db,&lock,async{
        let row=authoring::get_draft(&s.db,&who,&id,true).await?;
        let mut doc=document::validate(body.document)?;doc.read_only|=row.document.read_only;
        if doc.source_ref.as_deref().is_none_or(str::is_empty){doc.source_ref=row.document.source_ref;}
        if row.status=="published"{
            let bid=row.batch_id.ok_or_else(||AppError::conflict("已发布题单关联异常，请从课程作业编辑"))?;
            let current=crate::assignment_edit::document(&s,&who,bid).await?;
            doc.extra.insert("revision".into(),current.extra["revision"].clone());
            for p in &mut doc.problems{if let Some(old)=current.problems.iter().find(|x|x.slug==p.slug){p.extra.insert("problem_id".into(),old.extra["problem_id"].clone());}}
            crate::assignment_edit::update(&s,&who,bid,doc).await?;
        }else{
            let payload=serde_json::to_string(&doc).map_err(|e|AppError::internal(e.to_string()))?;
            sqlx::query("UPDATE cm_authoring_draft SET title=?,payload=?,updated_at=NOW() WHERE draft_id=?").bind(doc.title).bind(payload).bind(id).execute(&s.db).await?;
        }
        Ok(ok(Empty{}))
    }).await
}

async fn remove(State(s):State<AppState>,who:Identity,Path(id):Path<String>)->AppResult<ApiOk<Empty>>{
    crate::access::require_teacher(&s.db,&who).await?;
    authoring::with_lock(&s.db,&format!("hoj:publish:{id}"),async{
        let owner=sqlx::query_scalar::<_,String>("SELECT owner_id FROM cm_authoring_draft WHERE draft_id=?").bind(&id).fetch_optional(&s.db).await?.ok_or_else(||AppError::not_found("题单不存在"))?;
        if owner!=who.user&&!who.is_admin(){return Err(AppError::forbidden("只能删除自己的个人题库题单"));}
        if !id.bytes().all(|c|c.is_ascii_hexdigit())||id.len()!=32{return Err(AppError::validation("题单标识无效"));}
        let bids=sqlx::query_scalar::<_,u32>("SELECT batch_id FROM cm_batch WHERE authoring_key=? OR source_ref=?").bind(&id).bind(format!("library:{id}")).fetch_all(&s.db).await?;
        for bid in &bids{crate::access::batch_access(&s.db,&who,*bid,Need::TEACH_WRITE).await?;crate::assignment_edit::require_idle(&s,*bid).await?;}
        let dir=s.cfg.root.join("data/local/assignment-backups").join(format!("library-{}",authoring::new_draft_id()));tokio::fs::create_dir_all(&dir).await.map_err(crate::course_deletion::io_error)?;
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;tokio::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700)).await.map_err(crate::course_deletion::io_error)?;}
        let mut out=tokio::fs::File::create(dir.join("rows.jsonl")).await.map_err(crate::course_deletion::io_error)?;
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;out.set_permissions(std::fs::Permissions::from_mode(0o600)).await.map_err(crate::course_deletion::io_error)?;}
        crate::course_deletion::snapshot(&s.db,"codemind_course","cm_authoring_draft",&format!("draft_id='{id}'"),&mut out).await?;out.sync_all().await.map_err(crate::course_deletion::io_error)?;
        for bid in bids{crate::assignment_edit::remove(&s,&who,bid).await?;}
        sqlx::query("DELETE FROM cm_authoring_draft WHERE draft_id=?").bind(id).execute(&s.db).await?;Ok(ok(Empty{}))
    }).await
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
        let oid=row.offering_id.ok_or_else(||AppError::unprocessable("请在我的题单中选择课程布置作业"))?;
        let batch_id = authoring::publish(&s, oid, &id, &doc, &opts).await?;
        Ok(ok(PublishResponse { batch_id }))
    })
    .await
}
