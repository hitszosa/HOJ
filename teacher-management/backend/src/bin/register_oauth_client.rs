use anyhow::{Context, Result, bail};
use clap::Parser;
use diesel::prelude::*;
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};
use grader_backend::identity::oauth::{VALID_SCOPES, random_token, sha256_hex};
use grader_backend::schema::oauth_clients as clients;
use std::{fs::OpenOptions, io::Write, path::PathBuf};
use tracing_subscriber::EnvFilter;
use url::Url;

#[derive(Parser)]
#[command(
    name = "register_oauth_client",
    about = "Register an OAuth2 client for grader-backend"
)]
struct Args {
    /// OAuth2 client display name.
    #[arg(short, long)]
    name: String,
    /// Exact OAuth2 callback URI.
    #[arg(short = 'r', long)]
    redirect_uri: String,
    /// Space-separated read-only OAuth2 scopes.
    #[arg(short, long)]
    scopes: String,
    /// Generate a client ID when omitted.
    #[arg(short = 'i', long)]
    client_id: Option<String>,
    /// Confidential secret; prefer GRADER_OAUTH_CLIENT_SECRET over a shell argument.
    #[arg(long, env = "GRADER_OAUTH_CLIENT_SECRET", hide_env_values = true)]
    client_secret: Option<String>,
    /// Write a newly generated secret to this new private file, never to logs.
    #[arg(long, conflicts_with_all = ["public", "client_secret"])]
    secret_file: Option<PathBuf>,
    /// Public client; authorization requires S256 PKCE.
    #[arg(long, conflicts_with = "client_secret")]
    public: bool,
    /// Defaults to DATABASE_URL or the local grader database.
    #[arg(short = 'd', long)]
    database_url: Option<String>,
}

#[derive(Queryable)]
struct ExistingClient {
    id: i64,
    secret_hash: Option<String>,
    name: String,
    redirect_uri: String,
    allowed_scopes: String,
    active: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let args = Args::parse();
    validate(&args)?;
    let allowed_scopes = normalize_scopes(&args.scopes)?;
    let client_id = args
        .client_id
        .unwrap_or_else(|| format!("oauth_{}", random_token()));
    let database_url = args
        .database_url
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| "mysql://grader:grader@localhost/grader".to_owned());
    let mut conn = AsyncMysqlConnection::establish(&database_url)
        .await
        .map_err(|_| anyhow::anyhow!("failed to connect to database"))?;
    let existing = clients::table
        .filter(clients::client_id.eq(&client_id))
        .select((
            clients::id,
            clients::client_secret_hash,
            clients::name,
            clients::redirect_uri,
            clients::allowed_scopes,
            clients::active,
        ))
        .first::<ExistingClient>(&mut conn)
        .await
        .optional()
        .map_err(|_| anyhow::anyhow!("failed to check existing OAuth2 client"))?;
    if let Some(existing) = existing {
        let secret_matches = if args.public {
            existing.secret_hash.is_none()
        } else if let Some(secret) = args.client_secret.as_deref() {
            existing.secret_hash.as_deref() == Some(sha256_hex(secret).as_str())
        } else {
            existing.secret_hash.is_some()
        };
        if !existing.active
            || existing.name != args.name
            || existing.redirect_uri != args.redirect_uri
            || existing.allowed_scopes != allowed_scopes
            || !secret_matches
        {
            bail!(
                "OAuth2 client_id '{}' already exists with different settings.",
                client_id
            );
        }
        tracing::info!(
            db_id = existing.id,
            %client_id,
            public = args.public,
            "OAuth2 client already registered"
        );
        return Ok(());
    }
    let secret = if args.public {
        None
    } else if let Some(secret) = args.client_secret {
        Some(secret)
    } else {
        let path = args.secret_file.as_deref().context(
            "Use --secret-file to receive a generated secret, or supply GRADER_OAUTH_CLIENT_SECRET",
        )?;
        let secret = random_token();
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).context("Unable to create secret file")?;
        writeln!(file, "{secret}").context("Unable to write secret file")?;
        file.sync_all().context("Unable to flush secret file")?;
        tracing::info!(secret_file = %path.display(), "Generated OAuth2 secret saved privately");
        Some(secret)
    };
    let secret_hash = secret.as_deref().map(sha256_hex);
    diesel::insert_into(clients::table)
        .values((
            clients::client_id.eq(&client_id),
            clients::client_secret_hash.eq(secret_hash),
            clients::name.eq(&args.name),
            clients::redirect_uri.eq(&args.redirect_uri),
            clients::allowed_scopes.eq(&allowed_scopes),
            clients::active.eq(true),
        ))
        .execute(&mut conn)
        .await
        .map_err(|_| anyhow::anyhow!("failed to register OAuth2 client"))?;
    let id = clients::table
        .filter(clients::client_id.eq(&client_id))
        .select(clients::id)
        .first::<i64>(&mut conn)
        .await
        .map_err(|_| {
            anyhow::anyhow!("client registered, but could not retrieve its database ID")
        })?;
    tracing::info!(db_id = id, %client_id, scopes = %allowed_scopes, public = args.public, "OAuth2 client registered");
    Ok(())
}

fn validate(args: &Args) -> Result<()> {
    if args.name.trim().is_empty() || args.name.chars().count() > 255 {
        bail!("name must contain 1 to 255 characters.");
    }
    if let Some(id) = args.client_id.as_deref()
        && (id.trim().is_empty() || id.len() > 128)
    {
        bail!("client_id must contain 1 to 128 bytes.");
    }
    if args.redirect_uri.len() > 2048 {
        bail!("redirect_uri cannot exceed 2048 bytes.");
    }
    let url = Url::parse(&args.redirect_uri).context("redirect_uri must be an absolute URL")?;
    if url.fragment().is_some() {
        bail!("redirect_uri must not contain a fragment.");
    }
    if args.client_secret.as_ref().is_some_and(String::is_empty) {
        bail!("client_secret cannot be empty.");
    }
    Ok(())
}

fn normalize_scopes(input: &str) -> Result<String> {
    let mut scopes = Vec::new();
    for scope in input.split_whitespace() {
        if !VALID_SCOPES.contains(&scope) {
            bail!(
                "unknown scope '{}'. valid scopes: {}",
                scope,
                VALID_SCOPES.join(" ")
            );
        }
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    if scopes.is_empty() {
        bail!("at least one scope is required.");
    }
    Ok(scopes.join(" "))
}
