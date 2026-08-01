# Reviewer Scope — What a Reviewer Can and Cannot Judge

Issue: gHashTag/trios#1109 · Parent: #1090

## What this document is

A description of what the reviewer agent sees in its brief, and the line
between a criterion it can settle and one it must leave to a human. It
covers the four decisions that shape the brief: the diff is kept, the
full contents of touched files are added after the change, large files
are truncated with a visible marker, and the combination lets the
reviewer reach a verdict on criteria that depend on code the diff never
touched.

It mirrors `QueenReviewVerdictRequest.brief`
(`rings/SR-00/QueenReviewVerdictRequest.swift`), the functions that feed
it — `diffForReview` and `fileContentsForReview`
(`rings/SR-02/ChatViewModel.swift`) — and the parsing logic in
`QueenReviewVerdictRequest.parse`. The companion documents
[`queen-verdicts.md`](queen-verdicts.md) and
[`queen-spec-header.md`](queen-spec-header.md) describe the three verdict
states and the pinned criteria display; this document focuses on one
question: **what evidence does the reviewer receive, and what can it
decide from it?**

## The two questions a review asks

A diff answers one question: *what changed*. It shows the lines added and
the lines removed, and nothing else. That is enough to judge whether the
change does what the criterion asks — but only when the criterion is
about the change itself.

A second question is just as real: *what does the file look like now*. A
criterion may ask about code the change did not touch but that lives in a
file the change did. "The public API is documented" might be satisfied by
a doc comment three lines above the edit — present in the file, absent
from the diff. A reviewer who sees only the diff has no way to confirm
that; "could not check" is the honest answer, but it leaves the criterion
`.unchecked`, and an unchecked criterion blocks acceptance.

The brief carries both: the diff first, then the full contents of every
file in the task's owned paths, read from the working tree after the
commit. The two are separate sections so the reviewer can tell which is
which — "what changed" and "what resulted" are different questions, and
the brief presents them as different sections rather than merging them
into one stream.

## What the reviewer can judge

| Evidence in the brief | What it settles |
|-----------------------|-----------------|
| Diff (added/removed lines) | Whether the change itself does what a criterion asks. |
| Full file contents after change | Whether a criterion is satisfied by code already present in the file — changed or not. |
| Both together | Whether the change fits into the surrounding code, not just whether it is internally correct. |

The third row is the one the full-file contents exist for. Without them,
the reviewer sees the delta and nothing else. A criterion that reads
"every public function has a doc comment" could be met by comments that
were already there — but if the reviewer cannot see them, the verdict is
"could not check", and the criterion stays `.unchecked`. With the full
file in the brief, the reviewer can read the comment, confirm it exists,
and return `.met`.

This is criterion 4 of this issue's specification: a criterion satisfied
by unchanged code inside a touched file can now receive a verdict instead
of defaulting to unchecked. Verification is tracked in #1104.

## What the reviewer cannot judge

The brief is text, not an execution environment. A criterion that
requires running code, building a project, or exercising the UI is beyond
what the reviewer can settle from a diff and file contents:

- "The code compiles without warnings."
- "Tests pass."
- "The UI renders correctly in dark mode."
- "No existing behaviour broke."

The reviewer may form an opinion — "this looks like it should compile" —
but the brief does not contain the output of a build or a test run, and
the reviewer is instructed not to guess. A criterion it is unsure about
should be "could not check", not a silent `.met`. The brief says this
explicitly:

> Say "could not check" if the diff and file contents do not let you
> tell. Do not guess: a criterion you are unsure about is better left to
> a human than silently marked met.

These criteria stay `.unchecked` until the Queen (or a human) records a
verdict through `recordVerdict` after running the actual checks.

## How the brief is built

### The diff

`diffForReview` runs `git diff <baselineTree> -- <ownedPaths>` against
the baseline captured before the worker started. The diff is scoped to
the task's owned paths, not the entire branch, so the reviewer sees what
this task changed — not what other workers changed in parallel. An empty
diff is itself information: the worker changed nothing in its owned
paths, and the reviewer still receives the criteria and the file
contents.

