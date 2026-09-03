# T27-02: the tick's purity survey

Every function declared at module level in
`trios/agent-server/apps/server/src/api/services/queen-tick.ts` (1737 lines, sha256 71376c8d54e9),
classified `pure`, `io` or `prose` so the ring migration can be mechanical:
`pure` means arguments in, value out - no I/O, no clock, no string
formatting for a person - and only those can be generated from `.t27`.
`io` touches the pool, the network or the file system. `prose` returns a
sentence a person reads.

Produced by `trios/tools/tick-purity-survey.mjs` (Node standard library
only). The script reads the source read-only and writes only this file.

## Method

- Module level means the declaration starts at column 0:
  `function`, `async function`, their `export` forms, and
  `const NAME = (...) =>` arrows. 25 functions were found.
- Classification is by NAMED TOKENS in the function body (FR-001). The io
  tokens, in precedence order (the first category with a match decides the
  row and names its token):

| category | tokens |
| --- | --- |
| postgres | `pool.query`, `pool.connect`, `new Pool` |
| network | `fetch(` |
| child process | `spawn(` |
| clock | `Date.now()`, `new Date(`, `setInterval(`, `setTimeout(`, `clearInterval(` |
| environment | `process.env` |
| log | `logger.` |
| io import | `acquireQueenLease(`, `releaseQueenLease(`, `logLeaseOutcome(`, `queenLeaseDatabaseUrl(`, `dispatchBee(`, `reapStalledDispatches(`, `reapDispatchesFromPreviousBoot(`, `committedFiles(`, `committedFileCount(`, `setDurableCloseListener(` |

- Two further rules:
  1. A call to another module-level function this survey classifies io is
     itself an io token - the callee's clock, store or network reach is
     part of the caller's behaviour.
  2. A function with no io token whose declared return type is
     `string`/`string[]` and whose body builds that string with
     `${...}` interpolation is `prose`.
- A body containing no classifying token is `pure` (FR-002). That default
  is the rule most likely to be wrong, so its count is stated below.
- Precedence: io > prose > pure.
- Token search is plain text over the body, comments included; the three
  pure bodies contain none of the tokens even in their comments.

## The table

| function | line | class | deciding token |
| --- | --- | --- | --- |
| queendPath | 70 | io | process.env |
| tickIntervalSeconds | 129 | io | process.env |
| openIssues | 162 | io | fetch( |
| ensureQueenColumns | 219 | io | pool.query |
| rememberIssues | 276 | io | pool.query (also: logger.) |
| isoSeconds | 336 | io | new Date( |
| stateOfDispatch | 379 | pure | (no classifying token) |
| boardTask | 390 | io | isoSeconds( (call to a function this survey classifies io) |
| boundaryPathsOf | 466 | pure | (no classifying token) |
| bodiesFor | 492 | io | fetch( |
| askQueend | 516 | io | spawn( |
| startLeaseHeartbeat | 596 | io | setInterval( (also: clearInterval(, logger., acquireQueenLease() |
| runQueenTickOnce | 627 | io | acquireQueenLease( (also: logLeaseOutcome(, releaseQueenLease() |
| runRound | 675 | io | pool.query (also: new Date(, process.env, logger., reapStalledDispatches(, dispatchBee() |
| briefFor | 991 | prose | `# ${repo}#${issue}` (string return, sentences for a person) |
| criteriaBlock | 1106 | prose | `${i + 1}. ${c}` (string return, sentences for a person) |
| workerSystemPrompt | 1140 | prose | `You are a Trinity worker...` (string return, sentences for a person) |
| boundaryStrays | 1188 | io | logger. |
| reviewFinishedDispatches | 1239 | io | pool.query (also: logger., committedFiles() |
| parseVerdictBlock | 1355 | pure | (no classifying token) |
| report | 1421 | io | pool.query |
| recordTick | 1509 | io | pool.query |
| createRoundGate | 1571 | io | logger. |
| refillOnBeeCompletion | 1658 | io | setDurableCloseListener( |
| startQueenTick | 1672 | io | new Pool (also: setInterval(, clearInterval(, logger., queenLeaseDatabaseUrl(, reapDispatchesFromPreviousBoot(, releaseQueenLease() |

## Totals

- pure: 3
- io: 19
- prose: 3
- rows: 25 (3 + 19 + 3 = 25)
- decided `pure` by the absence of any classifying token: 3
  (stateOfDispatch, boundaryPathsOf, parseVerdictBlock) - the set most likely to be wrong.

## The pure set, signatures as written

These are the `.t27` candidates: the argument and return shapes below are
what a `.t27` signature has to say. Whitespace is collapsed; types are
otherwise exactly as written in the source.

| function | parameters | return |
| --- | --- | --- |
| stateOfDispatch | finished: boolean, reviewState: unknown | 'running' \| 'accepted' \| 'rejected' \| 'awaitingReview' |
| boundaryPathsOf | body: string | string[] |
| parseVerdictBlock | text: string | Array<{ criterion: string; met: boolean }> |

`stateOfDispatch` and `parseVerdictBlock` are the two the issue names as
pure by inspection; `boundaryPathsOf` is the third this survey finds. It
is a deliberate re-implementation of the Swift boundary rule so the board
can be drawn without spawning `queend` - a parser of its argument and
nothing else.

## Excluded by rule, and why

- Function declarations NESTED inside another function's body are not
  module-level and are not rows: `stop` (line 620, inside
  `startLeaseHeartbeat`), `settle` (1582) and `turn` (1589, both inside
  `createRoundGate`), `round` (1701) and `handover` (1724, both inside
  `startQueenTick`), plus the object methods of the `RoundGate` return
  value. The ring question applies to them through their enclosing rows.
- Interfaces are types, not functions: `SpecVerdict`, `QueendChoice`,
  `LeaseWatch`, `ReviewRound`, `RoundGate`.
- Module-level consts that are not functions: `LEASE_NAME`,
  `ZERO_UUID`, `LEASE_TTL_SECONDS`, `HEARTBEAT_SECONDS`,
  `ISSUE_PAGE_SIZE`, `ISSUE_PAGE_CAP`, `heartbeats` (a Set), `timer`.

## Rows a reader may want to argue with

- `boardTask` (io) - the only row decided by the callee rule. Its body's
  single non-pure act is calling `isoSeconds(`, which is io by
  `new Date(`. Pass the formatted timestamps in as arguments and
  `boardTask` becomes pure: it is otherwise a shape builder over its
  arguments, and an obvious `.t27` candidate once the clock is removed.
- `isoSeconds` (io) - `new Date(value)` parses its argument rather than
  reading the clock, but `new Date(` is one of the issue's own deciding
  tokens, and a `.t27` signature cannot assume JS date semantics either,
  so it stays io.
- `report` (io) - its body is prose assembly, but it ends in
  `pool.query`; the store outranks the sentences. The sentences are the
  prose half of a function the ring cannot own.
- `createRoundGate` (io) - no pool, no network, no clock of its own; the
  deciding token is `logger.` alone. It is a scheduler's queue, not a
  decision, so it does not belong in the ring either way.
- `refillOnBeeCompletion` (io) - a pure-shaped body whose one act
  registers a durable listener (`setDurableCloseListener(`).
- `boundaryStrays` (io) - cited on `logger.`, its only direct io token,
  but the load-bearing reason is one step down: it calls `askQueend(`,
  which spawns the policy binary. The callee rule found that for
  `boardTask`; here it is masked by the weaker direct token.
- `startLeaseHeartbeat` (io) - cited on `setInterval(`; the same body
  also renews the lease through `acquireQueenLease(` and logs through
  `logger.`.
