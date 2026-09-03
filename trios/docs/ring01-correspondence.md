# RING-01 correspondence: the 22 constants and 9 functions of `a2a.t27` against the running server

Measured 2026-09-03 on branch `queen-1342`, commit `87f4fd32`. This is a survey: it
edits no file under `rings/` and no route file. No tool was written for it either —
the verification at the end ran as a `node -e` one-liner against the Node standard
library, so nothing outside this document was created.

## Scope and method

The spec is `rings/T27-01/a2a.t27` (223 lines): 22 `pub const` declarations and 9
`pub fn` declarations. The code under survey is the tree the spec itself names as
its contract (a2a.t27:13-17): the nine routes in `agent-server/apps/server/src/api/routes/a2a.ts`
(`register` a2a.ts:69, `unregister` :78, `heartbeat` :87, `agents` :99, `matrix`
:104, `message` :113, `task/assign` :122, `task/update` :131, `stream` :143), the
registry service behind them, the `agents` table in `pg-agent-store.ts`, and the
rest of `agent-server/apps/server/src` as search domain. The Swift client in
`rings/SR-02` is quoted in the notes as a mirror, but it is not the surveyed tree:
a row counts as played only if code under `agent-server/apps/server/src` plays the
role.

Every file cited below is under `agent-server/apps/server/src`; basenames are
unique in that tree, so rows cite them short, as the issue itself does:

- `a2a.ts` = `agent-server/apps/server/src/api/routes/a2a.ts`
- `a2a-registry-service.ts` = `agent-server/apps/server/src/api/services/a2a/a2a-registry-service.ts`
- `pg-agent-store.ts` = `agent-server/apps/server/src/api/services/a2a/pg-agent-store.ts`
- `queen-tick.ts` = `agent-server/apps/server/src/api/services/queen-tick.ts`
- `task-queue-service.ts` = `agent-server/apps/server/src/api/services/task-queue-service.ts` (notes only — a sibling subsystem, see Notes)

## The measurement the issue reports, reproduced

For each of the 22 constant names, `grep -rn <NAME> --include='*.ts'` over
`agent-server/apps/server/src` returns **0 lines**. The same holds for the
substring `taskResult` and `addToolCall`. The issue's count of 22-for-22 absent is
correct at this commit. The vocabulary that is present instead: string literals
(`'online'`, `'offline'`, `'pending'`, `'taskAssign'`, `'taskUpdate'`), two
millisecond thresholds, and one SQL interval.

## The correspondence table

Rows appear in spec order. `kind` is `constant` (a `pub const` in a2a.t27) or
`function` (a `pub fn`). `plays its role in` cites the file and line of the code
that plays the constant's or function's role, or is `none` when nothing under the
surveyed tree does. `encoding` records the literal verbatim where a literal plays
the role.

| spec name | kind | plays its role in | encoding |
| --- | --- | --- | --- |
| MSG_DIRECT | constant | none | none |
| MSG_BROADCAST | constant | none | none |
| MSG_TASK_ASSIGN | constant | a2a-registry-service.ts:204 | `'taskAssign'` |
| MSG_TASK_UPDATE | constant | a2a-registry-service.ts:234 | `'taskUpdate'` |
| MSG_TASK_RESULT | constant | none | none |
| MSG_ADD_TOOL_CALL | constant | none | none |
| MSG_HEARTBEAT | constant | none | none |
| MSG_ERROR | constant | none | none |
| requires_recipient | function | none | none |
| is_task_message | function | none | none |
| TASK_PENDING | constant | a2a-registry-service.ts:196 | `'pending'` |
| TASK_ASSIGNED | constant | none | none |
| TASK_IN_PROGRESS | constant | none | none |
| TASK_COMPLETED | constant | none | none |
| TASK_FAILED | constant | none | none |
| TASK_CANCELLED | constant | none | none |
| is_terminal | function | none | none |
| can_transition | function | none | none |
| AGENT_ONLINE | constant | pg-agent-store.ts:114 (also :59, :86, :132; a2a-registry-service.ts:122) | `'online'` |
| AGENT_OFFLINE | constant | pg-agent-store.ts:122 (also :153) | `'offline'` |
| HEARTBEAT_INTERVAL_SECONDS | constant | none | none |
| MISSED_BEATS_BEFORE_OFFLINE | constant | none | none |
| offline_after_seconds | function | pg-agent-store.ts:151 and :154 (PostgreSQL); a2a-registry-service.ts:169 and :308 (memory) | `90` seconds (SQL `INTERVAL`); `120_000` ms |
| is_alive | function | a2a-registry-service.ts:171-174 (memory); pg-agent-store.ts:154 (SQL predicate); view column at pg-agent-store.ts:79 | `now - last < threshold`; `last_heartbeat < NOW() - INTERVAL '90 seconds'` |
| status_from_heartbeat | function | pg-agent-store.ts:114 (online write) and :153 (offline write) | `'online'` on beat, `'offline'` on prune — two statements, one role |
| PRIORITY_LOW | constant | none | none |
| PRIORITY_MEDIUM | constant | none | none |
| PRIORITY_HIGH | constant | none | none |
| PRIORITY_CRITICAL | constant | none | none |
| outranks | function | none | none |
| is_valid_priority | function | none | none |

