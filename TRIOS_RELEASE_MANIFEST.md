# TriOS Release Manifest — TRIOS-PORTABLE-LAND-001

**Version:** 1.0.0-dev  
**Landing date:** 2026-07-26  
**BrowserOS commit:** `0ffca73e1` (`feat/zai-provider` → `dev`)  
**Target branch:** `dev`  
**Release type:** Local developer landing (not a clean-machine public release)

---

## 1. What is in this landing

This manifest records the state of the `feat/zai-provider` integration stack after it was fast-forwarded onto the local `dev` branch. It is intended for developers who already have the sibling source checkouts and want to reproduce the build.

### Source included in the landing commit

- **TriOS Swift app:** `trios/main.swift`, `trios/rings/SR-00/SR-01/SR-02/`, `trios/BR-OUTPUT/` (lean set), `trios/build.sh`, `trios/trios` launcher, tests under `trios/tests/`.
- **BrowserOS server:** Local-auth token-family store (`token-family-store.ts`, `local-auth-service.ts`, `local-auth.ts`, `require-local-auth.ts`), chat-history service + routes, task-queue service + routes, A2A registry with PostgreSQL backend, retry/CORS/request-auth hardening, and matching tests.
- **Trinity rings tooling:** `trios/rings/RUST-01/clade-build`, `RUST-08/clade-promote` with seal gate, `RUST-12/clade-audit`.
- **Project memory:** Cycle plans/reports under `.claude/plans/` and `trios/.claude/plans/`.

### Not included (intentionally kept out of `dev`)

- Generated HTML/PDF marketing docs (`INSTALLATION_GUIDE.html`, `TRIOS_INSTALLATION_GUIDE.pdf`, etc.) — moved to `.claude/drafts/portable-land-artifacts/`.
- Runtime state (`.agents/`, `.build/`, live `.sqlite`/`-wal`/`-shm`, PM2 state, agent caches) — added to `.gitignore`.

---

## 2. Exact dependency commits

| Component | Commit | Note |
|-----------|--------|------|
| BrowserOS / TriOS | `0ffca73e1` | Landed on local `dev`; branch `feat/zai-provider` is a direct ancestor. |
| Trinity (`gHashTag/trinity`) | `9acaebd24` | Local checkout at `~/trinity`. **Unpublished integration files** — `apps/queen/Package.swift` and bridge files are modified locally and not on a reachable remote branch. |
| `trios-mesh` submodule (`gHashTag/tri-net`) | `27a76f2` | Commit exists only on local `feat/trios-integration` branch in the submodule checkout. `git submodule update --recursive` on a clean machine **will fail** because `27a76f2` is not on a reachable remote branch. |

---

## 3. Clean-machine blockers

These blockers must be resolved before a fully reproducible public release. They are documented, not fixed, in this cycle.

1. **Unpublished QueenUILib integration**
   - TriOS links against `libQueenUILib.dylib` built from `gHashTag/trinity/apps/queen`.
   - The local Trinity checkout has uncommitted integration changes required for the build.
   - **Action needed:** commit/push the QueenUILib integration to a reachable `gHashTag/trinity` branch.

2. **`trios-mesh` submodule commit not reachable**
   - Submodule pointer `27a76f2` is on a local-only branch `feat/trios-integration`.
   - **Action needed:** push `feat/trios-integration` to `gHashTag/tri-net` or update the submodule pointer to a commit on `origin/main`.

3. **Ad-hoc code signing only**
   - `build.sh` signs `trios.app` with `codesign --force --deep --sign -` (ad-hoc).
   - Local development works, but every rebuild may trigger Keychain re-authorization, and a clean machine cannot notarize.
   - **Action needed:** add a Developer ID identity (`TRIOS_DEVELOPER_ID`) to `build.sh`, plus notarization and stapling for public `.dmg`/`.zip` releases.

4. **No signed release artifact**
   - There is no `.dmg`, notarized `.zip`, GitHub Release, or Homebrew cask.
   - **Action needed:** create a release workflow that builds with `TRIOS_SWIFT_OPTIMIZATION=-O`, signs, notarizes, and publishes artifacts.

---

## 4. Local developer installation

Prerequisites: macOS 14+, Apple Silicon, Homebrew, Bun, Rust, Node.js, PM2, SQLCipher.

