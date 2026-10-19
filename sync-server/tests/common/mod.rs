//! Minimal HTTP/1.1 client over a TCP stream for the integration tests (loopback only; no
//! HTTP client dependency).

#![allow(dead_code)]

use std::collections::HashMap;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct Reply {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }

    pub fn error(&self) -> String {
        self.json()["error"]
            .as_str()
            .expect("error code")
            .to_string()
    }
}

/// `base_url` = `http://127.0.0.1:<port>`.
pub async fn request(
    base_url: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &[u8],
) -> Reply {
    request_with_headers(base_url, method, path, token, &[], body).await
}

/// [`request`] with extra request headers (e.g. `Range`).
pub async fn request_with_headers(
    base_url: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Reply {
    let host = base_url.strip_prefix("http://").expect("http base url");
    let mut stream = TcpStream::connect(host).await.expect("connect");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("write head");
    // The server may answer (413) and close before reading a large body: ignore write errors.
    let _ = stream.write_all(body).await;
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    parse(&raw)
}

fn parse(raw: &[u8]) -> Reply {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("end of headers");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .expect("status");
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    if headers
        .get("transfer-encoding")
        .is_some_and(|v| v.eq_ignore_ascii_case("chunked"))
    {
        body = dechunk(&body);
    }
    Reply {
        status,
        headers,
        body,
    }
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") {
        let size_text = String::from_utf8_lossy(&data[..line_end]).to_string();
        let size = usize::from_str_radix(size_text.trim(), 16).unwrap_or(0);
        data = &data[line_end + 2..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[(size + 2).min(data.len())..];
    }
    out
}

pub async fn post_json(base_url: &str, path: &str, token: Option<&str>, body: &Value) -> Reply {
    request(base_url, "POST", path, token, body.to_string().as_bytes()).await
}

pub async fn get(base_url: &str, path: &str) -> Reply {
    request(base_url, "GET", path, None, b"").await
}