## Totals

31 data rows: 22 constants, 9 functions. Rows whose `plays its role in` is
`none`: **23** (17 constants — MSG_DIRECT, MSG_BROADCAST, MSG_TASK_RESULT,
MSG_ADD_TOOL_CALL, MSG_HEARTBEAT, MSG_ERROR, TASK_ASSIGNED, TASK_IN_PROGRESS,
TASK_COMPLETED, TASK_FAILED, TASK_CANCELLED, HEARTBEAT_INTERVAL_SECONDS,
MISSED_BEATS_BEFORE_OFFLINE, PRIORITY_LOW, PRIORITY_MEDIUM, PRIORITY_HIGH,
PRIORITY_CRITICAL — and 6 functions — requires_recipient, is_task_message,
is_terminal, can_transition, outranks, is_valid_priority). The remaining 8 rows
have a correspondence.

## The two heartbeats

They are not the same beat. In one sentence: `HEARTBEAT_INTERVAL_SECONDS = 30`
(a2a.t27:158, "the client sends one every 30") is the cadence of an agent's
liveness beat against the A2A registry, while `HEARTBEAT_SECONDS = 60`
(queen-tick.ts:127 — the line the issue cites as `queen-tick.ts:139`; no revision
inspected back to the constant's introduction at commit `a4d782c7`, where it sat
at line 73, has ever held the declaration at line 139, which today is a comment
about issue pagination) is the cadence at which the Queen lease-holder renews its
single-writer lease. The lines that decide it: an agent beat arrives as
`POST /a2a/heartbeat` (a2a.ts:87) and is written to the `agents` table —
`UPDATE agents SET last_heartbeat = NOW(), status = 'online'`
(pg-agent-store.ts:114) — the exact quantity `is_alive` consumes
(a2a.t27:151, 178-183); the Queen beat renews the lease instead —
`startLeaseHeartbeat` defaults `everyMs` to `HEARTBEAT_SECONDS * 1000`
(queen-tick.ts:599) and calls `acquireQueenLease(pool, LEASE_NAME, holder,
LEASE_TTL_SECONDS)` (queen-tick.ts:603) against `LEASE_TTL_SECONDS = 180`
(queen-tick.ts:126), touching `agents.last_heartbeat` not at all. Different
senders (any A2A agent vs the Queen process), different stores (`agents` row vs
the queen lease), different consumers (registry liveness vs single-writer
exclusion). Because they are different quantities, there is no factor-of-two
disagreement between spec and code here; what is true instead is that the spec is
silent about the lease — it states agent liveness only — and that is the finding.
The 30-second cadence itself is matched, not contradicted, by the client that
actually beats: `startHeartbeat(interval: TimeInterval = 30)` in
`rings/SR-02/A2ARegistryClient.swift:136`.

## Notes on the rows

These are the facts a generation step must carry; each expands a row above.

- **The server never dispatches on message kind.** `POST /message` validates only
  that `id`, `sender` and `type` are present (a2a.ts:115-117) and forwards the
  message whatever its `type`; the only kinds the server itself constructs are the
  two task strings. Hence MSG_DIRECT, MSG_BROADCAST, MSG_TASK_RESULT,
  MSG_ADD_TOOL_CALL and MSG_ERROR are `none`: no literal and no branch plays them.
  Broadcast-ness is structural, not a kind: a message with no `recipient` fans out
  to all subscribers (a2a-registry-service.ts:256-267) and queues under the key
  `'__broadcast__'` (a2a-registry-service.ts:187) when undelivered; a message with
  a `recipient` goes to that agent alone (a2a-registry-service.ts:270-279). A
  migration from the integer kinds must know that on the server the
  direct-or-broadcast bit is carried by the presence of one field, not by the kind.
