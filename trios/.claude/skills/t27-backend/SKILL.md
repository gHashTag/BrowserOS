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

Found by generating ring 00 and reading the output. None is a reason to write
the ring in Rust by hand; each is a bug in the seed, which is the one place a
bug is worth fixing.

1. **`;` comments inside an enum body become variants.** `pub const V = enum(i8) { ; note\n a = 0 }` emits `pub enum V { note_words..., a = 0 }`. Use `//` inside braces. Top-level `;` is fine.
2. **`Enum.variant` emits as `Enum.variant` in Rust** — invalid; Rust needs `Enum::variant`. `RustCodegen::ExprFieldAccess` formats `{}.{}` unconditionally and does not know which identifiers name enums.
3. **`.variant` shorthand emits as `variant::`** — broken in the same place.
4. **`switch` as a function body emits an empty `match x { };`** — the arms are dropped by the Rust backend.
5. **`pub module name;` was not parsed** from a file whose comments are `//` — `gen-verilog` named the module `unknown`. The Verilog backend otherwise produced a well-formed module with clk/rst_n/en/ready and parameters from the consts.

Fix order: (2) and (3) unblock every ring; (4) is needed for anything with a
decision table; (1) and (5) are papercuts with obvious workarounds.

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
The point is a datapath with no multiplier: a weight is a code and multiplying
by it is a choice of sign.

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
