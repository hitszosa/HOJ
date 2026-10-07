use crate::app::error::{AppError, Result};
use axum_prometheus::{
    EndpointLabel, PrometheusMetricLayer, PrometheusMetricLayerBuilder,
    metrics::{Counter, counter, describe_counter},
    metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle},
    utils::{SECONDS_DURATION_BUCKETS, requests_duration_name},
};

pub struct Metrics {
    pub(crate) layer: PrometheusMetricLayer<'static>,
    pub(crate) handle: PrometheusHandle,
    pub(crate) queries: Counter,
}

impl Metrics {
    /// Install once during startup, before creating any instrumented connections.
    pub fn install() -> Result<Self> {
        let handle = PrometheusBuilder::new()
            .set_buckets_for_metric(
                Matcher::Full(requests_duration_name().to_owned()),
                SECONDS_DURATION_BUCKETS,
            )
            .map_err(|_| AppError::Internal("Cannot configure request metrics".into()))?
            .install_recorder()
            .map_err(|_| AppError::Internal("Cannot install metrics recorder".into()))?;
        let upkeep = handle.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                upkeep.run_upkeep();
            }
        });
        let layer = PrometheusMetricLayerBuilder::new()
            .with_endpoint_label_type(EndpointLabel::MatchedPathWithFallbackFn(|_| {
                "unmatched".to_owned()
            }))
            .build();
        describe_counter!(
            "grader_database_queries_total",
            "Database statements executed by application pool"
        );
        let queries = counter!("grader_database_queries_total");
        queries.increment(0);
        Ok(Self {
            layer,
            handle,
            queries,
        })
    }
}