- **MSG_HEARTBEAT is `none` as a kind but the liveness beat exists, on another
  transport:** the HTTP route `POST /a2a/heartbeat` (a2a.ts:87-97), not a message.
  The `:heartbeat` line the SSE stream writes every 15 seconds (a2a.ts:197-201)
  is a connection keep-alive comment, not liveness — a third thing named
  "heartbeat" that is neither of the two in the section above.
- **The A2A task lifecycle has no state set in code.** `A2aTask.state` is
  `string` (a2a-registry-service.ts:37); `assignTask` writes `'pending'`
  (:196) and `updateTaskState` writes whatever the caller sent, verbatim,
  with presence-only validation on the route (a2a.ts:133,
  a2a-registry-service.ts:224-227). So TASK_ASSIGNED through TASK_CANCELLED,
  `is_terminal` and `can_transition` are `none`: no literal enumerates the other
  five states and no code refuses or checks any transition.
- **A sibling subsystem shares vocabulary but does not play these roles.**
  `task-queue-service.ts:17-24` defines `TaskStatus = 'pending' | 'running' |
  'completed' | 'failed' | 'cancelled'` over the `agent_tasks` table — the agent
  harness queue, not the A2A registry — and its cancel guard
  `status NOT IN ('completed', 'cancelled')` (task-queue-service.ts:438) is a
  terminal-set check that, unlike the spec's `is_terminal`, omits `'failed'`. Its
  middle state is `'running'`, not `'assigned'` or `'in_progress'`. Cited here so
  the strings are not mistaken for A2A's: they are a different protocol's states.
- **Liveness thresholds, the one place the code disagrees with itself.** The
  PostgreSQL and memory backends answer the same question — how long an agent may
  be silent before it is called offline, which is the quantity
  `offline_after_seconds()` names — and they answer it differently: 90 seconds in
  SQL (`pruneOffline(thresholdSeconds = 90)`, pg-agent-store.ts:151, applied as an
  `INTERVAL` at :154) and 120 000 ms in memory (`threshold = 120_000`,
  a2a-registry-service.ts:169 in `listAgents`, :308 in the watchdog, which itself
  runs every 60 000 ms at :338). The spec's `30 x 3 = 90` agrees with the
  PostgreSQL path; against the memory path the same quantity is 120 in code and 90
  in spec. Also true and worth carrying: the memory path does not mark an agent
  offline at all — it deletes it (a2a-registry-service.ts:332-334) — so
  `status_from_heartbeat`'s role is played only in the PostgreSQL backend, split
  across the `'online'` write at pg-agent-store.ts:114 and the `'offline'` write
  at :153. Nothing anywhere counts beats; `MISSED_BEATS_BEFORE_OFFLINE` is `none`.
- **Priority is an unvalidated number.** `A2aTask.priority` is `number`
  (a2a-registry-service.ts:38); `task/assign` checks only that a task and an
  agentId are present (a2a.ts:124) and `assignTask` stores the number without a
  range check (a2a-registry-service.ts:195-222). No code in the A2A path compares
  two priorities, so `outranks` is `none`; none bounds the value, so
  `is_valid_priority` is `none`.
- **The Swift mirrors, outside the surveyed tree, hold the wire encodings.**
  `A2AMessageType` is a `String` enum with the eight kinds
  (rings/SR-01/A2AMessage.swift:28-29); `AgentTaskState` is a `String` enum with
  the six states, raw value "in progress" spelled with a space
  (rings/SR-01/A2AMessage.swift:49-59); `AgentTaskPriority` is an `Int` enum
  0-3 in exactly the spec's order and `Comparable` via `<`
  (rings/SR-01/A2AMessage.swift:64-67) — which is where `outranks`' logic lives
  today, on the client, not the server. If a generation step wants the wire to
  carry these, it must reconcile with these encodings, which the server passes
  through but never inspects.

## Verification

Run after writing, from the project root with the Node standard library only:

```
node -e "const s=require('fs').readFileSync('docs/ring01-correspondence.md','utf8'); \
const rows=s.split('\n').filter(l=>/^\| [A-Za-z_]+ \| (constant|function) \|/.test(l)); \
const none=rows.filter(l=>l.includes('| none |')).length; \
console.log('chars', s.length, 'data rows', rows.length, 'none rows', none, \
'heading', (s.match(/^## The two heartbeats$/gm)||[]).length);"
```

Expected, and observed: `chars` ≥ 2500, `data rows` 31, `none rows` 23, `heading` 1.
