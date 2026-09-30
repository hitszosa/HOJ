//! 本地题库浏览与组卷：索引、分类树、个人进度；从题库挑题生成草稿或直接发布到多个教学班。

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Router,
    extract::State,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    access::{Need, offering_access},
    auth::Identity,
    authoring::{self, DraftCreated, Origin, PublishOptions},
    document::{self, Case, Document, LanguageList},
    error::{AppError, AppResult},
    extract::{Json, Path},
    problem_bank::{BankCase, BankIndex, BankSet, BankTree},
    response::{ApiOk, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/problem-sets", get(index))
        .route("/api/problem-sets/tree", get(tree))
        .route("/api/problem-sets/my-status", get(my_status))
        .route("/api/problem-sets/publish-to-offerings", post(publish_to_offerings))
        .route("/api/offerings/{oid}/problem-sets", get(offering_sets))
        .route("/api/offerings/{oid}/import-set", post(import_set))
}

async fn index(State(s): State<AppState>, _who: Identity) -> ApiOk<Arc<BankIndex>> {
    ok(s.bank.index.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SolvedStatus {
    Passed,
    Tried,
    Unattempted,
}

/// 题库题目（source=`bank:<slug>`）的本人进度：slug → 状态。未做过的题不出现。
async fn bank_status(s: &AppState, user: &str) -> AppResult<BTreeMap<String, SolvedStatus>> {
    let rows = sqlx::query!(
        r#"SELECT p.source AS "source!: String", MAX(s.result=4) AS "passed!: bool"
           FROM jol.solution s JOIN jol.problem p ON s.problem_id=p.problem_id
           WHERE s.user_id=? AND p.source LIKE 'bank:%' GROUP BY p.source"#,
        user
    )
    .fetch_all(&s.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let slug = r.source.split_once(':').map(|(_, v)| v.to_owned()).unwrap_or(r.source);
            (slug, if r.passed { SolvedStatus::Passed } else { SolvedStatus::Tried })
        })
        .collect())
}

