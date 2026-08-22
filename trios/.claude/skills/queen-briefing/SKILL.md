---
name: queen-briefing
description: Write an issue a bee can actually pass. Use before filing any issue the Queen will delegate, when a bee "fails" criteria it could not reach, when a well-formed issue is never chosen, and when reviewing a task that came back with met criteria and unfinished work. Carries the boundary rule, the four measured instances that taught it, and the checklist.
---

# Writing a brief a bee can pass

A delegated issue is a contract with three parts that must agree: what to
change (the boundary), what makes it done (the criteria), and what proves it
(the run). When they disagree the bee cannot win, and its failure reads as the
bee's fault.

## The boundary rule

**Every file the criteria require must be inside the boundary.**

Not "most of them". A criterion naming work outside the boundary is a
criterion the bee is forbidden to satisfy: work outside the boundary is
dropped, not reviewed, so the honest bee reports the criterion unmet and
looks incompetent, while a dishonest one edits out of bounds and has the
work discarded silently.

Measured on 2026-08-23, both mine:

| Issue | Boundary I wrote | What the criteria demanded | Result |
|---|---|---|---|
| #1287 | `rings/SR-02/ChatViewModel.swift` | "a logic suite asserts…" - suites live in `tests/swift/` | The bee put its suite INSIDE ChatViewModel, the only file it was allowed to write |
| #1288 | `BR-OUTPUT/GitHubAPIClient.swift` | the poller's message, the drill, a logic suite - three other files | Four of five criteria unreachable; the bee's own change was exact and it still came back 1/5 |

Both bees did the reachable part correctly. Both looked like failures. The
review had to finish the work, and the second issue had to say so in its
closing comment, because a record that blames a bee for a boundary its author
drew is a record that lies.

## Criteria that make the issue invisible

The Queen skips a candidate as "looks already done" when every identifier
named in its criteria is present in its boundary files. For a **fix**, those
identifiers exist *because the defect exists* - `fetchPullRequest` is named by
#1288 precisely because that function loses the status - so the issue reads as
done before anyone touches it. Eight of seventeen candidates were dismissed
that way on 2026-08-23.

The heuristic is now gated on evidence that postdates the issue (a boundary
file with no commits since it was filed cannot hold its fix), which removes
most of it. What remains is on the author:

- Name the **new** thing in at least one criterion - the function that does
  not exist yet, the event that is not emitted yet. That is what "done" adds.
- Do not restate the defect's identifiers as if their presence were the goal.

## "Proven by a run" needs a place to put the run

A criterion of the form *proven by a run, quoted in the pull request* is the
strongest one this repository writes, and it requires the bee to be able to
WRITE the drill. That means the file holding the drill is in the boundary.
`#1151`, `#1170` and `#1172` each did this well - their drills sit in the file
they were allowed to edit, gated by `TRIOS_E2E_DRILL_<N>=1`, and a reviewer
can run them from the bee's own worktree:

```bash
cd .worktrees/<variant>/queen-<N>/trios
DEVELOPER_DIR=/Library/Developer/CommandLineTools TRINITY_ROOT=~/trinity make test-app
open --env TRIOS_E2E_DRILL_<N>=1 --env TRIOS_E2E_DISABLE_KEYCHAIN=1 trios-test.app
```

A drill that compares against a **committed fact-record** is stronger still:
change the behaviour without updating the record and `record_matches_committed`
fails, so a stale proof cannot pass quietly. Ask for that when the criterion
is about a message's exact wording.

## The checklist

Before filing, answer these in one line each:

1. **Every file the criteria touch - is it in the boundary?** List them. Code,
   test, drill, and the file that emits the message.
2. **Does at least one criterion name something that does not exist yet?**
   If not, the Queen may never choose the issue.
3. **Can the bee produce the proof, or am I asking for a run only I can do?**
   If only the operator can produce it (a live outage, a forge state), say so
   in the issue and do not make it a criterion.
4. **Is every criterion checkable by counting or reading, rather than by
   judgement?** "Not less than three hundred characters" is checkable.
   "Improve the documentation" is a wish. A criterion the model must judge is
   a criterion that will be judged wrongly at least once - #1151 exists
   because a 2,225-byte file was ruled short of three hundred.
5. **Is it in English?** L3. Every issue written after 2026-08-19 is.

## When a bee comes back short

Read the diff before the verdict. Three outcomes, and only one is the bee's
fault:

- **Reachable and undone** - send it back, naming the missing criterion.
- **Unreachable from its boundary** - finish it at review time, on the bee's
  own branch so the pull request carries the whole change, and say in the
  issue that the briefing was wrong. The bee's part still merges under its
  own commit.
- **Done and mis-judged** - the reviewer's verdict is a fossil; run the proof
  yourself and record the measured verdict. `/verify <issue> <criterion> met`
  takes the criterion text verbatim, spaces and all, with the verdict last.
