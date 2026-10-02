//! DATETIME 在 JSON 里统一为 `YYYY-MM-DD HH:MM:SS` 字符串（与数据库字面值一致）。
//! 用法：字段上 `#[serde(with = "crate::dt")]` + `#[ts(type = "string")]`，
//! 可空字段用 `crate::dt::opt` + `#[ts(type = "string | null")]`。

use chrono::NaiveDateTime;
use serde::Serializer;

pub const FORMAT: &str = "%Y-%m-%d %H:%M:%S";

pub fn serialize<S: Serializer>(v: &NaiveDateTime, s: S) -> Result<S::Ok, S::Error> {
    s.collect_str(&v.format(FORMAT))
}

pub fn fmt(v: &NaiveDateTime) -> String {
    v.format(FORMAT).to_string()
}

pub mod opt {
    use super::*;

    pub fn serialize<S: Serializer>(v: &Option<NaiveDateTime>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.collect_str(&v.format(FORMAT)),
            None => s.serialize_none(),
        }
    }
}
