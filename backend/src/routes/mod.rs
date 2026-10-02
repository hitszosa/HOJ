//! 路由：一个文件对应一个领域，每个文件的 `router()` 列出本领域全部接口。

pub mod batches;
pub mod drafts;
pub mod offerings;
pub mod problem_sets;
pub mod public_problems;
pub mod ranking;
pub mod session;
pub mod submissions;
pub mod system;
pub mod teacher_library;

use axum::Router;

use crate::state::AppState;

pub fn all() -> Router<AppState> {
    Router::new()
        .merge(system::router())
        .merge(session::router())
        .merge(offerings::router())
        .merge(batches::router())
        .merge(submissions::router())
        .merge(drafts::router())
        .merge(teacher_library::router())
        .merge(problem_sets::router())
        .merge(public_problems::router())
        .merge(ranking::router())
}
