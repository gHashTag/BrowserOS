---
name: tmp-zero
description: Eliminate world-writable /tmp usage from trios Rust ring source files by migrating tests to tempfile and production code to .trinity/ subdirs.
argument-hint: [ring]
---

# tmp-zero Skill (trios)

Ensure trios workspace Rust rings never use `/tmp` for test fixtures or runtime state.

## When to Invoke

- After a weak-spot audit finds `/tmp` in `rings/**/src/*.rs`.
- When adding a new ring that needs temporary test state.
- Before sealing a wave that touches filesystem paths.
- When hardening CI reproducibility and avoiding TOCTOU collisions.

## Anti-pattern: /tmp in tests

```rust
let path = "/tmp/clade_audit_bounded_test.txt";
fs::write(path, "payload").ok();
// ... test ...
fs::remove_file(path).ok();
```

Problems:
- World-writable directory enables cross-user/cross-process collisions.
- Leftover files from a crashed test can poison the next run (flakiness).
- CI runners may have different `/tmp` semantics or concurrency.

## Pattern: tempfile crate

```toml
[dev-dependencies]
tempfile = "3"
```

```rust
let dir = tempfile::tempdir().expect("tempdir");
let path = dir.path().join("bounded_test.txt");
fs::write(&path, "hello bounded").ok();
let result = read_file_bounded(&path);
assert_eq!(result, Some("hello bounded".to_string()));
// dir is automatically deleted when it leaves scope.
```

Benefits:
- Unique per-test directory under the OS temp root (still not `/tmp` directly).
- Automatic cleanup on drop, even on panic.
- No cross-test collisions.

## Pattern: project-relative runtime state

For persistent daemon state (not tests), use `{project_dir()}/.trinity/run/`:

```rust
let drop_path = format!("{}/.trinity/run/mesh.drop", trios_config::project_dir());
```

Override with env only when needed:

```rust
let drop_path = std::env::var("TRIOS_MESH_DROP").unwrap_or_else(|_| {
    format!("{}/.trinity/run/mesh.drop", trios_config::project_dir())
});
```

## Migration Recipe

1. `grep -RIn '/tmp' rings/**/src/*.rs` to find offenders.
2. Add `tempfile = "3"` to `[dev-dependencies]` if the `/tmp` usage is in tests.
3. Replace literal `/tmp/...` paths with `tempfile::tempdir()` or `NamedTempFile`.
4. For non-test `/tmp` paths, move to `.trinity/run/`, `.trinity/dev/`, or `.trinity/e2e/`.
5. Run `cargo test -p {ring} --all-features`.
6. Run `cargo clippy -p {ring} --all-targets --all-features`.
7. Run ASCII scan on changed files.

## CI Gate (backlog)

A future `clade-seal` ring can enforce:

```bash
grep -RIn '/tmp' rings/**/src/*.rs && exit 1
```

Exempt only documentation files (`docs/`, `smoke/`, `README.md`) and external tooling.

## Rules

- Never write to `/tmp` from trios workspace Rust source.
- Never use `/tmp` for persistent runtime state.
- Prefer `tempfile` for test scratch directories.
- Prefer `.trinity/` subdirs for project-relative runtime state.
- Keep all changed files ASCII-only (L3 PURITY).
