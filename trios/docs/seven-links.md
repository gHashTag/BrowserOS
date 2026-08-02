# Seven Links — The Review Chain from Specification to Verdict

Issue: gHashTag/trios#1134 · Parent: #1090

## What this document is

A description of the seven links in the review chain: the path a criterion
travels from the moment the Queen writes it into a task specification to the
moment it gates acceptance. Each link is a place where the chain can break
silently — the criterion does not fail, it stays `.unchecked`, which reads as
"nobody looked" when the chain itself was the thing that broke.

The companion document
[`night-of-the-review-chain.md`](night-of-the-review-chain.md) records four of
these links as they failed in a single incident (#1130). This document steps
back and names all seven, including the specification that defines the criteria,
the file contents that let the reviewer judge unchanged code, and the verdict
gate that decides whether acceptance may proceed.

## The seven links

### 1. The specification

The chain begins with the acceptance criteria written into the task spec
(`QueenTaskSpec.render`, `rings/SR-00/QueenTaskSpec.swift`). Each criterion is a
single sentence: "Существует файл `docs/seven-links.md`." The spec is posted as
the first message in the worker's chat and pinned in the header strip
(described in [`queen-spec-header.md`](queen-spec-header.md)) so the reviewer
never has to scroll to find what done means.

If the criteria are missing, ambiguous, or swapped for a worker's own
self-assessment, the reviewer has no contract to judge against. The spec header
and `QueenAcceptancePolicy.verdicts(criteria:recorded:)`
(`rings/SR-00/QueenCriterionVerdict.swift`) both use the same source —
`DelegatedTask.acceptanceCriteria` — so the criteria displayed in the header and
the criteria the reviewer receives in the brief can never disagree.

### 2. The brief

The brief is the evidence package assembled for the reviewer agent: the
criteria, the diff, and the full contents of touched files
(`QueenReviewVerdictRequest.brief`,
`rings/SR-00/QueenReviewVerdictRequest.swift`). An embedded adversary prompt
marker (`"adversary-review"`) proves that the brief that reached the reviewer is
the brief this chain built — if the brief were replaced with a worker's prompt,
which carries no marker, the check (`isAdversarialBrief`) fails and the
verdicts are discarded.

### 3. The root of paths

`fileContentsForReview` (`rings/SR-02/ChatViewModel.swift`) resolves every file
path against `ProjectPaths.root` — the project directory — not the git toplevel.
Resolving from the wrong root left every criterion-named file silently missing.
The reviewer received an empty set, read the criteria against nothing, and
returned "could not check." A file that does not exist on the working tree is
now included with an explicit `(file not found)` marker so the gap is visible.

### 4. The file contents

After the diff, the brief carries the full contents of every file in the task's
`ownedPaths`, read from the working tree after the commit
(`fileContentsForReview`, `rings/SR-02/ChatViewModel.swift`). This is the "what
it looks like now" evidence — a criterion about code the change did not touch
but that lives in a touched file can receive a verdict instead of defaulting to
`.unchecked`. The reviewer scope is described in
[`reviewer-scope.md`](reviewer-scope.md).

### 5. The excerpt volume

A large file sent in full crowds the brief and pushes the criteria below a wall
of code. `regionExtractedContent` narrows each file to regions around names the
criteria mention. When no criteria names are found, the excerpt says so
explicitly rather than hiding the gap behind plausible-looking opening lines.
Files exceeding 500 lines (`maxFileLinesInBrief`) are truncated with a visible
marker: `… (truncated: 500 of 1234 lines)`.

### 6. The response format

The reviewer formats its response in markdown — bold numbers, bullets,
checkboxes — and the parser (`QueenReviewVerdictRequest.parse`) must see through
the decoration to the number underneath. A response the parser cannot match
leaves the criterion absent, which reads as `.unchecked`. An empty response
retries once; if still empty, the criteria are recorded as "asked but
unanswered" (#1117) so the distinction from "never checked" stays alive.

### 7. The verdict gate

The final link is the verdict gate
(`QueenAcceptancePolicy.acceptanceBlockReason`,
`rings/SR-00/QueenCriterionVerdict.swift`). It merges mechanical verdicts
(criteria that name a file path are settled by what the branch carries) with
recorded verdicts from the reviewer, filling every gap with `.unchecked`. If any
criterion is `.unmet`, acceptance is blocked — unmet criteria are listed first.
If any criterion is `.unchecked` and none are `.unmet`, acceptance is still
blocked: an unchecked criterion is not a pass. Only when the block reason
returns `nil` may the Queen transition the task from `.awaitingReview` to
`.accepted`.

## What the chain has in common

Every link breaks the same way: silently. The criterion does not fail — it stays
`.unchecked`, which reads as "nobody looked" when the chain was the thing that
broke. The fixes all do the same thing: make the gap visible. The marker proves
the brief was sent. The project root proves the files were found. The full file
contents prove the reviewer saw the context. The excerpt notice proves the
excerpt was honest. The parser test proves the response was read. The verdict
gate proves nothing was left unanswered. Each link is now loud where it was
quiet.

## Code references

| Link | Symbol | File |
|------|--------|------|
| Specification | `QueenTaskSpec.render` | `rings/SR-00/QueenTaskSpec.swift` |
| Specification | `DelegatedTask.acceptanceCriteria` | `rings/SR-00/QueenDelegation.swift` |
| Brief | `QueenReviewVerdictRequest.brief` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Brief | `QueenReviewVerdictRequest.adversaryPromptMarker` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Root of paths | `ChatViewModel.fileContentsForReview` | `rings/SR-02/ChatViewModel.swift` |
| Root of paths | `ProjectPaths.root` | — |
| File contents | `ChatViewModel.diffForReview` | `rings/SR-02/ChatViewModel.swift` |
| File contents | `ChatViewModel.fileContentsForReview` | `rings/SR-02/ChatViewModel.swift` |
| Excerpt volume | `ChatViewModel.regionExtractedContent` | `rings/SR-02/ChatViewModel.swift` |
| Excerpt volume | `QueenReviewVerdictRequest.maxFileLinesInBrief` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Response format | `QueenReviewVerdictRequest.parse` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Response format | `runVerdictParserHandlesMarkdownNumbers` | `tests/swift/ChatSSEEndToEndTest.swift` |
| Verdict gate | `QueenAcceptancePolicy.mechanicalVerdicts` | `rings/SR-00/QueenCriterionVerdict.swift` |
| Verdict gate | `QueenAcceptancePolicy.verdicts` | `rings/SR-00/QueenCriterionVerdict.swift` |
| Verdict gate | `QueenAcceptancePolicy.acceptanceBlockReason` | `rings/SR-00/QueenCriterionVerdict.swift` |
