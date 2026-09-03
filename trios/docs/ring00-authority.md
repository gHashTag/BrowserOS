# Ring 00 Authority - When the Generated Ring Decides

Issue: gHashTag/trios#1331

## What this document is

The definition of the flip for RING-00: the point at which the capacity
question is answered by the generated Rust ring instead of by Swift, what
evidence must be recorded before that flip is allowed, what the round does
when the two disagree after it, and what removing the Swift implementation
would require. It changes no code. It is the contract the change will be
judged against.

The law it serves is written down in `.claude/skills/t27-backend/SKILL.md`:
a rule written once in T27 and generated into four targets is one rule,
while a rule transcribed into Swift, Rust, Zig and Verilog is four rules
that agree until someone edits one of them. And a ring is not started until
the one inside it runs in production. T27-02 - orchestration, the Queen's
own tick - cannot begin until T27-00 runs. "Runs" has to mean "decides",
or the law is satisfied by any ring that is merely executed, and the trunk
grows hollow from the inside out.

This document exists to give that word its meaning.

## Where it stands, measured 2026-09-03

- `rings/T27-00/queen_core.t27` generates
  `rings/T27-00/generated/queen_core.rs`: 121 lines, 7 rules, 21 constants.
- `tests/t27/ring00_parity.sh` runs the fixed input table through the
  generated Rust and the Swift policy: 14 function rows and 21 constant
  rows, every answer equal. Capacity has rows in neither table. The script
  checks that `can_start_another` and `free_slots` are declared and pins
  `MAX_CONCURRENT_WORKERS`, but the live capacity inputs are other
  scenarios' rows by the script's own header, so the production round is
  the first place capacity answers are compared at all.
- `t27core`, built from that generated Rust, is in the image and answered
  `can_start_another=true / free_slots=1` inside the container.
- The round asks both implementations every deciding round and compares
  the answers. This comparison is the cross-check.
- The Swift answer is the one acted on, every time.

## RING-00 does not decide anything

This must be said first, because the pipeline around it is real and green
and it is easy to read green as authority. The ring is executed, it
answers, its answer is compared - and the comparison is filed next to a
dispatch that was decided by Swift. Every deciding round. RING-00 does not
decide anything today. It is a check with no authority, which is the exact
mirror of what it is supposed to become: an authority with a check.

Until it decides, every rule it holds is also held in Swift.
`can_start_another` exists twice in the tree right now - at
`rings/T27-00/queen_core.t27` and at
`rings/SR-00/QueenDelegation.swift:472` - and two implementations of one
rule are what L0 exists to prevent. They agree today. The law was written
because agreement is the state from which they start to disagree.

## The flip

The flip is a deliberate change to the round: the commit that changes which
answer is read for the capacity question.

Before the flip, the round asks `queend` (Swift) and `t27core` (the ring)
every deciding round, records both answers and the comparison, and acts on
the Swift answer. The ring is the check.

After the flip, the round asks both every deciding round, records both
answers and the comparison, and acts on the ring's answer. Swift becomes
the check.

Three properties of the flip, all load-bearing:

1. **The comparison never stops.** The flip moves authority; it does not
   retire the cross-check. The day the comparison stops is the day the
   rule is back to one implementation, and nobody would know.
2. **The flip is a commit, not a toggle.** The threshold below makes the
   flip allowed; it does not perform it. An automatic flip is a runtime
   preference decided by a counter, which is the disease this document
   exists to prevent, wearing a stopwatch.
3. **The flip is recorded.** The commit message carries the evidence
   summary at the moment of the flip: the length of the agreement streak,
   the span it covered, the boundary rounds it contained, and the date of
   the last disagreement.

## The evidence required before the flip

A **deciding round** is a round in which the capacity question is asked
with intent to act on the answer. A diagnostic round is not a deciding
round.

A **cross-check round** is a deciding round in which both implementations
were asked, both answered, and both answers were recorded beside the input
they were given. The input is one integer - the running worker count as
the round itself computes it - handed identically to both sides. Feeding
the two implementations different numbers is not a cross-check; it is two
unrelated questions.

An **agreement** is a cross-check round in which the two answers are equal
on every question the ring answers for capacity: `can_start_another` and
`free_slots` both.

The threshold for the flip:

- **100 consecutive cross-check agreements**, and
- spanning **at least 14 calendar days** from the first to the last, and
- including **at least one agreement at `running == 3`** (the last slot:
  `can_start_another=true`, `free_slots=1`) and **at least one at
  `running == 4`** (the ceiling: `can_start_another=false`,
  `free_slots=0`).

Why each clause:

- **100 rounds** so the streak cannot be met by one busy afternoon. At
  any cadence the round has ever run, a hundred deciding rounds is days of
  production, not hours.
