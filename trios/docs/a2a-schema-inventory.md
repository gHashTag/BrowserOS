# A2A schema inventory — Task/Message/Envelope/Event shapes in the agent server

## Why this file exists

Issue gHashTag/trios#1083 (info-drop, async-only, filed 2026-07-08) records that
two anonymised `.tri` specifications are landing upstream in t27 —
`specs/scenes/scene_schema.tri` (a generic scene FSM) and
`specs/runtime/ring_runtime.tri` (a generic ring worker) — and that of the three
questions asked there, exactly one is answerable from this repository: does
trios already have a shared worker/task schema that those two specs would
duplicate? That question is answered by counting. Either the agent server
contains such a schema or it does not; this file is the count.

Both spec names above are quoted from the issue text only. No file outside this
repository was read, referenced or consulted to produce this document.

## Method — the script, so it can be re-run

The inventory table below was produced mechanically (not hand-typed) by this
exact command line, run from the repository root (the `apps/server/src/api/`
tree named in the issue lives under `agent-server/` in this checkout):

```
cd agent-server && grep -rnE '^[[:space:]]*(export[[:space:]]+)?(interface|type)[[:space:]]+[A-Za-z0-9_]+(Task|Message|Envelope|Event)([[:space:]]*([<{=]|extends)|[[:space:]]*$)' apps/server/src/api | sort -t: -k1,1 -k2,2n | awk -F: '{ line=$0; sub(/^[^:]+:[0-9]+:/, "", line); match(line, /(interface|type)[[:space:]]+[A-Za-z0-9_]+/); n=substr(line, RSTART, RLENGTH); sub(/^(interface|type)[[:space:]]+/, "", n); print "| " n " | " $1 " | " $2 " |" }'
```

How it works: `grep` matches declaration lines only — a line must begin
`interface X` or `type X` (optionally `export`-prefixed), the identifier must
end in `Task`, `Message`, `Envelope` or `Event`, and it must be followed by
`{`, `<`, `=`, `extends`, or end-of-line. That follow-set is what keeps import
clauses (for example `type QueuedMessage,`) out of the inventory, since an
import continues with a comma rather than a declaration token. `sort` orders by
file then numeric line; `awk` extracts the identifier and shapes each match
into a table row with its file and line.

## Inventory

Every TypeScript `interface` or `type` whose name ends in `Task`, `Message`,
`Envelope` or `Event` under `apps/server/src/api/` — 13 declarations, verbatim
output of the command above:

| name | file | line |
| --- | --- | --- |
| RegistryTask | apps/server/src/api/routes/queen-kanban.ts | 352 |
| A2aMessage | apps/server/src/api/services/a2a/a2a-registry-service.ts | 24 |
| A2aTask | apps/server/src/api/services/a2a/a2a-registry-service.ts | 33 |
| TurnLifecycleEvent | apps/server/src/api/services/agents/agent-harness-service.ts | 184 |
| OpenClawChatMessage | apps/server/src/api/services/openclaw/openclaw-cli-client.ts | 54 |
| OpenClawChatHistoryMessage | apps/server/src/api/services/openclaw/openclaw-http-client.ts | 11 |
| OpenClawSessionHistoryMessage | apps/server/src/api/services/openclaw/openclaw-http-client.ts | 41 |
| OpenClawSessionHistoryEvent | apps/server/src/api/services/openclaw/openclaw-http-client.ts | 81 |
| OpenClawStreamEvent | apps/server/src/api/services/openclaw/openclaw-types.ts | 7 |
| TerminalClientMessage | apps/server/src/api/services/terminal/terminal-protocol.ts | 41 |
| TerminalServerMessage | apps/server/src/api/services/terminal/terminal-protocol.ts | 42 |
| FamilyAuditEvent | apps/server/src/api/services/token-family-store.ts | 19 |
| AuthAuditEvent | apps/server/src/api/services/token-family-store.ts | 27 |

Notes, also verified from this tree:

- `QueuedMessage` is imported by `services/agents/agent-harness-service.ts` and
  `routes/agents.ts`, but it is declared at
  `apps/server/src/lib/agents/message-queue.ts:19` — outside the
  `apps/server/src/api/` tree this inventory is scoped to — so it is not a row
  above.
- A search of all of `apps/server/src/` finds no declaration named for a scene
  FSM or a ring worker, and this repository contains no `.tri` files at all.

## The answer to the duplication question

Compared with the two t27 spec names, `scene_schema.tri` and `ring_runtime.tri`, no entry in the inventory shares either name or describes a scene-FSM or ring-worker shape: the nearest candidates (`A2aTask` and `A2aMessage` in `a2a-registry-service.ts`, `RegistryTask` in `queen-kanban.ts`) are agent-server-internal service and view types, not a shared worker schema.
No overlapping schema exists.