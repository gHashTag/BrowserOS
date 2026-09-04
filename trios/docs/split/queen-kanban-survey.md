# Survey of `trios/agent-server/apps/server/src/api/routes/queen-kanban.ts`

Produced for gHashTag/trios#1406 by `trios/tools/queen-kanban-split-survey.mjs`.
The file is 1066 lines and nothing had ever said what is inside it. This
document reports. It does not split anything, and the judgement of whether and
when to split stays with a person.

- Run: `node trios/tools/queen-kanban-split-survey.mjs`
- Target: `trios/agent-server/apps/server/src/api/routes/queen-kanban.ts`
- File lines (measured this run): **1066**, 46079 bytes,
  sha256 `753e82bbb8fb4fec1da1b79cfad6a91efc1e820cb2f45e3417aab7d7e46c5821`
- Measured on the working tree of branch `queen-1406`, which is identical to
  `origin/feat/queen-supervisor` for this file (`git diff --stat
  origin/feat/queen-supervisor -- <file>` is empty).
- Determinism: two consecutive runs produced identical bytes - `cmp` silent,
  both sha256 `62b3ddfa6da4fd131f4e276abea9de0efd5b6c8676d230eba91e1b16c6f9a488`.

## Definitions the numbers rest on

- **declaration** - a top-level `import`, `interface`, `type`, `enum`, `class`,
  `function` or variable statement, found by parsing the source text. Nothing is
  taken from a list written into the tool, so the survey does not go stale the
  moment the file changes.
- **reference** - declaration A references declaration B when A's source text
  uses B's name outside a comment, a string body, a regex body or a property
  access. Mentions inside doc comments deliberately do NOT count: the comment
  above `pipelineRank` names `COLUMNS` and the comment above `RegistryTask`
  names `stillHoldsBoundary`, and neither is a dependency. A reference to an
  import is not a dependency either - an import is re-declared in a new module,
  it does not travel with the code.
- **independently extractable (declaration)** - references no other declaration
  in this file. Moving it needs nothing else from this file.
- **independently extractable (group)** - a connected component of the file's
  reference graph, other than the whole file. Members depend only on each other
  and on imports, and nothing left behind references them, so moving the group
  deletes lines from this file and adds no import to it.
- Doc comments directly above a declaration are not part of its span; they are
  counted separately and reported, because in practice they travel with an
  extraction.

## 1. Every top-level declaration, longest first

29 declarations, 3 imports, 0 unparsed. Line ranges are this file's own lines.

| lines | len | kind | exported | name | references (other declarations in this file) |
|---|---|---|---|---|---|
| 709-1023 | 315 | const | no | `SHELL` | (none) |
| 376-460 | 85 | async function | no | `build` | Card, Pulse, RegistryTask, composeCards, providerKeyCount |
| 640-700 | 61 | function | no | `addUntakenIssues` | Card, RegistryTask, asPaths, dispatchState, pathsOverlap, stillHoldsBoundary |
| 579-614 | 36 | function | no | `addInFlight` | Card, asPaths, dispatchColumn, dispatchDetail |
| 539-568 | 30 | function | no | `addRegistryTasks` | Card, RegistryTask, columnFor, pipelineRank |
| 103-126 | 24 | function | yes | `publicBoardProjection` | COLUMNS, Card, PublicBoard, Pulse |
| 330-350 | 21 | function | no | `addCriteria` | Card |
| 302-320 | 19 | function | no | `addLastRoundReasons` | Card |
| 495-513 | 19 | function | yes | `providerKeyCount` | (none) |
| 1025-1043 | 19 | function | yes | `createQueenBoardRoute` | COLUMNS, build |
| 52-67 | 16 | interface | no | `Card` | (none) |
| 69-84 | 16 | const | no | `COLUMNS` | (none) |
| 1045-1060 | 16 | function | yes | `createQueenPublicBoardRoute` | build, publicBoardProjection |
| 128-142 | 15 | function | no | `columnFor` | (none) |
| 195-207 | 13 | function | no | `stillHoldsBoundary` | REVIEW_BOUNDARY_HOLD_HOURS, RegistryTask |
| 352-364 | 13 | interface | no | `RegistryTask` | (none) |
| 473-485 | 13 | interface | yes | `Pulse` | (none) |
| 163-174 | 12 | function | no | `pipelineRank` | (none) |
| 266-277 | 12 | function | no | `dispatchDetail` | (none) |
| 524-533 | 10 | function | yes | `composeCards` | BoardInput, Card, addCriteria, addInFlight, addLastRoundReasons, addRegistryTasks, addUntakenIssues |
| 86-94 | 9 | interface | yes | `PublicBoard` | COLUMNS, Card, Pulse |
| 367-374 | 8 | interface | yes | `BoardInput` | RegistryTask |
| 632-638 | 7 | function | no | `dispatchState` | (none) |
| 217-222 | 6 | function | no | `normalizeBoundaryPath` | (none) |
| 238-243 | 6 | function | no | `pathsOverlap` | normalizeBoundaryPath |
| 258-263 | 6 | function | no | `dispatchColumn` | (none) |
| 1062-1066 | 5 | function | yes | `createQueenKanbanRoute` | SHELL |
| 288-291 | 4 | function | no | `asPaths` | (none) |
| 185-185 | 1 | const | no | `REVIEW_BOUNDARY_HOLD_HOURS` | (none) |

Imports (top-level, in file order):

