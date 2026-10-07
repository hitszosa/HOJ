use crate::{
    academic::assignments::{AssignmentAssist, AssignmentContext},
    app::cache::ReadCache,
    app::error::Result,
    app::state::AppState,
    identity::permissions::{CourseAssist, CourseContext},
    schema::{assignments, submissions},
};
use axum::{Router, response::Response, routing::get};
use diesel::prelude::*;
use diesel_async::{AsyncMysqlConnection, RunQueryDsl};
use serde::Serialize;

#[derive(Serialize)]
struct AssignmentStatistics {
    id: i64,
    average: f64,
    highest: f64,
    lowest: f64,
    median: f64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/assignments/{id}/statistics", get(assignment))
        .route("/courses/{id}/statistics", get(course))
}

async fn aggregate(
    conn: &mut AsyncMysqlConnection,
    ids: &[i64],
) -> Result<Vec<AssignmentStatistics>> {
    let mut result = Vec::with_capacity(ids.len());

    for chunk in ids.chunks(1000) {
        let scores = submissions::table
            .filter(submissions::assignment_id.eq_any(chunk))
            .filter(submissions::status.eq(1))
            .select((submissions::assignment_id, submissions::score))
            .order((
                submissions::assignment_id.asc(),
                submissions::score.asc(),
                submissions::id.asc(),
            ))
            .load::<(i64, f64)>(conn)
            .await?;

        let mut offset = 0;
        for &id in chunk {
            let start = offset;
            while offset < scores.len() && scores[offset].0 == id {
                offset += 1;
            }

            let values = &scores[start..offset];
            let count = values.len();
            let mut stats = AssignmentStatistics {
                id,
                average: 0.0,
                highest: 0.0,
                lowest: 0.0,
                median: 0.0,
            };

            if count > 0 {
                stats.average = values.iter().map(|v| v.1).sum::<f64>() / count as f64;
                stats.lowest = values[0].1;
                stats.highest = values[count - 1].1;
                stats.median = if count % 2 == 0 {
                    (values[count / 2 - 1].1 + values[count / 2].1) / 2.0
                } else {
                    values[count / 2].1
                };
            }

            result.push(stats);
        }
    }

    Ok(result)
}

async fn assignment(
    cache: ReadCache,
    AssignmentAssist(AssignmentContext { mut conn, row }): AssignmentAssist,
) -> Result<Response> {
    let key = format!("statistics:assignment:{}", row.id);
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let stats = aggregate(&mut conn, &[row.id]).await?;
    let value = stats
        .into_iter()
        .next()
        .expect("one assignment always produces statistics");
    cache.json(&key, &value, None).await
}

async fn course(
    cache: ReadCache,
    CourseAssist(CourseContext { mut conn, id, .. }): CourseAssist,
) -> Result<Response> {
    let key = format!("statistics:course:{id}");
    if let Some(response) = cache.get(&key, &mut conn).await? {
        return Ok(response);
    }
    let ids = assignments::table
        .filter(assignments::course_id.eq(id))
        .select(assignments::id)
        .order(assignments::id.asc())
        .load::<i64>(&mut conn)
        .await?;
    let values = aggregate(&mut conn, &ids).await?;
    cache.json(&key, &values, None).await
}
