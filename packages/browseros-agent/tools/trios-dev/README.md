# trios-dev

Rust replacement for the Go+shell dev runner.

## Build

```bash
cd packages/browseros-agent/tools/trios-dev
cargo build --release
# binary: target/release/trios-dev
```

## Commands

| Command | Description |
|---------|-------------|
| `trios-dev watch` | Start dev environment (WXT HMR + server). Browser must be opened manually or use `--manual`. |
| `trios-dev watch --manual` | Build extension statically, launch TRIOS.app with extension loaded |
| `trios-dev watch --new` | Use random ports (for parallel runs) |
| `trios-dev test` | Run bun test with full browser environment |
| `trios-dev test --headless` | Run tests headless |
| `trios-dev cleanup` | Kill dev ports, remove temp dirs |
| `trios-dev check` | Verify no BrowserOS hardcoded paths remain (run after any rename) |

## Fixed Ports

| Service | Port |
|---------|------|
| CDP (Chromium DevTools) | 9000 |
| Server | 9105 |
| Extension | 9305 |

Ports are **fixed**. If a port is occupied, trios-dev kills the occupying process and retries.
If still occupied after kill → **FATAL error** (no silent fallback to next port).

## Integration with bun dev

Update `package.json` in `packages/browseros-agent`:

```json
"scripts": {
  "dev": "cd tools/trios-dev && cargo build --release -q && ./target/release/trios-dev watch",
  "dev:manual": "cd tools/trios-dev && cargo build --release -q && ./target/release/trios-dev watch --manual",
  "dev:check": "cd tools/trios-dev && cargo build --release -q && ./target/release/trios-dev check"
}
```

## Agent Verification Flow (MANDATORY after any rename)

After **every** rename operation, agents MUST run:

```bash
cargo build --release -q -p trios-dev
./packages/browseros-agent/tools/trios-dev/target/release/trios-dev check
```

Expected output: `[check] ✔ No BrowserOS references found`

Non-zero exit = DO NOT COMMIT.
