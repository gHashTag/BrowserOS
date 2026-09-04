# Survey of `queen-dispatch.ts` — what is inside it, and what could move

Produced by `node trios/tools/queen-dispatch-split-survey.mjs` (from the
repository root). Every number below was measured by that run against
`trios/agent-server/apps/server/src/api/services/queen-dispatch.ts` — the
tool parses the source text at run time; nothing here is copied from the
issue or hard-coded into the tool. The tool reads and reports; it modifies
no file. It runs on the Node standard library alone — no TypeScript
compiler, no `make`, no build.

This is a survey, not a split. The judgement of whether to split this file,
and when, stays with a person. What follows is the evidence that judgement
would be argued from.

## The file, measured

| quantity | value |
| --- | --- |
| File line count | **1367** |
| Top-level declarations found | **30** |
| Lines covered by declaration ranges | 1306 |
| Unparsed lines (belong to no declaration) | 61 |
| 1306 + 61 | **1367 — agrees with the file's own line count** |

Unparsed lines are: lines 1–32 (the licence/header comment block, a blank,
the six `import` statements, a blank — labelled by the run as *comment block
and import statements*) and one blank separator line between each pair of
adjacent declarations (29 blanks). Nothing in the file failed to classify
beyond that: no line is left unaccounted for.

## Every top-level declaration, longest first

`exported` = reachable outside this file. `extractable` = references no
other top-level declaration in this file, so it can move to a new module on
its own. `references` = the other top-level declarations in this file that
its code names (doc comments are excluded from the match) — those are what
would have to travel with it if it moved alone.

| lines | range | kind | exported | extractable | name | references |
| ---: | --- | --- | --- | --- | --- | --- |
| 205 | 542–746 | class | no | no | `Scribe` | `TokenUsage` |
| 118 | 1141–1258 | function | yes | no | `dispatchBee` | `DispatchOutcome`, `missingProviderRefusal`, `prepareWorktree`, `recordDispatch`, `resolveWorkerProvider`, `startTurn` |
| 108 | 1260–1367 | function | yes | **yes** | `recordDispatch` | — |
| 98 | 443–540 | function | no | no | `startTurn` | `WorkerProvider`, `drain` |
| 93 | 941–1033 | function | yes | no | `closeDispatch` | `TokenUsage`, `durableCloseListener`, `finishDispatch` |
| 92 | 164–255 | function | yes | no | `resolveWorkerProvider` | `WORKER_PROVIDERS`, `WorkerProvider`, `keysFor`, `workerLanesFor` |
| 83 | 359–441 | function | yes | no | `prepareWorktree` | `run`, `workspaceRoot` |
| 77 | 832–908 | function | yes | no | `drain` | `Scribe`, `classifyQuotaExhaustion`, `closeDispatch` |
| 47 | 267–313 | function | no | **yes** | `run` | — |
| 46 | 83–128 | function | no | **yes** | `keysFor` | — |
| 40 | 1035–1074 | function | yes | no | `finishDispatch` | `TokenUsage` |
| 37 | 1076–1112 | function | yes | **yes** | `reapDispatchesFromPreviousBoot` | — |
| 34 | 748–781 | const | no | **yes** | `ZAI_QUOTA_EXHAUSTED_CODES` | — |
| 34 | 315–348 | function | yes | no | `committedFiles` | `run`, `workspaceRoot` |
| 32 | 33–64 | const | no | **yes** | `WORKER_PROVIDERS` | — |
| 24 | 783–806 | function | yes | no | `classifyQuotaExhaustion` | `ZAI_QUOTA_EXHAUSTED_CODES`, `zaiCodesIn` |
| 23 | 808–830 | function | no | **yes** | `zaiCodesIn` | — |
| 16 | 66–81 | interface | yes | **yes** | `WorkerProvider` | — |
| 16 | 130–145 | function | yes | **yes** | `configuredWorkerLanesPerCredential` | — |
| 16 | 1114–1129 | function | yes | **yes** | `reapStalledDispatches` | — |
| 15 | 916–930 | type | yes | **yes** | `DurableCloseListener` | — |
| 12 | 151–162 | function | yes | no | `configuredWorkerCapacity` | `WORKER_PROVIDERS`, `keysFor`, `workerLanesFor` |
| 9 | 1131–1139 | interface | yes | **yes** | `DispatchOutcome` | — |
| 9 | 257–265 | function | yes | no | `missingProviderRefusal` | `WORKER_PROVIDERS` |
| 6 | 934–939 | function | yes | no | `setDurableCloseListener` | `DurableCloseListener`, `durableCloseListener` |
| 5 | 910–914 | interface | yes | **yes** | `TokenUsage` | — |
| 4 | 350–353 | function | yes | no | `committedFileCount` | `committedFiles` |
| 3 | 147–149 | function | no | no | `workerLanesFor` | `configuredWorkerLanesPerCredential` |
| 3 | 355–357 | function | yes | **yes** | `workspaceRoot` | — |
| 1 | 932 | let | no | no | `durableCloseListener` | `DurableCloseListener` |

