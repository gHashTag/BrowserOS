# TriOS Portable Install and Landing Design

Status: local landing approved; clean-machine release blocked
Task: TRIOS-PORTABLE-LAND-001
Canonical BrowserOS branch: dev
Last audit: 2026-07-24

## 1. Goal

Make the complete `feat/zai-provider` stack available on the local canonical
`dev` branch without mixing unrelated dirty files into the landing. Preserve an
honest, repeatable path for installing TriOS on another Apple Silicon Mac.

This document distinguishes two outcomes:

1. Local landing: the complete feature branch is committed, fast-forwarded into
   local `dev`, and verified from that branch.
2. Portable release: a clean Mac can reproduce the same bundle using only
   reachable, pinned remote revisions.

The first outcome is ready. The second outcome is blocked by dependency
publication and must not be reported as complete.

## 2. Why a Blind Dirty-Tree Merge Is Unsafe

The feature branch is a full integration stack, not a Memory/Planner patch. It
contains Z.AI support, BrowserOS bridge and A2A work, TriOS UI and runtime
changes, mesh integration, hardening, and reliability records.

The correct landing operation is still a full branch fast-forward because
`dev` is its direct ancestor. The safety boundary is the final dirty-tree
commit: only reviewed TriOS paths may enter that commit. Foreign README files,
generated installation documents, build products, agent caches, and live
coordination state remain untracked or unstaged.

## 3. Current Clean-Machine Blockers

### 3.1 QueenUILib

`trios/build.sh` requires:

```text
$TRINITY_ROOT/apps/queen/Package.swift
```

and builds the `QueenUILib` product. The published `gHashTag/trinity` revision
currently checked out at `9acaebd248e95c7e9fccf5a9cf972498f71b111a`
does not contain the complete local Queen integration API used by TriOS. The
working checkout has uncommitted changes and new integration files.

Required release action: commit and publish the Queen package integration, then
pin the BrowserOS release record to that reachable Trinity commit.

### 3.2 trios-mesh

BrowserOS records the submodule revision:

```text
27a76f21e3935b8ffe2e89e517a1f2821673c25f
```

for `https://github.com/gHashTag/tri-net.git`. The revision is present locally
but is not contained in a reachable remote branch.

Required release action: publish that commit or replace the pointer with a
reviewed reachable commit, then prove a fresh recursive clone.

### 3.3 Distribution Build

The default build uses `-Onone` for development diagnostics. A portable release
must set:

```text
TRIOS_SWIFT_OPTIMIZATION=-O
```

The current bundle uses an ad-hoc signature. That is sufficient for local
development but triggers a Keychain authorization decision after rebuilds. A
normal distribution needs a stable Developer ID signature and notarization.

## 4. Prerequisites After the Publication Gate Is Closed

- Apple Silicon Mac running macOS 14 or newer.
- Xcode Command Line Tools; full Xcode is recommended so XCTest is available.
- Git with access to `gHashTag/BrowserOS`, `gHashTag/trinity`, and every private
  or submodule dependency required by the chosen release.
- BrowserOS installed and opened once so its CDP endpoint is available.
- Bun 1.3.6 at `/opt/homebrew/bin/bun`, `/usr/local/bin/bun`, or the path given
  by `TRIOS_BUN_PATH`.
- A published BrowserOS `dev` revision, a published Trinity revision containing
  `QueenUILib`, and a reachable recursive submodule graph.

Node, npm, yarn, and pnpm are not substitutes for Bun in
`packages/browseros-agent`.

## 5. Source Installation Layout

Use sibling checkouts so the default root resolution works:

```text
~/src/BrowserOS/
~/src/trinity/
```

Equivalent custom locations are supported through `TRIOS_ROOT` and
`TRINITY_ROOT`.

After the publication gate is closed, the supported sequence is:

```bash
xcode-select --install
brew install bun

mkdir -p "$HOME/src"
cd "$HOME/src"
git clone --recurse-submodules git@github.com:gHashTag/BrowserOS.git
git clone git@github.com:gHashTag/trinity.git

cd BrowserOS
git switch dev
git pull --ff-only
git submodule update --init --recursive

cd packages/browseros-agent
bun install --frozen-lockfile

cd ../../trios
TRIOS_ROOT="$PWD" \
TRINITY_ROOT="$HOME/src/trinity" \
TRIOS_SWIFT_OPTIMIZATION=-O \
./build.sh
```

Before running these commands on another machine, replace floating branch
selection with the release manifest's exact BrowserOS and Trinity commit IDs.

## 6. Verification Contract

The installation is acceptable only if all applicable checks pass:

```bash
codesign --verify --deep --strict --verbose=2 trios.app
open "$PWD/trios.app"
curl --fail http://127.0.0.1:9105/health
bash tests/swift/run_chat_sse_e2e.sh
bash e2e/trios_e2e_flow.sh
```

Expected health:

```json
{"status":"ok","cdpConnected":true}
```

The exact built bundle must be the process under test. A screenshot must show
Chat, history, planner, composer, provider controls, and Online status without
overlap or duplicated chrome.

## 7. First-Launch Permissions

The user, not an automation, decides macOS permission prompts:

- Keychain access for `ai.browseros.trios.agent-memory`.
- Accessibility access if window or cross-application control is used.
- Any BrowserOS permissions required by its installed build.

Selecting Deny for the memory key must keep startup fail-closed: long-term
recall is disabled, while the rest of the app may continue. Selecting Allow
once is required to validate the full memory runtime for the rebuilt signature.

## 8. Data and Secret Migration

Conversation history and preferences live in the macOS defaults domain:

```text
com.browseros.trios
```

Memory and planner storage lives at:

```text
~/Library/Application Support/Trinity S3AI/AgentMemory/agent-memory.sqlite3
```

The recall HMAC key and provider credentials live in the login Keychain. The
memory key uses a device-only accessibility policy and is not portable by
copying the SQLite file.

Therefore:

- Do not copy API keys into source files, environment snapshots, or install
  archives.
- Reconfigure provider credentials in Keychain on the destination Mac.
- Treat the memory database and its HMAC key as one trust unit. A database
  copied without the matching key cannot provide valid private recall.
- Prefer a future explicit export/import format over copying live SQLite,
  WAL, defaults, and Keychain state by hand.

## 9. Release Acceptance Gate

A portable release is complete only when:

- BrowserOS, Trinity, and every submodule commit are reachable from remotes.
- A fresh recursive clone in an empty directory succeeds.
- Bun dependency installation is lockfile-clean.
- The optimized build, 22 chat scenarios, XCTest when available, signature,
  health, runtime E2E, and visual inspection pass on the destination Mac.
- The release records exact commit IDs and tool versions.
- The user completes Keychain and Accessibility decisions.
- No local symlink, developer-home path, dirty dependency checkout, build
  cache, or untracked source file is required.

Until those conditions are met, local `dev` may be landed and used on this
machine, but it is not a reproducible portable release.

## 10. Three Valid Ways to Close the Gate

1. Cross-repository release: publish and pin BrowserOS, Trinity Queen, and
   tri-net commits. This preserves ownership boundaries and is preferred.
2. Vendored release: vendor the exact Queen and mesh source required by TriOS
   into one reviewed repository. This simplifies installation but increases
   update and licensing responsibility.
3. Core-only release: define a smaller TriOS build that excludes Queen and mesh
   and can be reproduced from BrowserOS alone. This is fastest to distribute
   but is not feature-equivalent to the current full stack.
