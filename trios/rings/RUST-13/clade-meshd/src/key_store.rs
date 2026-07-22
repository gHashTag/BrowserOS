//! Secure long-term key loading for clade-meshd.
//!
//! The node's X25519 static identity key is loaded from, in priority order:
//!
//! 1. The `TRIOS_MESH_PRIVATE_KEY` environment variable (base64-encoded 32 bytes).
//! 2. The on-disk key file `{key_dir}/node_{node_id}.key`.
//! 3. A newly generated key from the OS CSPRNG, persisted to that file.
//!
//! The private key is never logged. Only the derived public key (or its
//! fingerprint) should appear in logs and API responses.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use trios_mesh::crypto::{public_from_bytes, PublicKey, StaticKey, StaticSecret};
use trios_mesh::NodeId;

const PRIVATE_KEY_ENV: &str = "TRIOS_MESH_PRIVATE_KEY";
const KEY_DIR_ENV: &str = "TRIOS_MESH_KEY_DIR";

/// Resolve the key directory.
///
/// Uses `TRIOS_MESH_KEY_DIR` if set, otherwise `~/.trinity/mesh/keys`.
pub fn default_key_dir() -> PathBuf {
    std::env::var(KEY_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .map(|h| h.join(".trinity/mesh/keys"))
                .unwrap_or_else(|| PathBuf::from(".trinity/mesh/keys"))
        })
}

fn key_path(node_id: NodeId) -> PathBuf {
    default_key_dir().join(format!("node_{node_id}.key"))
}

/// Load or generate the node's static identity key.
///
/// Priority:
/// - `TRIOS_MESH_PRIVATE_KEY` env var (base64 of 32 bytes).
/// - existing key file.
/// - generated fresh key, persisted with 0o600 permissions under a 0o700 dir.
pub fn load_or_generate(node_id: NodeId) -> Result<StaticKey, String> {
    if let Ok(raw) = std::env::var(PRIVATE_KEY_ENV) {
        let secret = decode_secret(&raw).map_err(|e| format!("{PRIVATE_KEY_ENV}: {e}"))?;
        return Ok(StaticKey::from_secret(secret));
    }

    let path = key_path(node_id);
    if path.exists() {
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("cannot read key file {}: {e}", path.display()))?;
        let secret = decode_secret(text.trim())
            .map_err(|e| format!("invalid key file {}: {e}", path.display()))?;
        return Ok(StaticKey::from_secret(secret));
    }

    let key = StaticKey::generate();
    let secret_bytes = key.secret_bytes();
    let encoded = BASE64.encode(&secret_bytes);

    let dir = default_key_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create key dir {}: {e}", dir.display()))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("cannot set key dir permissions: {e}"))?;

    fs::write(&path, encoded).map_err(|e| format!("cannot write key file {}: {e}", path.display()))?;
    fs::set_permissions(&path,
        fs::Permissions::from_mode(0o600),
    )
    .map_err(|e| format!("cannot set key file permissions: {e}"))?;

    Ok(key)
}

/// Decode 32 secret bytes from base64.
fn decode_secret(text: &str) -> Result<StaticSecret, String> {
    let bytes = BASE64
        .decode(text.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "private key must decode to exactly 32 bytes, got {}",
            bytes.len()
        ));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(StaticSecret::from(arr))
}

/// Decode a peer public key from base64 wire bytes.
pub fn decode_public_key(text: &str) -> Result<PublicKey, String> {
    let bytes = BASE64
        .decode(text.trim())
        .map_err(|e| format!("invalid public key base64: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "public key must be 32 bytes, got {}",
            bytes.len()
        ));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(public_from_bytes(arr))
}

/// Return the base64-encoded public key bytes for a given static key.
pub fn public_key_base64(key: &StaticKey) -> String {
    BASE64.encode(key.public().to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn with_key_dir<F, T>(f: F) -> T
    where
        F: FnOnce(&std::path::Path) -> T,
    {
        let tmp_dir = std::env::temp_dir().join(format!(
            "clade_meshd_key_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp_dir);
        let original = env::var(KEY_DIR_ENV).ok();
        env::set_var(KEY_DIR_ENV, tmp_dir.as_os_str());
        let result = f(&tmp_dir);
        match original {
            Some(v) => env::set_var(KEY_DIR_ENV, v),
            None => env::remove_var(KEY_DIR_ENV),
        }
        let _ = fs::remove_dir_all(&tmp_dir);
        result
    }

    #[test]
    fn load_or_generate_and_env_override() {
        // All env-var touching tests are combined into a single test so parallel
        // tests do not race on the process-wide environment.
        with_key_dir(|_dir| {
            env::remove_var(PRIVATE_KEY_ENV);

            // 1. Generate a fresh key, persist it, and reload it.
            let key1 = load_or_generate(7).expect("generate key");
            let pub1 = public_key_base64(&key1);

            let key2 = load_or_generate(7).expect("reload key");
            let pub2 = public_key_base64(&key2);
            assert_eq!(pub1, pub2, "reloaded key must match generated key");

            let path = key_path(7);
            let meta = fs::metadata(&path).expect("key file exists");
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "key file must be user-readable/writable only");

            let dir_meta = fs::metadata(default_key_dir()).expect("key dir exists");
            let dir_mode = dir_meta.permissions().mode() & 0o777;
            assert_eq!(dir_mode, 0o700, "key dir must be user-only");

            // 2. Env variable overrides the on-disk key.
            let generated = StaticKey::generate();
            let expected_pub = public_key_base64(&generated);
            env::set_var(PRIVATE_KEY_ENV, BASE64.encode(generated.secret_bytes()));

            let loaded = load_or_generate(99).expect("load from env");
            assert_eq!(public_key_base64(&loaded), expected_pub);

            env::remove_var(PRIVATE_KEY_ENV);
        });
    }

    #[test]
    fn decode_public_key_roundtrip() {
        let key = StaticKey::generate();
        let b64 = public_key_base64(&key);
        let decoded = decode_public_key(&b64).expect("decode public key");
        assert_eq!(decoded.to_bytes(), key.public().to_bytes());
    }
}
