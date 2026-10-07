use std::collections::HashMap;
use std::time::Duration;

use aws_config::{BehaviorVersion, Region};
use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::app::config::Config;
use crate::app::error::{AppError, Result};

pub struct Storage {
    public: Client,
    internal: Client,
    credentials: SharedCredentialsProvider,
    bucket: String,
    region: String,
    post_url: String,
}

pub struct ObjectMetadata {
    pub size: i64,
    pub content_type: Option<String>,
}

impl Storage {
    pub async fn new(config: &Config) -> Result<Self> {
        let shared = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(config.aws_region.clone()))
            .timeout_config(
                TimeoutConfig::builder()
                    .operation_timeout(Duration::from_secs(60))
                    .operation_attempt_timeout(Duration::from_secs(30))
                    .connect_timeout(Duration::from_secs(10))
                    .build(),
            )
            .load()
            .await;
        let credentials = shared
            .credentials_provider()
            .ok_or_else(|| AppError::S3("No AWS credential provider is configured".into()))?;
        let client = |endpoint: &str| {
            Client::from_conf(
                aws_sdk_s3::config::Builder::from(&shared)
                    .endpoint_url(endpoint)
                    .force_path_style(true)
                    .build(),
            )
        };
        Ok(Self {
            public: client(&config.s3_public_url),
            internal: client(&config.s3_internal_url),
            credentials,
            bucket: config.s3_bucket.clone(),
            region: config.aws_region.clone(),
            post_url: format!(
                "{}/{}",
                config.s3_public_url.trim_end_matches('/'),
                config.s3_bucket
            ),
        })
    }

    pub async fn ensure_bucket(&self) -> Result<()> {
        match self.internal.head_bucket().bucket(&self.bucket).send().await {
            Ok(_) => Ok(()),
            Err(error) if error.raw_response().is_some_and(|response| response.status().as_u16() == 404) => {
                self.internal.create_bucket().bucket(&self.bucket).send().await
                    .map_err(|_| AppError::S3("Could not initialize local bucket".into()))?;
                Ok(())
            }
            Err(error) => Err(AppError::S3(format!("Could not inspect local bucket: status {:?}, {}",
                error.raw_response().map(|response| response.status().as_u16()), error))),
        }
    }

    pub async fn download_url(&self, file_ident: &str, internal: bool) -> Result<String> {
        let client = if internal {
            &self.internal
        } else {
            &self.public
        };
        let signing = PresigningConfig::expires_in(Duration::from_secs(3600))
            .map_err(|_| AppError::S3("Could not configure download signing".into()))?;
        let request = client
            .get_object()
            .bucket(&self.bucket)
            .key(file_ident)
            .presigned(signing)
            .await
            .map_err(|_| AppError::S3("Could not sign object download".into()))?;
        Ok(request.uri().to_string())
    }

    pub async fn upload_form(
        &self,
        file_ident: &str,
        max_size: i64,
        expires: DateTime<Utc>,
    ) -> Result<(String, HashMap<String, String>)> {
        let credentials = self
            .credentials
            .provide_credentials()
            .await
            .map_err(|_| AppError::S3("Could not obtain upload signing credentials".into()))?;
        let now = Utc::now();
        let expires = credentials
            .expiry()
            .map(DateTime::<Utc>::from)
            .map_or(expires, |credential_expiry| expires.min(credential_expiry));
        if expires <= now {
            return Err(AppError::S3(
                "Upload signing credentials have expired".into(),
            ));
        }
        let date = now.format("%Y%m%d").to_string();
        let datetime = now.format("%Y%m%dT%H%M%SZ").to_string();
        let scope = format!(
            "{}/{}/{}/s3/aws4_request",
            credentials.access_key_id(),
            date,
            self.region
        );
        let mut params: HashMap<String, String> = HashMap::from([
            ("Content-Type".into(), "application/octet-stream".into()),
            ("key".into(), file_ident.to_owned()),
            ("x-amz-algorithm".into(), "AWS4-HMAC-SHA256".into()),
            ("x-amz-credential".into(), scope),
            ("x-amz-date".into(), datetime),
        ]);
        if let Some(token) = credentials.session_token() {
            params.insert("x-amz-security-token".into(), token.to_owned());
        }
        let mut conditions = vec![
            serde_json::json!({"bucket": self.bucket}),
            serde_json::json!(["content-length-range", 0, max_size]),
        ];
        for (key, value) in &params {
            conditions.push(serde_json::json!({(key): value}));
        }
        let policy = STANDARD.encode(
            serde_json::json!({
                "expiration": expires.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                "conditions": conditions,
            })
            .to_string(),
        );
        let dated = hmac(
            format!("AWS4{}", credentials.secret_access_key()).as_bytes(),
            date.as_bytes(),
        )?;
        let regional = hmac(&dated, self.region.as_bytes())?;
        let service = hmac(&regional, b"s3")?;
        let signing = hmac(&service, b"aws4_request")?;
        let signature = hex::encode(hmac(&signing, policy.as_bytes())?);
        params.insert("policy".into(), policy);
        params.insert("x-amz-signature".into(), signature);
        Ok((self.post_url.clone(), params))
    }

    pub async fn head(&self, key: &str) -> Result<Option<ObjectMetadata>> {
        match self
            .internal
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(object) => Ok(Some(ObjectMetadata {
                size: object
                    .content_length()
                    .ok_or_else(|| AppError::S3("Object has no size".into()))?,
                content_type: object.content_type().map(str::to_owned),
            })),
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|error| error.is_not_found()) =>
            {
                Ok(None)
            }
            Err(_) => Err(AppError::S3("Could not inspect object".into())),
        }
    }

    pub async fn read_document(&self, key: &str, limit: usize) -> Result<Vec<u8>> {
        let object = self
            .internal
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| AppError::S3("Could not read document".into()))?;
        if object
            .content_length()
            .is_some_and(|size| size < 0 || size as u64 > limit as u64)
        {
            return Err(AppError::Validation(
                "Visual grading supports documents up to 50 MiB".into(),
            ));
        }
        let mut body = object.body;
        let mut bytes = Vec::new();
        while let Some(chunk) = body
            .try_next()
            .await
            .map_err(|_| AppError::S3("Document read interrupted".into()))?
        {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(AppError::Validation(
                    "Visual grading supports documents up to 50 MiB".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub async fn put_pdf(&self, key: &str, bytes: axum::body::Bytes) -> Result<()> {
        self.internal
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type("application/pdf")
            .body(aws_sdk_s3::primitives::ByteStream::from(bytes))
            .send()
            .await
            .map_err(|_| AppError::S3("Could not save Word preview".into()))?;
        Ok(())
    }

    pub async fn delete_batch(&self, keys: &[&str]) -> Result<()> {
        for chunk in keys.chunks(1000) {
            let objects = chunk
                .iter()
                .map(|key| {
                    ObjectIdentifier::builder()
                        .key(*key)
                        .build()
                        .map_err(|_| AppError::S3("Could not build object deletion".into()))
                })
                .collect::<Result<Vec<_>>>()?;
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .map_err(|_| AppError::S3("Could not build object deletion batch".into()))?;
            let response = self
                .internal
                .delete_objects()
                .bucket(&self.bucket)
                .delete(delete)
                .send()
                .await
                .map_err(|_| {
                    AppError::S3("Could not delete unused objects; retry cleanup".into())
                })?;
            if !response.errors().is_empty() {
                return Err(AppError::S3(
                    "Some unused objects could not be deleted; retry cleanup".into(),
                ));
            }
        }
        Ok(())
    }
}

fn hmac(key: &[u8], data: &[u8]) -> Result<[u8; 32]> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|_| AppError::S3("Could not sign upload policy".into()))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().into())
}
