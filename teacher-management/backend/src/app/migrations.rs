use diesel::{
    QueryableByName,
    migration::MigrationSource,
    mysql::Mysql,
    sql_query,
    sql_types::{BigInt, Text},
};
use diesel_async::{AsyncConnection, AsyncMigrationHarness, AsyncMysqlConnection, RunQueryDsl};
use diesel_migrations::{EmbeddedMigrations, MigrationHarness, embed_migrations};

use super::error::{AppError, Result};

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

#[derive(QueryableByName)]
struct Table {
    #[diesel(sql_type = Text)]
    table_name: String,
}

#[derive(QueryableByName)]
struct Version {
    #[diesel(sql_type = Text)]
    version: String,
}

async fn connect(database_url: &str) -> Result<AsyncMysqlConnection> {
    AsyncMysqlConnection::establish(database_url)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn embedded_versions() -> Result<Vec<String>> {
    let migrations = <EmbeddedMigrations as MigrationSource<Mysql>>::migrations(&MIGRATIONS)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let mut versions = migrations
        .iter()
        .map(|migration| migration.name().version().to_string())
        .collect::<Vec<_>>();
    versions.sort();
    Ok(versions)
}

async fn tables(conn: &mut AsyncMysqlConnection) -> Result<Vec<Table>> {
    Ok(sql_query(
        "SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()",
    )
    .load(conn)
    .await?)
}

async fn applied_versions(conn: &mut AsyncMysqlConnection) -> Result<Vec<String>> {
    Ok(
        sql_query("SELECT version FROM __diesel_schema_migrations ORDER BY version")
            .load::<Version>(conn)
            .await?
            .into_iter()
            .map(|row| row.version)
            .collect(),
    )
}

/// Serving never creates or stamps the migration ledger.
pub async fn assert_current(database_url: &str) -> Result<()> {
    let mut conn = connect(database_url).await?;
    if !tables(&mut conn)
        .await?
        .iter()
        .any(|table| table.table_name == "__diesel_schema_migrations")
    {
        return Err(AppError::Internal(
            "Missing migration history; initialize an empty database with migrate or convert an existing database before serving".into(),
        ));
    }
    if applied_versions(&mut conn).await? != embedded_versions()? {
        return Err(AppError::Internal(
            "Database migration history differs from this binary; run migrate before serving"
                .into(),
        ));
    }
    Ok(())
}

pub async fn migrate(database_url: &str) -> Result<()> {
    let mut conn = connect(database_url).await?;
    // The dedicated connection owns the schema lock until it is dropped.
    let acquired: i64 = diesel::select(diesel::dsl::sql::<BigInt>(
        "CAST(COALESCE(GET_LOCK(CONCAT('grader-schema:', LEFT(SHA2(DATABASE(), 256), 40)), 0), 0) AS SIGNED)",
    ))
    .get_result(&mut conn)
    .await?;
    if acquired != 1 {
        return Err(AppError::Internal(
            "Another schema operation holds the database advisory lock".into(),
        ));
    }
    let tables = tables(&mut conn).await?;
    let applied = if tables
        .iter()
        .any(|table| table.table_name == "__diesel_schema_migrations")
    {
        applied_versions(&mut conn).await?
    } else {
        Vec::new()
    };
    let embedded = embedded_versions()?;
    if !embedded.starts_with(&applied) {
        return Err(AppError::Internal(
            "Applied migration history is not a prefix of this binary's migrations".into(),
        ));
    }
    if applied.is_empty()
        && tables
            .iter()
            .any(|table| table.table_name != "__diesel_schema_migrations")
    {
        return Err(AppError::Internal(
            "Populated database has no migration history; convert it before running migrate".into(),
        ));
    }
    let mut harness = AsyncMigrationHarness::new(conn);
    let applied = harness
        .run_pending_migrations(MIGRATIONS)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    tracing::info!(
        applied_versions = applied.len(),
        "Database migrations complete"
    );
    Ok(())
}
