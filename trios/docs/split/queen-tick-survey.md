# Split survey: `trios/agent-server/apps/server/src/api/services/queen-tick.ts`

Issue gHashTag/trios#1402. The file is 1737 lines on the branch this survey
was produced from, and the repository's pre-commit hook has warned about its
length on every commit that touched it, changing nothing. This document is
the survey a split would have to be argued from: what the file actually
contains, which parts depend on nothing else in it, and which single
extraction removes the most lines for the least risk. It splits nothing.
Whether and when to split stays with a person.

## How it was produced

- Tool: `trios/tools/queen-tick-split-survey.mjs` - Node standard library
  only. It reads and reports; it writes nothing, invokes no TypeScript
  compiler, no `make`, no build.
- Commands: `node trios/tools/queen-tick-split-survey.mjs` (plain report)
  and `node trios/tools/queen-tick-split-survey.mjs --markdown` (the
  rendering embedded below), both run from the repository root.
- Tree: branch `queen-1402`, commit `87f4fd32`, where HEAD is identical to
  `origin/feat/queen-supervisor` - the tree the issue counts the file's
  1737 lines on. No tracked file differs from that commit; this survey's
  two files are the only additions.
- Every number below was measured during the run. Nothing is copied from
  the issue.

## Method

- Declarations are found by parsing the source text with a TypeScript-aware
  scanner: strings, template literals (including `${...}` interpolations,
  which occur inside the SQL blocks), line and block comments, regex
  literals, and brace/paren/bracket depth are all tracked, so the braces
  inside SQL text or inside `/\.\w{1,10}$/` never miscount a block. No
  top-level statement in the file ends with a semicolon (the only
  line-ending semicolons are inside SQL template text), so statement ends
  are found structurally, the way JavaScript itself inserts them.
- A declaration's `lines` is its code plus the comment block attached
  immediately above it: contiguous comment lines, with a blank line
  breaking the attachment. That rule is why the 37-line file header counts
  as a standalone comment rather than as documentation of `LEASE_NAME`, and
  why `LEASE_TTL_SECONDS` carries the 22-line lease-TTL comment while
  `HEARTBEAT_SECONDS`, directly beneath it, carries none.
- A reference is an occurrence of another top-level declaration's name in
  the declaration's code, with comments and template-literal text stripped.
  Property accesses (`x.name`, `x?.name`) are not references; a spread
  (`...criteriaBlock(...)`) is. No declaration in this file has a local
  binding that shadows another declaration's name, and no string literal
  contains one of the 38 names, so neither over- nor under-counts arise
  here.
- Assignment detection finds `name =` that is not `==`, not `=>`, and not a
  type annotation (`const x: Type = ...`). It matters because an imported
  ESM binding is read-only: `timer` is assigned by `startQueenTick`, so
  `timer` cannot move without it.
- Call sites outside the file are files containing a module specifier that
  ends in `/queen-tick` - covering static imports, dynamic imports, and the
  path constant in `routes/queen-lease.test.ts` - that also use a moved
  exported name in code. A comment mention does not count:
  `queen-criteria.test.ts` mentions `parseVerdictBlock` in a comment but
  imports only `briefFor`, which is not moved, so it needs no change.
- Anything the parser could not classify is reported as `unparsed` with its
  line. This run found none: all 1737 lines are accounted for.

## Determinism

The tool prints no clock and no randomness and iterates every collection in
sorted order. Two consecutive runs, compared:

    $ node trios/tools/queen-tick-split-survey.mjs | shasum
    4a75774e0b6a1e3037f988d30a28e9a4453feba6  -
    $ node trios/tools/queen-tick-split-survey.mjs | shasum
    4a75774e0b6a1e3037f988d30a28e9a4453feba6  -

Identical bytes. The `--markdown` rendering compares the same way:
`960da12dc44f014ecd5100677a654b9ad2931e0d` twice. Any future run against an
edited file changes the numbers only as the file changed.

## The survey

Everything from here to the end of the "Line accounting" section is the
tool's `--markdown` output, embedded unchanged.

---
Target: `trios/agent-server/apps/server/src/api/services/queen-tick.ts` - 1737 lines, measured this run.

