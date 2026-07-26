# TriOS Portable Install and Local Landing — TRIOS-PORTABLE-LAND-001 Plan

**Date:** 2026-07-26  
**Branch:** `feat/zai-provider` → `dev`  
**Task ID:** `TRIOS-PORTABLE-LAND-001`  
**Canonical spec:** `.llm/specs/2026-07-24-trios-portable-install-and-landing-design.md`  
**Road:** **B** (balanced: land + test + document + experience save)

---

## 0. Scope boundary

This cycle delivers **outcome 1** from the spec: a **local landing** of the full `feat/zai-provider` stack on the local `dev` branch, with an honest installation/landing document and a release manifest that records the current clean-machine blockers.

**Out of scope for this cycle:** resolving the clean-machine publication blockers (QueenUILib, `trios-mesh` submodule reachability, Developer ID signing). The final report will list them as deferred work, not as completed.

---

## 1. Weak spots researched

| Rank | Weak spot | Evidence | Severity | Why it blocks a safe landing |
|------|-----------|----------|----------|------------------------------|
| 1 | **Unreviewed dirty tree merge risk** | `git status` shows 100+ modified/untracked files across trios, BrowserOS server, root repo, generated docs, and build products. | P0 | A blind `git merge` would land foreign files (agent caches, `.build/`, generated PDF/HTML docs, scratch notes) into `dev`. |
| 2 | **Active claim mismatch** | `.trinity/queue/active.json` lists `TRIOS-PORTABLE-LAND-001` claimed by `codex-root` with no TTL and a stale `started_at` of `2026-07-24T07:41:50Z`. | P0 | Per `coordination-law.md`, no agent may mutate the task graph without an exclusive claim. The stale claim must be reclaimed before landing work begins. |
| 3 | **Unpublished `QueenUILib` integration** | `trios/build.sh` builds `$TRINITY_ROOT/apps/queen/Package.swift`; the working Trinity checkout at `/Users/playra/trinity` has uncommitted integration files. | P1 | Clean-machine recursive clone from `gHashTag/trinity` will not build TriOS. Local landing can succeed because the local Trinity checkout is present. |
| 4 | **Submodule commit not on a reachable remote branch** | `trios-mesh` submodule points to `27a76f21...` in `gHashTag/tri-net`; the commit is local-only. | P1 | A fresh `git submodule update --recursive` will fail. Local landing can use the existing submodule checkout. |
| 5 | **Ad-hoc code signature** | Current bundle is built without `TRIOS_DEVELOPER_ID` and signed ad-hoc. | P2 | Local development works, but every rebuild triggers Keychain re-authorization and a clean machine cannot notarize. Document, do not fix in this cycle. |
| 6 | **Mixed documentation artifacts** | Untracked `INSTALLATION_GUIDE.html`, `.pdf`, `ARCHITECTURE_OVERVIEW.md`, `MASTER_PACKAGE_SUMMARY.md`, etc. are presentation/marketing docs, not source. | P2 | They must be separated from the code landing so `dev` stays buildable and reviewable. |
| 7 | **No release manifest** | There is no `TRIOS_RELEASE_MANIFEST.md` pinning exact BrowserOS/Trinity/submodule commits and listing blockers. | P2 | Without it, the next agent/clean machine cannot reproduce or audit the landing. |

---

## 2. Competitor snapshot — portable install / landing patterns

| Competitor / product | Distribution model | What TriOS can adopt | Gap TriOS still has |
|----------------------|-------------------|----------------------|---------------------|
| **Claude Code** | Native `curl \| bash` installer to `~/.local/`, signed/notarized binary, optional npm global install, auto-update. | Ship a one-command shell installer that pulls a signed `.app`/binary and verifies checksum/signature. | TriOS currently requires sibling source checkouts + manual build. |
| **Claude Desktop** | Downloadable signed `.dmg`/`.app` with notarization, auto-update, no source build required. | Target a signed `.app` + notarized `.dmg` for end users. | We use ad-hoc signing and depend on unpublished local checkouts. |
| **Cursor** | `.dmg`/`.zip` app bundle, in-app updater, signed binary. | Provide a release `.zip` of `trios.app` plus a version manifest. | No stable release artifact or update feed exists. |
| **Zed** | Signed `.dmg`, Homebrew cask, nightly builds, public download page. | Add a Homebrew cask formula and a public download page once signing is available. | Distribution channel and signing identity missing. |
| **Dia (The Browser Company)** | macOS-only `.app`, polished onboarding, Atlassian distribution. | Polish first-launch permission guidance and onboarding copy. | Dia is closed-source and has a distribution partner; TriOS is open-source and self-distributed. |
| **OpenClaw / Repowire / AgentHive** | Source-first, CLI/Tauri/Go binaries, GitHub releases, docker optional. | Publish GitHub Releases with signed artifacts and a `install.sh` that handles dependencies (Bun, SQLCipher). | No GitHub release automation or signed artifact pipeline. |

