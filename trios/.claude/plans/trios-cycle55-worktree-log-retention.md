# Cycle 55 Plan - Worktree log retention and strict artifact cleanup

## Three variants

### Variant A - Tighten inline caps only
- Lower every inline rotation from 10 to 5.
- No age-based eviction, no worktree cleanup.
- Pros: trivial change. Cons: still no age eviction; worktrees stay dirty.

### Variant B - Strict retention + reusable cleaner (chosen)
- Lower cap to 5.
- Add 7-day age eviction.
- Add `scripts/cleanup_artifact_logs.sh` that works on main repo and all git worktrees.
- Call it from `build.sh` as a backstop.
- Pros: complete coverage, reusable, safe dry-run default. Cons: slightly more shell code.

### Variant C - Central Swift/Rust retention daemon
- Build a `LogArtifactRetentionService` actor or Rust binary that scans all worktrees on a schedule.
- JSON config per repo with per-family rules.
- Pros: most robust long-term. Cons: large change, needs new binary, not worth the current pain.

## Decomposition

1. **Spec** - write `.trinity/specs/worktree-log-retention-cycle55.md` and create GitHub issue #2047.
2. **Helper script** - create `scripts/cleanup_artifact_logs.sh` with `--dry-run` default and `--apply` flag.
3. **Tighten inline rotation** - update `build.sh`, `run_chat_sse_e2e.sh`, `run_queen_autonomous_test.sh` to cap=5 + age=7d.
4. **Rust cleanup** - update `clade-build/src/main.rs` to keep 5 files and evict logs older than 7 days.
5. **Wire backstop** - call `scripts/cleanup_artifact_logs.sh --apply` from `build.sh` for main repo.
6. **Verify** - run `./build.sh`, check counts, run cleaner on worktrees, run `clade-audit`.
7. **Report** - write `.claude/plans/trios-cycle55-worktree-log-retention-report.md`.
8. **Learn** - update `.trinity/experience.md` and add JSON episode.

## Issue

browseros-ai/BrowserOS#2047