Declarations found: **38** (15 exported, 23 not; unparsed: 0).

## What the file contains

Every top-level declaration, sorted by length descending. `lines` is code plus attached doc comments; `refs` names the other top-level declarations of this file it references - what would travel with it.

| lines | code | doc | kind | exported | name | span | refs in this file |
|---:|---:|---:|---|---|---|---|---|
| 320 | 306 | 14 | function | yes | `runRound` | 661-980 | `LeaseWatch`, `QueendChoice`, `SpecVerdict`, `askQueend`, `boardTask`, `bodiesFor`, `briefFor`, `ensureQueenColumns`, `openIssues`, `recordTick`, `rememberIssues`, `report`, `reviewFinishedDispatches`, `stateOfDispatch` |
| 114 | 114 | 0 | function | no | `reviewFinishedDispatches` | 1239-1352 | `ReviewRound`, `askQueend`, `boundaryStrays`, `parseVerdictBlock` |
| 113 | 104 | 9 | function | yes | `briefFor` | 982-1094 | `criteriaBlock` |
| 90 | 79 | 11 | function | no | `report` | 1410-1499 | `QueendChoice`, `ReviewRound` |
| 78 | 78 | 0 | function | yes | `createRoundGate` | 1571-1648 | `RoundGate` |
| 74 | 66 | 8 | function | yes | `startQueenTick` | 1664-1737 | `LEASE_NAME`, `createRoundGate`, `heartbeats`, `refillOnBeeCompletion`, `runQueenTickOnce`, `tickIntervalSeconds`, `timer` |
| 64 | 46 | 18 | function | yes | `rememberIssues` | 258-321 | `ISSUE_PAGE_CAP`, `SpecVerdict`, `boundaryPathsOf` |
| 58 | 42 | 16 | function | yes | `openIssues` | 146-203 | `ISSUE_PAGE_CAP`, `ISSUE_PAGE_SIZE` |
| 55 | 54 | 1 | function | yes | `parseVerdictBlock` | 1354-1408 | (none) |
| 54 | 54 | 0 | function | yes | `boardTask` | 390-443 | `ZERO_UUID`, `isoSeconds` |
| 52 | 38 | 14 | function | no | `ensureQueenColumns` | 205-256 | (none) |
| 50 | 10 | 40 | function | yes | `stateOfDispatch` | 339-388 | (none) |
| 50 | 30 | 20 | function | yes | `startLeaseHeartbeat` | 576-625 | `HEARTBEAT_SECONDS`, `LEASE_NAME`, `LEASE_TTL_SECONDS`, `LeaseWatch`, `heartbeats` |
| 45 | 24 | 21 | function | no | `boundaryPathsOf` | 445-489 | (none) |
| 44 | 18 | 26 | function | no | `boundaryStrays` | 1162-1205 | `askQueend` |
| 42 | 12 | 30 | interface | yes | `RoundGate` | 1528-1569 | (none) |
| 35 | 28 | 7 | function | no | `askQueend` | 509-543 | `QueendChoice`, `queendPath` |
| 35 | 25 | 10 | function | no | `criteriaBlock` | 1096-1130 | (none) |
| 33 | 33 | 0 | function | yes | `runQueenTickOnce` | 627-659 | `LEASE_NAME`, `LEASE_TTL_SECONDS`, `QueendChoice`, `runRound`, `startLeaseHeartbeat` |
| 31 | 6 | 25 | interface | no | `ReviewRound` | 1207-1237 | (none) |
| 29 | 21 | 8 | function | yes | `workerSystemPrompt` | 1132-1160 | (none) |
| 26 | 18 | 8 | function | no | `recordTick` | 1501-1526 | `LEASE_NAME`, `QueendChoice` |
| 23 | 1 | 22 | const | no | `LEASE_TTL_SECONDS` | 104-126 | (none) |
| 18 | 1 | 17 | const | no | `heartbeats` | 557-574 | (none) |
| 17 | 16 | 1 | function | no | `bodiesFor` | 491-507 | (none) |
| 15 | 2 | 13 | const | no | `isoSeconds` | 323-337 | (none) |
| 14 | 3 | 11 | function | no | `queendPath` | 59-72 | (none) |
| 14 | 14 | 0 | interface | no | `QueendChoice` | 89-102 | `SpecVerdict` |
| 11 | 3 | 8 | interface | yes | `LeaseWatch` | 545-555 | (none) |
| 11 | 3 | 8 | function | yes | `refillOnBeeCompletion` | 1650-1660 | (none) |
| 10 | 10 | 0 | interface | no | `SpecVerdict` | 78-87 | (none) |
| 9 | 1 | 8 | const | no | `ISSUE_PAGE_CAP` | 136-144 | (none) |
| 4 | 1 | 3 | const | no | `ZERO_UUID` | 73-76 | (none) |
| 4 | 4 | 0 | function | no | `tickIntervalSeconds` | 129-132 | (none) |
| 2 | 1 | 1 | const | no | `ISSUE_PAGE_SIZE` | 134-135 | (none) |
| 1 | 1 | 0 | const | no | `LEASE_NAME` | 58-58 | (none) |
| 1 | 1 | 0 | const | no | `HEARTBEAT_SECONDS` | 127-127 | (none) |
| 1 | 1 | 0 | let | no | `timer` | 1662-1662 | (none) |

