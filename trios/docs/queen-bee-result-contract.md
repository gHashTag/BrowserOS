# The bee result contract, and what a bee actually returns

Section 11.3 of `docs/architecture/Queen_T27_MVP_Architecture.md` (the section
begins at line 1311 of that file) defines what a finished bee owes the Queen:
a structured result carrying twelve fields. What a bee actually returns today
is a markdown `## VERDICT` block - one bullet line per acceptance criterion,
each line a criterion text and a verdict word. This document writes down the
distance between those two things, field by field, so the gap can be
implemented from, argued with, or rejected on its merits - but no longer
ignored because nobody wrote it down.

It describes the gap; it does not close it. There is no schema, no migration,
and no source code here, by design.

## What section 11.3 asks for

Reproduced verbatim from `docs/architecture/Queen_T27_MVP_Architecture.md`
section 11.3, so that a reader of this document never has to open the
architecture document to know what is being asked for:

```json
{
  "task_id": "...",
  "status": "completed",
  "base_commit": "...",
  "result_commit": "...",
  "changed_specs": [],
  "changed_compiler_files": [],
  "generated_artifacts": [],
  "tests_added": [],
  "commands_run": [],
  "evidence_manifest": "...",
  "known_risks": [],
  "human_decisions_required": []
}
```

The section closes with one more sentence: "A prose summary may accompany it
but cannot replace it."

## Where the gap is recorded

The entire written record of this gap is a single bullet. Section 2.2.7 of the
same architecture file, "Current Queen gaps relative to the T27 vision", has
its heading at line 303, and its second gap, at line 306, reads verbatim:

> 2. **Worker completion can still be conversational rather than artifact-contract based.**

When the issue that asked for this document was filed, no other document in
`docs/` mentioned the contract's fields:
`grep -rln "evidence_manifest\|result_commit\|artifact contract" docs/`
returned only the architecture file itself. It returns this document too
now - because this document names the fields, which is the whole change the
issue asked for. Nobody can implement a contract from a bullet, nobody can
argue against one, and the specific failures the missing fields would catch
stay invisible until they bite. This document exists so the first two of
those become possible.

## What the code does today

Six anchors. Each is stated with the one fact it establishes.

- `agent-server/apps/server/src/api/services/queen-tick.ts:1084` - the brief
  the tick dictates to the bee ends by telling it exactly what to write: a
  literal `## VERDICT` header, followed by one bullet per criterion, each
  ending in `met`, `unmet`, or `could-not-check`. That header and those
  bullets are the whole report format. The brief asks for no structured
  result of any kind.
- `agent-server/apps/server/src/api/services/queen-tick.ts:1330` -
  `parseVerdictBlock`, the function that reads the bee's block back. Its
  return type is `Array<{ criterion: string; met: boolean }>` and nothing
  else: a criterion text and a boolean per line. Note that
  `could-not-check` is folded into `met: false`, so even the verdict word
  survives only as a bit.
- `agent-server/apps/server/src/api/services/queen-tick.ts:1290` - the
  `kind: 'review'` question the review sends to the acceptance policy, and
  the four values sent with it (named in the next section).
- `agent-server/apps/server/src/api/services/queen-dispatch.ts:292` -
  `committedFiles` runs `git diff --name-only` with its base resolved at
  review time from `process.env.TRIOS_REPO_REF || 'origin/dev'` - a moving
  ref, read when the review happens rather than recorded when the bee
  started.
- `agent-server/queen-core/Sources/QueenCore/QueenReviewDecision.swift:50` -
  `decide`, the acceptance policy. Its parameter list - verdicts,
  totalCriteria, committedFiles, priorSendBacks - is the whole of what the
  policy can see. Nothing outside that list reaches the decision.
- `agent-server/queen-core/Sources/queend/main.swift:44` - the decoded
  question fields on the Swift side. The wire format has a slot for each of
  the four review values and for nothing else: no task identity, no commit
  hash, no file names, no commands, no evidence, and no risks can cross from
  the TypeScript side, because the decoder has nowhere to put them.

## The four values that reach the acceptance policy

From `queen-tick.ts:1290-1294`, the review question carries exactly four
values:

- `verdicts` - each parsed line, already reduced to `criterion` and `met`.
- `totalCriteria` - a count: the larger of the criteria the dispatch row
  promised and the lines the bee actually answered.
- `committedFiles` - a count, not the list of names. The names were computed
  - the same diff feeds the boundary check - but only `.length` crosses
  into the question, so no field-level provenance survives the call: the
  policy can see how many files changed, never which.
- `priorSendBacks` - the dispatch row's count of earlier returns.

Twelve fields in the contract; four values on the wire; and not one of the
four is any of the twelve.

## The score

How many of the twelve fields appear in the report the brief instructs the
bee to produce: `0 of 12`. Measured against the brief itself, whose builder
is the `briefFor` function:

