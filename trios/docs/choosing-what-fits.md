# Choosing What Fits — Why the Queue Hands Out Work by the Shoulder

Issue: gHashTag/trios#1164 · Parent: #1090

## What this document is

A note on the principle behind the choice rule (#1163): the queue must hand a bee work the bee can finish. Not the work that has waited longest, not the work that is most urgent to a human, not the work that is most interesting — the work that fits the worker's measured capacity. This note is the why; the rule itself lives in `chooseNextOpenIssue`, and the two agree or the rule is wrong.

## The measurement that decided it

Agent success falls sharply with task size. Across the runs behind the epic, the correlation between the length of a task and whether an agent completes it lands at R² = 0.83 — close enough to a law for planning purposes. Tasks a human finishes in under four minutes, agents take almost always. Tasks longer than four hours, agents finish in fewer than ten cases out of a hundred. The boundary is not a cliff but a slope, and the slope is steep.

Read plainly, the numbers say the scarce resource is not model capability and not willingness. It is capacity per task. A bee that is handed work beyond its shoulder does not try harder and succeed sometimes; it mostly produces a run that ends in nothing, and the nothing costs a chat, a review, and the hours between assignment and verdict.

## Why oldest-first fails

The old rule sorted by issue number: the oldest unclaimed issue goes out next. But the oldest unclaimed issue is precisely the one every previous pass walked around. It is not the most neglected gem; it is, statistically, the least doable thing in the queue. The current example from #1163: the rule keeps selecting #1111, an architectural interface-drift task. The bee goes silent on it, the run ends in nothing, the issue returns to the queue, and the rule — unchanged — selects it again. A rule that hands out what nobody could do builds a queue of predictable failures and calls it fairness.

Oldest-first is not wrong because order is wrong. It is wrong because age measures waiting, and waiting is not a property of the task. Size is.

## The order that converges

The sequence the measurements support:

1. **First: narrow and verifiable.** One file or few, mechanical change, a «готово» a counter can check. This is where an agent is close to fully autonomous, and where the Queen's trust is cheapest to earn.
2. **Then: medium tasks in well-covered code.** More files, more judgement, but the surrounding code has tests and precedent, so mistakes are caught by something other than hope.
3. **Last: architectural work.** The bee does not get it as work. It gets it as a draft — an analysis, a proposal, a map of options — and the human decides. The boundary between draft and work is the boundary between what fits and what doesn't.

The rule reads «посильное» from the spec itself: it counts the paths named in «Границы». Fewer paths, smaller task. A path ending in a directory counts as a large number — that is not a boundary, it is an area, and areas are not посильные.

## What fits is not what is easy

Choosing the feasible is not lowering the bar. The architectural work is not dropped, postponed indefinitely, or hidden; it is routed to the only worker who can hold it — the human — with the bee supplying the draft. Ambition stays. What changes is the matching: the queue stops confusing what matters most with what a bee can carry, because those are two different orderings and only one of them produces merges.

A queue that hands out tasks by importance produces important failures. A queue that hands out tasks by fit produces merges, and merges are how the important work eventually gets done at all.

## The honest limit of a note

This document changes no code and enforces nothing. It exists so that when someone later asks why `chooseNextOpenIssue` sorts by size instead of seniority, the answer is written down with its numbers attached — R² = 0.83, four minutes, four hours, ten in a hundred — and not left to be re-derived from scratch, or worse, quietly reverted to oldest-first because nobody remembered why the order looked strange.
