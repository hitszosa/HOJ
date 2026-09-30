//! 题单文档：教师草稿、导入文件、AI 生成结果共用的结构，存于 cm_authoring_draft.payload（JSON）。
//! 先在 `serde_json::Value` 上逐项校验（给出具体中文提示），再反序列化为强类型。

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Case {
    pub input: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Problem {
    pub slug: String,
    pub title: String,
    pub statement: String,
    pub samples: Vec<Case>,
    /// 隐藏测试：只进判题数据目录，永不外发。
    #[serde(default)]
    pub tests: Vec<Case>,
    #[serde(default, deserialize_with = "knowledge_list")]
    pub knowledge: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub difficulty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seq: Option<u32>,
    /// 其余字段原样保留（category、provenance 等）。
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Document {
    pub title: String,
    pub problems: Vec<Problem>,
    /// 只读来源：只增不减，禁止公开导出。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allowed_languages: Option<String>,
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Map<String, Value>,
}

/// knowledge 兼容三种写法：字符串列表、数字混排、以“、”分隔的单个字符串。
fn knowledge_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        Value::String(s) => s.split('、').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect(),
        _ => Vec::new(),
    })
}

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_-]{1,64}$").unwrap());

fn non_blank(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
}

pub fn validate(doc: Value) -> AppResult<Document> {
    let bad = |m: &str| Err(AppError::unprocessable(m));
    let Some(obj) = doc.as_object() else { return bad("题单须为对象") };
    if obj.get("read_only").is_some_and(|v| !v.is_boolean()) {
        return bad("read_only 必须为布尔值");
    }
    match obj.get("source_ref") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s.chars().count() <= 255 => {}
        _ => return bad("source_ref 必须是不超过 255 字符的字符串"),
    }
    match obj.get("allowed_languages") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s.chars().count() <= 64 => {}
        _ => return bad("allowed_languages 必须是不超过 64 字符的字符串"),
    }
    if !non_blank(obj.get("title")) {
        return bad("请填写题单标题");
    }
    let Some(problems) = obj.get("problems").and_then(Value::as_array).filter(|p| (1..=100).contains(&p.len())) else {
        return bad("每个题单需要 1–100 道题");
    };
    let mut slugs = HashSet::new();
    for p in problems {
        let Some(p) = p.as_object().filter(|p| ["slug", "title", "statement"].iter().all(|k| non_blank(p.get(*k)))) else {
            return bad("每题须有 slug、标题和题面");
        };
        let slug = p["slug"].as_str().unwrap_or_default();
        if !SLUG.is_match(slug) || !slugs.insert(slug.to_owned()) {
            return bad("题目 slug 不合法或重复");
        }
        for kind in ["samples", "tests"] {
            let cases = match p.get(kind) {
                None => continue,
                Some(Value::Array(c)) if c.len() <= 100 => c,
                _ => return bad("样例或测试数据格式错误"),
            };
            let well_formed = |c: &Value| c.get("input").is_some_and(Value::is_string) && c.get("output").is_some_and(Value::is_string);
            if !cases.iter().all(well_formed) {
                return bad("样例和测试须包含文本 input/output");
            }
        }
        if p.get("samples").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return bad("每题至少提供一个样例");
        }
    }
    let mut value = doc;
    // null 与缺省等价，交给 serde 默认值处理。
    if let Some(obj) = value.as_object_mut() {
        obj.retain(|k, v| !(v.is_null() && matches!(k.as_str(), "source_ref" | "allowed_languages")));
    }
    serde_json::from_value(value).map_err(|_| AppError::unprocessable("题单格式错误"))
}

static DTD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<!DOCTYPE|<!ENTITY").unwrap());

/// 解析上传的题单文本：YAML / JSON，或 FPS XML（禁止 DTD 与实体）。
pub fn parse(content: &str) -> AppResult<Document> {
    if content.len() > 1_048_576 {
        return Err(AppError::unprocessable("题单文件过大"));
    }
    let unparsable = || AppError::unprocessable("无法解析题单，请检查 YAML / JSON / FPS XML 格式");
    let value = if content.trim_start().starts_with('<') {
        if DTD.is_match(content) {
            return Err(unparsable());
        }
        parse_fps(content).ok_or_else(unparsable)?
    } else {
        serde_yaml::from_str::<Value>(content).map_err(|_| unparsable())?
    };
    validate(value)
}