- **14 days** so the window necessarily crosses both quiet and busy swarm
  states. A threshold met entirely inside one campaign day says nothing
  about the next.
- **Both sides of the boundary** because a period in which `running` never
  reached the ceiling exercises only the true branch. A flip earned
  without ever seeing `can_start_another=false` in production is a flip
  over half the law. The in-container measurement above already sat at
  the boundary (`free_slots=1`), so this clause asks for what production
  already does, made mandatory rather than incidental.

What resets the count, and what merely voids it:

- A **disagreement** in any cross-check round resets the count to zero.
- A round in which either implementation failed to answer - crash, missing
  binary, unparseable output - is **void**: it is not an agreement, and it
  breaks the consecutiveness. Void is recorded as void and never folded
  into agreement. Empty is never green; a comparison that did not run
  proves nothing and must not be counted as if it had.
- `tests/t27/ring00_parity.sh` going red also resets the count. The fixed
  table and the production cross-check are one body of evidence about one
  pair of implementations; a table that cannot agree offline is not
  evidence that they agree in production.

Before the flip, a disagreement is an incident, not a decision point: it
is surfaced and it resets the streak, and Swift is still acted on, because
Swift is the authority and that is what authority means. But it is never
silent - the streak exists to certify a period, and a disagreement inside
that period is exactly the thing the streak is meant to catch.

## On disagreement after the flip

After the flip, dispatch requires three things: the ring answered, Swift
answered, and the two answers are equal. If any one of the three fails,
the round **refuses to dispatch and says so**.

The refusal is not a preference for either side:

- **No worker starts that round.** Both answers are quarantined; neither
  is recorded as the answer acted on. A disagreement about capacity is
  not a thing to average, and it is not a thing to break by preference
  either - the two implementations exist because the rule is supposed to
  exist once, and when they disagree the rule itself is in question.
- **The disagreement is recorded as an incident**, with the input and both
  answers, and surfaced where rounds are read - not logged away.
- **The refusal persists** until the disagreement is resolved. Resolution
  means the cause is found and fixed and the evidence period restarts. It
  does not mean one side outvoted the other.
- **It escalates.** A standing disagreement between two readings of one
  rule is a person's problem - the same shape the ring itself already
  encodes, where two real failures end the automatic loop
  (`MAX_REAL_ATTEMPTS = 2`).

The honest note about what refusal costs: on a disagreement the two
answers are one true and one false, and refusing to dispatch lands on the
conservative side of the split - a worker started late is a delay, a
worker started past the ceiling is a violation. The refusal is chosen for
its recoverability, not because the false side is trusted; no answer is
credited, and the next round asks again.

A failure to answer is treated the same way, on either side, by
symmetry. If the ring - the authority - fails to answer, the round does
not fall back to Swift: a fallback is a runtime preference, made by an
outage instead of an average, and it would record Swift's answer as
acted-on in exactly the round the cross-check went dark. If Swift - the
check - fails to answer, an authority without its check is a single
implementation again, which is the state the flip exists to leave. Either
way: refuse, say so, escalate.

## Removing Swift

After the flip, Swift is the check. This document does not recommend
removing Swift, and will not while it is the check. The check is not
scaffold to be struck once the ring is trusted - it is what trust is
measured against.

What removal would require, in order:

1. **One full threshold period after the flip, green.** 100 consecutive
   cross-check agreements spanning at least 14 days, with Swift answering
   as the check and the ring as the authority, and no disagreement in it.
2. **A replacement independent reader that does not share t27c's front
   end.** Swift is currently the only reading of the law that does not
   factor through t27c's parse: the Rust, Zig, C and Verilog outputs are
   all functions of one AST, so their agreement is evidence about the
   lowerings, not about the `.t27` text (the related-fault limitation,
   recorded for this project in `.trinity/dashboard/FOUNDATIONS.md`,
   observation P2). Removing Swift before another independent reader runs
   does not consolidate anything - it returns the rule to single-copy
   status with no check at all, and a rule with no independent reading is
   indistinguishable from a wrong rule.
3. **`tests/t27/ring00_parity.sh` still in the tree and green**, so the
   fixed table remains the offline half of the evidence even after the
   live comparison changes shape.

Until all three hold, Swift stays. The two implementations of one rule
are the cost of proving which one is the rule; the proof is not finished
on the day the flip lands.

## What this document does not decide

- The ring's other answers - retry, review, the merge gate - are not
  flipped by this document. Each flips the same way, when a recorded
  cross-check of its own has met a threshold of its own. Capacity goes
  first because it is the question the round already asks every deciding
  round.
- T27-02 stays unstarted. The ring law is not satisfied by this document;
  it is satisfied by the flip running in production - which is the point
  of writing the contract before the change instead of after it.
