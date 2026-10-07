use std::collections::BTreeSet;
use std::fs::File;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, bail, ensure};
use aws_config::{BehaviorVersion, Region};
use aws_credential_types::Credentials;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use clap::Parser;
use diesel::sql_types::{BigInt, Json, Nullable, Text};
use diesel::{QueryableByName, sql_query};
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl, SimpleAsyncConnection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

#[path = "migrate_upload_objects/manifest.rs"]
mod manifest;
use manifest::{append, create_manifest, open_manifest};

#[derive(Parser)]
#[command(
    about = "Inspect legacy upload objects; --apply requires all application writers stopped"
)]
struct Args {
    /// Perform copies, database cutover, and legacy-object deletion (default: read-only).
    #[arg(long)]
    apply: bool,
    /// Private JSONL rollback manifest. A new path is created exclusively; an existing path resumes.
    #[arg(long, required_if_eq("apply", "true"))]
    manifest: Option<PathBuf>,
}

const OLD: [&str; 6] = [
    "object_key",
    "staging_key",
    "object_etag",
    "published_at",
    "source_etag",
    "source_version",
];
const BASE: [&str; 14] = [
    "id",
    "file_ident",
    "uploaded_by",
    "created_at",
    "upload_finished_at",
    "file_name",
    "file_size",
    "content_type",
    "assignment_id",
    "upload_state",
    "upload_expires_at",
    "upload_purpose",
    "object_key",
    "staging_key",
];
const AFFECTED: &str = "(object_key IS NOT NULL AND BINARY object_key <> BINARY file_ident) \
    OR staging_key IS NOT NULL OR upload_state = 'finalizing'";

#[derive(QueryableByName)]
struct Number {
    #[diesel(sql_type = BigInt)]
    n: i64,
}

#[derive(QueryableByName)]
struct TextValue {
    #[diesel(sql_type = Text)]
    value: String,
}

#[derive(QueryableByName, Serialize, Deserialize, Clone)]
struct Row {
    #[diesel(sql_type = BigInt)]
    id: i64,
    #[diesel(sql_type = Text)]
    file_ident: String,
    #[diesel(sql_type = Text)]
    upload_state: String,
    #[diesel(sql_type = Nullable<Text>)]
    object_key: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    staging_key: Option<String>,
    #[diesel(sql_type = Json)]
    snapshot: Value,
}

#[derive(Serialize, Deserialize)]
struct Planned {
    row: Row,
    source: Option<String>,
    size: u64,
    etag: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    database: String,
    endpoint: String,
    bucket: String,
    rows: Vec<Planned>,
    cleanup: BTreeSet<String>,
}

struct Store {
    client: Client,
    bucket: String,
}

struct Metadata {
    size: u64,
    etag: Option<String>,
}

fn required(name: &str) -> Result<String> {
    std::env::var(name)
        .map_err(|_| anyhow::anyhow!("required environment variable missing: {name}"))
}