| line | module | binds |
|---|---|---|
| 48 | `hono` | Hono |
| 49 | `pg` | Pool |
| 50 | `../services/queen-lease` | queenLeaseDatabaseUrl |

Unparsed top-level statements: **0**. The parser classified every statement.

## 2. Accounting

Every line of the file lands in exactly one bucket, so the survey can be checked
against the file itself:

| bucket | lines |
|---|---|
| declaration lines (29 declarations) | 817 |
| import lines (3 imports) | 3 |
| unparsed statement lines (0) | 0 |
| comment lines (attached and standalone) | 216 |
| blank lines | 30 |
| **accounted total** | **1066** |
| **file line count (measured)** | **1066** |

Declaration lines + unparsed lines = 817 + 0 = 817; with imports, comments and
blanks the total is 1066, which equals the file's own line count. They agree.

## 3. Independently extractable declarations

A declaration is independently extractable when it references no other
declaration in this file.

**14 declarations, 455 lines (42.7% of 1066):**

SHELL (315), providerKeyCount (19), Card (16), COLUMNS (16), columnFor (15),
RegistryTask (13), Pulse (13), pipelineRank (12), dispatchDetail (12),
dispatchState (7), normalizeBoundaryPath (6), dispatchColumn (6), asPaths (4),
REVIEW_BOUNDARY_HOLD_HOURS (1).

Note what this list is and is not: these declarations need nothing else from
this file to move, but most of them are used by the declarations around them,
so moving one alone would leave this file importing it back. `SHELL` is the
exception worth noticing - nothing else in the file uses it except the route
that serves it.

## 4. Reference-graph components

The file's declarations partition into exactly two connected components:

1. **497 declaration lines, 27 declarations** - the board's data logic: every
   interface, every helper, `build`, `composeCards`, and the two routes that
   serve JSON (`createQueenBoardRoute`, `createQueenPublicBoardRoute`).
   [independently extractable group]
2. **320 declaration lines, 2 declarations** - `SHELL` (the HTML page, 315
   lines) and `createQueenKanbanRoute` (the route that serves it, 5 lines).
   [independently extractable group]

The two halves never reference each other. That is the structural fact a split
would stand on: this is not one 1066-line tangle, it is two modules sharing a
file - a board-data module and an HTML shell - plus nothing else.

## 5. Recommended single extraction (one move, with its cost)

By the rule "the largest independently extractable group", the recommendation
is component 1: move the board's data logic out, keep the HTML shell here.

- **Group**: BoardInput, COLUMNS, Card, PublicBoard, Pulse,
  REVIEW_BOUNDARY_HOLD_HOURS, RegistryTask, addCriteria, addInFlight,
  addLastRoundReasons, addRegistryTasks, addUntakenIssues, asPaths, build,
  columnFor, composeCards, createQueenBoardRoute, createQueenPublicBoardRoute,
  dispatchColumn, dispatchDetail, dispatchState, normalizeBoundaryPath,
  pathsOverlap, pipelineRank, providerKeyCount, publicBoardProjection,
  stillHoldsBoundary (all 27 listed with line ranges in section 1).
- **Lines removed**: 497 declaration lines; 660 counting the doc comments that
  travel with them. This file keeps about 406 lines: the 46-line license
  header, the three imports, `SHELL` with its comment, and
  `createQueenKanbanRoute`.
- **Imports the moved code needs** (re-declared in the new module):
  `queenLeaseDatabaseUrl` (from `../services/queen-lease`), `Hono` (from
  `hono`), `Pool` (from `pg`).
- **References left behind in this file**: none. `SHELL` and
  `createQueenKanbanRoute` use none of the moved names, so this file needs no
  new import - the edit is deletion plus the new module.
- **Call sites outside this file that need their import changed** (from a scan
  of 1182 source files under the repository root):
  - `trios/agent-server/apps/server/src/api/server.ts:47-51` imports
    `createQueenBoardRoute` and `createQueenPublicBoardRoute` (used at lines
    240 and 339) from `./routes/queen-kanban`. The same import statement also
    brings `createQueenKanbanRoute`, which remains in this file - so that one
    import statement splits in two.
  - `trios/agent-server/apps/server/tests/api/queen-board.test.ts:5-9` imports
    `composeCards` and `publicBoardProjection` (used at lines 193, 222, 265,
    289, 311, 334 and five more) from `../../src/api/routes/queen-kanban`;
    the same statement also brings `createQueenKanbanRoute`, which stays.
- **Other references to this file's path** (not imports): the test reads the
  file by path at `queen-board.test.ts:64` to hold the board's rules against
  the Swift policy - unaffected by this move unless the assertions target
  moved text, which the survey does not guess at.

The honest caveat that comes with "largest": component 2 (SHELL +
createQueenKanbanRoute, 320 declaration lines, 327 with its comment) is the
smaller move with the same guarantee - nothing left behind references it, and
its external importers are the same two files named above (both import
`createQueenKanbanRoute`). It is the lower-risk half-step if moving 27
declarations in one commit is too much at once. Both are listed above; the rule
in the issue says recommend one, and by lines removed the data logic is the one.

## What this survey does not do

It does not split the file, does not modify any source, runs under plain `node`
with the Node standard library only, and invokes no TypeScript compiler, no
`make`, no build. To reproduce:

```
node trios/tools/queen-kanban-split-survey.mjs
```

Two runs with no edit between them are byte-identical (verified with `cmp`).
