# Plan: Replace Deterministic Mesh Crypto Seed with Secure Key Loading

## Context

`trios-mesh` already has a production-grade X25519 + ChaCha20-Poly1305 crypto core in `trios/rings/RUST-13/trios-mesh/src/crypto.rs`. The weakness is not the primitives, but how the static identity keys are sourced:

- `clade-meshd/src/main.rs` derives its private key from the node id via `deterministic_seed(id)`.
- `trios-mesh/src/bin/trios_meshd.rs` does the same via `seed_for(id)`.

Because the seed is predictable from the node id, anyone who knows a peer's id can derive its private key, breaking confidentiality and authentication. The code itself labels these as "demo" / "simulation-only".

This plan removes the deterministic derivation and replaces it with secure key loading/generation.

## Goal

- Load the node's long-term X25519 private key from a secure runtime source.
- Fall back to generating a fresh key with the OS CSPRNG and persisting it with restrictive file permissions.
- Derive the public key from the loaded secret; never derive the secret from the node id.
- Remove all deterministic seed functions.
- Update peer bootstrapping so that a peer's **public key** is supplied explicitly (request body or config), not reverse-computed from the node id.
- Keep the existing `Handshake`/Noise-XX path untouched; only the static-key path changes.

## Non-Goals

- No changes to the AEAD, ratchet, replay window, or ETX routing code.
- No new Swift UI for QR/key exchange in this task (follow-up).
- No migration of old deterministic keys: this is a security break by design.
- No Apple Keychain / Linux keyring integration yet (file-system + env only).

## Files to Modify / Create

### trios-mesh library

- `trios/rings/RUST-13/trios-mesh/src/crypto.rs`
  - Add `StaticKey::from_secret(secret: StaticSecret)`.
  - Add `StaticKey::generate()` that uses `StaticSecret::random_from_rng(OsRng)`.

### clade-meshd

- `trios/rings/RUST-13/clade-meshd/src/key_store.rs` (new)
  - `fn load_or_generate(node_id: NodeId) -> Result<StaticKey, String>`:
    1. If `TRIOS_MESH_PRIVATE_KEY` is set, decode base64/hex to 32 bytes and use it.
    2. Else look at `~/.trinity/mesh/keys/node_{node_id}.key`.
    3. Else generate a new key, create the directory with `0o700`, write the file with `0o600`.
  - Helper `fn decode_public_key(base64: &str) -> Result<PublicKey, String>`.
- `trios/rings/RUST-13/clade-meshd/src/main.rs`
  - Delete `deterministic_seed` and its unit test.
  - Add `my_key: StaticKey` to `MeshState`.
  - Load the key in `main()` before building state.
  - Change `PeerRequest` for `seed-peer` to include a required `public_key: String` (base64 of the peer's X25519 public key).
  - Update `seed_peer_handler` to decode the supplied public key instead of deriving it.
- `trios/rings/RUST-13/clade-meshd/Cargo.toml`
  - No new dependencies expected (`base64` and `dirs` already present).

### trios-meshd

- `trios/rings/RUST-13/trios-mesh/src/bin/trios_meshd.rs`
  - Delete `seed_for`.
  - Load/generate the node's key with the same helper logic (inline or a new `trios-mesh/src/key_store.rs`).
  - Extend config grammar with `peer_pubkey <pid> <base64>` so peer public keys are explicit.
  - Refuse to start if a `peer` directive has no matching `peer_pubkey`.

## Implementation Steps

### Step 1 — Extend `StaticKey`

In `crypto.rs`:

```rust
impl StaticKey {
    pub fn from_secret(secret: StaticSecret) -> Self {
        Self(secret)
    }

    pub fn generate() -> Self {
        Self(StaticSecret::random_from_rng(OsRng))
    }
}
```

Keep `from_seed` for any legitimate test cases that still need a known seed, but stop using it for production identities.

### Step 2 — Key store module for clade-meshd

Create `key_store.rs`:

- Constants:
  - `TRIOS_MESH_PRIVATE_KEY` env var name.
  - Default dir `~/.trinity/mesh/keys/`.
- `load_or_generate(node_id)`:
  - Try env first (base64 decode of 32 bytes). Hex support is nice-to-have but base64 is enough.
  - Resolve default path with `dirs::home_dir()`.
  - If file exists, read and base64-decode.
  - If not, generate `StaticKey::generate()`, encode to base64, create dir with mode `0o700`, write file with mode `0o600`.
  - Return `StaticKey::from_secret(secret)`.
  - On any decode/IO error, return `Err(String)` so the daemon exits cleanly with a clear message.
- `decode_public_key(s)`: base64 decode to `[u8; 32]`, then `trios_mesh::crypto::public_from_bytes`.

### Step 3 — Wire clade-meshd to the key store

- `MeshState` gains a `my_key: StaticKey` field.
- `main()` calls `key_store::load_or_generate(node_id)?` and passes the key into `MeshState::new`.
- `seed_peer_handler` uses `state.my_key` as its identity and the decoded peer public key from the request.
- Remove `deterministic_seed` and `deterministic_seed_is_stable` test.
- Add a unit test that the key store generates a valid key, re-loads it, and the re-loaded key matches the generated public key.

### Step 4 — Update `trios_meshd`

- Delete `seed_for`.
- In `run()`:
  - Load/generate the node key with the same env/file logic.
  - Parse `peer_pubkey` entries into a map `NodeId -> PublicKey`.
  - When processing each `peer` directive, look up the public key; if missing, return an error.
  - Derive sessions from real keys.
- Add a small test for config parsing with `peer_pubkey`.

### Step 5 — Update existing tests

- `clade-meshd` tests currently use `Handshake::new()` (ephemeral) in `seed_both`, so they do not need deterministic seeds. Confirm they still pass after removing `deterministic_seed`.
- `trios_meshd` has no in-tree unit tests, only smoke scripts; update smoke instructions or leave them for a follow-up.

### Step 6 — Verify

Run:

```bash
cd trios/rings/RUST-13
cargo test --workspace
```

Expected: all workspace tests pass.

Also run the new SSE chat test to ensure the unrelated Swift side still builds:

```bash
cd trios
bash tests/swift/run_chat_sse_e2e.sh
./build.sh
```

Optional manual check:

```bash
TRIOS_MESH_NODE_ID=1 cargo run --bin clade-meshd
# In another shell, generate a second key and seed-peer with its public key.
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Generated key file is created with world-readable permissions | Explicitly set `0o600` and parent dir `0o700`; verify with tests. |
| `TRIOS_MESH_PRIVATE_KEY` env var accidentally logged | Never log it; log only the derived public key / fingerprint. |
| Removing deterministic seed breaks any existing smoke/demo that relied on it | Update `trios_meshd` config grammar; document the change. |
| Peer public key must be supplied manually before seeding | Return a clear 400 error explaining how to provide it; update UI later. |
| `StaticSecret::random_from_rng(OsRng)` is blocking on systems with low entropy | `OsRng` is non-blocking on modern OSes; acceptable for daemon startup. |

## Follow-ups

- Task #8: forward mesh chat sealed frames through transport (now unblocked).
- Swift UI: expose a way to share/scan peer public keys before calling `/seed-peer`.
- CI: add a macOS runner for Swift tests and a Linux runner for Rust mesh tests (the current `.github/workflows/test.yml` is browseros-agent only).
