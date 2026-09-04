# The loop's instruments

A cron fires every fifteen minutes and asks for the same thing: find the weak
points, act on them, and do not break what the previous fire built. These are
the tools that fire answers with. They are ordinary Node scripts with no
dependencies; every one of them can be run by hand.

    node heal.mjs            # the whole chain, in order
    node heal.mjs --dry      # the same chain, reading only
    node loop.mjs status     # iteration, lock, counts
    node loop.mjs dash       # the dashboard as last rendered
    node selftest.mjs        # 43 calibration cases, no network

## The chain

`heal.mjs` runs eleven steps in a fixed order. Four of them act; the rest read.
A step that acts is named for what it frees.

| step | acts | what it is for |
|---|---|---|
| `reap` | yes | free the volume before anything else; bees die at 0s on a full disk |
| `lease` | yes | release path fences held by dispatches that finished long ago |
| `push-work` | yes | 63 branches and 1321 files once sat in a container nobody could see |
| `close-done` | yes | an accepted issue left open keeps claiming its own boundary |
| `stale-escalations` | yes | retire an escalation whose stated cause no longer reproduces |
| `clocks` | no | no decision keyed on a field something rewrites |
| `fields` | no | no decision reading a column its query never selected |
| `fp-check` | no | no checker accusing material the world calls good |
| `verdict-audit` | no | what the swarm claims, against what it actually pushed |
| `judge-packet` | no | assemble what no mechanical check can reach, for a judge |
| `author` | yes | refill the backlog from a measured deficit, under a WIP limit |

## The three rules these were built from

**A checker that has never been shown failing has not been tested.** Six false
accusations shipped in one night while the synthetic fixtures agreed with the
checkers that wrote them. `fp-check.mjs` therefore runs each checker against
material the WORLD calls good - briefs a worker actually satisfied, source the
tree actually ships - and any accusation there is a false one. `selftest.mjs`
proves the negative first: every case plants a known defect and asserts the tool
notices.

**Unreadable is not clean.** A step that cannot reach its evidence reports `??`,
never `ok`. The first run of `stale-escalations.mjs` could not compile its
parser probe and said so; had it reported clean it would have retired six
escalations on no evidence at all.

**A clock may only release what a clock can settle.** `sendBack` and `wait` are
released by time because their input can never change. An escalation names a
cause, so `stale-escalations.mjs` re-measures the cause and releases nothing
whose cause still holds - and nothing at all whose issue asks for a person in
its own words.

## Runtime, and what is deliberately not here

`state.json`, `ledger.jsonl`, `loop.lock`, `packets/`, `state/` and the rendered
dashboards are produced by a run and are gitignored. The ledger is append-only
and the state carries the anchors the dashboard renders from; both are only
meaningful on the machine that produced them.

The lock is held for an ITERATION, not a process. An iteration is many
short-lived processes, so pid liveness is useless: the process that took the
lock has always exited by the time the next call looks. Age is the only sound
test, and the window (45 minutes) is deliberately longer than the 15-minute
cadence - after a crash it is better to skip two fires than to let two write at
once.

## Quoting

`shq()` exists because `execSync` hands its string to the LOCAL `/bin/sh`. A
payload built with `JSON.stringify` is double-quoted, so `$1`, `$base` and
`$(...)` expand here rather than there. That produced two confident wrong
diagnoses: `any($1)` reached Postgres as `any()`, and a branch survey reported
0 branches against a container holding 118. Four selftest cases pin it.