fn snapshot_sql(legacy: bool) -> String {
    let fields = BASE
        .iter()
        .filter(|f| !OLD.contains(f))
        .copied()
        .chain(OLD.iter().copied().filter(|_| legacy));
    format!(
        "JSON_OBJECT({})",
        fields
            .map(|f| format!("'{f}', `{f}`"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

async fn legacy_schema(conn: &mut AsyncMysqlConnection) -> Result<bool> {
    let row = sql_query("SELECT CAST(COUNT(*) AS SIGNED) AS n FROM information_schema.columns \
        WHERE table_schema = DATABASE() AND table_name = 'file_info' \
        AND column_name IN ('object_key','staging_key','object_etag','published_at','source_etag','source_version')")
        .get_result::<Number>(conn).await.map_err(|_| anyhow::anyhow!("could not inspect database schema"))?;
    ensure!(
        row.n == 0 || row.n == 6,
        "partial legacy schema; refusing migration"
    );
    Ok(row.n == 6)
}

async fn affected(conn: &mut AsyncMysqlConnection) -> Result<Vec<Row>> {
    let mut rows = Vec::new();
    let mut after = 0_i64;
    loop {
        let page = sql_query(format!(
            "SELECT id, file_ident, upload_state, object_key, staging_key, {} AS snapshot \
            FROM file_info WHERE id > ? AND ({AFFECTED}) ORDER BY id LIMIT 250",
            snapshot_sql(true)
        ))
        .bind::<BigInt, _>(after)
        .load::<Row>(conn)
        .await
        .map_err(|_| anyhow::anyhow!("could not load legacy upload rows"))?;
        if page.is_empty() {
            break;
        }
        after = page.last().unwrap().id;
        rows.extend(page);
    }
    Ok(rows)
}

async fn protected(conn: &mut AsyncMysqlConnection, key: &str) -> Result<bool> {
    let row = sql_query(
        "SELECT CAST(COUNT(*) AS SIGNED) AS n FROM file_info \
        WHERE file_ident = ? AND BINARY file_ident = BINARY ?",
    )
    .bind::<Text, _>(key)
    .bind::<Text, _>(key)
    .get_result::<Number>(conn)
    .await
    .map_err(|_| anyhow::anyhow!("could not check protected destination"))?;
    Ok(row.n != 0)
}

impl Store {
    async fn head(&self, key: &str) -> Result<Option<Metadata>> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(out) => {
                let size = out
                    .content_length()
                    .filter(|n| *n >= 0)
                    .ok_or_else(|| anyhow::anyhow!("object size unavailable"))?;
                Ok(Some(Metadata {
                    size: size as u64,
                    etag: out.e_tag().map(str::to_owned),
                }))
            }
            Err(e) if e.as_service_error().is_some_and(|e| e.is_not_found()) => Ok(None),
            Err(_) => bail!("object metadata request failed"),
        }
    }

    async fn digest(&self, key: &str, etag: Option<&str>) -> Result<(u64, String)> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .set_if_match(etag.map(str::to_owned))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("object verification download failed"))?;
        let mut stream = output.body.into_async_read();
        let mut buffer = [0_u8; 65536];
        let mut size = 0_u64;
        let mut hash = Sha256::new();
        loop {
            let n = stream
                .read(&mut buffer)
                .await
                .map_err(|_| anyhow::anyhow!("object verification stream failed"))?;
            if n == 0 {
                break;
            }
            size += n as u64;
            hash.update(&buffer[..n]);
        }
        Ok((size, hex::encode(hash.finalize())))
    }

    async fn prefixes(&self) -> Result<BTreeSet<String>> {
        let mut keys = BTreeSet::new();
        for prefix in ["objects/", "staging/"] {
            let mut token = None;
            loop {
                let page = self
                    .client
                    .list_objects_v2()
                    .bucket(&self.bucket)
                    .prefix(prefix)
                    .max_keys(1000)
                    .set_continuation_token(token.clone())
                    .send()
                    .await
                    .map_err(|_| anyhow::anyhow!("legacy-prefix listing failed"))?;
                for item in page.contents() {
                    keys.insert(
                        item.key()
                            .ok_or_else(|| anyhow::anyhow!("listed object has no key"))?
                            .to_owned(),
                    );
                }
                if !page.is_truncated().unwrap_or(false) {
                    break;
                }
                let next = page.next_continuation_token().map(str::to_owned);
                ensure!(
                    next.is_some() && next != token,
                    "legacy-prefix pagination did not advance"
                );
                token = next;
            }
        }
        Ok(keys)
    }

    async fn copy_verified(&self, plan: &Planned) -> Result<Option<Value>> {
        let Some(source) = &plan.source else {
            return Ok(None);
        };
        let expected = self.digest(source, plan.etag.as_deref()).await?;
        ensure!(
            expected.0 == plan.size,
            "source size changed for row {}",
            plan.row.id
        );
        let target = &plan.row.file_ident;
        if target != source {
            if self.head(target).await?.is_none() {
                let source_path = format!("{}/{}", self.bucket, source);
                let encoded = percent_encoding::utf8_percent_encode(
                    &source_path,
                    percent_encoding::NON_ALPHANUMERIC,
                )
                .to_string();
                self.client
                    .copy_object()
                    .bucket(&self.bucket)
                    .key(target)
                    .copy_source(encoded)
                    .if_none_match("*")
                    .set_copy_source_if_match(plan.etag.clone())
                    .send()
                    .await
                    .map_err(|_| {
                        anyhow::anyhow!("server-side object copy failed for row {}", plan.row.id)
                    })?;
            }
            let actual = self.digest(target, None).await?;
            ensure!(
                actual == expected,
                "destination content differs for row {}; not overwriting",
                plan.row.id
            );
        }
        Ok(Some(
            json!({"phase":"verified", "id":plan.row.id, "bytes":expected.0, "sha256":expected.1}),
        ))
    }

    async fn delete(&self, keys: &[String]) -> Result<()> {
        for chunk in keys.chunks(1000) {
            let objects = chunk
                .iter()
                .map(|key| ObjectIdentifier::builder().key(key).build())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| anyhow::anyhow!("could not prepare object deletion"))?;
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .map_err(|_| anyhow::anyhow!("could not prepare object deletion batch"))?;
            let result = self
                .client
                .delete_objects()
                .bucket(&self.bucket)
                .delete(delete)
                .send()
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "legacy-object deletion request failed; resume with the same manifest"
                    )
                })?;
            ensure!(
                result.errors().is_empty(),
                "some legacy-object deletions failed; resume with the same manifest"
            );
        }
        Ok(())
    }
}