The diff is included verbatim in the brief, inside a ```` ```diff ````
fence. A summary or paraphrase is never substituted: a summary that
rephrases a diff is the same summary that hides the line that fails.

### The file contents

`fileContentsForReview` reads every path in the task's `ownedPaths` from
the working tree after the commit. The working tree — not a git object —
is the source because the diff itself is taken against the working tree:
if the diff is correct, the working tree is the right source for the
content around it.

Files are drawn from `ownedPaths` (the task boundary), not from
`git diff --name-only`. A worker that changed nothing still produced work
— the criteria describe the result, not the delta. If the reviewer saw
only the delta, an empty diff would be an empty brief, and every
criterion would read "could not check". Carrying the owned files means
the reviewer can judge what is there regardless of what moved.

Each file appears under a `### <path>` heading, in a fenced block, sorted
alphabetically by path.

### Truncation

A single file may occupy no more than 500 lines in the brief
(`maxFileLinesInBrief`). Beyond that, the file is cut at the limit and a
marker is appended:

```
… (truncated: 500 of 1234 lines)
```

The marker states how many lines were shown and how many were omitted, so
the reviewer knows the file was truncated rather than ending where the
fence closes. Silent truncation — cutting without a mark — would make a
500-line file look like a 500-line file, and a criterion about something
in line 800 would get a verdict the reviewer could not actually reach.

500 is a ceiling on the *file's* footprint, not on the brief as a whole.
A task that owns three small files gets all three in full; a task that
owns one 2000-line file gets the first 500 lines of it, marked. The
limit exists because a file dumped in full crowds out the diff, the
criteria, and the verdicts the brief exists to collect — not because the
reviewer cannot read a long file.

## What does not change

- **Mechanical verdicts** (`QueenAcceptancePolicy.mechanicalVerdicts`)
  still settle criteria that name a file path — existence is checked by
  what the branch carries, not by what the reviewer reads. The reviewer
  fills the gap: criteria a path check cannot answer.

- **The three-state verdict** is unchanged. The reviewer returns `.met`
  or `.unmet` for criteria it can settle; everything else stays
  `.unchecked`. Adding file contents to the brief expands what the
  reviewer *can* settle, not how the verdict is *recorded*.

- **Parsing** (`QueenReviewVerdictRequest.parse`) is unchanged. The
  reviewer's response is still parsed conservatively: a garbled or
  inconclusive answer leaves a criterion absent from the result, which
  reads as `.unchecked`. More evidence in the brief does not loosen the
  parser.

## Code references

| Symbol | File | Role |
|--------|------|------|
| `QueenReviewVerdictRequest.brief` | `rings/SR-00/QueenReviewVerdictRequest.swift` | Builds the brief: criteria table, diff, full file contents, truncation marker. |
| `QueenReviewVerdictRequest.maxFileLinesInBrief` | `rings/SR-00/QueenReviewVerdictRequest.swift` | 500-line ceiling per file. Beyond it, the file is truncated with a visible marker. |
| `QueenReviewVerdictRequest.parse` | `rings/SR-00/QueenReviewVerdictRequest.swift` | Parses the reviewer's response into per-criterion verdicts. Conservative: unrecognised answers stay absent. |
| `ChatViewModel.diffForReview` | `rings/SR-02/ChatViewModel.swift` | Runs `git diff <baseline> -- <ownedPaths>`. Scoped to owned paths. |
| `ChatViewModel.fileContentsForReview` | `rings/SR-02/ChatViewModel.swift` | Reads owned files from the working tree after the commit. Source of the "what it looks like now" evidence. |
| `ChatViewModel.requestReviewerVerdicts` | `rings/SR-02/ChatViewModel.swift` | Calls `brief`, sends it to the reviewer agent, stores the raw response. |
| `QueenCriterionVerdict` | `rings/SR-00/QueenCriterionVerdict.swift` | The three-state enum: `.met`, `.unmet`, `.unchecked`. |
| `QueenAcceptancePolicy.mechanicalVerdicts` | `rings/SR-00/QueenCriterionVerdict.swift` | Auto-verdict for path-naming criteria. Runs before the reviewer; the reviewer covers what it cannot. |