fn parse_fps(content: &str) -> Option<Value> {
    let doc = roxmltree::Document::parse(content).ok()?;
    let text = |item: roxmltree::Node, tag: &str| {
        item.children().find(|c| c.has_tag_name(tag)).and_then(|c| c.text()).unwrap_or("").to_owned()
    };
    let mut problems = Vec::new();
    for (i, item) in doc.root_element().children().filter(|c| c.has_tag_name("item")).enumerate() {
        let collect = |tag: &str| item.children().filter(|c| c.has_tag_name(tag)).map(|c| c.text().unwrap_or("").to_owned()).collect::<Vec<_>>();
        let (ins, outs) = (collect("test_input"), collect("test_output"));
        if ins.len() != outs.len() {
            return None;
        }
        problems.push(serde_json::json!({
            "slug": format!("fps-{}", i + 1),
            "title": text(item, "title"),
            "statement": format!("{}\n{}\n{}", text(item, "description"), text(item, "input"), text(item, "output")),
            "samples": [{"input": text(item, "sample_input"), "output": text(item, "sample_output")}],
            "tests": ins.into_iter().zip(outs).map(|(i, o)| serde_json::json!({"input": i, "output": o})).collect::<Vec<_>>(),
        }));
    }
    Some(serde_json::json!({"title": "导入的 FPS 题单", "problems": problems}))
}

/// 发布前检查：每题必须有隐藏测试，且不能全部与样例重复。
pub fn check_publishable(doc: &Document) -> AppResult<()> {
    for p in &doc.problems {
        if p.tests.is_empty() {
            return Err(AppError::unprocessable(format!("题目「{}」缺少隐藏测试；仅公开样例不能发布", p.title)));
        }
        let samples: HashSet<(&str, &str)> = p.samples.iter().map(|s| (s.input.as_str(), s.output.as_str())).collect();
        if p.tests.iter().all(|t| samples.contains(&(t.input.as_str(), t.output.as_str()))) {
            return Err(AppError::unprocessable(format!("题目「{}」隐藏测试必须覆盖样例之外的输入", p.title)));
        }
    }
    Ok(())
}

/// 请求里的语言限制：接受逗号串或字符串数组，归一为合法语言键的逗号串；空则不限制。
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum LanguageList {
    Csv(String),
    List(Vec<String>),
}

impl LanguageList {
    pub fn normalize(&self) -> Option<String> {
        let joined = match self {
            Self::Csv(s) => s.clone(),
            Self::List(v) => v.join(","),
        };
        let valid = crate::hustoj::parse_languages(&joined);
        (!valid.is_empty()).then(|| valid.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({"title":"T","problems":[{"slug":"a","title":"A","statement":"S","samples":[{"input":"1\n","output":"1\n"}],
               "tests":[{"input":"2\n","output":"2\n"}],"knowledge":"循环、数组","category":"x"}]})
    }

    #[test]
    fn valid_document_keeps_extra_fields() {
        let doc = validate(sample()).unwrap();
        assert_eq!(doc.problems[0].knowledge, vec!["循环", "数组"]);
        assert_eq!(doc.problems[0].extra["category"], "x");
        check_publishable(&doc).unwrap();
    }

    #[test]
    fn rejects_duplicate_slug_and_bad_read_only() {
        let mut v = sample();
        let p = v["problems"][0].clone();
        v["problems"].as_array_mut().unwrap().push(p);
        assert!(validate(v).is_err());
        let mut v = sample();
        v["read_only"] = json!("no");
        assert!(validate(v).is_err());
    }

    #[test]
    fn rejects_xml_entities() {
        assert!(parse(r#"<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><fps/>"#).is_err());
    }

    #[test]
    fn parses_fps() {
        let xml = "<fps><item><title>A</title><description>D</description><sample_input>1</sample_input>\
                   <sample_output>1</sample_output><test_input>2</test_input><test_output>2</test_output></item></fps>";
        let doc = parse(xml).unwrap();
        assert_eq!(doc.problems[0].slug, "fps-1");
        assert_eq!(doc.problems[0].tests.len(), 1);
    }

    #[test]
    fn samples_only_cannot_publish() {
        let mut v = sample();
        v["problems"][0]["tests"] = json!([{"input":"1\n","output":"1\n"}]);
        assert!(check_publishable(&validate(v).unwrap()).is_err());
    }
}
