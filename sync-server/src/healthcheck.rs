//! `healthcheck` subcommand: `GET /api/health` over a plain TCP stream (the slim Docker image
//! has no curl; no HTTP client dependency). Used by the Docker `HEALTHCHECK`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Overall timeout of the check.
pub const TIMEOUT: Duration = Duration::from_secs(3);

/// The address to call for a bind address: an unspecified IP (`0.0.0.0`, `::`) becomes the
/// loopback of the same family.
pub fn target(bind: &str) -> Option<SocketAddr> {
    let mut addr: SocketAddr = bind.parse().ok()?;
    if addr.ip().is_unspecified() {
        let ip = match addr.ip() {
            IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
        };
        addr.set_ip(ip);
    }
    Some(addr)
}

/// `true` when the server at `bind` answers `200` with `"ok":true` within [`TIMEOUT`].
pub async fn check(bind: &str) -> bool {
    let Some(addr) = target(bind) else {
        return false;
    };
    matches!(
        tokio::time::timeout(TIMEOUT, request(addr)).await,
        Ok(Ok(true))
    )
}

async fn request(addr: SocketAddr) -> std::io::Result<bool> {
    let mut stream = TcpStream::connect(addr).await?;
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    // `Connection: close`: the server ends the stream after the response. Small cap.
    (&mut stream)
        .take(64 * 1024)
        .read_to_end(&mut response)
        .await?;
    Ok(is_healthy(&response))
}

/// Status line `HTTP/1.x 200` and a body containing `"ok":true`.
pub fn is_healthy(response: &[u8]) -> bool {
    let text = String::from_utf8_lossy(response);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let status_ok = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        == Some("200");
    status_ok && body.contains("\"ok\":true")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_bind_targets_loopback() {
        assert_eq!(
            target("0.0.0.0:3020"),
            Some("127.0.0.1:3020".parse().expect("addr"))
        );
        assert_eq!(
            target("[::]:3020"),
            Some("[::1]:3020".parse().expect("addr"))
        );
        assert_eq!(
            target("127.0.0.1:4000"),
            Some("127.0.0.1:4000".parse().expect("addr"))
        );
        assert_eq!(target("nonsense"), None);
    }

    #[test]
    fn parses_responses() {
        assert!(is_healthy(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"protocol\":1}"
        ));
        assert!(!is_healthy(b"HTTP/1.1 500 Internal\r\n\r\n{\"ok\":true}"));
        assert!(!is_healthy(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":false}"));
        assert!(!is_healthy(b"garbage"));
    }
}