## Independently extractable

**23** declarations reference nothing else in this file and account for **480** of 1647 declaration lines (29.1%):

- `HEARTBEAT_SECONDS` (const, 1 lines, 127-127)
- `ISSUE_PAGE_CAP` (const, 9 lines, 136-144)
- `ISSUE_PAGE_SIZE` (const, 2 lines, 134-135)
- `LEASE_NAME` (const, 1 lines, 58-58)
- `LEASE_TTL_SECONDS` (const, 23 lines, 104-126)
- `LeaseWatch` (interface, 11 lines, 545-555, exported)
- `ReviewRound` (interface, 31 lines, 1207-1237)
- `RoundGate` (interface, 42 lines, 1528-1569, exported)
- `SpecVerdict` (interface, 10 lines, 78-87)
- `ZERO_UUID` (const, 4 lines, 73-76)
- `bodiesFor` (function, 17 lines, 491-507)
- `boundaryPathsOf` (function, 45 lines, 445-489)
- `criteriaBlock` (function, 35 lines, 1096-1130)
- `ensureQueenColumns` (function, 52 lines, 205-256)
- `heartbeats` (const, 18 lines, 557-574)
- `isoSeconds` (const, 15 lines, 323-337)
- `parseVerdictBlock` (function, 55 lines, 1354-1408, exported)
- `queendPath` (function, 14 lines, 59-72)
- `refillOnBeeCompletion` (function, 11 lines, 1650-1660, exported)
- `stateOfDispatch` (function, 50 lines, 339-388, exported)
- `tickIntervalSeconds` (function, 4 lines, 129-132)
- `timer` (let, 1 lines, 1662-1662)
- `workerSystemPrompt` (function, 29 lines, 1132-1160, exported)

`timer` counts as independently extractable above, but startQueenTick assigns it, and an imported ESM binding is read-only - it can move only together with its assigner.

## Unparsed

None. Every top-level code line was classified.

## Closed groups (data, not recommendations)

A closed group is a declaration plus everything it references, transitively - the smallest set that could move to one new module together. Groups covering the whole file are marked: they are not extractions, they are the file.

