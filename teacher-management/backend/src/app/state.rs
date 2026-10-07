use crate::{
    app::{cache::Cache, config::Config, db::Pool},
    files::storage::Storage,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub cache: Cache,
    pub config: Arc<Config>,
    pub storage: Arc<Storage>,
    pub extractor: tonic::transport::Channel,
}
