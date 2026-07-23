//! Security helpers for `clade-meshd`.
//!
//! - API token authentication via `Authorization: Bearer <token>`.
//! - Request-size and payload-kind limits for the HTTP chat endpoints.
//! - Loopback-only UDP bind policy and per-peer address uniqueness.
//! - Path validation so key/chat store directories are not created in unsafe
//!   locations (e.g. `/tmp` or world-writable roots).
//!
//! phi^2 + phi^-2 = 3

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::{distributions::Alphanumeric, Rng};
use subtle::ConstantTimeEq;
use warp::Filter;

use crate::chat;

/// Environment variable that holds the daemon API token. If unset, a random
/// token is generated at startup and printed to stderr exactly once.
pub const API_TOKEN_ENV: &str = "TRIOS_MESH_API_TOKEN";

/// Cap HTTP body size for the chat endpoints. Large bodies risk memory pressure
/// and slow synchronous handling under the async lock.
pub const MAX_HTTP_BODY_BYTES: u64 = 64 * 1024;

/// Largest raw UDP/transport frame we are willing to send or receive. The mesh
/// wire header adds 11 bytes; the modem layer enforces a hard 255-byte ceiling
/// on the final frame, so keep the payload budget well below that.
#[allow(dead_code)]
pub const MAX_FRAME_SIZE: usize = 512;

/// Maximum decoded payload accepted by the public `/send`, `/open` and
/// `/messages/*` HTTP endpoints. Includes the chat envelope plus any base64
/// media payload.
pub const MAX_CHAT_PAYLOAD: usize = 4 * 1024;

/// Length of generated API tokens.
const TOKEN_LEN: usize = 32;

/// Load or generate the daemon API token.
///
/// If `TRIOS_MESH_API_TOKEN` is set and non-empty it is used verbatim.
/// Otherwise a URL-safe random token is generated.
pub fn load_api_token() -> String {
    std::env::var(API_TOKEN_ENV)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(generate_random_token)
}

fn generate_random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(TOKEN_LEN)
        .map(char::from)
        .collect()
}

/// Warp filter that rejects requests without a valid `Authorization: Bearer`
/// header. The token comparison is done in constant time via `subtle`.
pub fn auth_filter(
    token: String,
) -> impl Filter<Extract = (), Error = warp::Rejection> + Clone {
    warp::header::<String>("authorization")
        .and_then(move |header: String| {
            let expected = token.clone();
            async move {
                let provided = header
                    .strip_prefix("Bearer ")
                    .or_else(|| header.strip_prefix("bearer "))
                    .unwrap_or(&header);
                if provided.as_bytes().ct_eq(expected.as_bytes()).into() {
                    Ok(())
                } else {
                    Err(warp::reject::custom(InvalidToken))
                }
            }
        })
        .untuple_one()
}

#[derive(Debug)]
struct InvalidToken;
impl warp::reject::Reject for InvalidToken {}

/// Convert a rejection into a constant generic error response so callers cannot
/// probe for token correctness.
pub async fn unauthorized_reply(_: warp::Rejection) -> Result<impl warp::Reply, std::convert::Infallible> {
    Ok(warp::reply::with_status(
        warp::reply::json(&serde_json::json!({ "error": "unauthorized" })),
        warp::http::StatusCode::UNAUTHORIZED,
    ))
}

/// Validate that a chat envelope kind is one of the reserved protocol values and
/// that the decoded base64 payload (if any) is within budget.
pub fn validate_chat_envelope(req: &crate::ChatSendRequest) -> Result<(), String> {
    if !matches!(
        req.kind,
        chat::MSG_TEXT | chat::MSG_PHOTO | chat::MSG_VIDEO | chat::MSG_VOICE | chat::MSG_STATUS | chat::MSG_ACK
    ) {
        return Err(format!("unknown chat kind: {}", req.kind));
    }

    if req.kind == chat::MSG_TEXT {
        let text = req.text.as_deref().unwrap_or("");
        if text.len() > chat::MAX_TEXT {
            return Err(format!(
                "text too long: {} > {}",
                text.len(),
                chat::MAX_TEXT
            ));
        }
    }

    if let Some(payload_b64) = &req.payload_base64 {
        // Estimate decoded size: ceil(len * 3 / 4) is an upper bound for valid base64.
        let decoded_len = payload_b64.len().saturating_mul(3).div_ceil(4);
        if decoded_len > MAX_CHAT_PAYLOAD {
            return Err(format!(
                "payload too large: decoded ~{} > {}",
                decoded_len,
                MAX_CHAT_PAYLOAD
            ));
        }
    }

    Ok(())
}

/// Validate a base64-encoded raw frame/payload and ensure it is within the
/// transport budget.
pub fn validate_raw_payload_b64(payload_b64: &str) -> Result<Vec<u8>, String> {
    let decoded = BASE64
        .decode(payload_b64.trim())
        .map_err(|_| "invalid base64 payload".to_string())?;
    if decoded.len() > MAX_CHAT_PAYLOAD {
        return Err(format!(
            "payload too large: {} > {}",
            decoded.len(),
            MAX_CHAT_PAYLOAD
        ));
    }
    Ok(decoded)
}

/// Restrict UDP bind addresses to loopback in host-sim builds unless the
/// operator explicitly opts into external exposure.
pub fn validate_udp_bind(addr: SocketAddr) -> Result<SocketAddr, String> {
    if !is_loopback(addr.ip()) {
        let allow_external = std::env::var("TRIOS_MESH_UDP_EXTERNAL")
            .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !allow_external {
            return Err(format!(
                "refusing to bind UDP to non-loopback address {}. \
                 Set TRIOS_MESH_UDP_EXTERNAL=true to override.",
                addr
            ));
        }
    }
    Ok(addr)
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Validate that a seed-peer address is loopback/private and not already mapped
/// to a different peer id.
pub fn validate_seed_addr(
    addr: SocketAddr,
    existing_peer: Option<crate::NodeId>,
) -> Result<(), String> {
    if !is_loopback_or_private(addr.ip()) {
        return Err(format!("seed address {} is not loopback/private", addr));
    }
    if let Some(existing) = existing_peer {
        return Err(format!(
            "address {} already mapped to peer {}; re-seed requires re-key",
            addr, existing
        ));
    }
    Ok(())
}

fn is_loopback_or_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unicast_link_local(),
    }
}

/// Reject paths that point to world-writable directories or fall under `/tmp`.
#[allow(dead_code)]
pub fn safe_store_path(path: &Path) -> Result<(), String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if canonical.starts_with("/tmp") || canonical.starts_with("/var/tmp") {
        return Err(format!(
            "refusing to use store under temporary directory: {}",
            canonical.display()
        ));
    }
    if let Some(parent) = canonical.parent() {
        if is_world_writable(parent)? {
            return Err(format!(
                "store parent directory is world-writable: {}",
                parent.display()
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_world_writable(path: &Path) -> Result<bool, String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    Ok(meta.permissions().mode() & 0o002 != 0)
}

#[cfg(not(unix))]
fn is_world_writable(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

/// Resolve the API token file path from `TRIOS_MESH_TOKEN_FILE`.
#[allow(dead_code)]
pub fn token_file_path() -> Option<PathBuf> {
    std::env::var("TRIOS_MESH_TOKEN_FILE").ok().map(PathBuf::from)
}
