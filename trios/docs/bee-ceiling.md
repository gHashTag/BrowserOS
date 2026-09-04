# The bee ceiling

The Queen's worker ceiling, `maximumConcurrentWorkers = 4`, is a policy
number. It is not the output of a measurement: no run has ever varied the
number and recorded what the swarm did. Every fact quoted below was found in
this checkout by the searches in the next section, run on 2026-09-03, or is
quoted from the measurements recorded in `.trinity/dashboard/PARALLEL-BEES.md`
and `.trinity/dashboard/CLOUD-MIGRATION.md`.

This document does not recommend a new value. It records where the number
lives, what would have to be true before it moves, and the one quantity that
has never been measured. The number is the operator's.

## Where the number lives, and how that was found

Both searches were run from the repository root:

```sh
grep -rn "maximumConcurrentWorkers\|MAX_CONCURRENT_WORKERS" rings/ agent-server/queen-core/ tests/
```

```sh
grep -rn "workers already running" rings/ agent-server/ tests/
```

The first finds **every declaration and every read of the constant**: 23 hits
across 10 files. Stripped of user-facing strings and comments that merely
mention it, the number is *declared* in six places, below. The second finds the
refusal the cap produces, which is how anyone notices it at all.

### Declaration sites

| # | Site | Language | What is written there |
|---|------|----------|----------------------|
| 1 | `rings/SR-00/QueenDelegation.swift:470` | Swift | `public static let maximumConcurrentWorkers = 4` — the Mac Queen's policy |
| 2 | `rings/T27-00/queen_core.t27:37` | T27 | `pub const MAX_CONCURRENT_WORKERS: i32 = 4;` — the container's parity ring, generated to Rust and Zig |
| 3 | `agent-server/queen-core/Sources/QueenPolicy/QueenDelegation.swift:470` | Swift | byte-identical Linux copy of site 1, compiled inside the container image |
| 4 | `tests/t27/ring00_parity.sh:172` | shell | `"k01|MAX_CONCURRENT_WORKERS|4|…"` — the parity table pins the T27 constant to a literal `4` written in the test |
| 5 | `tests/swift/queen_t27_measurement_test.swift:81` | Swift | `pub const MAX_CONCURRENT_WORKERS: i32 = 4;` — captured generated Rust, pasted into the test |
| 6 | `tests/swift/queen_t27_measurement_test.swift:117` | Swift | the same constant in captured generated Zig |

Six declarations, three of them (rows 1–3) live at runtime, three (rows 4–6)
are literals in tests that go stale if the constant moves and they do not.

### Enforcement sites

The constant is *enforced* through one gate per language, called from several
places:

| Site | Role |
|------|------|
| `rings/SR-00/QueenDelegation.swift:472-473` | `canStartAnother(running:)` — the Swift gate |
| `rings/T27-00/queen_core.t27:198-199` | `can_start_another(running)` — the T27 gate |
| `rings/T27-00/queen_core.t27:204-208` | `free_slots(running)` — headroom arithmetic on the same constant |
| `rings/SR-02/QueenDelegationRegistry.swift:176` | Mac caller; :177-178 prints the refusal |
| `rings/SR-02/ChatViewModel.swift:5171` | Mac dispatch caller; the re-check after the last `await`, :5175 names the limit |
| `rings/SR-02/ChatViewModel.swift:8192` | send-back sweep — a returned worker re-takes a slot, so this gate throttles returns to the cap |
| `rings/SR-02/ChatViewModel.swift:9523` | pre-deployment gate; :9524-9525 prints the refusal |
| `rings/SR-02/ChatViewModel.swift:9906` | resuming stranded rejected tasks, one slot at a time |
| `agent-server/queen-core/Sources/queend/main.swift:192` | container caller; :194-195 prints `"<n> workers already running (limit 4)"` |

The refusal string `"4 workers already running (limit 4)"` appears verbatim in
`agent-server/apps/server/tests/api/queen-board-record.test.ts:108` and
`agent-server/apps/server/src/api/services/queen-tick.ts:407`; those two record
a defect the cap's message once hid — finished-but-unjudged tasks held slots,
so the message reported four workers where exactly one bee existed. The
message counts states, not bees, and any raise multiplies that distinction's
importance.

### Two languages, no agreement check

Raising the number means editing site 1 **and** site 2 — Swift and T27 are
different languages, compiled separately, and neither imports the other.
Nothing checks that they agree. The nearest thing is the parity harness
(`tests/t27/ring00_parity.sh`, run by `make t27-rings` inside `make check`):
row `k01` reads the constant out of the **generated Rust** and compares it to
the literal `4` in row 4 above. The Swift location is cited in that row's
trailing column — as prose, not as something the test reads. The Swift source
is never opened by any test that also opens the T27 source. Concretely: edit
only `QueenDelegation.swift` and every check stays green while the two Queens
disagree; edit only the `.t27` and the parity row fails on its own stale
literal, which names the row, not the disagreement.

The Swift pair (rows 1 and 3) is different: `make queen-core-sync`
(`Makefile:1079`) compares the Linux copy byte for byte against
`rings/SR-00`. That target is not in the `make check` line (`Makefile:2024`)
and not called by `build.sh` or CI — it is a check that exists but must be
invoked by hand. The Swift↔T27 pair has no counterpart at all.

## The two limits

There are two ceilings over the swarm and they are set by different things.
The policy cap is a constant compiled into two languages
(`maximumConcurrentWorkers` in Swift, `MAX_CONCURRENT_WORKERS` in T27). The
lane count is arithmetic over credentials at runtime:
`configuredWorkerCapacity()` at
`agent-server/apps/server/src/api/services/queen-dispatch.ts:156` computes