```sh
sed -n '/export function briefFor/,/^}/p' agent-server/apps/server/src/api/services/queen-tick.ts \
  | grep -oE '\b(task_id|status|base_commit|result_commit|changed_specs|changed_compiler_files|generated_artifacts|tests_added|commands_run|evidence_manifest|known_risks|human_decisions_required)\b' \
  | sort -u | wc -l
```

prints `0`. The same field-name grep over section 11.3 of the architecture
document prints `12`. The distance between those two numbers is the subject
of the rest of this document.

## The twelve fields, one by one

In the order the 11.3 JSON lists them. Each section answers the same three
questions: does the report the bee is instructed to write carry the field;
does anything on the server side reconstruct it, and from what; and one
concrete failure - an event that can occur in this system - that the field
would have caught.

### `task_id`

Not carried: the `## VERDICT` block the brief dictates contains criterion
bullets and nothing else, so the report never says which task it reports on.
Reconstructed positionally: the review attributes whatever block it finds to
the issue on the dispatch row, because it found the block in that dispatch's
conversation transcript. Failure it would have caught: `parseVerdictBlock`
takes the last `## VERDICT` in the whole conversation, so anything containing
that header which appears after the bee's genuine block - a quoted verdict
from another issue's brief, pasted into the final message while explaining
something to the operator - becomes the block that is parsed, and its
criteria are counted and judged as this task's answers. A block required to
open with the task it answers gives the review a check to fail: a verdict
that does not claim the dispatch under review is refused instead of graded.

### `status`

Not carried: the block has per-criterion verdict words but no overall
declaration by the bee that the task is done, blocked, or partial.
Reconstructed from two places that are not the bee: the runner writes
`finished_at` and an `outcome` string when the stream ends - and the review
reads neither, excluding only outcomes beginning with `reaped` - and the
policy derives a review state (`accept`, `sendBack`, `wait`, `escalate`)
afterwards. Failure it would have caught: a stream that ends badly, or on a
quota stop, closes the dispatch with no verdict block in the final message;
zero parsed verdicts against a positive `totalCriteria` makes the policy
answer `wait`, `review_state` is written as `wait`, and because the reviewer
only ever looks at dispatches whose `review_state` is null, that dispatch is
never examined again: not sent back, not escalated, the issue held by work
that already stopped. A declared status - `blocked`, `incomplete` - is a
value the review could act on instead of waiting on one that can never
arrive.

### `base_commit`

Not carried: nothing in the bee's report names the commit it started from.
Reconstructed never: no base is recorded anywhere; `committedFiles` resolves
its base at review time from a moving ref (`queen-dispatch.ts:292`), so if
`origin/dev` advances between dispatch and review, the diff includes commits
the bee never made, `boundaryStrays` at `queen-tick.ts:1182` compares those
foreign paths against the bee's boundary, and the Queen records a stray
against a worker that stayed inside its boundary. A recorded `base_commit`
makes that diff reproducible and the accusation impossible.

### `result_commit`

Not carried: the block names no commit, and the bee's job ends at a commit on
its own branch that it is told not to push. Reconstructed never: no commit
hash is captured anywhere in the dispatch or review path - the review diffs
the branch ref live at review time, and the dispatch row stores the branch
name, the review state, the note, and the strays, but no SHA. Failure it
would have caught: after `accept` releases the issue, the work leaves this
machine as a patch replayed by the operator, and any later re-dispatch of the
same issue re-creates `queen-${issue}` from base with `git worktree add -B`,
replacing the branch that was accepted with a different commit under the same
name; nothing in the record can tell which commit the acceptance judged, so
the accepted diff cannot be reproduced or audited after the fact. A recorded
`result_commit` pins what was judged to what was accepted.

### `changed_specs`

Not carried: the report says nothing about which files it touched.
Reconstructed only as an undifferentiated path list: `committedFiles`
returns the changed paths, but nothing classifies them - the names are
compared against the boundary and then discarded at `.length` when the
question is built. Failure it would have caught: section 11.4 puts language
semantic changes on the high-risk list that requires human review, but a bee
whose boundary includes the spec directory can rewrite a `.t27` semantic
spec, mark every criterion `met`, and be accepted by a policy that sees only
a positive file count - a high-risk semantic change auto-accepted with no
signal anywhere that semantics moved. A `changed_specs` list names the spec
delta and gives the escalate arm something to trigger on.

### `changed_compiler_files`

Not carried, and reconstructed no further than the raw path list: the diff
names are never classified as compiler sources, IR, backend, or anything
else, so no consumer can ask "did this task touch the compiler?" and get an
answer. Failure it would have caught: section 11.4 lists IR schema changes
as high-risk requiring a person; a bee edits IR schema sources inside its
boundary alongside its assigned work, answers every criterion `met`, and the
policy accepts on file count alone - the schema change is invisible to every
check the acceptance policy runs. A `changed_compiler_files` list makes the
compiler surface of a task a fact the policy can read rather than a fact
nobody recorded.

### `generated_artifacts`