async fn plan(
    conn: &mut AsyncMysqlConnection,
    store: &Store,
    rows: Vec<Row>,
) -> Result<(Vec<Planned>, usize)> {
    let mut plans = Vec::new();
    let mut missing_ready = 0;
    for row in rows {
        ensure!(
            !row.file_ident.is_empty(),
            "empty destination identifier for row {}",
            row.id
        );
        ensure!(
            ["ready", "pending", "finalizing", "deleting"].contains(&row.upload_state.as_str()),
            "unknown upload state for row {}",
            row.id
        );
        let mut found = None;
        if row.upload_state == "ready" {
            let key = row.object_key.as_deref().unwrap_or(&row.file_ident);
            if let Some(metadata) = store.head(key).await? {
                found = Some((key.to_owned(), metadata));
            } else {
                missing_ready += 1;
            }
        } else if row.upload_state != "deleting" {
            let mut candidates = Vec::new();
            if let Some(key) = &row.staging_key {
                candidates.push(key.as_str());
            }
            if let Some(key) = &row.object_key {
                candidates.push(key.as_str());
            }
            candidates.push(&row.file_ident);
            for key in candidates {
                if let Some(metadata) = store.head(key).await? {
                    found = Some((key.to_owned(), metadata));
                    break;
                }
            }
        }
        if let Some((key, _)) = &found {
            ensure!(
                key == &row.file_ident || !protected(conn, key).await?,
                "source belongs to another destination for row {}",
                row.id
            );
        }
        let (source, size, etag) = match found {
            Some((key, metadata)) => (Some(key), metadata.size, metadata.etag),
            None => (None, 0, None),
        };
        plans.push(Planned {
            row,
            source,
            size,
            etag,
        });
    }
    Ok((plans, missing_ready))
}

fn expected(row: &Row, legacy: bool) -> Value {
    let mut value = row.snapshot.clone();
    let map = value.as_object_mut().unwrap();
    for field in OLD {
        if legacy {
            map.insert(field.into(), Value::Null);
        } else {
            map.remove(field);
        }
    }
    if legacy {
        map.insert("object_key".into(), json!(row.file_ident));
    }
    if row.upload_state == "finalizing" {
        map.insert("upload_state".into(), json!("pending"));
    }
    value
}

#[derive(QueryableByName)]
struct Snapshot {
    #[diesel(sql_type = Json)]
    snapshot: Value,
}

async fn current(
    conn: &mut AsyncMysqlConnection,
    id: i64,
    legacy: bool,
    lock: bool,
) -> Result<Value> {
    let suffix = if lock { " FOR UPDATE" } else { "" };
    sql_query(format!(
        "SELECT {} AS snapshot FROM file_info WHERE id = ?{suffix}",
        snapshot_sql(legacy)
    ))
    .bind::<BigInt, _>(id)
    .get_result::<Snapshot>(conn)
    .await
    .map(|r| r.snapshot)
    .map_err(|_| {
        anyhow::anyhow!("could not load current row {id}; keep all application writers stopped")
    })
}

async fn committed(
    conn: &mut AsyncMysqlConnection,
    manifest: &Manifest,
    legacy: bool,
) -> Result<bool> {
    let mut old = 0;
    let mut new = 0;
    for plan in &manifest.rows {
        let value = current(conn, plan.row.id, legacy, false).await?;
        if value == expected(&plan.row, legacy) {
            new += 1;
        } else if legacy && value == plan.row.snapshot {
            old += 1;
        } else {
            bail!(
                "database row {} changed outside this migration; refusing resume",
                plan.row.id
            );
        }
    }
    ensure!(
        old == 0 || new == 0,
        "mixed database cutover state; refusing resume"
    );
    Ok(old == 0)
}

