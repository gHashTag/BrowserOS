# Tri-Net Status Across Tabs

Task: `TRI-NET-TABS-001`

Issue: `#T27-EPIC-001`

## Problem

Trios has separate Git and Mesh tabs, but neither presents the authoritative
tri-net delivery state. Pull request #89, its exact 263-commit merge, the main
branch head, post-merge hardening commits, and repository links are therefore
missing or can drift between views.

## Contract

1. Git and Mesh consume one shared tri-net repository status store.
2. The store refreshes PR #89, repository metadata, current main commits, and
   the compare range from the PR merge commit to current main through GitHub.
3. PR #89 displays as merged by gHashTag at 2026-07-22 16:35 UTC with 263
   commits and merge commit `5b147bf`.
4. The UI distinguishes the exact PR merge from later main development. At the
   verified snapshot, current main is `e841159`, five commits beyond the merge,
   with no claim that main is still pinned to `5b147bf`.
5. Recent main highlights include security discovery/fix, spam hardening,
   listener fuzzing, replay protection, and recovery performance work when
   those commits are returned by GitHub.
6. The Git tab pins a tri-net delivery card above the repository list. The Mesh
   Status tab shows the same repository card before runtime topology details.
7. Repository, PR, merge commit, and current main links open in the browser.
8. A labeled verified fallback snapshot remains available when GitHub is
   temporarily unreachable; live and fallback state are never confused.

## Tests

- The verified snapshot identifies PR #89 as an exact merge of 263 commits.
- The current main head and five post-merge commits are represented separately.
- Derived status text never reports zero current divergence after main moves.
- GitHub payload decoding preserves merge identity and recent highlights.
- The Swift build, signature, runtime launch, and BrowserOS health pass.

## Invariants

- GitHub reads remain read-only and do not require a token for public data.
- Existing repository, issue, branch, mesh runtime, and mesh chat controls stay
  available.
- Source and first-party documentation remain English and ASCII-only.
