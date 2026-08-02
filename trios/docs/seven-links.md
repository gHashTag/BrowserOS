# Seven Links — The Review Chain and Where It Broke

Issue: gHashTag/trios#1134 · Parent: #1090

## What this document is

The review chain runs from the Queen's specification to the reviewer's
verdict to the gate's decision. Seven links in that chain broke during the
build of the delegation system — each one silently, each one reading as
"the work is not good enough" when the chain itself was the thing that
failed. This document names all seven, describes how each broke, how each
was repaired, and names the eighth that was found at the end of the road.

The companion document
[`night-of-the-review-chain.md`](night-of-the-review-chain.md) covers the
first four in greater depth; this document stands on its own as the full
account.

## The pattern

Every link breaks the same way: the question never reaches the judge, or
the answer never reaches the gate. The criterion does not fail — it stays
`.unchecked`, which reads as "nobody looked" when the chain was the thing
that broke. A confident wrong answer is worse than silence, because it
looks exactly like the gate working.

## The seven links

### 1. The brief — files the criteria name never arrive

The brief is the evidence package sent to the reviewer: criteria, diff,
and the full contents of touched files. When the brief did not carry the
files a criterion names, a task whose owned path was a test file but whose
contract was about the application could not be judged (#1119). The
reviewer had nothing to read, so the verdict read "could not check" —
honest uncertainty masking a missing payload.

**Repaired** by `fileContentsForReview` reading every path in the task's
`ownedPaths` from the working tree, not just the files the diff touched.
The `adversaryPromptMarker` (`"adversary-review"`,
`rings/SR-00/QueenReviewVerdictRequest.swift`) proves the brief that
reached the reviewer is the brief this chain built — a worker's prompt
carries no marker, so a swapped brief fails `isAdversarialBrief` and the
verdicts are discarded.

### 2. The root of paths — resolution against the wrong directory

`fileContentsForReview` resolved every file path against the git root —
the repository toplevel — rather than `ProjectPaths.root`, the project
directory. For this project the git root sits one level above the project
directory, so every criterion-named file was silently missing. The miss
was swallowed by a `fileExists` guard that dropped the file instead of
reporting it as absent (#1121).

**Repaired** by resolving from `ProjectPaths.root`. A file that does not
exist on the working tree is now included with an explicit
`(file not found)` marker rather than dropped, so the gap is visible to
the reviewer instead of swallowed.

### 3. The response format — the parser cannot read what the reviewer wrote

The reviewer formats its response in markdown — bold numbers (`**1.`),
bullets (`- 1.`), checkboxes (`[x] 1.`) — and the parser had to see
through the decoration to the number underneath. A response the parser
could not match left the criterion absent, which read as `.unchecked`
(#1122). The parser's own comment listed bare and checkbox variants but
never markdown.

**Repaired** by `runVerdictParserHandlesMarkdownNumbers`
(`tests/swift/ChatSSEEndToEndTest.swift`), which feeds a real reviewer
response and asserts all verdicts parse. Each decoration variant is
recognised; a decorated line with no verdict keyword stays absent —
lenience to decoration must not become a willingness to guess.

### 4. The excerpt that follows the diff, not the criteria

`ChatViewModel.swift` is over five thousand lines, and the brief carried
its first 500. A criterion about behaviour below the declarations read
"could not check" because the reviewer was shown lines 1–500 and the
criterion was about line 800 (#1123).

**Repaired** by `regionExtractedContent` narrowing each file to regions
around names the criteria mention. When the region selection finds
nothing, the excerpt says so rather than hiding the gap behind the file's
opening lines.

### 5. The excerpt on an empty diff — re-review shows the wrong lines

The region extraction in link 4 worked when there was a diff, but fell
back to the first 500 lines when there was not. A re-review of finished
work is always an empty diff, which is exactly the case the fallback
ruins: the criteria are about the implementation, and the first 500 lines
are the declarations (#1124).

**Repaired** by the same `regionExtractedContent` path covering the
no-diff case. When no criteria names are found in a file, the excerpt
prints an explicit notice:

```
(none of the criteria names found in this file — looked for: ChatViewModel, fileContentsForReview)
```

The truncation marker (`… (truncated: 500 of 1234 lines)`) was added in
the same pass, so the reviewer always knows whether a file ended or was
cut.

### 6. The phantom deletion — a stale baseline turns a file into a removal

On an empty branch the diff was taken against a baseline captured after
an earlier run's work, so a file sitting on disk arrived at the reviewer
as `deleted file mode 100644` — 119 lines removed. The reviewer answered
"unmet" twice, and it was right about the document it was given. A
confident wrong "no" is worse than silence: it looks exactly like the gate
working (#1132).

**Repaired** by an empty branch having nothing to compare and saying so,
instead of presenting a file that exists as removed.

### 7. The premature verdict — the gate decides before the evidence arrives

The log order was flat:

```
15:15:58  Review command applied
15:16:04  Reviewer returned 2 verdict(s) for 2 criterion(s)
```

Acceptance decided six seconds before the evidence existed and never came
back to it. Six links damaged the question; this one does not wait for
the answer. Everything that read as "the gate refuses" was, at the last
step, a gate that had already refused before anyone spoke (#1133).

**Repaired** by acceptance waiting for its evidence: verdicts are
recorded, then the decision follows, and the log order reflects the
causal order.

## The eighth link

The proposal carried 2,010 files. The base branch pointed at the remote
default so the Queen would stop merging into the branch a person was
working on, but a bee's branch was cut from that working branch — a night
of commits ahead of `dev`. The diff against `dev` was the night, not the
bee. Both extremes were wrong: the current branch merges into somebody's
work; the default branch proposes everything. The answer is the point the
bee's branch was cut from (#1135).

Found by finally reaching the end of the road — the first task to go the
whole way from delegate to merge since #1102.

## What the chain has in common

Every link was invisible until the step before it worked. Every one broke
silently: the criterion stayed `.unchecked` or received a confident wrong
answer, and the failure read as honest judgement rather than a broken
pipe. The fixes all do the same thing — make the gap visible. The marker
proves the brief was sent. The project root proves the files were found.
The parser test proves the response was read. The region extraction proves
the excerpt was honest. The empty-diff notice proves the right lines were
shown. The empty-branch comparison proves nothing was invented. The
causal ordering proves the gate waited for its evidence. Each link is now
loud where it was quiet.

## Code references

| Link | Symbol | File |
|------|--------|------|
| 1. Brief | `QueenReviewVerdictRequest.adversaryPromptMarker` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| 1. Brief | `QueenReviewVerdictRequest.isAdversarialBrief` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| 1. Brief | `ChatViewModel.fileContentsForReview` | `rings/SR-02/ChatViewModel.swift` |
| 2. Root of paths | `ChatViewModel.fileContentsForReview` | `rings/SR-02/ChatViewModel.swift` |
| 2. Root of paths | `ProjectPaths.root` | — |
| 3. Response format | `QueenReviewVerdictRequest.parse` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| 3. Response format | `runVerdictParserHandlesMarkdownNumbers` | `tests/swift/ChatSSEEndToEndTest.swift` |
| 4. Excerpt (diff) | `ChatViewModel.regionExtractedContent` | `rings/SR-02/ChatViewModel.swift` |
| 5. Excerpt (empty diff) | `ChatViewModel.regionExtractedContent` | `rings/SR-02/ChatViewModel.swift` |
| 5. Excerpt (empty diff) | `QueenReviewVerdictRequest.maxFileLinesInBrief` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| 7. Premature verdict | Review pipeline ordering | `rings/SR-02/ChatViewModel.swift` |
