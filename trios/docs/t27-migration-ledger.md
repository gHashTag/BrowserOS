# T27 migration ledger

L0 states the law: everything below the interface is written in `.t27` and
generated to its target. This ledger measures the distance between that law
and this tree. Every number below was counted from the files at generation
time — nothing here is typed, retyped, or carried over by hand.

- Generated: `2026-09-03T16:04:06.256Z`
- Commit: `87f4fd32` (`git rev-parse --short HEAD`)
- Regenerate: `node tools/t27-migration-ledger.mjs` from the repository root,
  or `node trios/tools/t27-migration-ledger.mjs` from the directory that
  contains this repository.

## The migration surface

| ring | spec lines | hand-written lines | generated files |
| --- | --- | --- | --- |
| T27-00 | 209 | 1805 | 0 (not yet generated) |
| T27-01 | 223 | 933 | 0 (not yet generated) |
| T27-02 | 0 (no .t27 in tree) | 1737 | 0 (not yet generated) |
| T27-03 | 0 (no .t27 in tree) | 411 | 0 (not yet generated) |
| T27-04 | 0 (no .t27 in tree) | 131 | 0 (not yet generated) |

`spec lines` — total lines of every `*.t27` under `rings/<ring>/`. A ring
showing `0 (no .t27 in tree)` has no specification in this tree yet; the
walk found none, which is a count, not an assertion. `hand-written lines` —
total lines of the files that implement the same rule by hand today, summed
per ring in the breakdown below. `generated files` — every file under
`rings/<ring>/` that is not a `.t27` spec, i.e. what the compiler would have
emitted there. A ring showing `0 (not yet generated)` is marked so because
the count came back zero.

## Per-ring breakdown

### T27-00 — decision core: retry, review, merge gate, capacity

- Spec: `rings/T27-00/queen_core.t27` — 209 lines
- Hand-written twins (1805 lines total):
  - `agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift` — 1231 lines
  - `agent-server/queen-core/Sources/QueenPolicy/QueenCriterionVerdict.swift` — 219 lines
  - `agent-server/queen-core/Sources/QueenPolicy/ModelPricing.swift` — 224 lines
  - `agent-server/queen-core/Sources/QueenPolicy/QueenSalience.swift` — 131 lines
- Generated files under `rings/T27-00/`: 0 — not yet generated.

### T27-01 — A2A protocol

- Spec: `rings/T27-01/a2a.t27` — 223 lines
- Hand-written twins (933 lines total):
  - `agent-server/apps/server/src/api/routes/a2a.ts` — 223 lines
  - `agent-server/apps/server/src/api/services/a2a/pg-agent-store.ts` — 206 lines
  - `rings/SR-02/A2ARegistryClient.swift` — 504 lines
- Generated files under `rings/T27-01/`: 0 — not yet generated.

### T27-02 — orchestration: the Queen’s tick

- Spec: none found under `rings/T27-02/`.
- Hand-written twins (1737 lines total):
  - `agent-server/apps/server/src/api/services/queen-tick.ts` — 1737 lines
- Generated files under `rings/T27-02/`: 0 — not yet generated.

### T27-03 — transport: SSE

- Spec: none found under `rings/T27-03/`.
- Hand-written twins (411 lines total):
  - `rings/SR-01/SSETransport.swift` — 411 lines
- Generated files under `rings/T27-03/`: 0 — not yet generated.

### T27-04 — scoring: salience, reliability, latency

- Spec: none found under `rings/T27-04/`.
- Hand-written twins (131 lines total):
  - `agent-server/queen-core/Sources/QueenPolicy/QueenSalience.swift` — 131 lines
- Generated files under `rings/T27-04/`: 0 — not yet generated.

## Counts, not assertions

`.t27` files found under `rings/`, excluding copies inside `.claude`
worktree directories — the exclusion the quotable number forgot, applied
here by rule and counted here again:

- Walked and counted: 2 `.t27` file(s).
- Excluded as stale worktree copies (inside `.claude`): 0.
- Rings of the trunk with a `.t27` source: 2 of 5.
- Generated files across every trunk ring: 0.

The hand-written twin of the decision core is Swift, not Rust: the Dockerfile
builds `queend` from `agent-server/queen-core/Sources/` and the TypeScript
asks it every decision over stdin. The distance this ledger measures is the
gap between those Swift files and the `.t27` that restates them.
