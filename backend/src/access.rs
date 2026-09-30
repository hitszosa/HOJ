//! 权限闸：无成员资格 404，成员但教师权限不足 403，历史（archived）教学班写操作 409。
//! 所有按教学班 / 题单的访问都必须先过这里。

use chrono::NaiveDateTime;
use serde::Serialize;
use sqlx::MySqlPool;
use ts_rs::TS;

use crate::{
    auth::Identity,
    error::{AppError, AppResult},
    hustoj,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Role {
    Teacher,
    Ta,
    Student,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "teacher" => Some(Self::Teacher),
            "ta" => Some(Self::Ta),
            "student" => Some(Self::Student),
            _ => None,
        }
    }

    /// 教师与助教：可看班级学情。
    pub fn is_staff(self) -> bool {
        matches!(self, Self::Teacher | Self::Ta)
    }
}

/// 需要的访问级别。
#[derive(Debug, Clone, Copy)]
pub struct Need {
    pub teacher: bool,
    pub write: bool,
}

impl Need {
    pub const READ: Self = Self { teacher: false, write: false };
    pub const WRITE: Self = Self { teacher: false, write: true };
    pub const TEACH: Self = Self { teacher: true, write: false };
    pub const TEACH_WRITE: Self = Self { teacher: true, write: true };
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Offering {
    pub offering_id: u32,
    pub course_id: u32,
    pub course_code: String,
    pub course_name: String,
    pub term: String,
    pub section: String,
    pub title: Option<String>,
    pub teacher_id: String,
    pub status: String,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub created_at: NaiveDateTime,
    #[serde(with = "crate::dt")]
    #[ts(type = "string")]
    pub updated_at: NaiveDateTime,
    /// 当前用户在本班的角色。
    pub role: Role,
}

impl Offering {
    pub fn archived(&self) -> bool {
        self.status == "archived"
    }
}

pub async fn offering_access(db: &MySqlPool, who: &Identity, oid: u32, need: Need) -> AppResult<Offering> {
    let row = sqlx::query!(
        r#"SELECT o.offering_id, o.course_id, c.code AS course_code, c.name AS course_name, o.term, o.section, o.title,
                  o.teacher_id, o.status, o.created_at, o.updated_at, e.role AS "role?"
           FROM cm_offering o
           JOIN cm_course c ON c.course_id=o.course_id
           LEFT JOIN cm_enrollment e ON e.offering_id=o.offering_id AND e.user_id=? AND e.status='active'
           WHERE o.offering_id=?"#,
        who.user,
        oid
    )
    .fetch_optional(db)
    .await?;
    let hidden = || AppError::not_found("教学班不存在或不可访问");
    let row = row.ok_or_else(hidden)?;
    let role = if row.teacher_id == who.user || who.is_admin() {
        Role::Teacher
    } else {
        row.role.as_deref().and_then(Role::parse).ok_or_else(hidden)?
    };
    if need.teacher && role != Role::Teacher {
        return Err(AppError::forbidden("只有本教学班教师可以操作"));
    }
    if need.write && row.status == "archived" {
        return Err(AppError::conflict("历史教学班为只读，不能修改、发布或提交"));
    }
    Ok(Offering {
        offering_id: row.offering_id,
        course_id: row.course_id,
        course_code: row.course_code,
        course_name: row.course_name,
        term: row.term,
        section: row.section,
        title: row.title,
        teacher_id: row.teacher_id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        role,
    })
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Batch {
    pub batch_id: u32,
    pub offering_id: u32,
    pub seq: u32,
    pub title: String,
    pub description: Option<String>,
    #[serde(with = "crate::dt::opt")]
    #[ts(type = "string | null")]
    pub open_at: Option<NaiveDateTime>,
    #[serde(with = "crate::dt::opt")]
    #[ts(type = "string | null")]
    pub due_at: Option<NaiveDateTime>,
    pub allow_late: bool,
    pub ai_enabled: bool,
    pub status: String,
    pub source_ref: Option<String>,
    pub read_only: bool,
    /// 允许提交的语言键；未限制时为全部语言。
    pub allowed_languages: Vec<String>,
    /// 按数据库时钟计算：已过截止时间。
    pub past_due: bool,
    #[serde(skip)]
    pub not_open_yet: bool,
    #[serde(skip)]
    pub languages_restricted: bool,
}

impl Batch {
    /// 截止或关闭后不再接收提交与自测。
    pub fn accepting(&self) -> bool {
        self.status != "closed" && (self.allow_late || !self.past_due)
    }
}

struct BatchRow {
    batch_id: u32,
    offering_id: u32,
    seq: u32,
    title: String,
    description: Option<String>,
    open_at: Option<NaiveDateTime>,
    due_at: Option<NaiveDateTime>,
    allow_late: bool,
    ai_enabled: bool,
    status: String,
    source_ref: Option<String>,
    read_only: bool,
    allowed_languages: Option<String>,
    past_due: bool,
    not_open_yet: bool,
}

impl From<BatchRow> for Batch {
    fn from(r: BatchRow) -> Self {
        Batch {
            batch_id: r.batch_id,
            offering_id: r.offering_id,
            seq: r.seq,
            title: r.title,
            description: r.description,
            open_at: r.open_at,
            due_at: r.due_at,
            allow_late: r.allow_late,
            ai_enabled: r.ai_enabled,
            status: r.status,
            source_ref: r.source_ref,
            read_only: r.read_only,
            languages_restricted: r.allowed_languages.as_deref().is_some_and(|s| !hustoj::parse_languages(s).is_empty()),
            allowed_languages: hustoj::allowed_languages(r.allowed_languages.as_deref()),
            past_due: r.past_due,
            not_open_yet: r.not_open_yet,
        }
    }
}

pub async fn load_batch(db: &MySqlPool, bid: u32) -> AppResult<Option<Batch>> {
    let row = sqlx::query_as!(
        BatchRow,
        r#"SELECT batch_id, offering_id, seq, title, description, open_at, due_at,
                  allow_late AS "allow_late: bool", ai_enabled AS "ai_enabled: bool", status, source_ref,
                  read_only AS "read_only: bool", allowed_languages,
                  (due_at IS NOT NULL AND due_at < NOW()) AS "past_due!: bool",
                  (open_at IS NOT NULL AND open_at > NOW()) AS "not_open_yet!: bool"
           FROM cm_batch WHERE batch_id=?"#,
        bid
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(Batch::from))
}

/// 教学班的全部题单（按 seq）。`visible_only` 时只返回对学生开放的题单。
pub async fn offering_batches(db: &MySqlPool, oid: u32, visible_only: bool) -> AppResult<Vec<Batch>> {
    let rows = sqlx::query_as!(
        BatchRow,
        r#"SELECT batch_id, offering_id, seq, title, description, open_at, due_at,
                  allow_late AS "allow_late: bool", ai_enabled AS "ai_enabled: bool", status, source_ref,
                  read_only AS "read_only: bool", allowed_languages,
                  (due_at IS NOT NULL AND due_at < NOW()) AS "past_due!: bool",
                  (open_at IS NOT NULL AND open_at > NOW()) AS "not_open_yet!: bool"
           FROM cm_batch
           WHERE offering_id=? AND (? = 0 OR (status!='draft' AND (open_at IS NULL OR open_at<=NOW())))
           ORDER BY seq"#,
        oid,
        visible_only as i8
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Batch::from).collect())
}

pub async fn batch_access(db: &MySqlPool, who: &Identity, bid: u32, need: Need) -> AppResult<(Batch, Offering)> {
    let batch = load_batch(db, bid).await?.ok_or_else(|| AppError::not_found("题单不存在"))?;
    let off = offering_access(db, who, batch.offering_id, need).await?;
    if off.role == Role::Student && (batch.status == "draft" || batch.not_open_yet) {
        return Err(AppError::not_found("题单尚未开放"));
    }
    Ok((batch, off))
}

/// 教师身份：HUSTOJ 教师/管理员权限，或至少主讲过一个教学班。
pub async fn is_teacher(db: &MySqlPool, who: &Identity) -> AppResult<bool> {
    if who.is_admin() {
        return Ok(true);
    }
    let hit = sqlx::query_scalar!(
        r#"SELECT 1 AS "x!: i32" FROM jol.privilege WHERE user_id=? AND rightstr IN ('teacher','administrator')
           UNION SELECT 1 FROM cm_offering WHERE teacher_id=? LIMIT 1"#,
        who.user,
        who.user
    )
    .fetch_optional(db)
    .await?;
    Ok(hit.is_some())
}

pub async fn require_teacher(db: &MySqlPool, who: &Identity) -> AppResult<()> {
    if is_teacher(db, who).await? { Ok(()) } else { Err(AppError::forbidden("只有教师身份可以访问此功能")) }
}

/// 未指定教学班时的默认落点：本人最新学期的活跃班。
/// 旧版在本人无班时会落到“全库最新的班”，草稿随后对本人不可访问；这里改为直接报错。
pub async fn primary_offering(db: &MySqlPool, who: &Identity) -> AppResult<u32> {
    sqlx::query_scalar!(
        "SELECT offering_id FROM cm_offering WHERE (teacher_id=? OR ?='admin') AND status='active' ORDER BY term DESC, offering_id DESC LIMIT 1",
        who.user,
        who.user
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::validation("暂无可用教学班，请先开设或分配教学班"))
}
