# Queen priorities: what outranks what

Intended reader: a Bee holding a brief, deciding whether the brief it was
handed is the right thing to be working on.

This document exists because the Queen chooses the next issue by capacity,
boundary and order, and nothing in that choice says whether the chosen issue
matters. The priority order was never written down in a form a worker reads,
so a documentation chore and the ring that blocks the whole backend looked
identical. This file writes it down. It changes nothing else: it does not
change the chooser, which does not yet rank by these tiers, and making the
chooser rank by priority would be a separate change needing its own evidence.

## Sources

Nothing below is invented here. The ordering is assembled from two documents,
and where both are silent this file says so rather than deciding (see the
final section):

- `CLAUDE.md`, section "L0 -- SOURCE: everything is T27 except the seed" --
  the operator's decision of 2026-08-19, which sits above the L1-L7 law
  table. L0 makes every component below the user interface generated from
  `.t27` ring sources, and orders migration ring by ring: innermost first,
  and a ring is not started until the one inside it runs in production.
- `docs/architecture/Queen_T27_MVP_Architecture.md` -- the MVP architecture,
  committed to this repository on 2026-09-01 (6d1d5065) after living only in
  an unversioned directory. Its section 2.2.7, "Current Queen gaps relative
  to the T27 vision", names the ten gaps reproduced in Tier 2 below.

## The four tiers, in descending order

### Tier 1: work that unblocks the T27 rings

Work that starts, completes or unblocks a `.t27` ring. Today that means
`rings/T27-02` above all: orchestration, the Queen's own tick -- delegation,
review sweep, bounded send-back -- which the ring table CLAUDE.md points at
(`.claude/skills/t27-backend/SKILL.md`) records as "does not exist, never
started". `rings/T27-00` and `rings/T27-01` exist as `.t27` sources; the next
ring in the migration order simply is not there.

Why it outranks Tier 2: L0 is a law that sits above every other law in this
repository, and under it every ring depends on the rings inside it, so while
`rings/T27-02` does not exist the rings outside it cannot be started at all,
which makes this the only tier whose absence gates work in every tier below
it.

### Tier 2: the ten named Queen gaps

The gaps that section 2.2.7 of the architecture document names between the
Queen that runs today and the T27 vision, reproduced in the source's own
order:

- No demonstrated canonical Queen-to-T27 mission contract.
- Worker completion can still be conversational rather than artifact-contract based.
- No unified provenance manifest spans Queen decision, Bee task, specification delta, compiler run, backend artifact, and validation result.
- No demonstrated semantic-diff reviewer for `.t27` changes.
- No demonstrated quorum or competing-proposal mechanism for high-risk architecture choices.
- No uniform evidence score tying tests, conformance, determinism, and reproducibility to acceptance.
- No demonstrated remote/cloud execution contract that preserves the same local guarantees.
- No demonstrated hardware-in-the-loop gate integrated into Queen's acceptance policy.
- Virtual-branch isolation is useful but must be stress-tested against concurrent edits, tool behavior, and recovery.
- The T27 compiler's backend capability model is not yet exposed as a Queen planning primitive.

Why it outranks Tier 3: the architecture document names these ten as the
standing difference between the Queen that runs today and the product she
exists to deliver, so closing them creates capability the project does not
yet have, while fixing a defect repairs capability it already has and can
still exercise, imperfectly.

### Tier 3: correctness defects in what already runs

A defect in code that is live today: behavior that computes, stores, sends
or displays the wrong thing.

Why it outranks Tier 4: wrong output propagates into everything built on top
of it -- including the ring work of Tier 1 and the evidence of Tier 2 --
while untidiness only costs a reader time, so a system that computes wrongly
is repaired before a system that reads badly.

### Tier 4: documentation and tidying

Writing documents like this one, reorganising, renaming, closing dead
issues: work that improves how the project reads but that nothing waits on.

Why it outranks nothing: Tier 4 is the floor of this list; it is taken up
when no tier above it is ready to be worked.

## What the chooser does today

For the avoidance of doubt: the chooser does not yet rank by these tiers.
Nothing enforces this order. The chooser -- `queend`'s "choose" rule
(`agent-server/queen-core/Sources/queend/main.swift`), fed by the tick
(`agent-server/apps/server/src/api/services/queen-tick.ts`) -- picks the
first candidate in GitHub listing order that:

- is not already claimed by a live or finished worker,
- declares a parseable boundary that no other task holds,
- sits under the swarm's daily spend cap.

Priority is not an input to that choice. A Tier 4 chore listed above a Tier 1
ring in the issue list will be chosen first, every time, until the chooser
itself is changed.

## Where the sources are silent

- The two sources do not rank the four tiers as a whole. Tier 1's place is
  established by CLAUDE.md's L0 and the missing `rings/T27-02`; Tier 2's
  contents are the architecture document's section 2.2.7. The positions of
  Tier 3 and Tier 4 come from the issue that created this file (#1322);
  neither source confirms or contradicts them.
- Section 2.2.7 numbers its ten gaps but does not rank them against each
  other, so no ordering within any tier is established by anything cited
  here.
- The architecture document's other priority lists -- section 7.3's backend
  priority (MVP, P1, P2) and principle P7, "tests and gates outrank model
  confidence" -- order backends and evidence, not issues; they are not task
  priorities.
