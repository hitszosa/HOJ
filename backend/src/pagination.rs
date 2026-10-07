//! 题库和提交列表共用的分页参数。

/// page 从 1 开始，page_size 取 1–100，返回 (limit, offset)。
pub fn limit_offset(page: Option<u32>, page_size: Option<u32>, default_size: u32) -> (u32, u32) {
    let limit = page_size.unwrap_or(default_size).clamp(1, 100);
    (limit, (page.unwrap_or(1).max(1) - 1) * limit)
}
