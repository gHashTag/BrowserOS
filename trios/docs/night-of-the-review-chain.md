# Night of the Review Chain — Four Links That Silently Dropped the Verdict

Issue: gHashTag/trios#1130 · Parent: #1090

## What this document is

A short record of the four links in the review chain, each of which
could silently drop a verdict — not by returning the wrong answer, but by
ensuring the reviewer was never in a position to give one. The chain runs
from the brief that carries the evidence, through the root that resolves
the paths inside it, through the format the response is expected in, to
the volume of each file excerpt the reviewer actually reads. Every link
broke the same way: the criterion did not fail, it stayed `.unchecked`,
which reads as "nobody looked" when the chain itself was the thing that
broke.

## The four links

### 1. The brief

The brief is the evidence package sent to the reviewer agent: criteria,
diff, and the full contents of touched files. If the brief is empty,
wrong, or swapped for a worker's prompt, the reviewer has nothing to
judge — but the system cannot distinguish "the reviewer judged and said
nothing" from "the reviewer was never given the case."

**Proved by** the adversarial prompt marker.
`QueenReviewVerdictRequest.adversaryPromptMarker` (`"adversary-review"`,
`rings/SR-00/QueenReviewVerdictRequest.swift`) is embedded in every
reviewer brief, and `isAdversarialBrief` checks for it before the
response is trusted. If the brief were replaced with a worker's prompt —
which carries no marker — the check fails and the verdicts are discarded.
The marker is the link that says the brief that reached the reviewer is
the brief this chain built.

### 2. The root of paths

`fileContentsForReview` resolves every file path against `ProjectPaths.root`
— the project directory — not the git toplevel. For this project the git
root sits one level above the project directory, and resolving from the
wrong root meant every criterion-named file was silently missing. The
reviewer received an empty set of files, read the criteria against
nothing, and returned "could not check" — which looked like honest
uncertainty rather than a path resolution bug.

**Proved by** the root itself. The comment in `fileContentsForReview`
(`rings/SR-02/ChatViewModel.swift`) names the failure and the fix:

> Resolving from the project root means the files are actually found;
> resolving from the git root left every criterion-named file missing
> and the reviewer with nothing to read.

A file that does not exist on the working tree is now included with an
explicit `(file not found)` marker rather than dropped, so the gap is
visible to the reviewer instead of swallowed.

### 3. The response format

The reviewer formats its response in markdown — bold numbers (`**1.`),
bullets (`- 1.`), checkboxes (`[x] 1.`) — and the parser must see
through the decoration to the number underneath. A response the parser
cannot match leaves the criterion absent, which reads as `.unchecked`.
An empty response retries once; if still empty, the criteria are recorded
as "asked but unanswered" so the distinction from "never checked" stays
alive (#1117).

**Proved by** `runVerdictParserHandlesMarkdownNumbers`
(`tests/swift/ChatSSEEndToEndTest.swift`). It feeds a real reviewer
response captured from a live delegation (#1105) and asserts all four
verdicts parse. It then proves each decoration variant (`**1.`,
`[x] 1.`, `- 1.`) is recognised, and that a decorated line with no
verdict keyword stays absent — lenience to decoration must not become a
willingness to guess.

### 4. The excerpt volume

A large file sent in full crowds the brief and pushes the criteria below
a wall of code. `regionExtractedContent` narrows each file to regions
around names the criteria mention. When the region selection finds
nothing — no criteria name appears in the file — the old behaviour was to
substitute the file's opening lines, which look like relevant context but
are not. A criterion about line 800 reads as "could not check" when the
reviewer was shown lines 1–20.

**Proved by** the explicit notice (#1124). When no criteria names are
found in a file, the excerpt says so rather than hiding the gap behind a
plausible-looking excerpt:

```
(none of the criteria names found in this file — looked for: ChatViewModel, fileContentsForReview)
```

The same principle applies to the truncation marker in
`QueenReviewVerdictRequest.brief`: a file that exceeds 500 lines is cut
with `… (truncated: 500 of 1234 lines)` so the reviewer knows it was
truncated, not finished.

## What the chain has in common

Every link breaks the same way: silently. The criterion does not fail —
it stays `.unchecked`, which reads as "nobody looked" when the chain was
the thing that broke. The fixes all do the same thing: make the gap
visible. The marker proves the brief was sent. The project root proves
the files were found. The parser test proves the response was read. The
notice proves the excerpt was honest. Each link is now loud where it was
quiet.

## Code references

| Link | Symbol | File |
|------|--------|------|
| Brief | `QueenReviewVerdictRequest.adversaryPromptMarker` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Brief | `QueenReviewVerdictRequest.isAdversarialBrief` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Root of paths | `ChatViewModel.fileContentsForReview` | `rings/SR-02/ChatViewModel.swift` |
| Root of paths | `ProjectPaths.root` | — |
| Response format | `QueenReviewVerdictRequest.parse` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
| Response format | `runVerdictParserHandlesMarkdownNumbers` | `tests/swift/ChatSSEEndToEndTest.swift` |
| Excerpt volume | `ChatViewModel.regionExtractedContent` | `rings/SR-02/ChatViewModel.swift` |
| Excerpt volume | `QueenReviewVerdictRequest.maxFileLinesInBrief` | `rings/SR-00/QueenReviewVerdictRequest.swift` |
