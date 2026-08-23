---
name: t27-backend
description: Move trios logic out of Swift into T27 rings that generate Rust, Zig, C and Verilog. Use for any backend work, ring migration, FPGA verification, or Railway deployment of trios. Contains the verified toolchain, the ring order, and the compiler gaps that block generation today.
---

# T27 backend — the trunk and its rings

## The law

**Everything is written in T27 except a minimal Rust seed.**

The seed is the bootstrap compiler (`t27c`) and nothing else. Every other
component — decision core, A2A registry, orchestration, transport — is a `.t27`
source that generates its target. Swift keeps the user interface and nothing
below it.

The reason is not taste. A rule written once and transcribed into Swift, Rust,
Zig and Verilog is four rules that agree until someone edits one of them. A
rule written in T27 and generated into four targets is one rule. That is the
whole argument, and it is why the decision core moves first: it is the part
where a disagreement between targets would be a wrong answer rather than a
different shade of one.

## Migrate in rings, from the innermost outward

Like the layers of a trunk. A ring may only depend on rings inside it, and a
ring is not started until the one inside it runs in production.

| Ring | What | Depends on | Target |
|------|------|-----------|--------|
| **T27-00** | Decision core: retry, review, merge gate, capacity. No clock, no network, no store, no strings. | nothing | Rust (server), Verilog (silicon) |
| **T27-01** | A2A protocol: agent card, message, task, registry semantics | 00 | Rust + Postgres |
| **T27-02** | Orchestration: the Queen's tick, delegation, review sweep, bounded send-back | 00, 01 | Rust + inngest |
| **T27-03** | Transport: SSE fan-out, per-agent buffers, event ids | 01 | Rust |
| **T27-04** | Scoring: salience, reliability, latency ranking — **this is where TNF belongs** | 00 | Rust, Verilog |

Ring 00 needs no floating point at all: it is enums and integers, which is
exactly why it is also the ring that can be synthesised without argument.

## Verified toolchain (checked on this machine, 2026-08-19)

```bash
cd /Users/playra/t27/bootstrap && cargo build --release   # binary: /Users/playra/t27/target/release/t27c
t27c gen-rust    <file.t27>    # Rust
t27c gen         <file.t27>    # Zig
t27c gen-c       <file.t27>    # C
t27c gen-verilog <file.t27>    # synthesisable Verilog
t27c icarus-simulate <file.t27>
```

Open-source FPGA flow, all present, **no Vivado required**:

- `openFPGALoader` — programs the board
- `iverilog` — simulation (t27c drives it directly)
- `yosys` + `nextpnr-xilinx` — synthesis and place-and-route

## Territory — read before touching anything

A second agent owns the **t27 repository** and the **FPGA stands** (wave W931,
branch `claude/igla-fpga-improvements`). Do not edit `/Users/playra/t27`; do not
program a board. `t27/fpga/HARDWARE_SSOT.md` is authoritative for hardware and
explicitly warns against forking its facts - point at it, never copy it.

## The board is real and answers

```
openFPGALoader --detect
  index 0: idcode 0x4ba00477  ARM cortex A9
  index 1: idcode 0x3727093   xilinx zynq xc7z020
```

Two stands, not one - my first detect used the default cable and named only
the Zynq:

- `-c ft232` / `digilent_hs2` -> idcode `0x3636093`, Artix-7 200T. Their SSOT
  calls it **QMTech Wukong V1 (XC7A200T-FGG676)**; the operator called it an
  **ALINX AX7203**. Same idcode, same die - unsettled, and their SSOT wins.
- `-c ft2232` / `digilent` -> idcode `0x3727093`, Zynq **XC7Z020** + Cortex-A9
  (`0x4ba00477`). **This one runs tri-net.** The Queen's rings do not go there.

The Zynq is the interesting one in principle - A9 cores beside the fabric, so a
ring runs as software and as logic from one source and the two can be compared
- but it is allocated.

**Verify on hardware, never by reading the Verilog.** A generated module that
looks right and was never simulated is a claim, not a result.

## Compiler gaps that block generation TODAY

Re-measured 2026-08-23 against a t27c built from `t27/bootstrap` at that date.
Read the measurement, not the old list: one entry below had already been fixed
and was still being repeated here, and the entry that matters most was
described far too mildly.

Build the compiler without writing into the sibling checkout:

```
CARGO_TARGET_DIR=<trios>/.trinity/t27c-build cargo build --release \
  --manifest-path ~/t27/bootstrap/Cargo.toml
```