async fn cutover(conn: &mut AsyncMysqlConnection, manifest: &Manifest) -> Result<()> {
    conn.batch_execute("START TRANSACTION")
        .await
        .map_err(|_| anyhow::anyhow!("could not start cutover transaction"))?;
    let result: Result<()> = async {
        for plan in &manifest.rows {
            ensure!(current(conn, plan.row.id, true, true).await? == plan.row.snapshot,
                "database changed before cutover for row {}", plan.row.id);
        }
        for plan in &manifest.rows {
            let changed = sql_query("UPDATE file_info SET object_key = file_ident, staging_key = NULL, \
                object_etag = NULL, published_at = NULL, source_etag = NULL, source_version = NULL, \
                upload_state = IF(upload_state = 'finalizing', 'pending', upload_state) WHERE id = ?")
                .bind::<BigInt, _>(plan.row.id).execute(conn).await
                .map_err(|_| anyhow::anyhow!("database cutover update failed for row {}", plan.row.id))?;
            ensure!(changed == 1, "database cutover row was not updated");
        }
        Ok(())
    }.await;
    if let Err(error) = result {
        let _ = conn.batch_execute("ROLLBACK").await;
        return Err(error);
    }
    conn.batch_execute("COMMIT").await.map_err(|_| {
        anyhow::anyhow!("cutover commit outcome uncertain; resume with the same manifest")
    })?;
    Ok(())
}

async fn require_direct_rows(conn: &mut AsyncMysqlConnection) -> Result<()> {
    let row = sql_query(format!(
        "SELECT CAST(COUNT(*) AS SIGNED) AS n FROM file_info WHERE {AFFECTED}"
    ))
    .get_result::<Number>(conn)
    .await
    .map_err(|_| anyhow::anyhow!("could not verify completed database cutover"))?;
    ensure!(
        row.n == 0,
        "unmigrated rows remain; refusing cleanup; keep all application writers stopped"
    );
    Ok(())
}

async fn cleanup(
    conn: &mut AsyncMysqlConnection,
    store: &Store,
    manifest: &Manifest,
    file: &mut File,
) -> Result<usize> {
    let mut candidates = manifest.cleanup.clone();
    candidates.extend(store.prefixes().await?);
    let mut keys = Vec::new();
    for key in candidates {
        if !protected(conn, &key).await? {
            keys.push(key);
        }
    }
    append(file, &json!({"phase":"cleanup_started", "keys":keys}))?;
    store.delete(&keys).await?;
    let mut remaining = 0;
    for key in store.prefixes().await? {
        if !protected(conn, &key).await? {
            remaining += 1;
        }
    }
    ensure!(
        remaining == 0,
        "legacy prefix objects remain; resume with the same manifest"
    );
    append(
        file,
        &json!({"phase":"complete", "deleted_candidates":keys.len(), "old_prefix_remaining":remaining}),
    )?;
    Ok(remaining)
}