| lines | members | whole file | group ([anchors] -> members) |
|---:|---:|---|---|
| 1618 | 37 | no | [startQueenTick] `runRound`, `reviewFinishedDispatches`, `briefFor`, `report`, `createRoundGate`, `startQueenTick`, `rememberIssues`, `openIssues`, `parseVerdictBlock`, `boardTask`, `ensureQueenColumns`, `stateOfDispatch`, `startLeaseHeartbeat`, `boundaryPathsOf`, `boundaryStrays`, `RoundGate`, `askQueend`, `criteriaBlock`, `runQueenTickOnce`, `ReviewRound`, `recordTick`, `LEASE_TTL_SECONDS`, `heartbeats`, `bodiesFor`, `isoSeconds`, `queendPath`, `QueendChoice`, `LeaseWatch`, `refillOnBeeCompletion`, `SpecVerdict`, `ISSUE_PAGE_CAP`, `ZERO_UUID`, `tickIntervalSeconds`, `ISSUE_PAGE_SIZE`, `LEASE_NAME`, `HEARTBEAT_SECONDS`, `timer` |
| 1408 | 31 | no | [runQueenTickOnce] `runRound`, `reviewFinishedDispatches`, `briefFor`, `report`, `rememberIssues`, `openIssues`, `parseVerdictBlock`, `boardTask`, `ensureQueenColumns`, `stateOfDispatch`, `startLeaseHeartbeat`, `boundaryPathsOf`, `boundaryStrays`, `askQueend`, `criteriaBlock`, `runQueenTickOnce`, `ReviewRound`, `recordTick`, `LEASE_TTL_SECONDS`, `heartbeats`, `bodiesFor`, `isoSeconds`, `queendPath`, `QueendChoice`, `LeaseWatch`, `SpecVerdict`, `ISSUE_PAGE_CAP`, `ZERO_UUID`, `ISSUE_PAGE_SIZE`, `LEASE_NAME`, `HEARTBEAT_SECONDS` |
| 1283 | 26 | no | [runRound] `runRound`, `reviewFinishedDispatches`, `briefFor`, `report`, `rememberIssues`, `openIssues`, `parseVerdictBlock`, `boardTask`, `ensureQueenColumns`, `stateOfDispatch`, `boundaryPathsOf`, `boundaryStrays`, `askQueend`, `criteriaBlock`, `ReviewRound`, `recordTick`, `bodiesFor`, `isoSeconds`, `queendPath`, `QueendChoice`, `LeaseWatch`, `SpecVerdict`, `ISSUE_PAGE_CAP`, `ZERO_UUID`, `ISSUE_PAGE_SIZE`, `LEASE_NAME` |
| 317 | 8 | no | [reviewFinishedDispatches] `reviewFinishedDispatches`, `parseVerdictBlock`, `boundaryStrays`, `askQueend`, `ReviewRound`, `queendPath`, `QueendChoice`, `SpecVerdict` |
| 148 | 2 | no | [briefFor] `briefFor`, `criteriaBlock` |
| 145 | 4 | no | [report] `report`, `ReviewRound`, `QueendChoice`, `SpecVerdict` |
| 128 | 4 | no | [rememberIssues] `rememberIssues`, `boundaryPathsOf`, `SpecVerdict`, `ISSUE_PAGE_CAP` |
| 120 | 2 | no | [createRoundGate] `createRoundGate`, `RoundGate` |
| 117 | 5 | no | [boundaryStrays] `boundaryStrays`, `askQueend`, `queendPath`, `QueendChoice`, `SpecVerdict` |
| 104 | 6 | no | [startLeaseHeartbeat] `startLeaseHeartbeat`, `LEASE_TTL_SECONDS`, `heartbeats`, `LeaseWatch`, `LEASE_NAME`, `HEARTBEAT_SECONDS` |
| 73 | 4 | no | [askQueend] `askQueend`, `queendPath`, `QueendChoice`, `SpecVerdict` |
| 73 | 3 | no | [boardTask] `boardTask`, `isoSeconds`, `ZERO_UUID` |
| 69 | 3 | no | [openIssues] `openIssues`, `ISSUE_PAGE_CAP`, `ISSUE_PAGE_SIZE` |
| 55 | 1 | no | [parseVerdictBlock] `parseVerdictBlock` |
| 52 | 1 | no | [ensureQueenColumns] `ensureQueenColumns` |
| 51 | 4 | no | [recordTick] `recordTick`, `QueendChoice`, `SpecVerdict`, `LEASE_NAME` |
| 50 | 1 | no | [stateOfDispatch] `stateOfDispatch` |
| 45 | 1 | no | [boundaryPathsOf] `boundaryPathsOf` |
| 42 | 1 | no | [RoundGate] `RoundGate` |
| 35 | 1 | no | [criteriaBlock] `criteriaBlock` |
| 31 | 1 | no | [ReviewRound] `ReviewRound` |
| 29 | 1 | no | [workerSystemPrompt] `workerSystemPrompt` |
| 24 | 2 | no | [QueendChoice] `QueendChoice`, `SpecVerdict` |
| 23 | 1 | no | [LEASE_TTL_SECONDS] `LEASE_TTL_SECONDS` |
| 18 | 1 | no | [heartbeats] `heartbeats` |
| 17 | 1 | no | [bodiesFor] `bodiesFor` |
| 15 | 1 | no | [isoSeconds] `isoSeconds` |
| 14 | 1 | no | [queendPath] `queendPath` |
| 11 | 1 | no | [LeaseWatch] `LeaseWatch` |
| 11 | 1 | no | [refillOnBeeCompletion] `refillOnBeeCompletion` |
| 10 | 1 | no | [SpecVerdict] `SpecVerdict` |
| 9 | 1 | no | [ISSUE_PAGE_CAP] `ISSUE_PAGE_CAP` |
| 4 | 1 | no | [ZERO_UUID] `ZERO_UUID` |
| 4 | 1 | no | [tickIntervalSeconds] `tickIntervalSeconds` |
| 2 | 1 | no | [ISSUE_PAGE_SIZE] `ISSUE_PAGE_SIZE` |
| 1 | 1 | no | [HEARTBEAT_SECONDS] `HEARTBEAT_SECONDS` |
| 1 | 1 | no | [LEASE_NAME] `LEASE_NAME` |
| 1 | 1 | no | [timer] `timer` |