async fn my_status(State(s): State<AppState>, who: Identity) -> AppResult<ApiOk<BTreeMap<String, SolvedStatus>>> {
    Ok(ok(bank_status(&s, &who.user).await?))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TreeResponse {
    pub tree: Arc<BankTree>,
    pub my_status: BTreeMap<String, SolvedStatus>,
}

async fn tree(State(s): State<AppState>, who: Identity) -> AppResult<ApiOk<TreeResponse>> {
    Ok(ok(TreeResponse { tree: s.bank.tree.clone(), my_status: bank_status(&s, &who.user).await? }))
}

// ---------------------------------------------------------------- 教学班视角

#[derive(Serialize, TS)]
#[ts(export)]
pub struct CategoryOption {
    #[serde(flatten)]
    pub set: BankSet,
    /// 属于本课程教学大纲推荐的分类。
    pub matched: bool,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DraftSetPreview {
    /// `draft:<draft_id>`，可直接作为组卷的 set_id。
    pub id: String,
    pub draft_id: String,
    pub code: String,
    pub title: String,
    pub origin: Origin,
    pub count: usize,
    pub problems: Vec<DraftProblemPreview>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DraftProblemPreview {
    pub slug: String,
    pub title: String,
    pub difficulty: String,
    pub knowledge: Vec<String>,
    pub statement: String,
    pub samples: Vec<Case>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct OfferingSets {
    pub course_id: u32,
    pub course_code: String,
    pub course_name: String,
    pub offering_title: String,
    pub term: String,
    pub section: String,
    /// 全部分类，按大纲推荐标记 `matched`（推荐列表 = matched 为 true 的项）。
    pub categories: Vec<CategoryOption>,
    /// 与本课程对应的独立题单。
    pub course_sets: Vec<BankSet>,
    /// 竞赛 / 认证类独立题单。
    pub contest_sets: Vec<BankSet>,
    pub my_problem_sets: Vec<DraftSetPreview>,
}

async fn offering_sets(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>) -> AppResult<ApiOk<OfferingSets>> {
    offering_access(&s.db, &who, oid, Need::TEACH).await?;
    let c = sqlx::query!(
        "SELECT c.course_id, c.code, c.name, o.term, o.section, o.title AS offering_title
         FROM cm_offering o JOIN cm_course c USING(course_id) WHERE o.offering_id=?",
        oid
    )
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| AppError::not_found("课程不存在"))?;
    // 试点课程代码 PILOTxxxx 与正式课程 COMPxxxx 共用大纲。
    let canonical = c.code.to_uppercase().replace("PILOT", "COMP");
    let recommended = s.bank.syllabus.get(&canonical).cloned().unwrap_or_default();
    let categories = s
        .bank
        .index
        .categories
        .iter()
        .map(|set| CategoryOption { matched: recommended.contains(&set.code), set: set.clone() })
        .collect();
    let (mut course_sets, mut contest_sets) = (Vec::new(), Vec::new());
    for set in &s.bank.index.standalone_sets {
        let course = set.course.as_deref().unwrap_or("").to_uppercase();
        let code = set.code.to_uppercase();
        if course == canonical || code.starts_with(&canonical) {
            course_sets.push(set.clone());
        } else if !code.starts_with("COMP") && !code.starts_with("PILOT") {
            contest_sets.push(set.clone());
        }
    }
    let drafts = sqlx::query!("SELECT draft_id, title, payload, origin FROM cm_authoring_draft WHERE owner_id=? ORDER BY updated_at DESC", who.user)
        .fetch_all(&s.db)
        .await?;
    let my_problem_sets = drafts
        .into_iter()
        .filter_map(|d| {
            let doc: Document = serde_json::from_str(&d.payload).ok()?;
            let problems: Vec<DraftProblemPreview> = doc
                .problems
                .into_iter()
                .map(|p| DraftProblemPreview {
                    slug: p.slug,
                    title: p.title,
                    difficulty: p.difficulty.unwrap_or_else(|| "medium".into()),
                    knowledge: p.knowledge,
                    statement: p.statement,
                    samples: p.samples,
                })
                .collect();
            Some(DraftSetPreview {
                id: format!("draft:{}", d.draft_id),
                code: d.draft_id.chars().take(8).collect(),
                draft_id: d.draft_id,
                title: d.title,
                origin: Origin::parse(&d.origin),
                count: problems.len(),
                problems,
            })
        })
        .collect();
    Ok(ok(OfferingSets {
        course_id: c.course_id,
        offering_title: c.offering_title.unwrap_or_else(|| format!("{} · {}班", c.term, c.section)),
        course_code: c.code,
        course_name: c.name,
        term: c.term,
        section: c.section,
        categories,
        course_sets,
        contest_sets,
        my_problem_sets,
    }))
}

// ---------------------------------------------------------------- 组卷

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct PickedItem {
    /// `cat:<code>` / `set:<code>` / `draft:<draft_id>`。
    pub set_id: String,
    pub slug: String,
}

/// 选题方式二选一：逐题 `items`；或整份 `set_id`（可用 `selected_slugs` 过滤，缺省取前 15 题）。
#[derive(Deserialize, TS)]
#[ts(export)]
pub struct Selection {
    #[serde(default)]
    #[ts(optional)]
    pub items: Option<Vec<PickedItem>>,
    #[serde(default)]
    #[ts(optional)]
    pub set_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub selected_slugs: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
}

struct Picked {
    slug: String,
    title: String,
    statement: String,
    knowledge: Vec<String>,
    samples: Vec<Case>,
    tests: Vec<Case>,
}

fn cases(v: &[BankCase]) -> Vec<Case> {
    v.iter().map(|c| Case { input: c.input.clone(), output: c.output.clone() }).collect()
}

/// 读取一份题单的全部题目：(展示代码, 题目)。
async fn load_set(s: &AppState, who: &Identity, set_id: &str) -> AppResult<(String, Vec<Picked>)> {
    if let Some(did) = set_id.strip_prefix("draft:") {
        let draft = authoring::get_draft(&s.db, who, did, false).await?;
        let picked = draft
            .document
            .problems
            .into_iter()
            .map(|p| Picked { slug: p.slug, title: p.title, statement: p.statement, knowledge: p.knowledge, samples: p.samples, tests: p.tests })
            .collect();
        return Ok((format!("draft:{}", did.chars().take(8).collect::<String>()), picked));
    }
    let (code, full) = s.bank.load_full(set_id).await?;
    let picked = full
        .problems
        .iter()
        .map(|p| Picked {
            slug: p.slug.clone(),
            title: p.title.clone(),
            statement: p.statement.clone(),
            knowledge: p.knowledge.clone(),
            samples: cases(&p.samples),
            tests: cases(&p.tests),
        })
        .collect();
    Ok((code, picked))
}

/// 按选择组装草稿文档。`tests_fallback_to_samples`：直接发布时无隐藏测试的题用样例充当测试。
async fn compose(s: &AppState, who: &Identity, sel: &Selection, tests_fallback_to_samples: bool, allowed_languages: Option<String>) -> AppResult<Document> {
    let mut sources: Vec<String> = Vec::new();
    let mut chosen: Vec<Picked> = Vec::new();
    if let Some(items) = sel.items.as_ref().filter(|i| !i.is_empty()) {
        let mut loaded: BTreeMap<String, (String, Vec<Picked>)> = BTreeMap::new();
        for it in items {
            let (sid, slug) = (it.set_id.trim(), it.slug.trim());
            if sid.is_empty() || slug.is_empty() {
                continue;
            }
            if !loaded.contains_key(sid) {
                loaded.insert(sid.to_owned(), load_set(s, who, sid).await?);
            }
            let (code, problems) = loaded.get_mut(sid).expect("inserted above");
            if !sources.contains(code) {
                sources.push(code.clone());
            }
            if let Some(i) = problems.iter().position(|p| p.slug == slug) {
                chosen.push(problems.swap_remove(i));
            }
        }
        if chosen.is_empty() {
            return Err(AppError::unprocessable("未在指定题单中找到勾选的题目"));
        }
    } else {
        let sid = sel.set_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let sid = sid.ok_or_else(|| AppError::unprocessable("请指定题单编号 (set_id) 或题目清单 (items)"))?;
        let (code, problems) = load_set(s, who, sid).await?;
        sources.push(code);
        if problems.is_empty() {
            return Err(AppError::unprocessable("题单内容为空"));
        }
        chosen = match sel.selected_slugs.as_ref().filter(|v| !v.is_empty()) {
            Some(slugs) => problems.into_iter().filter(|p| slugs.contains(&p.slug)).collect(),
            None => problems.into_iter().take(15).collect(),
        };
        if chosen.is_empty() {
            return Err(AppError::unprocessable("未选中任何题目"));
        }
    }
    chosen.truncate(100);

    let mut used = std::collections::HashSet::new();
    let problems: Vec<serde_json::Value> = chosen
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            let seq = i + 1;
            let raw = if p.slug.is_empty() { format!("prob-{seq}") } else { p.slug };
            let mut slug: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).take(64).collect();
            if slug.is_empty() || used.contains(&slug) {
                slug = format!("{}-{}", slug.chars().take(50).collect::<String>(), &authoring::new_draft_id()[..6]);
            }
            used.insert(slug.clone());
            let title = if p.title.trim().is_empty() { format!("题目 {seq}") } else { p.title.trim().to_owned() };
            let statement = if p.statement.trim().is_empty() { title.clone() } else { p.statement.trim().to_owned() };
            let samples = if p.samples.is_empty() { vec![Case { input: "1\n".into(), output: "1\n".into() }] } else { p.samples };
            let tests = if !p.tests.is_empty() { p.tests } else if tests_fallback_to_samples { samples.clone() } else { Vec::new() };
            serde_json::json!({
                "slug": slug, "seq": seq, "title": title, "statement": statement,
                "knowledge": p.knowledge, "samples": samples, "tests": tests,
            })
        })
        .collect();
    let count = problems.len();
    let title = match sel.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_owned(),
        None if sources.len() == 1 => format!("题单 · {}", sources[0]),
        None => format!("跨题单组合练习 ({count} 题)"),
    };
    sources.sort();
    let mut source_ref = if sources.len() <= 3 { format!("bank:{}", sources.join(",")) } else { format!("bank:mixed({})", sources.len()) };
    if source_ref.chars().count() > 255 {
        source_ref = source_ref.chars().take(255).collect();
    }
    document::validate(serde_json::json!({
        "title": title, "source_ref": source_ref, "read_only": false,
        "allowed_languages": allowed_languages, "problems": problems,
    }))
}

