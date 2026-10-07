//! 路由：一个文件对应一个领域，每个文件的 `router()` 列出本领域全部接口。

pub mod batches;
pub mod account;
pub mod drafts;
pub mod offerings;
pub mod management;
pub mod problem_sets;
pub mod public_problems;
pub mod session;
pub mod submissions;
pub mod student_progress;
pub mod question_ranking;
pub mod assignment_overview;
pub mod system;
pub mod teacher_library;

use axum::Router;

use crate::state::AppState;

pub fn all() -> Router<AppState> {
    Router::new()
        .merge(system::router())
        .merge(account::router())
        .merge(session::router())
        .merge(management::router())
        .merge(offerings::router())
        .merge(batches::router())
        .merge(submissions::router())
        .merge(student_progress::router())
        .merge(question_ranking::router())
        .merge(assignment_overview::router())
        .merge(drafts::router())
        .merge(teacher_library::router())
        .merge(problem_sets::router())
        .merge(public_problems::router())
}