## The one recommended extraction

**The largest independently extractable group**: every declaration that references nothing else in this file, moved together into one new module. It removes **479 lines** (27.6% of the file's 1737; 238 of them code) and severs no internal dependency.

Declarations that move (22):

- `parseVerdictBlock` (function, 55 lines, 1354-1408, exported)
- `ensureQueenColumns` (function, 52 lines, 205-256)
- `stateOfDispatch` (function, 50 lines, 339-388, exported)
- `boundaryPathsOf` (function, 45 lines, 445-489)
- `RoundGate` (interface, 42 lines, 1528-1569, exported)
- `criteriaBlock` (function, 35 lines, 1096-1130)
- `ReviewRound` (interface, 31 lines, 1207-1237)
- `workerSystemPrompt` (function, 29 lines, 1132-1160, exported)
- `LEASE_TTL_SECONDS` (const, 23 lines, 104-126)
- `heartbeats` (const, 18 lines, 557-574)
- `bodiesFor` (function, 17 lines, 491-507)
- `isoSeconds` (const, 15 lines, 323-337)
- `queendPath` (function, 14 lines, 59-72)
- `LeaseWatch` (interface, 11 lines, 545-555, exported)
- `refillOnBeeCompletion` (function, 11 lines, 1650-1660, exported)
- `SpecVerdict` (interface, 10 lines, 78-87)
- `ISSUE_PAGE_CAP` (const, 9 lines, 136-144)
- `ZERO_UUID` (const, 4 lines, 73-76)
- `tickIntervalSeconds` (function, 4 lines, 129-132)
- `ISSUE_PAGE_SIZE` (const, 2 lines, 134-135)
- `LEASE_NAME` (const, 1 lines, 58-58)
- `HEARTBEAT_SECONDS` (const, 1 lines, 127-127)

`timer` stays behind: references nothing else in this file, but another declaration assigns it, and an imported ESM binding is read-only - it can move only together with its assigner.

References inside `queen-tick.ts` that become imports of the new module:

- `HEARTBEAT_SECONDS` <- `startLeaseHeartbeat`
- `ISSUE_PAGE_CAP` <- `openIssues`, `rememberIssues`
- `ISSUE_PAGE_SIZE` <- `openIssues`
- `LEASE_NAME` <- `recordTick`, `runQueenTickOnce`, `startLeaseHeartbeat`, `startQueenTick`
- `LEASE_TTL_SECONDS` <- `runQueenTickOnce`, `startLeaseHeartbeat`
- `LeaseWatch` <- `runRound`, `startLeaseHeartbeat`
- `ReviewRound` <- `report`, `reviewFinishedDispatches`
- `RoundGate` <- `createRoundGate`
- `SpecVerdict` <- `QueendChoice`, `rememberIssues`, `runRound`
- `ZERO_UUID` <- `boardTask`
- `bodiesFor` <- `runRound`
- `boundaryPathsOf` <- `rememberIssues`
- `criteriaBlock` <- `briefFor`
- `ensureQueenColumns` <- `runRound`
- `heartbeats` <- `startLeaseHeartbeat`, `startQueenTick`
- `isoSeconds` <- `boardTask`
- `parseVerdictBlock` <- `reviewFinishedDispatches`
- `queendPath` <- `askQueend`
- `refillOnBeeCompletion` <- `startQueenTick`
- `stateOfDispatch` <- `runRound`
- `tickIntervalSeconds` <- `startQueenTick`

Call sites outside this file that would need an import change:

- `trios/agent-server/apps/server/src/api/services/queen-dispatch.ts` (import lines 31) imports `workerSystemPrompt`
- `trios/agent-server/apps/server/tests/api/queen-round.test.ts` (import lines 15, 484) imports `workerSystemPrompt`, `refillOnBeeCompletion`
- `trios/agent-server/apps/server/tests/api/verdict-block.test.ts` (import lines 2) imports `parseVerdictBlock`

Files that import `queen-tick` but use no moved name need no change: `trios/agent-server/apps/server/src/api/routes/queen-lease.ts`, `trios/agent-server/apps/server/src/main.ts`, `trios/agent-server/apps/server/tests/api/queen-board-record.test.ts`, `trios/agent-server/apps/server/tests/api/queen-criteria.test.ts`, `trios/agent-server/apps/server/tests/api/queen-heartbeat.test.ts`, `trios/agent-server/apps/server/tests/api/queen-issue-pages.test.ts`, `trios/agent-server/apps/server/tests/api/routes/queen-lease.test.ts`.

## Line accounting

| bucket | lines |
|---|---:|
| declaration code | 1269 |
| attached doc comments | 378 |
| import statements | 18 |
| blank | 35 |
| standalone comments | 37 |
| export lists | 0 |
| unparsed | 0 |
| **total** | **1737** |
| file lines (measured) | 1737 |

Declaration lines plus unparsed = 1647 + 0 = 1647 of 1737; the remaining 90 are imports (18), blanks (35), standalone comments (37) and export lists (0). The accounting agrees with the file's own line count.

---

## Reading it

- The recommendation is one move because the dependency maths says so: 22 of
  the 38 declarations reference nothing else in this file, so they can leave
  together with no severed dependency - the only cost is that the remaining
  file imports what it still uses, itemized in the recommendation.
- What "a split that would drag the whole file behind it" looks like in
  numbers: anchoring on `runRound` (306 code lines, the obvious biggest
  function) carries 25 other declarations and 1283 lines with it;
  `runQueenTickOnce` carries 31 declarations and 1408 lines; `startQueenTick`
  carries 37 of the 38 declarations - everything except
  `workerSystemPrompt` - and 1618 lines. None of those is a split, and the
  survey recommends none of them.
- A person may prefer one coherent module over a 22-declaration move. The
  closed-group table is the menu; the coherent clusters that stand out are
  `briefFor` + `criteriaBlock` (148 lines: the brief and its criteria
  block), `createRoundGate` + `RoundGate` (120 lines: the whole refill
  gate), `boardTask` + `isoSeconds` + `ZERO_UUID` (73 lines: the board
  record and its two helpers), and the review cluster around
  `reviewFinishedDispatches` (317 lines). These are data, not
  recommendations.
- `timer` cannot move alone no matter what else moves: `startQueenTick`
  assigns it, and an imported binding is read-only. Moving `timer` means
  moving `startQueenTick`, whose closure is 37 of the 38 declarations.
- After any edit to the file, re-run
  `node trios/tools/queen-tick-split-survey.mjs` and the survey re-derives
  every number from the new text; the tool holds no list of declarations to
  go stale.