async fn import_set(State(s): State<AppState>, who: Identity, Path(oid): Path<u32>, Json(sel): Json<Selection>) -> AppResult<ApiOk<DraftCreated>> {
    offering_access(&s.db, &who, oid, Need::TEACH_WRITE).await?;
    let doc = compose(&s, &who, &sel, false, None).await?;
    Ok(ok(authoring::create_draft(&s.db, oid, &who.user, doc, Origin::Teacher).await?))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PublishAction {
    /// 建草稿并立即发布。
    #[default]
    Publish,
    /// 只建草稿。
    Draft,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct PublishToOfferingsRequest {
    pub offering_ids: Vec<u32>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub selection: Selection,
    #[serde(default)]
    #[ts(optional, as = "Option<PublishAction>")]
    pub action: PublishAction,
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
pub struct OfferingPublishResult {
    pub offering_id: u32,
    pub draft_id: String,
    /// 仅 action=publish 时有值。
    pub batch_id: Option<u32>,
    pub status: &'static str,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PublishToOfferingsResponse {
    pub action: PublishAction,
    pub title: String,
    pub problem_count: usize,
    pub offering_count: usize,
    pub results: Vec<OfferingPublishResult>,
}

async fn publish_to_offerings(
    State(s): State<AppState>,
    who: Identity,
    Json(body): Json<PublishToOfferingsRequest>,
) -> AppResult<ApiOk<PublishToOfferingsResponse>> {
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
    let allowed = body.allowed_languages.as_ref().and_then(LanguageList::normalize);
    let doc = compose(&s, &who, &body.selection, true, allowed.clone()).await?;
    let due_at = authoring::parse_due(body.due_at.as_deref())?;
    let mut results = Vec::new();
    for &oid in &oids {
        let key = authoring::insert_draft(&s.db, oid, &who.user, &doc, Origin::Teacher).await?;
        let batch_id = if body.action == PublishAction::Publish {
            let opts = PublishOptions {
                due_at,
                ai_enabled: body.ai_enabled.unwrap_or(true),
                allowed_languages: allowed.clone(),
                read_only: false,
                source_ref: doc.source_ref.clone(),
                legacy_batch_id: None,
            };
            // 新草稿 id 唯一，无需加锁。
            Some(authoring::publish(&s, oid, &key, &doc, &opts).await?)
        } else {
            None
        };
        let status = if batch_id.is_some() { "published" } else { "draft" };
        results.push(OfferingPublishResult { offering_id: oid, draft_id: key, batch_id, status });
    }
    Ok(ok(PublishToOfferingsResponse {
        action: body.action,
        problem_count: doc.problems.len(),
        title: doc.title,
        offering_count: oids.len(),
        results,
    }))
}
