//! Attachment files on Cloudflare R2, through its S3 API: each
//! request is presigned for a few minutes ([`rusty_s3`], sans-IO) and sent by [`reqwest`] over
//! rustls + ring with the webpki roots (no OpenSSL, no system certificates in the image).
//!
//! One private bucket for every account; an object's key is `comptes/<account_id>/<name>`, both
//! made by the server ([`crate::files::storage_name`]), never a string of a client. Only the
//! server holds the key of the bucket (`TAIDO_R2_*`), which is never logged.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderValue, Method};
use rusty_s3::actions::{DeleteObject, GetObject, HeadObject, PutObject};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

use crate::error::ServerError;

/// Endpoint of the account's S3 API, with the jurisdiction of the bucket
/// (`https://<account_id>.eu.r2.cloudflarestorage.com` for an EU bucket).
pub const ENV_ENDPOINT: &str = "TAIDO_R2_ENDPOINT";
/// Name of the bucket.
pub const ENV_BUCKET: &str = "TAIDO_R2_BUCKET";
/// Access Key ID of the bucket's API token.
pub const ENV_ACCESS_KEY_ID: &str = "TAIDO_R2_ACCESS_KEY_ID";
/// Secret Access Key of the bucket's API token.
pub const ENV_SECRET_ACCESS_KEY: &str = "TAIDO_R2_SECRET_ACCESS_KEY";

/// Folder of the accounts in the bucket.
const ACCOUNTS_PREFIX: &str = "comptes";
/// Lifetime of a presigned request (it is sent at once).
const SIGNED_FOR: Duration = Duration::from_secs(300);
/// Longest wait for R2 to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest upload of one file (100 MiB at a slow 1 MB/s takes under two minutes).
const PUT_TIMEOUT: Duration = Duration::from_secs(600);

/// Where the bucket is and how to reach it.
#[derive(Clone, PartialEq, Eq)]
pub struct R2Config {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl std::fmt::Debug for R2Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("R2Config")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .finish_non_exhaustive()
    }
}

impl R2Config {
    /// Reads the `TAIDO_R2_*` variables: none set = files stay on the disk (`None`); some but
    /// not all = an error naming the missing ones.
    pub fn from_env() -> Result<Option<R2Config>, ServerError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<R2Config>, ServerError> {
        let keys = [
            ENV_ENDPOINT,
            ENV_BUCKET,
            ENV_ACCESS_KEY_ID,
            ENV_SECRET_ACCESS_KEY,
        ];
        let values: Vec<Option<String>> = keys
            .iter()
            .map(|key| {
                lookup(key)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            })
            .collect();
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        let missing: Vec<&str> = keys
            .iter()
            .zip(&values)
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| *k)
            .collect();
        if !missing.is_empty() {
            return Err(ServerError::Invalid(format!(
                "R2 storage needs {} too",
                missing.join(", ")
            )));
        }
        let mut values = values.into_iter().flatten();
        let mut next = || values.next().unwrap_or_default();
        Ok(Some(R2Config {
            endpoint: next(),
            bucket: next(),
            access_key_id: next(),
            secret_access_key: next(),
        }))
    }
}

/// The bucket of the attachment files.
pub struct R2 {
    bucket: Bucket,
    credentials: Credentials,
    client: reqwest::Client,
}

impl std::fmt::Debug for R2 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("R2")
            .field("bucket", &self.bucket.name())
            .finish_non_exhaustive()
    }
}

/// What R2 answered to a read of an object.
pub enum Read {
    /// No such object.
    Missing,
    /// The object (or the asked range of it): status, headers and body to pass on.
    Found(reqwest::Response),
}