```
keys × lanes-per-key
```

where keys come from `keysFor()` (`queen-dispatch.ts:115`, reading
`ZAI_API_KEY`, `ZAI_API_KEY_2` … `_16`, deduplicated because two names for
one secret are one rate limit, not two), and lanes-per-key comes from
`configuredWorkerLanesPerCredential()` (`queen-dispatch.ts:139`, reading
`TRIOS_ZAI_CONCURRENCY_PER_KEY`, failing safe to 1, bounded at 4, applied to
Z.ai only). A lane is handed out by slot through `resolveWorkerProvider()`
(`queen-dispatch.ts:182`), spreading bees across distinct keys before reusing
a key, and when every lane is taken the refusal names the credential, not the
policy: "all N provider key(s) are already in use …" (`queen-dispatch.ts:1169`).

The arithmetic today, measured 2026-09-03 on production: two live Z.AI keys,
two lanes each, so `2 × 2 = 4` effective lanes, against a policy cap of 4.
Which binds first is `min(policy cap, keys × lanes)` — and today the two are
**equal**, which is precisely why they are mistaken for one limit. They are
not: the policy cap is a constant an operator edits in a compiler-checked
file, the lane count is whatever the environment happens to hold this deploy,
and either can move without the other. The equality is a coincidence of one
measurement on one day, not a designed invariant — and it is also the
observation that the swarm went idle twelve issues later: with the backlog
consumed the effective ceiling and the policy ceiling were reached together,
and every round that still had work refused with `4 workers already running
(limit 4)`.

## What the 96-call measurement did and did not cover

`PARALLEL-BEES.md` fired real tool calls at the container: 96/96 succeeded in
2.6 s, 200/200 in 3.1 s, and under 100 sustained concurrent commands memory
sat at 5%, pids at 10%, load near half of 24 vCPU. What that covered: the
container's capacity to serve concurrent *tool* invocations — filesystem and
shell calls into a machine nobody was supervising from.

What it did not cover, because none of it was running: a single model-backed
worker. No provider request was made at any width, so it says nothing about
key rate limits, lane contention, or 429s; no Queen review was issued at any
width, so it says nothing about verdict cost as workers multiply; no two
workers' branches were merged, no SSE stream ran against the Mac's main
actor, and no dispatch lived long enough to meet the reaper. The table in
`PARALLEL-BEES.md` that estimates what fails first at wider swarms (keys,
pids, memory, the main actor, the JS thread) is arithmetic over separate
single measurements, not an observation of a swarm at any width. It refutes
the cap's own stated reasons — verdicts are one-shot requests with empty
history, and file collisions are already handled structurally by
`pathsOverlap`/`conflictingTasks` (`QueenDelegation.swift:579`, `:636`) —
but refuting a reason is not measuring a ceiling.

## What has never been measured

**What has never been measured is the swarm's completed-issue throughput —
issues accepted per hour, alongside 429s per issue and time-to-verdict — with
the cap deliberately raised past its current value on live keys, so that the
width at which marginal throughput stops rising is an observed fact rather
than an inference.** Every measurement to date sits at one of two extremes:
zero workers (the parked-review period, where the cap never fired because
nothing ran) or four workers (the 2026-09-03 run, where it fired on every
round with a backlog). Nothing exists between or beyond those points, so the
cost side of the ledger — review latency as width grows, retry storms when
keys saturate, the Mac's main actor under several SSE streams — has never
been seen even once, and the benefit side, issues per hour per additional
lane, has never been seen either. The measurement that would settle the cap
is that curve: raise the policy number by small steps on a deployment whose
key rotation is wired onto the request path (it exists at
`rings/SR-00/ModelConfigurationStore+KeyRotation.swift:44-59` and its only
callers today are a UI toggle), record throughput and refusals per width, and
stop at the width where throughput flattens or refusals climb. The cap then
becomes the observed knee in that curve. Until the curve exists, any number
is an opinion, including the current one.

## What would have to be true before the number moves

Stated as conditions, in the order `PARALLEL-BEES.md` itself puts them —
none of them is a value:

1. **Key rotation on the request path.** `ModelConfigurationStore+KeyRotation.swift:44-59`
   has no caller on the request path; its only callers are a UI toggle. Until
   it is called where provider requests are made, every additional concurrent
   worker is an additional share of one key's rate limit.
2. **A 429 charged to the credential, not the issue.**
   `rings/SR-00/QueenRetryPolicy.swift:88-108` classifies a throttled
   response as `producedNothing`, and `:67` retires an issue after two real
   attempts. Concurrency makes 429s certain; until throttling stops
   destroying work, a wider swarm widens the blast radius.
3. **The process group killed, not the parent.** A worker whose children
   survive its kill holds its slot until the process restarts; measured, a
   3 s timeout was still pending at 25 s.
4. **The six sites in this document edited together, in the same commit** —
   or the tests of rows 4–6 knowingly updated to the new literals — with the
   understanding that nothing will fail if the two languages disagree.
5. **The lane count known at decision time.** The policy cap and
   `keys × lanes` are set by different files and different mechanisms; a
   number chosen without knowing which one is smaller on the target
   deployment is a number chosen blind.

## Boundary

This document is the deliverable. No Swift, Rust, T27 source or Makefile was
edited to produce it, and it changes no behaviour: `trios/docs/bee-ceiling.md`
is the only file it adds.