**Strategic takeaway:** The immediate value is **not** a one-click installer (blocked by signing + dependency publication). The value is a **reviewed local landing + honest installation guide + release manifest** so that the team can reproduce the build locally and know exactly what remains before a clean-machine release.

---

## 3. Decomposed implementation plan

### Phase 1 — Claim and state hygiene (5 min)

1. **Reclaim stale task claim.**
   - Read `.trinity/claims/active/`.
   - Move the stale `codex-root` claim for `TRIOS-PORTABLE-LAND-001` to `.trinity/claims/released/{claim_id}.json` with result `stale-reclaimed`.
   - Create a new active claim: `agent=claude`, `task_id=TRIOS-PORTABLE-LAND-001`, `spec_path=.llm/specs/2026-07-24-trios-portable-install-and-landing-design.md`, TTL 120 min, priority P1.
   - Append `claim.reclaim` and `task.intent` events to `.trinity/events/akashic-log.jsonl`.

2. **Update queue state.**
   - Ensure `TRIOS-PORTABLE-LAND-001` is the only active task in `.trinity/queue/active.json` and that dependent in-progress weak-spot tasks are either completed or parked as `blocked`/`pending`.

### Phase 2 — Dirty-tree triage (10 min)

3. **Classify every modified/untracked file into four buckets:**
   - **A — Core source (land):** `trios/rings/`, `trios/BR-OUTPUT/`, `trios/build.sh`, `trios/main.swift`, `trios/tests/`, `packages/browseros-agent/` server/source/test changes, root `Package.swift`, root `.gitignore`.
   - **B — Generated plans/reports (land as docs):** `.claude/plans/trios-cycle{11..27}-*.md`, `.claude/plans/trios-*-report.md` — these are the audit trail of prior cycles and should live on `dev` as project memory.
   - **C — Generated install/marketing artifacts (do NOT land in dev):** `INSTALLATION_GUIDE.html`, `INSTALLATION_GUIDE_PREVIEW.png`, `TRIOS_INSTALLATION_GUIDE.pdf`, `TRIOS_MASTER_INSTALLATION_GUIDE.md`, `ARCHITECTURE_OVERVIEW.md`, `MASTER_PACKAGE_SUMMARY.md`, `RESTRUCTURING_COMPLETE.md`, `AGENT_*_NETWORK*.md`, `OF`, `amp`, `.agents/`, `.build/`.
   - **D — Runtime state (never commit):** `.trinity/doctor_prev.dat`, `.trinity/reviews/`, `packages/browseros-agent/.trinity/`, `packages/browseros-agent/apps/server/.trinity/`, live `.sqlite`/`-wal`/`-shm` files if any.

4. **Create a safe staging area for bucket C/D.**
   - Move bucket C to `/Users/playra/BrowserOS/.claude/drafts/portable-land-artifacts/` (preserving them for the report/manifest but removing from the working tree).
   - Add bucket D paths to root `.gitignore` if not already ignored.

### Phase 3 — Reviewed local landing commit (15 min)

5. **Stage bucket A + B only.**
   - Stage trios source, BrowserOS server changes, tests, and build scripts.
   - Stage plan/report markdowns under `.claude/plans/`.
   - Leave root `README.md` changes staged only if they are factual release notes; otherwise revert them or move to a docs commit.

6. **Split the commit if needed.**
   - Commit 1: `feat(trios): land Z.AI/provider integration stack on dev` — core source + tests + server changes. Use `Closes #N` only if there is an open issue mapped to this landing; otherwise omit L1 `Closes #N` because no issue is linked in the spec.
   - Commit 2: `docs(trios): add cycle plans and reports to dev branch` — `.claude/plans/` markdowns.

7. **Fast-forward local `dev`.**
   - `git checkout dev`
   - `git merge --ff-only feat/zai-provider`
   - Verify `dev` now points to the landing commits and that `dev...HEAD` diff is empty.

### Phase 4 — Documentation and manifest (15 min)

8. **Write `TRIOS_RELEASE_MANIFEST.md` at repo root.**
   - Exact BrowserOS commit (current `feat/zai-provider` HEAD).
   - Exact Trinity commit used locally and note it is unpublished.
   - Exact `trios-mesh` submodule commit and note it is not on a reachable remote branch.
   - Required build flags: `TRIOS_SWIFT_OPTIMIZATION=-O` for release, default `-Onone` for dev.
   - Signature status: ad-hoc only; Developer ID + notarization required for public release.
   - Verification contract from spec §6.
   - Prerequisites and sibling-checkout layout.

9. **Write/update `docs/INSTALLATION_README.md`.**
   - Source-install steps for a local developer (after dependency publication is solved).
   - Clear “What is not yet portable” section citing QueenUILib, submodule, and signing.
   - First-launch permission guidance (Keychain, Accessibility, BrowserOS CDP).
   - Data migration warning: defaults domain, SQLite file, and Keychain key are a trust unit.

### Phase 5 — Verification gates (20 min)