`make t27-rings` and `make chain` now do this for you.

### CORRECTION, same day: it is the PARSER, and it is not only `switch`

Everything below this heading down to the ratio table was written earlier on
2026-08-23 and is wrong about the cause. It said `switch` is not lowered to
Rust. `switch` is one symptom of a much larger defect, and the defect is not
in a backend at all.

`Parser::parse_fn_body` (`bootstrap/src/compiler.rs:1887`) is:

```rust
match self.parse_body_stmt() {
    Ok(stmt) => decl.children.push(stmt),
    Err(_) => { self.recover_to_stmt_boundary(); }   // the error is dropped
}
```

`recover_to_stmt_boundary` then advances to the next `;` at brace depth 0, so
a statement the parser cannot handle takes **everything up to the next
top-level semicolon** with it. `parse_module_body` (`compiler.rs:1073`) has
the identical shape at item level. The nodes are gone before any backend
runs, so `gen`, `gen-c`, `gen-verilog` and `gen-rust` all lose the same code.
`t27c parse` shows the statements simply absent.

Measured triggers, each exiting 0 with empty stderr:

- `if <cond> { }` with the condition NOT in parentheses - which is how every
  Rust-flavoured spec in both trees writes it. `parse_if_stmt`
  (`compiler.rs:2150`) opens with `self.expect(TokenKind::LParen)?`. Takes the
  `if` and one following statement; recurses if that statement is another `if`.
- `match` in any position; parentheses do not rescue it.
- `let x: T = if …;` and `let x: T = match …;` - the first deletes the binding
  silently, the second emits the literal text `let x: T = match;`.
- An implicit tail return emits `expr;` **with a semicolon**, so the function
  returns `()`. This is the whole idiomatic Rust-flavoured dialect, and it
  means those functions do not compile even when nothing was deleted.
- `while` without parenthesised condition, `let mut`, `[N][]const T{}`
  literals, `fn` declared inside `struct`, and every item after the first
  brace-style `module` block.

`unimplemented!()` turns out to be the empty-body FALLBACK, not a
construct-specific stub: it appears only when deletion leaves nothing behind.
So counting stubs badly understates the damage - a function can lose half its
body, emit no stub, and still compile.

**Do not use the earlier "1.1% of functions are stubs" figure as a health
measure.** Generation exiting 0 says nothing about whether the output is
correct or even compiles.

Reported upstream with minimal repros and source line numbers:
https://github.com/gHashTag/t27/issues/2508

The rest of this section is kept because its ratio table is still a useful
map of WHERE the damage is concentrated, even though its stated cause is
wrong.

### Superseded: `switch` is not lowered to Rust

A `switch` **as a function body** makes the whole body `unimplemented!()`. A
`switch` **anywhere else in a body** is worse: it is deleted, everything after
it in the function is deleted, and every remaining item in the file is
dropped. Exit code 0. stderr empty. Measured on a three-function probe:

```
pub fn nested(x: i8) i8 {           pub fn nested(x: i8) -> i8 {
    if (x > 0) {                        if (x > 0) {
        switch (x) { ... }      ->      }
    }                               }
    return 0;
}                                   // afterstmt and enumref: gone
```

Three functions in, one out, no diagnostic, and the result does not compile
(`error[E0308]: mismatched types` — the surviving function lost its return).

This single gap is the whole self-hosting story. A parser and three code
generators are switch statements by nature, so they lower to nothing:

| spec | lines | Rust lines | fns emitted |
|------|------:|-----------:|------------:|
| `compiler/parser/parser.t27` | 952 | 9 | 1, a stub |
| `compiler/codegen/zig/codegen.t27` | 1199 | 28 | 0 |
| `compiler/codegen/verilog/codegen.t27` | 866 | 34 | 0 |
| `compiler/codegen/testgen.t27` | 761 | 22 | 0 |
| `compiler/parser/lexer.t27` | 454 | 104 | 0 |
| `compiler/ast.t27` (healthy, for contrast) | 450 | 355 | — |
| `compiler/cli/gen.t27` (healthy) | 369 | 302 | 3 |

So "the specs are broken" is not what is happening. **1159 of 1161 `.t27`
files parse and generate**; the two that do not are a symlink loop at
`bootstrap/bootstrap/specs/physics/formula_registry.t27` and an unbalanced
brace at `specs/test_framework/verilog_bench_harness.t27:460`. The specs are
fine. The Rust backend cannot lower the construct they are made of.

