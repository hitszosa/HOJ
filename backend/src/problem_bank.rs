//! 本地结构化题库（data/problem_sets）。启动时建一次索引（只含预览字段，不含隐藏测试），
//! 需要隐藏测试时（导入、首次开放公开题）再按文件读取完整题目。

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use moka::sync::Cache;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sqlx::MySqlPool;
use ts_rs::TS;

use crate::{
    error::{AppError, AppResult},
    hustoj::{self, TestCase},
    state::AppState,
};

/// YAML 里的标量可能被解析成数字或布尔（如 `output: 3`），统一收成字符串。
fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

fn lenient_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BankCase {
    #[serde(default, deserialize_with = "lenient_string")]
    pub input: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub output: String,
}

/// 题库题目的完整内容（含隐藏测试），只在服务端内部使用。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BankProblemFull {
    #[serde(default, deserialize_with = "lenient_string")]
    pub slug: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub title: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub statement: String,
    #[serde(default)]
    pub difficulty: Option<String>,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub knowledge: Vec<String>,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub samples: Vec<BankCase>,
    #[serde(default)]
    pub tests: Vec<BankCase>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct BankSetFull {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub course: Option<String>,
    #[serde(default)]
    pub problems: Vec<BankProblemFull>,
}

/// 索引里的题目预览（不含隐藏测试）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BankProblem {
    #[serde(default, deserialize_with = "lenient_string")]
    pub slug: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub title: String,
    #[serde(default)]
    pub difficulty: String,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub tags: Vec<String>,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub knowledge: Vec<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub provenance: String,
    #[serde(default, deserialize_with = "lenient_string")]
    pub statement: String,
    #[serde(default)]
    pub samples: Vec<BankCase>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SetKind {
    /// 知识点分类（problems/categories/<code>.yml）。
    Category,
    /// 独立题单（problem_sets/<code>.yml）。
    Set,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BankSet {
    /// `cat:<code>` 或 `set:<code>`。
    pub id: String,
    pub kind: SetKind,
    pub code: String,
    pub title: String,
    /// 分类名（仅 category）。
    pub category_name: Option<String>,
    /// 所属课程代码（仅 set）。
    pub course: Option<String>,
    pub tags: Vec<String>,
    pub count: usize,
    /// 难度前缀（如 L1）→ 题数（仅 category）。
    pub difficulty_count: BTreeMap<String, usize>,
    pub problems: Vec<BankProblem>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BankIndex {
    pub categories: Vec<BankSet>,
    pub standalone_sets: Vec<BankSet>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TreeKind {
    Root,
    Pillar,
    Group,
    Leaf,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct TreeNode {
    pub id: String,
    pub name: String,
    pub kind: TreeKind,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub count: usize,
    /// 叶子节点：对应题单代码与预览。
    pub code: Option<String>,
    pub tags: Vec<String>,
    pub difficulty_count: BTreeMap<String, usize>,
    pub problems: Vec<BankProblem>,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct BankTree {
    pub root: TreeNode,
    pub total_problems: usize,
    pub total_sets: usize,
}

pub struct ProblemBank {
    dir: PathBuf,
    pub index: Arc<BankIndex>,
    pub tree: Arc<BankTree>,
    /// 课程代码 → 推荐分类代码。
    pub syllabus: HashMap<String, Vec<String>>,
    /// slug → 所在题单 id（分类优先）。
    slug_to_set: HashMap<String, String>,
    full_sets: Cache<String, Arc<BankSetFull>>,
}

struct Pillar {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    description: &'static str,
    groups: &'static [(&'static str, &'static str, &'static [&'static str])],
}

const TAXONOMY: &[Pillar] = &[
    Pillar {
        id: "p1-basics",
        name: "1. 基础与语言入门",
        icon: "🌱",
        description: "C/C++ 语法规范、分支与循环结构、基础函数与模块化设计",
        groups: &[
            ("g1-syntax", "语言与基本语法", &["01-basic-io", "08-functions", "10-struct-pointer", "DFBY-P05"]),
            ("g1-branch", "顺序与分支结构", &["02-branching", "DFBY-P01"]),
            ("g1-loop", "循环与多重迭代", &["03-loops", "04-nested-loops", "DFBY-P02"]),
        ],
    },
    Pillar {
        id: "p2-structures",
        name: "2. 核心数据结构",
        icon: "🧱",
        description: "线性表、数组矩阵、栈队列、二叉树与并查集等存储结构",
        groups: &[
            ("g2-linear", "线性表、数组与字符串", &["05-array-1d", "06-array-2d", "07-strings", "13-linear-list", "DFBY-P03", "DFBY-P04"]),
            ("g2-stack-queue", "栈、队列与单调结构", &["14-stack-queue"]),
            ("g2-trees", "树形结构与并查集", &["15-binary-tree", "16-heap-priority", "17-dsu"]),
        ],
    },
    Pillar {
        id: "p3-algorithms",
        name: "3. 算法思想与进阶",
        icon: "⚡",
        description: "排序二分、递归分治、搜索回溯、贪心动态规划与图论体系",
        groups: &[
            ("g3-sorting-search", "排序与高效检索", &["11-sorting", "12-binary-search"]),
            ("g3-recursion-search", "递归分治与搜索回溯", &["09-recursion-divide", "19-dfs-backtracking", "LUOGU-T03"]),
            ("g3-greedy", "经典贪心策略", &["18-greedy", "LUOGU-T04", "YBT-ADV-S01"]),
            ("g3-dp", "动态规划模型", &["20-dp-knapsack", "21-dp-linear-interval", "LUOGU-T01", "YBT-ADV-S03"]),
            ("g3-graphs", "图论核心算法", &["22-graph-shortest", "23-graph-mst-topo", "LUOGU-T02", "YBT-ADV-S02"]),
        ],
    },
    Pillar {
        id: "p4-math",
        name: "4. 数学与数论专项",
        icon: "🔢",
        description: "经典数论素数筛法、高精度大数乘除与组合数学",
        groups: &[("g4-theory", "初等数学与数论基础", &["24-number-theory", "YBT-ADV-S05", "YBT-ADV-S04"])],
    },
    Pillar {
        id: "p5-contests",
        name: "5. 竞赛真题与等级认证",
        icon: "🏆",
        description: "蓝桥杯真题、GESP 等级认证、USACO 实战与高校专业机试",
        groups: &[
            ("g5-lanqiao", "蓝桥杯历届真题精选", &["LANQIAO-B01", "LANQIAO-B02", "LANQIAO-B03", "LANQIAO-B04", "LANQIAO-B05", "LANQIAO-B06"]),
            ("g5-gesp", "CCF GESP 认证精选", &["GESP-G01"]),
            ("g5-usaco", "USACO 国际竞赛实战", &["USACO-U01", "USACO-U02"]),
            ("g5-nowcoder", "牛客大学专业机试", &["NOWCODER-N01"]),
        ],
    },
];

#[derive(Deserialize)]
struct CatalogEntry {
    category_id: String,
    #[serde(default)]
    category_name: String,
    #[serde(flatten)]
    problem: BankProblem,
}

#[derive(Deserialize)]
struct SetPreview {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    course: Option<Value>,
    #[serde(default)]
    problems: Vec<BankProblem>,
}

fn yml_stems(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "yml"))
        .filter_map(|p| Some((p.file_stem()?.to_str()?.to_owned(), p)))
        .collect();
    out.sort();
    out
}

fn difficulty_prefix(d: &str) -> String {
    d.chars().take(2).collect()
}

impl ProblemBank {
    /// 读取失败的文件跳过并记日志，题库缺失不影响服务启动。
    pub fn load(data_dir: &Path) -> Self {
        let dir = data_dir.join("problem_sets");
        let catalog: Vec<CatalogEntry> = fs::read(dir.join("index/catalog.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| tracing::warn!(error = %e, "catalog.json")).ok())
            .unwrap_or_default();
        let mut by_category: HashMap<String, Vec<CatalogEntry>> = HashMap::new();
        for mut entry in catalog {
            if entry.problem.difficulty.is_empty() {
                entry.problem.difficulty = "L1-入门".into();
            }
            by_category.entry(entry.category_id.clone()).or_default().push(entry);
        }
        let mut categories = Vec::new();
        for (stem, _) in yml_stems(&dir.join("problems/categories")) {
            let entries = by_category.remove(&stem).unwrap_or_default();
            let name = entries.first().map(|e| e.category_name.clone()).unwrap_or_else(|| stem.clone());
            let tags = match entries.first() {
                Some(e) if !e.problem.tags.is_empty() => e.problem.tags.clone(),
                Some(_) => vec![name.clone()],
                None => vec![stem.clone()],
            };
            let mut difficulty_count = BTreeMap::new();
            for e in &entries {
                *difficulty_count.entry(difficulty_prefix(&e.problem.difficulty)).or_insert(0) += 1;
            }
            let problems: Vec<BankProblem> = entries.into_iter().map(|e| e.problem).collect();
            categories.push(BankSet {
                id: format!("cat:{stem}"),
                kind: SetKind::Category,
                title: format!("{stem} · {name}"),
                code: stem,
                category_name: Some(name),
                course: None,
                tags,
                count: problems.len(),
                difficulty_count,
                problems,
            });
        }
        let mut standalone_sets = Vec::new();
        for (stem, path) in yml_stems(&dir) {
            let parsed = fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| serde_yaml::from_str::<SetPreview>(&s).map_err(|e| e.to_string()));
            let doc = match parsed {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(file = %path.display(), error = %e, "skip problem set");
                    continue;
                }
            };
            let problems: Vec<BankProblem> = doc
                .problems
                .into_iter()
                .map(|mut p| {
                    if p.difficulty.is_empty() {
                        p.difficulty = "medium".into();
                    }
                    p
                })
                .collect();
            let course = doc.course.map(|c| c.as_str().map(str::to_owned).unwrap_or_else(|| c.to_string()));
            standalone_sets.push(BankSet {
                id: format!("set:{stem}"),
                kind: SetKind::Set,
                title: doc.title.unwrap_or_else(|| stem.clone()),
                code: stem,
                category_name: None,
                course: Some(course.unwrap_or_default()),
                tags: Vec::new(),
                count: problems.len(),
                difficulty_count: BTreeMap::new(),
                problems,
            });
        }
        let mut slug_to_set = HashMap::new();
        for set in categories.iter().chain(&standalone_sets) {
            for p in &set.problems {
                slug_to_set.entry(p.slug.clone()).or_insert_with(|| set.id.clone());
            }
        }
        let index = BankIndex { categories, standalone_sets };
        let tree = build_tree(&index);
        let syllabus = fs::read(data_dir.join("course_syllabus.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<HashMap<String, Value>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|(code, v)| {
                let cats = v["recommended_categories"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                (code, cats)
            })
            .collect();
        tracing::info!(categories = index.categories.len(), sets = index.standalone_sets.len(), "problem bank loaded");
        Self {
            dir,
            index: Arc::new(index),
            tree: Arc::new(tree),
            syllabus,
            slug_to_set,
            full_sets: Cache::builder().max_capacity(4).build(),
        }
    }

    pub fn set(&self, id: &str) -> Option<&BankSet> {
        self.index.categories.iter().chain(&self.index.standalone_sets).find(|s| s.id == id)
    }

    /// 预览题目与其所在题单。
    pub fn find(&self, slug: &str) -> Option<(&BankSet, &BankProblem)> {
        let set = self.set(self.slug_to_set.get(slug)?)?;
        Some((set, set.problems.iter().find(|p| p.slug == slug)?))
    }

    /// 题单 id → (展示代码, 文件路径)。接受 `cat:`/`category:`/`set:` 前缀或裸代码。
    pub fn resolve_file(&self, set_id: &str) -> (String, PathBuf) {
        let cat = |c: &str| self.dir.join("problems/categories").join(format!("{c}.yml"));
        let set = |c: &str| self.dir.join(format!("{c}.yml"));
        if let Some(code) = set_id.strip_prefix("cat:").or_else(|| set_id.strip_prefix("category:")) {
            (code.to_owned(), cat(code))
        } else if let Some(code) = set_id.strip_prefix("set:") {
            (code.to_owned(), set(code))
        } else if set(set_id).is_file() {
            (set_id.to_owned(), set(set_id))
        } else {
            (set_id.to_owned(), cat(set_id))
        }
    }

    /// 读取完整题单（含隐藏测试）。文件可达数十 MB，放到阻塞线程解析并缓存最近几份。
    pub async fn load_full(&self, set_id: &str) -> AppResult<(String, Arc<BankSetFull>)> {
        let (code, path) = self.resolve_file(set_id);
        let key = path.to_string_lossy().into_owned();
        if let Some(doc) = self.full_sets.get(&key) {
            return Ok((code, doc));
        }
        // 代码只允许题库命名字符，防止路径穿越。
        if code.is_empty() || !code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') || !path.is_file() {
            return Err(AppError::not_found(format!("未找到题单文件: {set_id}")));
        }
        let doc = tokio::task::spawn_blocking(move || -> Result<BankSetFull, String> {
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            serde_yaml::from_str(&text).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(|e| AppError::internal(format!("problem set {set_id}: {e}")))?;
        let doc = Arc::new(doc);
        self.full_sets.insert(key, doc.clone());
        Ok((code, doc))
    }
}

fn build_tree(index: &BankIndex) -> BankTree {
    let lookup: HashMap<&str, &BankSet> = index.categories.iter().chain(&index.standalone_sets).map(|s| (s.code.as_str(), s)).collect();
    let node = |id: &str, name: &str, kind: TreeKind| TreeNode {
        id: id.to_owned(),
        name: name.to_owned(),
        kind,
        icon: None,
        description: None,
        count: 0,
        code: None,
        tags: Vec::new(),
        difficulty_count: BTreeMap::new(),
        problems: Vec::new(),
        children: Vec::new(),
    };
    let mut total_sets = 0;
    let mut pillars = Vec::new();
    for p in TAXONOMY {
        let mut pn = node(p.id, p.name, TreeKind::Pillar);
        pn.icon = Some(p.icon.to_owned());
        pn.description = Some(p.description.to_owned());
        for (gid, gname, codes) in p.groups {
            let mut gn = node(gid, gname, TreeKind::Group);
            for set in codes.iter().filter_map(|c| lookup.get(c)) {
                total_sets += 1;
                let mut leaf = node(&set.id, &set.title, TreeKind::Leaf);
                leaf.code = Some(set.code.clone());
                leaf.count = set.count;
                leaf.tags = set.tags.clone();
                leaf.difficulty_count = set.difficulty_count.clone();
                leaf.problems = set.problems.clone();
                gn.count += leaf.count;
                gn.children.push(leaf);
            }
            pn.count += gn.count;
            pn.children.push(gn);
        }
        pillars.push(pn);
    }
    let total_problems = pillars.iter().map(|p| p.count).sum();
    let mut root = node("root", "算法题库全景分类体系", TreeKind::Root);
    root.icon = Some("🎓".into());
    root.count = total_problems;
    root.children = pillars;
    BankTree { root, total_problems, total_sets }
}

/// 题库题目首次被访问或提交时落库到 jol.problem（source=`bank:<slug>`），并写入测试点。
pub async fn ensure_bank_problem(state: &AppState, slug: &str) -> AppResult<Option<i32>> {
    let source = format!("bank:{slug}");
    if let Some(pid) = existing_bank_problem(&state.db, &source).await? {
        return Ok(Some(pid));
    }
    let Some((set, _)) = state.bank.find(slug) else { return Ok(None) };
    let (_, full) = state.bank.load_full(&set.id).await?;
    let Some(p) = full.problems.iter().find(|p| p.slug == slug) else { return Ok(None) };
    let title = if p.title.trim().is_empty() { slug.to_owned() } else { p.title.trim().to_owned() };
    let default_sample = [BankCase { input: "1\n".into(), output: "1\n".into() }];
    let samples: &[BankCase] = if p.samples.is_empty() { &default_sample } else { &p.samples };
    let tests: &[BankCase] = if p.tests.is_empty() { samples } else { &p.tests };
    let hint = if p.tags.is_empty() { &p.knowledge } else { &p.tags }.iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("、");
    // INSERT ... SELECT WHERE NOT EXISTS：并发首访不会插出两道同源题。
    let result = sqlx::query!(
        "INSERT INTO jol.problem(title,description,input,output,sample_input,sample_output,hint,source,in_date,defunct,time_limit,memory_limit)
         SELECT ?,?,'','',?,?,?,?,NOW(),'N',1,128 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM jol.problem WHERE source=?)",
        title, p.statement.trim(), samples[0].input, samples[0].output, hint, source, source
    )
    .execute(&state.ops)
    .await?;
    let pid = existing_bank_problem(&state.ops, &source).await?.ok_or_else(|| AppError::internal("bank problem insert lost"))?;
    if result.rows_affected() > 0 {
        let cases: Vec<TestCase> = tests.iter().map(|t| TestCase { input: &t.input, output: &t.output }).collect();
        // 题目已开放；测试点写入失败只记日志，与旧版一致（重试入口：重新发布或运维脚本）。
        if let Err(e) = hustoj::write_test_files(state, pid, &cases).await {
            tracing::warn!(pid, error = %e, "bank problem test data write failed");
        }
    }
    Ok(Some(pid))
}

async fn existing_bank_problem(db: &MySqlPool, source: &str) -> AppResult<Option<i32>> {
    Ok(sqlx::query_scalar!("SELECT problem_id FROM jol.problem WHERE source=? ORDER BY problem_id LIMIT 1", source).fetch_optional(db).await?)
}
