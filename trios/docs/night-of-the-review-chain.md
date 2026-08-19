# Night of the Review Chain

Issue: gHashTag/trios#1130 · Parent: #1090

The review chain has four links — the brief, the root of paths, the
response format, the excerpt volume — and one night run showed all four
breaking the same way: not by returning a wrong answer, but by dropping
the result silently. No criterion failed. Each stayed `.unchecked` and
read as "nobody looked," while the chain itself was the thing that broke.

1. **The brief** — the evidence package sent to the reviewer. Empty,
   wrong, or swapped for a worker's prompt, it leaves the reviewer with
   nothing to judge, indistinguishable from a reviewer who judged and
   said nothing. Proved by `adversaryPromptMarker` (`"adversary-review"`)
   with `isAdversarialBrief` in `rings/SR-00/QueenReviewVerdictRequest.swift`:
   a brief without the marker is discarded before its verdicts are trusted.

2. **The root of paths** — where file paths in the brief resolve from.
   The git toplevel sits one level above the project root; resolving from
   the wrong one left every criterion-named file silently missing, and the
   reviewer answered "could not check" — honest uncertainty wearing the
   face of a path bug. Proved by the comment in `fileContentsForReview`
   (`rings/SR-02/ChatViewModel.swift`) and the explicit `(file not found)`
   marker, which makes a missing file visible instead of swallowed.

3. **The response format** — what the reviewer's answer is expected to
   look like. It answers in markdown (`**1.`, `[x] 1.`, `- 1.`); a parser
   that cannot see through the decoration leaves the criterion absent,
   which reads as `.unchecked`. Proved by
   `runVerdictParserHandlesMarkdownNumbers`
   (`tests/swift/ChatSSEEndToEndTest.swift`), fed a live delegation
   response (#1105): every variant parses, and a decorated line with no
   verdict keyword stays absent — lenience is not guessing.

4. **The excerpt volume** — how much of each file the reviewer reads.
   When region selection found no criteria names, the old behaviour
   substituted the file's opening lines: real-looking context that
   answers nothing, so a criterion about line 800 read as "could not
   check" while the reviewer was shown lines 1–20. Proved by the gap
   notice of #1124, made honest by #1196 (`regionExtractedContent` in
   `rings/SR-02/ChatViewModel.swift`): `(no criteria names found in this
   file; names searched: …)` above a `FILE BEGINS` banner, with `… (N
   lines omitted) …` and `… (truncated: 500 of N lines)` marking every
   other cut.

Four links, one signature: the result fell silently. Every fix does the
same thing — the gap is now said out loud where it used to be quiet.