Fixing `switch` in `gen-rust` is the single highest-value change available to
this whole programme, and it lives in `t27/bootstrap` — report it there, do
not work around it here.

### Still open, but masked

2. **`Enum.variant` emits as `Enum.variant`** — invalid; Rust needs `Enum::variant`. `RustCodegen::ExprFieldAccess` formats `{}.{}` unconditionally and does not know which identifiers name enums.
3. **`.variant` shorthand emits as `variant::`** — broken in the same place.

Both are currently **unobservable** in any spec that uses `switch`, because
the body is discarded before they can be reached. Do not report them as fixed
if they stop appearing; re-measure them on a switch-free probe.

5. **`pub module name;` was not parsed** from a file whose comments are `//` — `gen-verilog` named the module `unknown`. The Verilog backend otherwise produced a well-formed module with clk/rst_n/en/ready and parameters from the consts.

### Fixed since this list was written

1. ~~`;` comments inside an enum body become variants.~~ Measured 2026-08-23:
   a `//` comment inside an enum body is dropped correctly and the enum emits
   clean. Kept here only so the next reader does not re-report it.

### How trios' own rings stand

All 70 `.t27` files in `rings/` generate, none fails, and 14 of 1286 emitted
functions (1.1%) are `unimplemented!()` stubs — concentrated in seven mesh
specs, worst `adaptive_retry.t27` (4 of 6) and `m3_multihop.t27` (4 of 10).
`rings/T27-00/queen_core.t27` and `rings/T27-01/a2a.t27` have none.

## Existing modules to build on, not replace

**A2A is already a client/server split with a Postgres store.** Do not design a
new protocol; ring 01 reimplements this contract.

Nine routes in `agent-server/apps/server/src/api/routes/a2a.ts`:
`register`, `unregister`, `heartbeat`, `agents`, `matrix`, `message`,
`task/assign`, `task/update`, `stream` (SSE, per-agent buffer, event ids).
Store: `pg-agent-store.ts` — table `agents` (id, name, capabilities[],
last_heartbeat, status, metadata, created_at, updated_at), index on status,
plus an `agent_matrix` view. Swift client: `rings/SR-02/A2ARegistryClient.swift`.

**Railway project `999` (`564d9ebd-7aa8-44fe-93ec-e0b03c87158d`), environment
`production`** already runs what the rings need:

| Service | Use for |
|---------|---------|
| Postgres | the Queen's registry and A2A agents — replaces `.trinity/state/*.json` |
| Redis | worker leases and coordination |
| inngest | the Queen's loop: tick, delegate, wait, review, bounded send-back. This IS a durable workflow; it should stop being a 5-minute timer in an app that must stay running. |
| postgrest | read-only state for the UI without a bespoke endpoint |
| Bucket / Console (MinIO) | transcripts, artifacts, cassettes |

Deploying there also answers the operator's standing complaint about logs: the
Railway deploy/build/http streams are readable without the machine being awake.

## TNF — Ternary Network Floats

Sign, exponent in balanced ternary trits, M-bit mantissa, `1 + E_t + M = N`.

The ternary network is multiplier-free — that property belongs to the network,
not to any number format. A weight is a code and applying it is a choice of
sign. TNF is the format the accumulator spends its range on, which is a
different and smaller claim.

**Not implemented in trios.** The article is `~/Downloads/TNF_статья_ru.md`
(12 Aug 2026), with `tnf_paper.pdf` and the architecture PDF beside it.

It IS implemented and measured in the t27 repository by the other agent: gate
G8 reports 19/19 tracts routed, 14/15 within seed noise, bin16 exactly 1.00x,
LNS16 an honest 1.46x outlier. Those are their numbers on their hardware. Do
not restate them as ours, and do not claim TNF is used here until a `.t27`
module in trios uses it and the answer is checked.

My first pass said "no implementation anywhere on this machine". That was a
local file search in three directories and it was wrong - the work was on a
branch I had not looked at. Search the sibling repositories' branches before
declaring something absent.

**Where it belongs:** ring 04, the scoring layer — salience, reliability EMA,
latency ranking — which is the only place in the supervisor that carries `f64`
today. Ring 00 needs no floats and must not acquire any.

## What a bee is told to write

A worker on a backend task writes **`.t27`**, never Rust, Zig, C or Verilog by
hand. Generated files are artifacts: they are not edited, and a diff that
changes one without changing its `.t27` is a defect, not a change.

The one exception is the seed — `t27/bootstrap` — where hand-written Rust is
the point.
