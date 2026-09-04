# Silent-skip audit — report and the exemplar's repair

## The defect

`trios/rings/RUST-13/trios-mesh/build.rs` begins like this (post-image as
recorded in `.trinity/patches/trios-mesh-integration.patch`; the submodule is
not materialized in this checkout):

```rust
fn main() {
    let t27c = "../t27/target/release/t27c";
    if !Path::new(t27c).exists() {
        return; // t27c not available, skip regen
    }
    ...
    if !specs_dir.exists() || !gen_dir.exists() {
        return;
    }
```

The `../t27/target/release/t27c` path does not exist in this checkout, so the
hook has returned at its first branch every time it has ever run — and printed
nothing. `cargo build` prints nothing. The ring's own `STATUS.md` records that
46 of 68 committed artifacts differ from a fresh generation, and
`src/lib.rs:3-5` states that the generated stubs are excluded from compilation
and that four hand-written modules are the runtime surface.

A tool that cannot do its job and reports success is worse than one that
fails, because the failure is what would have been noticed.

## The audit

`trios/tools/silent-skip-audit.mjs` generalises this defect into a rule and
finds every occurrence in the tree. It runs on the Node standard library only,
invokes no external tool, never reads or writes anything under a `t27/`
directory, and never touches the inside of the `trios-mesh` submodule (its
recorded content is reconstructed from the committed integration patch and
audited under the submodule's real path).

### The rule (what counts as a silent skip)

A **silent skip** is all three of:

1. An **exit statement** — `return`, `continue`, or `exit` (the forms that
   abandon the remaining work or skip the current item).
2. Whose **immediately governing condition is a negated availability check** —
   a test that a file, directory, or executable exists / a command is on PATH,
   in "skip when missing" form (`!Path::new(p).exists()`, `[ -f p ] ||`,
   `! command -v tool`, `!existsSync(p)`, `not Path(p).exists()`,
   `!fileExists(...)`). Positive checks ("skip if already present") are
   deliberately excluded: that is the idempotency idiom, not a disabled tool.
3. Where **no message primitive is emitted before the exit** — no
   `println!`/`eprintln!`/`panic!`/log macro, no `echo`/`printf`/`log`, no
   `console.*`/`print`/`throw`, no `print`/`raise`. A skip that emits first is
   **loud** and is *not* reported. Distinguishing the two is the entire value:
   a checker that flags both is a `grep` for `return`. Returned payloads (error
   objects, `null`, `''`, HTTP 404 responses) do not count as messages under
   this rule — they are listed as candidates for a human to triage, and every
   finding carries `file:line`, the guard, and the checked path so that triage
   does not require re-reading the source.

### Result on today's tree

`node trios/tools/silent-skip-audit.mjs` reports **32 silent skips in 18
files** — 30 from the working tree and 2 from the recorded submodule patch
(see the tool's output for the live list; it is byte-identical across
consecutive runs). The exemplar is reported at both of its skip sites:

```
trios/rings/RUST-13/trios-mesh/build.rs:17 [record]  return  guard: !Path::new(t27c).exists()  checks: t27c (= "../t27/target/release/t27c")
trios/rings/RUST-13/trios-mesh/build.rs:25 [record]  return  guard: !specs_dir.exists() || !gen_dir.exists()  checks: specs_dir (= "specs") | gen_dir (= "gen/rust")
```

An audit that does not find its own exemplar has not been tested; this one
finds it, at the `return` lines, with the paths named.

The same run also surfaces a second instance of exactly the defect class that
motivated this work: `.trinity/wave-106-mesh.sh:13` —
`[ -f "$committed" ] || continue` — the committed-vs-fresh *measurement*
script itself silently skips any committed artifact that is missing, so its
byte-identity numbers can undercount without saying so.

`node trios/tools/silent-skip-audit.mjs --selftest` builds a fixture pair (one
silent skip, one that warns before returning), asserts that only the silent
one is reported, and exits 0.

## The exemplar's repair — proposed lines, not applied

Two distinct skip causes exist in `build.rs`, so two warnings belong there —
one per cause, each naming the path that was checked. Insert each
`println!` immediately before the corresponding `return;` (line numbers refer
to the recorded post-image: guard 1 at line 16 returns at 17, guard 2 at line
24 returns at 25):

**Cause 1 — the compiler is missing (guard on `../t27/target/release/t27c`):**

```rust
println!("cargo:warning=t27c not found at ../t27/target/release/t27c - trios-mesh build.rs is skipping regeneration; committed gen/rust/ artifacts are being used without being checked");
```

**Cause 2 — the spec or output directory is missing (guard on `specs/` and
`gen/rust/`):**

```rust
println!("cargo:warning=specs/ or gen/rust/ is missing - trios-mesh build.rs cannot tell whether generated code is stale; regeneration is skipped");
```

The repair is deliberately **non-fatal** (FR-006): a `println!` addressed to
`cargo:warning=` rides cargo's warning channel and the hook still exits
successfully. A hard failure (`panic!`, `std::process::exit`, an `Err` return)
would stop every build on a machine without the compiler — which is most of
them — and the skip would become an outage instead of an observation. The
warning says exactly what did not happen and which paths were missing, so the
reader can verify it without opening the source.

### Why this could not be applied here

`trios-mesh` is a **git submodule** — mode `160000` in this repository's tree,
gitlink commit `2257dea0e53da5bc8cd7dbbcd10bb15cb027f5cf`, with no
`.gitmodules` entry. An edit to `build.rs` inside it cannot be landed through
this repository at all, and nothing inside `trios/rings/RUST-13/trios-mesh/`
was created, edited, or written by this task: the submodule is not even
materialized in this checkout, and the audit reconstructed its recorded
content from the committed patch. The two lines above are the deliverable;
the operator applies them in `gHashTag/tri-net`. Separately, regeneration of
the artifacts is blocked upstream — `t27c` lives in a repository this one may
not edit — which is why the warning text speaks of committed artifacts being
used without being checked.

## Reproducing

```console
$ node trios/tools/silent-skip-audit.mjs           # full list + total
$ node trios/tools/silent-skip-audit.mjs --selftest # fixture pair, exit 0
$ node trios/tools/silent-skip-audit.mjs > a && node trios/tools/silent-skip-audit.mjs > b && cmp a b  # identical
```

## Findings index (as of this writing)

Working tree: `trios/.trinity/wave-106-mesh.sh:13`,
`trios/Makefile:1675,1782,2252,2320,2340,3425,3524,4533,5203`,
`trios/agent-server/apps/eval/src/dashboard/server.ts:219,242`,
`trios/agent-server/apps/server/src/api/routes/memory.ts:18`,
`trios/agent-server/apps/server/src/api/services/openclaw/container-runtime-factory.ts:87`,
`trios/agent-server/apps/server/src/api/services/openclaw/runtime-state.ts:44`,
`trios/agent-server/apps/server/src/config.ts:218`,
`trios/agent-server/apps/server/src/lib/agents/acpx-runtime-context.ts:207,217`,
`trios/agent-server/apps/server/src/lib/soul.ts:29`,
`trios/agent-server/apps/server/src/tools/memory/read-core.ts:17`,
`trios/agent-server/scripts/build/cli/config.ts:22`, `trios/build.sh:1024`,
`trios/rings/RUST-10/clade-worktree/src/main.rs:219`,
`trios/rings/RUST-13/clade-meshd/src/chat.rs:90`,
`trios/rings/SR-02/ChatViewModel.swift:10615`,
`trios/scripts/cleanup_artifact_logs.sh:63,71,97,144`,
`trios/tests/swift/run_chat_sse_e2e.sh:252`.
Recorded submodule: `trios/rings/RUST-13/trios-mesh/build.rs:17,25`.

For contrast, the loud sites in this tree — `clade-tablecloth` 598,
`clade-improve` 223, `clade-promote` 441, `clade-monitor` 983, the `trios`
launcher's pm2 guard, `agent-server/tools/dev/run.sh:6`,
`Makefile:1236-1261` and `Makefile:711`, and `converter.py:255` — all warn or
fail before returning, and none of them is listed by the audit.

Several of these are deliberate by design (for example the CI config check at
`trios/agent-server/scripts/build/cli/config.ts:22`, and `chat.rs:90`, which
starts empty on first run); the audit's job is to name every site so the next
instance is caught in a run rather than in a month, not to pronounce each one
a bug.