async fn run(args: Args) -> Result<()> {
    let database_url = required("DATABASE_URL")?;
    let endpoint = required("S3_INTERNAL_URL")?;
    let parsed =
        url::Url::parse(&endpoint).map_err(|_| anyhow::anyhow!("invalid S3_INTERNAL_URL"))?;
    ensure!(
        ["http", "https"].contains(&parsed.scheme())
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "S3_INTERNAL_URL must be an HTTP endpoint without embedded credentials, query, or fragment"
    );
    let bucket = required("S3_BUCKET_NAME")?;
    let region = required("AWS_REGION")?;
    let credentials = Credentials::new(
        required("AWS_ACCESS_KEY_ID")?,
        required("AWS_SECRET_ACCESS_KEY")?,
        None,
        None,
        "migration-env",
    );
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region))
        .credentials_provider(credentials)
        .timeout_config(
            TimeoutConfig::builder()
                .operation_timeout(Duration::from_secs(300))
                .operation_attempt_timeout(Duration::from_secs(120))
                .connect_timeout(Duration::from_secs(10))
                .build(),
        )
        .load()
        .await;
    let store = Store {
        client: Client::from_conf(
            aws_sdk_s3::config::Builder::from(&config)
                .endpoint_url(&endpoint)
                .force_path_style(true)
                .build(),
        ),
        bucket: bucket.clone(),
    };
    let mut conn = AsyncMysqlConnection::establish(&database_url)
        .await
        .map_err(|_| anyhow::anyhow!("database connection failed"))?;
    let database = sql_query("SELECT DATABASE() AS value")
        .get_result::<TextValue>(&mut conn)
        .await
        .map_err(|_| anyhow::anyhow!("could not identify database"))?
        .value;
    let legacy = legacy_schema(&mut conn).await?;
    let versioning = store
        .client
        .get_bucket_versioning()
        .bucket(&bucket)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("could not inspect bucket versioning"))?;
    let status = versioning
        .status()
        .map(|s| s.as_str())
        .unwrap_or("Disabled");
    println!("bucket_versioning={status}");
    if args.apply {
        ensure!(
            status == "Disabled",
            "apply requires never-enabled bucket versioning; old versions would otherwise remain"
        );
    }
    let existing = match args.manifest.as_ref() {
        Some(path) => match std::fs::symlink_metadata(path) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => bail!("could not inspect manifest path"),
        },
        None => false,
    };
    let (manifest, mut file) = if args.apply && existing {
        let (manifest, file) = open_manifest(args.manifest.as_ref().unwrap())?;
        ensure!(
            manifest.database == database
                && manifest.endpoint == endpoint
                && manifest.bucket == bucket,
            "manifest belongs to a different database or object store"
        );
        (manifest, Some(file))
    } else {
        let rows = if legacy {
            affected(&mut conn).await?
        } else {
            Vec::new()
        };
        let (rows, missing) = plan(&mut conn, &store, rows).await?;
        let bytes: u64 = rows.iter().map(|r| r.size).sum();
        let objects = rows.iter().filter(|r| r.source.is_some()).count();
        let mut cleanup = store.prefixes().await?;
        let prefix_count = cleanup.len();
        for plan in &rows {
            cleanup.extend(
                plan.row
                    .object_key
                    .iter()
                    .chain(plan.row.staging_key.iter())
                    .cloned(),
            );
        }
        let ready = rows
            .iter()
            .filter(|r| r.row.upload_state == "ready")
            .count();
        let pending = rows
            .iter()
            .filter(|r| r.row.upload_state == "pending")
            .count();
        let finalizing = rows
            .iter()
            .filter(|r| r.row.upload_state == "finalizing")
            .count();
        let deleting = rows
            .iter()
            .filter(|r| r.row.upload_state == "deleting")
            .count();
        println!(
            "states ready={ready} pending={pending} finalizing={finalizing} deleting={deleting}"
        );
        println!(
            "inspect affected_rows={} source_objects={objects} source_bytes={bytes} missing_ready={missing} old_prefix_objects={prefix_count} legacy_schema={legacy}",
            rows.len()
        );
        if !args.apply {
            return Ok(());
        }
        ensure!(
            missing == 0,
            "ready source objects are missing; no changes made"
        );
        ensure!(
            legacy,
            "legacy columns already removed; use the original manifest to resume cleanup"
        );
        let manifest = Manifest {
            format: 1,
            database,
            endpoint,
            bucket,
            rows,
            cleanup,
        };
        let file = create_manifest(
            args.manifest
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("--apply requires --manifest"))?,
            &manifest,
        )?;
        (manifest, Some(file))
    };
    let file = file.as_mut().unwrap();
    let mut verified = 0;
    if !committed(&mut conn, &manifest, legacy).await? {
        ensure!(legacy, "legacy columns removed before database cutover");
        for plan in &manifest.rows {
            if let Some(event) = store.copy_verified(plan).await? {
                append(file, &event)?;
                verified += 1;
            }
        }
        cutover(&mut conn, &manifest).await?;
        append(file, &json!({"phase":"database_committed"}))?;
    }
    if legacy {
        require_direct_rows(&mut conn).await?;
    }
    let remaining = cleanup(&mut conn, &store, &manifest, file).await?;
    let bytes: u64 = manifest.rows.iter().map(|r| r.size).sum();
    println!(
        "applied rows={} bytes={bytes} verified_this_run={verified} old_prefix_remaining={remaining}",
        manifest.rows.len()
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Args::parse()).await {
        // SDK/SQL errors may contain signed URLs or connection strings: never print their chains.
        eprintln!("migration failed: {error}");
        std::process::exit(1);
    }
}
