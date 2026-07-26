# TriOS Installation Guide

**Target audience:** local developers and early testers building TriOS from source.  
**Scope:** source installation on macOS 14+ (Apple Silicon).  
**Version:** 1.0.0-dev  
**Last updated:** 2026-07-26

---

## What is portable today

The `feat/zai-provider` integration stack has been landed on the local `dev` branch. A developer who already has the sibling source checkouts can build and run TriOS end-to-end.

## What is NOT yet portable

A fully clean-machine public release is blocked by three external dependencies:

1. **Unpublished QueenUILib integration** — `gHashTag/trinity/apps/queen` contains local modifications required by TriOS. A fresh `git clone` of `gHashTag/trinity` will not build TriOS until those changes are pushed to a reachable branch.
2. **`trios-mesh` submodule commit not on a remote branch** — `trios/rings/RUST-13/trios-mesh` points to `27a76f2`, which exists only in a local branch. `git submodule update --recursive` will fail on a clean machine until the commit is pushed or the pointer is updated.
3. **Ad-hoc code signing only** — `trios.app` is signed with a development identity. Public distribution requires a Developer ID identity + notarization.

See `TRIOS_RELEASE_MANIFEST.md` at the repo root for exact commits and the deferred release checklist.

---

## Prerequisites

- macOS 14.0 or later on Apple Silicon
- [Homebrew](https://brew.sh)
- [Bun](https://bun.sh)
- [Rust](https://rustup.rs)
- Node.js 20+ and [PM2](https://pm2.keymetrics.io)
- Git
- SQLCipher (`brew install sqlcipher`)
- A local clone of `gHashTag/trinity` (sibling to `BrowserOS` or pointed to by `TRINITY_ROOT`)

---

## Install from source

```bash
# 1. Clone BrowserOS
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS

# 2. Clone Trinity as a sibling checkout (required for QueenUILib)
git clone https://github.com/gHashTag/trinity.git ../trinity

# 3. Initialize submodules (requires the local-only trios-mesh branch to be present)
git submodule update --init --recursive trios/rings/RUST-13/trios-mesh

# 4. Install dependencies
brew install sqlcipher git node@20
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
npm install -g pm2

# 5. Build the TriOS app
cd trios
export TRINITY_ROOT=/path/to/trinity
./build.sh

# 6. Launch app + backend services
./trios
```

---

## First-launch permissions

After `open trios.app` or `./trios`, macOS may ask for:

- **Keychain access** — TriOS stores its encryption key in the macOS Keychain (`com.browseros.trios.encryption`). Choose **Always Allow**.
- **Accessibility** — only if you enable hotkey/overlay features in Settings.
- **Local network** — the BrowserOS CDP bridge communicates on `127.0.0.1`.

If Keychain prompts repeat after every rebuild, the bundle is ad-hoc signed. This is expected for local development and is resolved by a Developer ID signature.

---

## Verify the installation

```bash
# App process
curl -s http://127.0.0.1:9105/health
# Expected: {"status":"ok","cdpConnected":true}

# Backend services
pm2 status

# Trinity gates
cargo run --bin clade-build
cargo run --bin clade-e2e
cargo run --bin clade-audit
cargo run --bin clade-seal
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `QueenUILib was not produced` | `TRINITY_ROOT` points to a Trinity checkout without the required integration changes. | Use the local Trinity checkout that has the modified `apps/queen` files, or wait for the integration to be published. |
| `git submodule update` fails | `trios-mesh` commit `27a76f2` is not on a remote branch. | Manually checkout the submodule branch that contains `27a76f2`, or update the submodule pointer once it is pushed. |
| Rebuild triggers repeated Keychain prompts | Ad-hoc signing. | Accept the prompt or set `TRIOS_DEVELOPER_ID` once a Developer ID certificate is available. |
| Menu-bar logo disappears | App process was killed or not restarted after a rebuild. | Run `open trios.app` after every `./build.sh`. |
| `/doctor` reports model issue | The configured LLM model is unavailable or the account has no balance/package. | See the chat troubleshooting section or run `/doctor --model` to select an available model. |

---

## Data migration warning

TriOS stores conversation history, agent memory, and encryption keys locally:

- `~/Library/Containers/com.browseros.trios/` (sandbox defaults)
- `~/.trios/` (config and recovery packages)
- macOS Keychain item `com.browseros.trios.encryption`
- SQLite files in `trios/.trinity/state/`

These form a single trust unit. Copying only the SQLite files without the matching Keychain key will leave encrypted data unreadable. Use the in-app recovery export/import flow when moving to a new Mac.

---

## Next steps

- Read `TRIOS_RELEASE_MANIFEST.md` for the full dependency map and deferred clean-machine checklist.
- Read `trios/QUICK_START.md` for a one-page copy-paste install script.
- Read `trios/LAUNCH.md` for day-to-day launcher commands and the `trios` CLI.

---

*Part of TRIOS-PORTABLE-LAND-001.*