10. **Run the Trinity verification contract on `dev`.**
    - `cd trios && ./build.sh` — must pass.
    - `cargo run --bin clade-build` — must pass.
    - `cargo run --bin clade-e2e` — must pass.
    - `cargo run --bin clade-audit` — hard gates must be 0 findings.
    - `cargo run --bin clade-seal` — must be `SEAL VALID`.
    - `bash tests/swift/run_chat_sse_e2e.sh` — must pass (if environment has BrowserOS running).
    - `bash e2e/trios_e2e_flow.sh` — must pass.
    - `open trios.app` and `curl --fail http://127.0.0.1:9105/health` — must return `{"status":"ok","cdpConnected":true}`.

11. **Verify `dev` branch integrity.**
    - `git diff --stat dev...HEAD` must be empty.
    - `git status --short` on `dev` must show only leftover bucket C/D files that are intentionally ignored or moved to drafts.

### Phase 6 — Report and learnings (10 min)

12. **Write final report:** `.claude/plans/trios-portable-land-001-report.md`.
    - What was landed.
    - What was intentionally left out and why.
    - Verification results.
    - Three cooperation options for the next loop.

13. **Save experience episode.**
    - Write `.trinity/experience/2026-07-26_portable-land-local.json`.
    - Append a summary to `.trinity/experience.md`.
    - Add/update persistent memory at `/Users/playra/.claude/projects/-Users-playra-BrowserOS/memory/trios-portable-land-001.md` and `MEMORY.md` index.

14. **Release claim and queue.**
    - Move active claim to `.trinity/claims/released/` with result `clean`.
    - Move task from active to done in `.trinity/queue/`.
    - Append `claim.release` and `task.complete` events to Akashic log.

---

## 4. Implementation order

1. Reclaim stale claim / update queue.
2. Classify dirty-tree files (buckets A–D).
3. Move bucket C/D out of the working tree.
4. Stage bucket A + B.
5. Commit core source + tests + server changes.
6. Commit plan/report docs.
7. Fast-forward `dev`.
8. Write `TRIOS_RELEASE_MANIFEST.md` and `docs/INSTALLATION_README.md`.
9. Run verification gates on `dev`.
10. Relaunch `trios.app` and health-check.
11. Write final report and three variants.
12. Save experience episode and memory.
13. Release claim / close queue task.

---

## 5. Verification gates

| Gate | Command | Expected |
|------|---------|----------|
| Swift build | `cd trios && ./build.sh` | PASS |
| Clade build | `cargo run --bin clade-build` | PASS |
| Clade e2e | `cargo run --bin clade-e2e` | PASS |
| Clade audit | `cargo run --bin clade-audit` | 0 hard findings |
| Clade seal | `cargo run --bin clade-seal` | SEAL VALID |
| Chat SSE e2e | `bash tests/swift/run_chat_sse_e2e.sh` | PASS |
| TriOS e2e flow | `bash e2e/trios_e2e_flow.sh` | PASS |
| Health check | `curl --fail http://127.0.0.1:9105/health` | `{"status":"ok","cdpConnected":true}` |
| Branch integrity | `git diff --stat dev...HEAD` on `dev` | empty |
| Dirty tree | `git status --short` on `dev` | only ignored/draft residuals |

---

## 6. Three variants for the next loop

### Variant A — Minimal: keep landing local, improve docs only
Do not attempt to resolve publication blockers. In the next cycle, polish the installation guide, add screenshots, and create a `Makefile`/`install.sh` wrapper that works on the existing local developer machine. This is lowest risk and keeps `dev` green.

### Variant B — Balanced: local landing + pre-publication checklist + dependency staging (recommended)
Land `dev` as above, then create a **publication runbook** that stages the unpublished pieces:
1. Commit and push the Trinity QueenUILib integration to a reachable `gHashTag/trinity` branch.
2. Push the `trios-mesh` submodule commit to `gHashTag/tri-net` or update the pointer to a reachable commit.
3. Add a CI job that does a clean recursive clone and `TRIOS_SWIFT_OPTIMIZATION=-O ./build.sh` to prove the gate is closable.
4. Keep ad-hoc signing for now and document the Developer ID gap.
This variant makes the clean-machine release a deterministic future step rather than a surprise.

### Variant C — Deep: full clean-machine portable release
Resolve **all** blockers in one cycle: publish QueenUILib and the submodule, add Developer ID signing + notarization to `build.sh`, produce a signed `.dmg`/`.zip` release artifact, and run the installation on a fresh Apple Silicon Mac. This is the most complete outcome but requires external credentials, repository write access, and a second machine for verification — likely more than one cycle.

**Recommendation:** choose **Variant B** next. It preserves the safety of the local landing while turning the publication blockers into an actionable, tracked checklist.

---

## 7. Backlog / next loop options

- Resolve QueenUILib publication.
- Resolve `trios-mesh` submodule reachability.
- Add Developer ID code-signing and notarization to `build.sh`.
- Build a `install.sh` one-command local installer.
- Create a GitHub Releases workflow for signed artifacts.
- Add a Homebrew cask formula.
- Verify installation on a clean Apple Silicon Mac.
- Implement explicit export/import for conversation/memory state (safer than copying live SQLite + Keychain).
