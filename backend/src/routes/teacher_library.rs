//! 教师个人题库：跨班汇总本人草稿、新建题单、一次部署到多个教学班。

use std::collections::HashSet;

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
    access::{self, Need, offering_access},
    ai,
    auth::Identity,
    authoring::{self, DraftCreated, Origin, PublishOptions},
    document::{self, Case, Document, LanguageList},
    error::{AppError, AppResult},
    extract::Json,
    response::{ApiOk, ok},
    routes::drafts::{clean_topic, document_from},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/teacher/library", get(library))
        .route("/api/teacher/library/sets", post(create_set))
        .route("/api/teacher/library/deploy", post(deploy))
}

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct LibraryProblem {
    pub slug: String,
    pub title: String,
    pub statement: String,
    pub knowledge: Vec<String>,
    pub difficulty: String,
    pub samples: Vec<Case>,
    pub samples_count: usize,
    pub tests_count: usize,
    pub draft_id: String,
    pub draft_title: String,
    pub origin: Origin,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub updated_at: NaiveDateTime,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct LibrarySet {
    pub draft_id: String,
    pub offering_id: u32,
    pub title: String,
    pub status: String,
    pub origin: Origin,
    pub batch_id: Option<u32>,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub updated_at: NaiveDateTime,
    pub count: usize,
    pub problems: Vec<LibraryProblem>,
    pub course_code: Option<String>,
    pub course_name: Option<String>,
    pub offering_term: Option<String>,
    pub offering_section: Option<String>,
    pub offering_title: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TeachingOffering {
    pub code: String,
    pub name: String,
    pub offering_id: u32,
    pub term: String,
    pub section: String,
    pub status: String,
    pub title: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct LibraryStats {
    pub total_sets: usize,
    pub total_problems: usize,
    pub ai_sets: usize,
    pub teacher_sets: usize,
    pub published_sets: usize,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Library {
    pub sets: Vec<LibrarySet>,
    /// 去重后的全部题目（按标题 + slug）。
    pub problems: Vec<LibraryProblem>,
    pub offerings: Vec<TeachingOffering>,
    pub stats: LibraryStats,
}

async fn library(State(s): State<AppState>, who: Identity) -> AppResult<ApiOk<Library>> {
    access::require_teacher(&s.db, &who).await?;
    let offerings = sqlx::query_as!(
        TeachingOffering,
        "SELECT c.code, c.name, o.offering_id, o.term, o.section, o.status, o.title
         FROM cm_course c JOIN cm_offering o USING(course_id)
         WHERE o.teacher_id=? OR ?='admin' ORDER BY o.term DESC, c.code",
        who.user,
        who.user
    )
    .fetch_all(&s.db)
    .await?;
    let drafts = sqlx::query!(
        r#"SELECT d.draft_id, d.offering_id, d.title, d.payload, d.status, d.origin, d.batch_id, d.updated_at,
                  o.term AS "offering_term?", o.section AS "offering_section?", o.title AS offering_title,
                  c.name AS "course_name?", c.code AS "course_code?"
           FROM cm_authoring_draft d
           LEFT JOIN cm_offering o ON d.offering_id=o.offering_id
           LEFT JOIN cm_course c ON o.course_id=c.course_id
           WHERE d.owner_id=? ORDER BY d.updated_at DESC"#,
        who.user
    )
    .fetch_all(&s.db)
    .await?;
    let mut sets = Vec::with_capacity(drafts.len());
    let mut flat = Vec::new();
    let mut seen = HashSet::new();
    for d in drafts {
        let origin = Origin::parse(&d.origin);
        let doc: Option<Document> = serde_json::from_str(&d.payload).ok();
        let problems: Vec<LibraryProblem> = doc
            .map(|doc| doc.problems)
            .unwrap_or_default()
            .into_iter()
            .map(|p| LibraryProblem {
                slug: p.slug,
                title: p.title,
                statement: p.statement,
                knowledge: p.knowledge,
                difficulty: p.difficulty.unwrap_or_else(|| "medium".into()),
                samples_count: p.samples.len(),
                tests_count: p.tests.len(),
                samples: p.samples,
                draft_id: d.draft_id.clone(),
                draft_title: d.title.clone(),
                origin,
                updated_at: d.updated_at,
            })
            .collect();
        for p in &problems {
            if seen.insert((p.title.clone(), p.slug.clone())) {
                flat.push(p.clone());
            }
        }
        sets.push(LibrarySet {
            draft_id: d.draft_id,
            offering_id: d.offering_id,
            title: d.title,
            status: d.status,
            origin,
            batch_id: d.batch_id,
            updated_at: d.updated_at,
            count: problems.len(),
            problems,
            course_code: d.course_code,
            course_name: d.course_name,
            offering_term: d.offering_term,
            offering_section: d.offering_section,
            offering_title: d.offering_title,
        });
    }
    let stats = LibraryStats {
        total_sets: sets.len(),
        total_problems: flat.len(),
        ai_sets: sets.iter().filter(|s| s.origin == Origin::Ai).count(),
        teacher_sets: sets.iter().filter(|s| s.origin == Origin::Teacher).count(),
        published_sets: sets.iter().filter(|s| s.status == "published").count(),
    };
    Ok(ok(Library { sets, problems: flat, offerings, stats }))
}

/// 新建题单，按优先级：`topic`（AI 生成）→ `content`（导入文本）→ `document` → 空白模板。
#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CreateSetRequest {
    /// 缺省时落到本人最新学期的活跃班。
    #[serde(default)]
    #[ts(optional)]
    pub offering_id: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub topic: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub content: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "unknown")]
    pub document: Option<Value>,
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
}

async fn create_set(State(s): State<AppState>, who: Identity, Json(body): Json<CreateSetRequest>) -> AppResult<ApiOk<DraftCreated>> {
    access::require_teacher(&s.db, &who).await?;
    let oid = match body.offering_id.filter(|&o| o > 0) {
        Some(oid) => offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?.offering_id,
        None => access::primary_offering(&s.db, &who).await?,
    };
    let topic = body.topic.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let (doc, origin) = if let Some(topic) = topic {
        (ai::generate_document(&s, &clean_topic(topic)?).await?, Origin::Ai)
    } else if body.content.as_deref().is_some_and(|c| !c.is_empty()) || body.document.as_ref().is_some_and(|d| !d.is_null()) {
        (document_from(body.content.filter(|c| !c.is_empty()), body.document)?, Origin::Teacher)
    } else {
        let title = body.title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).unwrap_or_else(|| "新建自编题单".into());
        let template = serde_json::json!({
            "title": title,
            "problems": [{
                "slug": "prob-01", "title": "第一题：新试题描述", "statement": "输入描述...\n输出描述...\n数据范围...",
                "knowledge": ["基础语法"], "samples": [{"input": "1 2\n", "output": "3\n"}], "tests": [{"input": "2 3\n", "output": "5\n"}],
            }],
        });
        (document::validate(template)?, Origin::Teacher)
    };
    Ok(ok(authoring::create_draft(&s.db, oid, &who.user, doc, origin).await?))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct DeployRequest {
    pub draft_id: String,
    pub offering_ids: Vec<u32>,
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
pub struct DeployResult {
    pub offering_id: u32,
    pub batch_id: u32,
    pub draft_id: String,
    pub course_name: String,
    pub section: String,
    pub status: &'static str,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DeployResponse {
    pub title: String,
    pub problem_count: usize,
    pub offering_count: usize,
    pub results: Vec<DeployResult>,
}

/// 把一份草稿发布到多个教学班：本班未发布的草稿直接发布，其余班各复制一份草稿再发布。
async fn deploy(State(s): State<AppState>, who: Identity, Json(body): Json<DeployRequest>) -> AppResult<ApiOk<DeployResponse>> {
    access::require_teacher(&s.db, &who).await?;
    let draft_id = body.draft_id.trim().to_owned();
    if draft_id.is_empty() {
        return Err(AppError::unprocessable("请指定要发布的题单 (draft_id)"));
    }
    if body.offering_ids.is_empty() {
        return Err(AppError::unprocessable("请至少选择一个发布的教学班级"));
    }
    let mut oids = Vec::new();
    for &oid in &body.offering_ids {
        offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?;
        if !oids.contains(&oid) {
            oids.push(oid);
        }
    }
    let source = authoring::get_draft(&s.db, &who, &draft_id, false).await?;
    let doc = source.document.clone();
    document::check_publishable(&doc)?;
    let due_at = authoring::parse_due(body.due_at.as_deref())?;
    let allowed = body
        .allowed_languages
        .as_ref()
        .and_then(LanguageList::normalize)
        .or_else(|| doc.allowed_languages.as_deref().and_then(|l| LanguageList::Csv(l.to_owned()).normalize()));
    let lock = format!("hoj:publish:{draft_id}");
    let results = authoring::with_lock(&s.db, &lock, async {
        let mut results = Vec::new();
        for &oid in &oids {
            let key = if source.offering_id == oid && source.status != "published" {
                draft_id.clone()
            } else {
                authoring::insert_draft(&s.db, oid, &who.user, &doc, source.origin).await?
            };
            let opts = PublishOptions {
                due_at,
                ai_enabled: body.ai_enabled.unwrap_or(true),
                allowed_languages: allowed.clone(),
                read_only: doc.read_only,
                source_ref: Some(doc.source_ref.clone().filter(|r| !r.is_empty()).unwrap_or_else(|| format!("teacher:{}:{}", who.user, &key[..8]))),
                legacy_batch_id: None,
            };
            let batch_id = authoring::publish(&s, oid, &key, &doc, &opts).await?;
            let info = sqlx::query!("SELECT c.name, o.section FROM cm_offering o JOIN cm_course c USING(course_id) WHERE o.offering_id=?", oid)
                .fetch_optional(&s.db)
                .await?;
            results.push(DeployResult {
                offering_id: oid,
                batch_id,
                draft_id: key,
                course_name: info.as_ref().map(|i| i.name.clone()).unwrap_or_default(),
                section: info.map(|i| i.section).unwrap_or_default(),
                status: "published",
            });
        }
        Ok(results)
    })
    .await?;
    Ok(ok(DeployResponse { title: doc.title, problem_count: doc.problems.len(), offering_count: oids.len(), results }))
}
