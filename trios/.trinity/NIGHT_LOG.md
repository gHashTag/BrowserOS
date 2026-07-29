# Night log

An autonomous cycle runs hourly at :17 and appends here. Each entry says what
changed, what proved it, and what was deliberately left alone.

The cycle may build, test, fix and commit locally. It may not push, open a PR,
merge, or touch the trios repository. That line is where reversible ends.

---

## Setup, 2026-07-29 evening

Loop armed. Baseline before it starts: `make` builds, `make cassettes` passes
4/4, the headless harness passes with 157 assertions. Branch
`feat/queen-supervisor`, nothing unpushed beyond what is already on the remote.

## Cycle 1, 2026-07-29 late evening

Verified first: build clean, 157 headless assertions, 4/4 cassettes. Then the
dead-code scan over 166 declared types found two with a single occurrence.

Removed `rings/SR-02/QueenDelegationService.swift`. It sat in `rings/`, so it
compiled into every build, and nothing called it - its job was taken over by
`ChatViewModel.delegateIssueToWorker` when delegation was actually wired up. It
is the same file the Queen's own `/roadmap` flagged, which is a decent sign the
audit and the scanner agree.

Left `BR-OUTPUT/QueenStatusBadge.swift` alone. It is also uncalled, but it lives
in BR-OUTPUT and is absent from the lean build list, so it is an unbuilt
prototype rather than dead weight. Deleting drafts from the drafts folder is not
an improvement.

Re-verified after the removal: build clean, 157 assertions, 4/4 cassettes.