Not carried: the report never enumerates what the task was supposed to
generate. Reconstructed never: the diff lists paths but cannot tell a
generated artifact from a hand-written file, and nothing checks that a
deliverable exists or is readable. Failure it would have caught: a task whose
deliverable is a generated artifact - a report, a vector set - is accepted on
the strength of `committedFiles` being greater than zero, a count satisfied
by any file at all, such as the bee's own notes; the artifact was never
committed, exists only in a container that is discarded, and the acceptance
stands. A `generated_artifacts` list names the promised deliverables, and an
acceptance whose named artifacts are absent from the diff is visible as the
contradiction it is.

### `tests_added`

Not carried: the report says nothing about tests. Reconstructed never: the
diff names are not classified, so there is no count of test files anywhere in
the review path, and the policy's only structural check is that the file
count is nonzero. Failure it would have caught: a criterion of the form
"adds a regression test for X" is answered `met`; the fix alone satisfies
`committedFiles > 0`; the acceptance records nothing about any test; and a
fix merged with zero tests is indistinguishable, in everything the Queen
writes down, from one merged with them. A `tests_added` list - including an
empty one against a criterion that promised tests - is exactly the
distinction the record cannot make today.

### `commands_run`

Not carried. This is the field with no reconstruction of any kind: no shell
history, no command log, no captured output crosses from the bee's container
to the review - the four-value question has no slot for it, and nothing on
the server side re-runs or re-checks anything the bee claims to have run.
What follows: an acceptance criterion of the form "`bun run typecheck`
reports 0 errors" is settled by the bee writing the word `met`, and nothing
downstream can distinguish a criterion that was executed from one that was
asserted. Failure it would have caught: a type error introduced by the task
is shipped behind an acceptance whose only evidence for "0 errors" is the
bee's own word, and the first machine to run the command is the one that
discovers the lie - after the issue is released.

### `evidence_manifest`

Not carried: the report names no evidence. Reconstructed never: the dispatch
row stores a review note and the boundary strays, but no manifest is ever
produced, so section 11.4's "no unexplained manifest drift" has no manifest
to drift and its "evidence artifacts are readable" has no artifact to open.
Failure it would have caught: a criterion of the form "the screenshot is
saved at path X" or "the output file exists at Y" is met by assertion; the
policy cannot fail on unreadable evidence because no evidence is ever named;
and the accept stands even when the named file was never created - nothing
downstream re-opens the file, because nothing downstream knows its path. An
`evidence_manifest` gives every assertion a path to check and the acceptance
a reason to refuse one it cannot read.

### `known_risks`

Not carried: the brief gives the bee no structured place to declare a risk,
so anything it knows goes into prose. Reconstructed never: prose outside the
`## VERDICT` block is discarded - `parseVerdictBlock` stops at the block,
nothing else reads the transcript, and the review note that survives holds
only the policy's own reason string. Failure it would have caught: a bee
discovers mid-task that its fix only works behind a flag, says so in its
final message above the block, marks every criterion `met`, and is accepted;
the risk the bee wrote down is carried nowhere - not into the review note,
not into any record the release process reads - and the release inherits a
risk that was known, stated, and dropped. A `known_risks` list puts what the
bee knows into the result the Queen judges and the operator harvests.

### `human_decisions_required`

Not carried: the bee never declares that a person must choose.
Reconstructed only from the Queen's side of the table: `decide` can return
`escalate`, but only on its own rules - no acceptance criteria at all, every
criterion `met` against an empty diff, or the send-back count exhausted.
Human involvement is summoned by policy arithmetic, never reported by the
worker. Failure it would have caught: a bee that hits a genuine fork needing
a human choice - two valid implementations, or a criterion it cannot check
without credentials it does not hold - writes `could-not-check`, which
`parseVerdictBlock` folds into `met: false`; the policy sees an ordinary
unmet criterion and sends the task back for another pass instead of to a
person, one of the two allowed send-backs is spent, and the next pass cannot
resolve the fork either. A `human_decisions_required` list routes the
decision to a person on the first pass rather than the third.

## Finding these anchors in any tree

The line numbers cited above were fixed when this document was written, and
the files move. To check any anchor in a tree of any age, locate the symbol
instead of trusting the number:

```sh
grep -n "'## VERDICT'," agent-server/apps/server/src/api/services/queen-tick.ts
grep -n "kind: 'review'" agent-server/apps/server/src/api/services/queen-tick.ts
grep -n "export function parseVerdictBlock" agent-server/apps/server/src/api/services/queen-tick.ts
grep -n "TRIOS_REPO_REF" agent-server/apps/server/src/api/services/queen-dispatch.ts
grep -n "public static func decide(" agent-server/queen-core/Sources/QueenCore/QueenReviewDecision.swift
grep -n "let verdicts:" agent-server/queen-core/Sources/queend/main.swift
```

## What this document does not do

It does not close the gap. The twelve fields above are described so that the
next person can write the contract - in the brief, in the parser, on the
wire, in the policy, or in the record - knowing exactly what each field buys
and what its absence already costs. Closing it is a separate piece of work
with a separate review; this is the argument for doing that work, and the
specification to do it against.