impl R2 {
    pub fn new(config: &R2Config) -> Result<Arc<R2>, ServerError> {
        let invalid = |what: &str| ServerError::Invalid(format!("{ENV_ENDPOINT}: {what}"));
        let endpoint: reqwest::Url = config.endpoint.parse().map_err(|_| invalid("not a URL"))?;
        // Path style: one host for every bucket of the account (`<endpoint>/<bucket>/<key>`).
        let bucket = Bucket::new(
            endpoint,
            UrlStyle::Path,
            config.bucket.clone(),
            "auto".to_string(),
        )
        .map_err(|_| invalid("not an http(s) URL with a host"))?;
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|err| ServerError::Invalid(format!("TLS: {err}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|err| ServerError::Invalid(format!("R2 client: {err}")))?;
        Ok(Arc::new(R2 {
            bucket,
            credentials: Credentials::new(
                config.access_key_id.clone(),
                config.secret_access_key.clone(),
            ),
            client,
        }))
    }

    /// Key of an attachment's file: `comptes/<account_id>/<name>`.
    pub fn key(account_id: &str, name: &str) -> String {
        format!("{ACCOUNTS_PREFIX}/{account_id}/{name}")
    }

    /// Uploads the file at `path` (`size` bytes) as `key`, replacing any object there.
    pub async fn put_file(&self, key: &str, path: &Path, size: u64) -> Result<(), ServerError> {
        let url = PutObject::new(&self.bucket, Some(&self.credentials), key).sign(SIGNED_FOR);
        let file = tokio::fs::File::open(path).await?;
        let response = self
            .client
            .put(url)
            .header(reqwest::header::CONTENT_LENGTH, size)
            .timeout(PUT_TIMEOUT)
            .body(file)
            .send()
            .await
            .map_err(request_error)?;
        expect_success(response, "put").await
    }

    /// Size of the object `key`; `None` when there is none.
    pub async fn size(&self, key: &str) -> Result<Option<u64>, ServerError> {
        let url = HeadObject::new(&self.bucket, Some(&self.credentials), key).sign(SIGNED_FOR);
        let response = self.client.head(url).send().await.map_err(request_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = success(response, "head").await?;
        Ok(response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok()))
    }

    /// Reads the object `key` (`GET`, or `HEAD` for the headers only), with the client's
    /// `Range` when it gave one.
    pub async fn read(
        &self,
        key: &str,
        method: &Method,
        range: Option<&HeaderValue>,
    ) -> Result<Read, ServerError> {
        let request = if *method == Method::HEAD {
            let url = HeadObject::new(&self.bucket, Some(&self.credentials), key).sign(SIGNED_FOR);
            self.client.head(url)
        } else {
            let url = GetObject::new(&self.bucket, Some(&self.credentials), key).sign(SIGNED_FOR);
            self.client.get(url)
        };
        let request = match range.and_then(|r| r.to_str().ok()) {
            Some(range) => request.header(reqwest::header::RANGE, range),
            None => request,
        };
        let response = request.send().await.map_err(request_error)?;
        match response.status().as_u16() {
            404 => Ok(Read::Missing),
            // 416: a range past the end, passed on as it is.
            200 | 206 | 416 => Ok(Read::Found(response)),
            _ => Err(failure(response, "get").await),
        }
    }

    /// Deletes the object `key` (nothing to do when there is none).
    pub async fn delete(&self, key: &str) -> Result<(), ServerError> {
        let url = DeleteObject::new(&self.bucket, Some(&self.credentials), key).sign(SIGNED_FOR);
        let response = self
            .client
            .delete(url)
            .send()
            .await
            .map_err(request_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        expect_success(response, "delete").await
    }
}

/// A request that could not be sent or answered (the URL, which is signed, is left out).
fn request_error(err: reqwest::Error) -> ServerError {
    ServerError::Storage(format!("R2 unreachable: {}", err.without_url()))
}

async fn success(
    response: reqwest::Response,
    what: &str,
) -> Result<reqwest::Response, ServerError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(failure(response, what).await)
    }
}

async fn expect_success(response: reqwest::Response, what: &str) -> Result<(), ServerError> {
    success(response, what).await.map(drop)
}

/// The status and S3 error code of a refused request (its body is an XML `<Error>`).
async fn failure(response: reqwest::Response, what: &str) -> ServerError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let code = body
        .split_once("<Code>")
        .and_then(|(_, rest)| rest.split_once("</Code>"))
        .map_or("", |(code, _)| code);
    ServerError::Storage(format!("R2 {what} refused: {status} {code}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_all_or_nothing() {
        assert_eq!(R2Config::from_lookup(|_| None).expect("none"), None);
        assert_eq!(
            R2Config::from_lookup(|_| Some(" ".into())).expect("blank"),
            None
        );
        let full = R2Config::from_lookup(|key| {
            Some(match key {
                ENV_ENDPOINT => "https://acc.eu.r2.cloudflarestorage.com".into(),
                ENV_BUCKET => "taido-fichiers".into(),
                ENV_ACCESS_KEY_ID => "id".into(),
                _ => " secret ".into(),
            })
        })
        .expect("full")
        .expect("some");
        assert_eq!(full.bucket, "taido-fichiers");
        assert_eq!(full.secret_access_key, "secret");
        assert!(!format!("{full:?}").contains("secret"), "never printed");
        let err = R2Config::from_lookup(|key| (key == ENV_BUCKET).then(|| "b".into()))
            .expect_err("partial");
        let text = err.to_string();
        assert!(
            text.contains(ENV_ENDPOINT) && text.contains(ENV_SECRET_ACCESS_KEY),
            "{text}"
        );
        assert!(!text.contains(ENV_BUCKET), "{text}");
    }

    #[test]
    fn keys_are_per_account() {
        assert_eq!(R2::key("acc-1", "abc"), "comptes/acc-1/abc");
    }

    #[test]
    fn the_endpoint_must_be_an_http_url() {
        let config = |endpoint: &str| R2Config {
            endpoint: endpoint.into(),
            bucket: "b".into(),
            access_key_id: "id".into(),
            secret_access_key: "s".into(),
        };
        assert!(R2::new(&config("https://acc.eu.r2.cloudflarestorage.com")).is_ok());
        assert!(R2::new(&config("ftp://acc")).is_err());
        assert!(R2::new(&config("pas une adresse")).is_err());
    }

    /// Against the real bucket of the `TAIDO_R2_*` variables (never in `pnpm check`):
    /// `cargo test -- --ignored the_real_bucket`. Writes, reads and deletes one test object.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs the TAIDO_R2_* variables and the network"]
    async fn the_real_bucket_stores_reads_and_deletes() {
        let config = R2Config::from_env()
            .expect("config")
            .expect("TAIDO_R2_* set");
        let r2 = R2::new(&config).expect("client");
        let key = R2::key("essai", "verification-du-serveur");
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("f");
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).expect("write");

        r2.put_file(&key, &path, 10_000).await.expect("put");
        assert_eq!(r2.size(&key).await.expect("head"), Some(10_000));
        let range = HeaderValue::from_static("bytes=100-199");
        let Read::Found(part) = r2
            .read(&key, &Method::GET, Some(&range))
            .await
            .expect("get")
        else {
            panic!("missing");
        };
        assert_eq!(part.status().as_u16(), 206);
        assert_eq!(part.bytes().await.expect("body").as_ref(), &data[100..200]);
        r2.delete(&key).await.expect("delete");
        assert_eq!(r2.size(&key).await.expect("head"), None);
    }
}
