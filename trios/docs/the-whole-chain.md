# The Whole Chain — A Note on a Ring Walked in Full

Issue: gHashTag/trios#1186 · Parent: #1090

## What this document is

A record that the full cycle of the delegation system has been walked
end to end on real work. Not a drill, not a probe: this document is
itself the payload of that walk. It was born as a GitHub issue, became
a specification, entered a chat, was written by a worker, reviewed by
the Queen against its acceptance criteria, and merged. The note you are
reading is the demonstration the epic asked for.

## Why the note was needed

When epic
[#1090](https://github.com/gHashTag/trios/issues/1090) listed what was
already done, one line stood out under "what remains": the cycle had
never once reached a pull request. The parts worked in isolation —
issues arrived, specs rendered, chats opened, bees reported — but the
ring was never closed on a real task. The Queen had never reviewed
anything and never merged anything. Issue #1186 exists for exactly one
reason, stated in its body: to show the ring on real work ("показать
круг на настоящей работе").

## The chain, link by link

The chain is the sequence the epic names: issue → specification → chat
→ worker's work → branch → review → merge → archive. Each link hands
the task to the next, and the chain counts as passed only when every
link holds. This task walks them all:

1. **Issue.** The task arrived as GitHub issue #1186 — a plain request
   for a note, carrying no code of its own.
2. **Specification.** The Queen turned the issue into a Spec Kit brief:
   intent, acceptance criteria, file boundary, out of scope. The brief
   named one file and two criteria — small on purpose, so the
   demonstration is about the chain, not the payload.
3. **Chat.** One chat, one bee. The bee held only its task, the Queen
   held only the map; neither drowned in the other's context.
4. **Work.** The worker wrote this file inside the boundary the spec
   drew, touching nothing else and committing nothing itself.
5. **Branch.** The edits belong to the task's branch, while the shared
   checkout stays clean for the user, the build, and every other bee.
6. **Review.** The Queen reads the diff against the acceptance
   criteria, not against taste. An unchecked criterion is not a pass.
7. **Merge and archive.** The diff lands, the chat that carried the
   task closes. A note like this one, readable on a landed branch, is
   the loop's closing brace.

## What this changes

Before: parts that worked alone and a cycle that stopped short of a
pull request. After: a ring walked in full on real work, with a note
left behind to say so plainly.

The companion notes cover the individual links —
[`seven-links.md`](seven-links.md) (where the review chain broke),
[`merge-truth.md`](merge-truth.md) (how a merge is proven),
[`queen-verdicts.md`](queen-verdicts.md) (how criteria are judged),
[`queen-archive-rules.md`](queen-archive-rules.md) (when a settled task
may leave the working view). This note carries the one thing none of
them could: the chain, passed entirely.

*2026-08-19*
