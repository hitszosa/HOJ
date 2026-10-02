//! OpenAI 兼容的模型服务：AI 出题与提交学习建议。

use std::{sync::LazyLock, time::Duration};

use regex::Regex;
use serde_json::{Value, json};

use crate::{
    document::{self, Document},
    error::{AppError, AppResult},
    state::AppState,
};

const GENERATE_SYSTEM: &str = "你是编程课教师助手。只返回 JSON 题单，含 title, problems。每题含 slug,title,statement,samples:[{input,output}],tests:[{input,output}],knowledge:[字符串]。给出可验证的边界测试。产物必须由教师审核。不得声称已访问外部资料。";
const HINT_SYSTEM: &str = "你是编程课助教。只依据给定事实写 1 条中文学习建议，不超过 300 字。不得改写、质疑或猜测判题结果，不得声称看到隐藏测试或外部资料，不得给出可直接提交的完整解答。";

/// 调用 chat/completions，返回首条消息文本。任何失败都归为 None，由调用方决定降级方式。
async fn chat(state: &AppState, payload: Value, timeout: Duration) -> Option<Value> {
    let ai = &state.cfg.ai;
    let url = format!("{}/chat/completions", ai.url.as_deref()?.trim_end_matches('/'));
    let response = state
        .http
        .post(url)
        .bearer_auth(ai.key.as_deref().unwrap_or(""))
        .json(&payload)
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    Some(body["choices"][0]["message"]["content"].clone())
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^```(?:json)?\s*|\s*```$").unwrap());

/// 按教学目标生成题单草稿；产物仍须经教师审核后才能发布。
pub async fn generate_document(state: &AppState, topic: &str) -> AppResult<Document> {
    if !state.cfg.ai.configured() {
        return Err(AppError::unavailable("尚未连接 AI 出题服务；请使用自编题或导入题单"));
    }
    let payload = json!({
        "model": state.cfg.ai.model,
        "messages": [{"role": "system", "content": GENERATE_SYSTEM}, {"role": "user", "content": topic}],
    });
    let invalid = || AppError::upstream("AI 服务没有返回有效题单，请重试或手动编写");
    let content = chat(state, payload, Duration::from_secs(45)).await.ok_or_else(invalid)?;
    let text = content.as_str().ok_or_else(invalid)?;
    let text = FENCE.replace_all(text.trim(), "");
    let value: Value = serde_json::from_str(&text).map_err(|_| invalid())?;
    // 模型输出不合格属于上游问题，统一报 502 而不是 422。
    document::validate(value).map_err(|_| invalid())
}

pub const RULES_FALLBACK: [&str; 3] = ["先读取判题结果与错误信息。", "使用题目样例复现并记录中间状态。", "一次只修改一个假设，再用新的提交验证。"];

pub fn rule_hints(result: i16) -> [&'static str; 3] {
    match result {
        6 => ["对照输入约束检查边界值。", "选取最小规模与最大规模，手动跟踪关键变量。", "把实际输出和预期输出逐行比较，定位第一个不同的位置。"],
        11 => ["先定位编译器给出的第一条错误。", "检查该行之前的括号、类型声明和作用域。", "逐步缩小报错片段，修复后重新提交。"],
        7 => ["检查循环是否可以结束。", "估算输入规模与循环次数的关系。", "查找是否重复计算了相同的中间结果。"],
        _ => RULES_FALLBACK,
    }
}

fn level_guide(level: u8) -> &'static str {
    match level {
        1 => "只给方向性提示，不点具体行号",
        2 => "指出可疑的结构或边界，可引用判题错误信息",
        _ => "给出接近可操作的定位，但仍不得提供完整解答",
    }
}

/// 按字符截断（题面等短文本）。
pub fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit { text.to_owned() } else { format!("{}……（已截断）", text.chars().take(limit).collect::<String>()) }
}

/// 按 UTF-8 字节截断（源码），不切出半个字符。
pub fn clip_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}……（已截断）", &text[..end])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HintFailure {
    NotConfigured,
    ModelUnavailable,
    InvalidResponse,
    AlreadyPassed,
}

pub struct HintInput<'a> {
    pub title: &'a str,
    pub statement: &'a str,
    pub input: &'a str,
    pub output: &'a str,
    pub sample_input: &'a str,
    pub sample_output: &'a str,
    pub result: i16,
    pub label: &'a str,
    pub time_ms: i32,
    pub memory_kb: i32,
    /// 只发编译信息：运行错误可能回显隐藏输入/输出，绝不外发。
    pub compile_error: &'a str,
    pub language: u32,
    pub code: &'a str,
}

/// 只发送本次已授权的事实：公开题面、学生本人代码、服务端判题结果与提示级别。
pub async fn analysis_hint(state: &AppState, x: &HintInput<'_>, level: u8) -> Result<String, HintFailure> {
    if !state.cfg.ai.configured() {
        return Err(HintFailure::NotConfigured);
    }
    let case = json!({
        "level": level,
        "levelGuide": level_guide(level),
        "problem": {
            "title": clip(x.title, 200), "statement": clip(x.statement, 4000),
            "input": clip(x.input, 1000), "output": clip(x.output, 1000),
            "sampleInput": clip(x.sample_input, 1000), "sampleOutput": clip(x.sample_output, 1000),
        },
        "judge": {
            "resultCode": x.result, "resultLabel": x.label, "timeMs": x.time_ms, "memoryKb": x.memory_kb,
            "compileError": clip(x.compile_error, 2000),
        },
        "language": x.language,
        "code": clip_bytes(x.code, 8000),
    });
    let payload = json!({
        "model": state.cfg.ai.model,
        "temperature": 0.2,
        "messages": [{"role": "system", "content": HINT_SYSTEM}, {"role": "user", "content": case.to_string()}],
    });
    let content = chat(state, payload, state.cfg.ai.hint_timeout).await.ok_or(HintFailure::ModelUnavailable)?;
    let text = content.as_str().map(str::trim).ok_or(HintFailure::InvalidResponse)?;
    if text.is_empty() || text.chars().count() > 1200 {
        return Err(HintFailure::InvalidResponse);
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("你好世界", 2), "你好……（已截断）");
        assert_eq!(clip_bytes("你好", 4), "你……（已截断）");
    }
}