A declaration's range includes the doc-comment block sitting directly above
it, because those lines travel with the code when it moves. Line ranges are
1-based, as printed by the run.

## Independently extractable declarations

14 of the 30 declarations reference nothing else in this file. They can each
move to a new module on their own, and — because none needs any of the
others — they could also move **together** as one new module:

**Count: 14 declarations, 407 of the 1306 declaration lines.**

`recordDispatch` (108), `run` (47), `keysFor` (46), `reapDispatchesFromPreviousBoot`
(37), `ZAI_QUOTA_EXHAUSTED_CODES` (34), `WORKER_PROVIDERS` (32), `zaiCodesIn`
(23), `WorkerProvider` (16), `configuredWorkerLanesPerCredential` (16),
`reapStalledDispatches` (16), `DurableCloseListener` (15), `DispatchOutcome`
(9), `TokenUsage` (5), `workspaceRoot` (3).

That 407-line group is the *lowest-risk* cut in the file — nothing rewires
inside the moved set — but it is not the largest, and the largest is what
the closing section below names.

## The recommended extraction — one move, with its cost

Definition used (stated so it can be judged): a declaration cannot move
alone if it references others; its references are what travels with it. The
**closure** of a declaration is itself plus every declaration it
transitively references. Extracting a declaration moves exactly its
closure. A closure equal to the whole file would drag the file behind it
and is no extraction at all, so such seeds are not candidates. Among the
remaining candidates, the largest by lines:

**Seed: `dispatchBee`. Moves 24 of 30 declarations — 1197 of 1306
declaration lines removed from this file.**

The declarations that move (lines with each, as measured):

| lines | range | name |
| ---: | --- | --- |
| 205 | 542–746 | `Scribe` (not exported) |
| 118 | 1141–1258 | `dispatchBee` |
| 108 | 1260–1367 | `recordDispatch` |
| 98 | 443–540 | `startTurn` (not exported) |
| 93 | 941–1033 | `closeDispatch` |
| 92 | 164–255 | `resolveWorkerProvider` |
| 83 | 359–441 | `prepareWorktree` |
| 77 | 832–908 | `drain` |
| 47 | 267–313 | `run` (not exported) |
| 46 | 83–128 | `keysFor` (not exported) |
| 40 | 1035–1074 | `finishDispatch` |
| 34 | 748–781 | `ZAI_QUOTA_EXHAUSTED_CODES` (not exported) |
| 32 | 33–64 | `WORKER_PROVIDERS` (not exported) |
| 24 | 783–806 | `classifyQuotaExhaustion` |
| 23 | 808–830 | `zaiCodesIn` (not exported) |
| 16 | 66–81 | `WorkerProvider` |
| 16 | 130–145 | `configuredWorkerLanesPerCredential` |
| 15 | 916–930 | `DurableCloseListener` |
| 9 | 1131–1139 | `DispatchOutcome` |
| 9 | 257–265 | `missingProviderRefusal` |
| 5 | 910–914 | `TokenUsage` |
| 3 | 147–149 | `workerLanesFor` (not exported) |
| 3 | 355–357 | `workspaceRoot` |
| 1 | 932 | `durableCloseListener` (not exported) |