```bash
# 1. Clone the main repo
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS

# 2. Clone the Trinity sibling checkout (required for QueenUILib)
git clone https://github.com/gHashTag/trinity.git ../trinity

# 3. Check out the trios-mesh submodule (will fail on a clean machine until blocker #2 is resolved)
git submodule update --init --recursive trios/rings/RUST-13/trios-mesh

# 4. Install dependencies
brew install sqlcipher git node@20
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
npm install -g pm2

# 5. Build TriOS
cd trios
export TRINITY_ROOT=/path/to/trinity
./build.sh

# 6. Launch
cd trios
./trios
```

After launch, verify:

```bash
curl -s http://127.0.0.1:9105/health
# Expected: {"status":"ok","cdpConnected":true}
```

---

## 5. Build configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRIOS_ROOT` | directory of `build.sh` | Project root override. |
| `TRINITY_ROOT` | `../../trinity` relative to TriOS | QueenUILib source checkout. |
| `TRIOS_SWIFT_OPTIMIZATION` | `-Onone` | Use `-O` for release builds. |
| `TRIOS_REUSE_QUEEN_BUILD` | unset | Skip rebuilding QueenUILib if set. |
| `TRIOS_INCLUDE_PROTOTYPES` | unset | Compile every tracked `BR-OUTPUT/` prototype. |
| `TRIOS_DEVELOPER_ID` | unset | Developer ID for signed release builds (not yet wired). |

---

## 6. Verification contract

The following gates passed on the landing commit before `dev` was fast-forwarded:

| Gate | Command | Result |
|------|---------|--------|
| Swift build | `cd trios && ./build.sh` | PASS |
| Clade build | `cargo run --bin clade-build` | PASS |
| Clade e2e | `cargo run --bin clade-e2e` | PASS |
| Clade audit | `cargo run --bin clade-audit` | 0 hard findings |
| Clade seal | `cargo run --bin clade-seal` | SEAL VALID |
| Chat SSE e2e | `bash tests/swift/run_chat_sse_e2e.sh` | PASS |
| TriOS e2e flow | `bash e2e/trios_e2e_flow.sh` | PASS |
| Health check | `curl http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}` |

---

## 7. Known runtime observations

- The e2e reports show occasional `Connection refused` errors on `127.0.0.1:9205` (Canary MCP). These are transient health probes; the primary Sovereign health endpoint (`127.0.0.1:9105/health`) remains healthy.
- After any rebuild, `trios.app` must be relaunched with `open trios.app` to load the new binary and preserve the menu-bar logo. The `clade-monitor` watchdog will also relaunch it within ~60 s if the process is missing.

---

## 8. Deferred work for clean-machine release

1. Push Trinity QueenUILib integration to a reachable branch.
2. Push `trios-mesh` `27a76f2` (or update pointer) to a reachable remote branch.
3. Add `TRIOS_DEVELOPER_ID` signing + notarization to `build.sh`.
4. Add a CI job that does a clean recursive clone and verifies `TRIOS_SWIFT_OPTIMIZATION=-O ./build.sh`.
5. Produce a signed `.dmg`/`.zip` and a GitHub Release workflow.
6. Add a Homebrew cask formula once a signed artifact exists.
7. Verify first-launch onboarding and permission prompts on a fresh Apple Silicon Mac.

---

## 9. Legal / license

TriOS and BrowserOS are licensed under AGPL-3.0-or-later. The release manifest itself is documentation and may be reused under the same license.

---

*Generated by the Trinity autonomous execution loop for TRIOS-PORTABLE-LAND-001.*

## 2026-07-24 Update: Upstream divergence discovered

After the local fast-forward, `origin/dev` advanced with commits that are not in local `dev`:
- `216b3f5cb refactor(wave 7): extract @browseros/agent-core, retire TS server surface`
- `48e0b52c6 chore(trios switchover): remove Swift app copy, mcp-bridge and trios CI`
- plus 15 further commits ending at `74d9a0d9c`.

This means the portable landing commit (`0ffca73e1` and docs commits) lives on a **local-only branch**; it cannot be pushed to `origin/dev` without a major merge/rebase because the upstream removed:
- `packages/browseros-agent/apps/server/` (400 files)
- `trios/` Swift app + Rust rings (467 files)
- the `trios-mesh` submodule
- and replaced the TS server surface with `@browseros/agent-core` + Rust `trios-server`.

Resolution options are tracked in `.claude/plans/trios-portable-land-001-report.md` Variant C.
