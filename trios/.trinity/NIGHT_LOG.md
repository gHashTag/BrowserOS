# Night log

An autonomous cycle runs hourly at :17 and appends here. Each entry says what
changed, what proved it, and what was deliberately left alone.

The cycle may build, test, fix and commit locally. It may not push, open a PR,
merge, or touch the trios repository. That line is where reversible ends.

---

## Setup, 2026-07-29 evening

Loop armed. Baseline before it starts: `make` builds, `make cassettes` passes
4/4, the headless harness passes with 157 assertions. Branch
`feat/queen-supervisor`, nothing unpushed beyond what is already on the remote.

## Cycle 1, 2026-07-29 late evening

Verified first: build clean, 157 headless assertions, 4/4 cassettes. Then the
dead-code scan over 166 declared types found two with a single occurrence.

Removed `rings/SR-02/QueenDelegationService.swift`. It sat in `rings/`, so it
compiled into every build, and nothing called it - its job was taken over by
`ChatViewModel.delegateIssueToWorker` when delegation was actually wired up. It
is the same file the Queen's own `/roadmap` flagged, which is a decent sign the
audit and the scanner agree.

Left `BR-OUTPUT/QueenStatusBadge.swift` alone. It is also uncalled, but it lives
in BR-OUTPUT and is absent from the lean build list, so it is an unbuilt
prototype rather than dead weight. Deleting drafts from the drafts folder is not
an improvement.

Re-verified after the removal: build clean, 157 assertions, 4/4 cassettes.

## Cycle 2, 2026-07-30 early

Build, cassettes and harness green first. Then: six pure types had zero
assertions between them - ModelPricing, SwarmBudget, SkillCatalog,
QueenSystemPrompt, QueenBriefing, QueenSelfAudit. Each is a place where a wrong
answer is expensive, and each had already gone wrong once by hand.

Added 21 assertions covering exactly those failures: an unpriced model reports
no cost rather than an average; a sub-cent spend reads as "<$0.01" rather than
zero; a skill with no frontmatter is described by its heading rather than a
stray bullet from mid-list; the Queen's roster says it is the enabled set and
names the disabled ones, because given a bare list the model invented a state
and told the user a live skill was off; a brief puts the boundary before the
recipe; dead code outranks everything in a roadmap.

Assertions went 157 to 178. Build clean, cassettes 4/4.

Nothing else touched. QueenBranchCommitter still has no coverage - it shells out
to git and needs a scratch repository, which is a bigger job than this cycle
allows and is written down rather than half-done.

## Cycle 3, 2026-07-30

Green first: build clean, 178 assertions, cassettes 4/4. The dead-code scan over
168 types returned only QueenStatusBadge, which is a BR-OUTPUT draft absent from
the build list and was already deliberately left alone last cycle. So (a) was
clear and I moved to (b), a number printed that was never really measured.

Found it in the Skills tab: `bodyCharacters / 1000` with no floor, so any skill
under a thousand characters displayed as "0k chars". Three real skills read that
way - chat-ux-patterns at 580, trios-launch at 637, e2e-testing at 722. A file
that exists reported as empty, which is the same failure as "$0.00" for a
sub-cent spend.

The rule already existed in three places and the third had drifted, so it moved
to `CompactCount` in SR-00 and the task banner and review digest now defer to
it. Six assertions cover the boundary in both directions, including 999 and 1000.

Assertions 178 to 184. Build clean, cassettes 4/4.

Left alone: QueenStatusBadge again, for the same reason, and
QueenBranchCommitter, which still needs a scratch git repository to test
properly.

## Cycle 4, 2026-07-30

Green first: build clean, 184 assertions, cassettes 4/4. Dead-code scan clear
again apart from the BR-OUTPUT draft. So (c) this time - a check that silently
matches nothing.

The scanner behind /roadmap is the obvious candidate, because it has already
done exactly that once: it looked for `func Queen...`, but Swift methods are
named after what they do and only types carry the prefix, so it found zero
declarations, reported zero findings, and that read as a clean bill of health.

It is now run against a known-bad input. A temporary tree gets two planted
types: one declared and referenced nowhere, one declared and genuinely used. The
assertions require it to find the first, leave the second alone, rank the find
as dead rather than merely noting it, and return empty on an empty tree without
erroring. Both directions, so a scanner that stops matching cannot pass by
being silent.

Assertions 184 to 188. Build clean, cassettes 4/4.

Left alone: QueenStatusBadge, and QueenBranchCommitter, whose root is not
injectable - testing it needs a small refactor first, which is a cycle of its
own rather than a rushed appendix to this one.

## Cycle 5, 2026-07-30

Green first. Then the item deferred in the last two cycles: QueenBranchCommitter
had no coverage, because its root was a constant and the only way to run it was
against the live checkout.

Made the root a parameter and pointed it at a throwaway repository. Seven
assertions now cover the piece that actually touches git: a baseline is taken, a
file inside the boundary is committed while one written outside it at the same
moment is not, the summary names what landed, HEAD stays where it was, the stray
file is still sitting uncommitted in the working tree afterwards, and a missing
baseline makes the committer refuse rather than guess whose edits it is looking
at.

Two runGit call sites had been left without the new root while I was threading
it through. The compiler did not catch that - both compiled fine and would have
silently run against the real repository. Caught by reading the diff, which is
the argument for making the parameter required rather than defaulted; noted, not
done, because changing the signature ripples into ChatViewModel and that is a
cycle of its own.

Assertions 188 to 195. Build clean, cassettes 4/4.