What stays: `committedFiles` (34), `committedFileCount` (4),
`configuredWorkerCapacity` (12), `reapDispatchesFromPreviousBoot` (37),
`reapStalledDispatches` (16), `setDurableCloseListener` (6) — 109
declaration lines plus the 61 unparsed lines.

**Every call site outside this file that would need its import changed**
(found by scanning the repository for import statements naming
`queen-dispatch`):

- `trios/agent-server/apps/server/src/api/services/queen-tick.ts` — imports
  `dispatchBee`, `workspaceRoot` (both move)
- `trios/agent-server/apps/server/tests/api/queen-dispatch.test.ts` —
  imports `classifyQuotaExhaustion`, `closeDispatch`,
  `configuredWorkerLanesPerCredential`, `drain`, `finishDispatch`,
  `missingProviderRefusal`, `prepareWorktree`, `recordDispatch`,
  `resolveWorkerProvider`, `workspaceRoot` (all move)
- `trios/agent-server/apps/server/tests/api/queen-round.test.ts` — imports
  `closeDispatch` (moves)

One file imports from this module and would keep working unchanged:
`trios/agent-server/apps/server/src/api/routes/queen-public-research.ts`
imports `configuredWorkerCapacity`, which stays. A comment in
`trios/agent-server/apps/server/src/api/routes/queen-lease.ts` mentions
this file but imports nothing from it.

Declarations left behind that reference moved ones — the remaining file
would import these names from the new module:

- `committedFiles` → `run`, `workspaceRoot`
- `configuredWorkerCapacity` → `WORKER_PROVIDERS`, `keysFor`, `workerLanesFor`
- `setDurableCloseListener` → `DurableCloseListener`, `durableCloseListener`

A group and its complement describe the same cut: this recommendation
moves the machinery and leaves the leaf helpers, but a person could
equivalently keep the machinery's name here and move the six leaves. Which
side keeps the module name is not the tool's to decide.

### Runner-up candidates

Every distinct proper closure, largest first (the top of the list is the
recommendation above; shown here so the smaller, lower-risk cuts are
visible):

| lines | declarations | seed |
| ---: | ---: | --- |
| 1197 | 24 | `dispatchBee` |
| 631 | 12 | `startTurn` |
| 517 | 10 | `drain` |
| 210 | 2 | `Scribe` |
| 205 | 6 | `resolveWorkerProvider` |
| 154 | 5 | `closeDispatch` |
| 133 | 3 | `prepareWorktree` |
| 109 | 5 | `configuredWorkerCapacity` |
| 108 | 1 | `recordDispatch` |
| 88 | 4 | `committedFileCount` |
| 84 | 3 | `committedFiles` |

Read plainly: the file is one deeply interconnected unit around
`dispatchBee`. There is no mid-sized extraction that removes, say, half the
file — every closure is either small (≤ 210 lines) or nearly everything
(631, 1197). The 631-line `startTurn` closure (the turn/stream machinery:
`startTurn`, `drain`, `Scribe`, the quota classification and the
close/finish machinery) is the largest cut that does **not** move
`dispatchBee` itself, if keeping the orchestrator in this file matters more
than removing the most lines.

## Reproducing

```
node trios/tools/queen-dispatch-split-survey.mjs
```

The run prints the table above with the declaration count, the accounting
(declaration lines + unparsed lines = file line count), and the recommended
extraction. Two consecutive runs over an unchanged file produce
byte-identical output (verified with `cmp`; same SHA-256 both runs) — no
timestamps, no environment data, all listings sorted. The tool exports its
analysis as `splitQueenDispatch()` for programmatic use; running the file
directly prints the report.

If no group had been independently extractable — every declaration's
closure equalling the whole file — the run would say so plainly instead of
proposing a split that drags the file behind it. That branch is implemented
and was exercised against a synthetic all-interconnected file (it printed
the plain statement); it did not fire for this file.
