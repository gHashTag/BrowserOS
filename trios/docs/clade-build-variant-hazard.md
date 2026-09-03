# clade-build has no dev arm - a bare invocation replaces the running app

Recorded for gHashTag/trios#1356. The builder lives at
`rings/RUST-01/clade-build/src/main.rs`; every line number below is in that
file.

## The defect, at its line numbers

- **`main.rs:54`** - `env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into())`.
  An unset `TRIOS_VARIANT` builds **prod**.
- **`main.rs:330`** - `fn resolve_variant(name: &str) -> Variant` has exactly
  two arms: `name == "staging"`, and an `else` that returns the prod `Variant`.
  There is no dev arm. `TRIOS_VARIANT=dev cargo run --bin clade-build` falls
  into the same `else` and also builds prod, so the obvious "safe" spelling is
  not safe.
- **`main.rs:347`** - the prod arm's `app_bundle` is
  `format!("{}/trios.app", &project_dir())`: every unrecognized variant writes
  the bundle of the application the user is running.
- **`main.rs:551`** - `fn resolve_variant_unknown_defaults_to_prod()` pins the
  behaviour with a test: an unknown variant name resolves to prod, on purpose.

So any `cargo run --bin clade-build` without a variant visible on the command
line silently overwrites `trios.app`. That is precisely the accident
`build.sh:10-12` and the `agent-safe-build` skill exist to prevent, and the
builder takes the opposite default from the documented interface:
`build.sh:19` reads `VARIANT="${TRIOS_VARIANT:-dev}"`, and
`grep -c clade-build Makefile` returns 0 - the make interface does not use
this builder at all.

## The Rust change that would fix it (named, not made here)

Give `resolve_variant` a dev arm and stop letting silence mean prod:

1. Add a `name == "dev"` branch ahead of the `else`, producing a dev `Variant`
   that matches `build.sh`'s dev: app bundle `trios-dev.app`, bundle id
   `com.browseros.trios.dev`, binary `trios_dev_app`, the dev ports and the
   `.trinity-dev` data root. The `build_root` stays the project dir; only the
   outputs move, exactly as the staging arm already does at `main.rs:330-341`.
2. Change the fallthrough at `main.rs:343` from "return prod" to fail loudly
   on an unrecognized variant (print the name, exit non-zero), mirroring the
   explicit `case` statements `build.sh` uses after its own variant
   validation, so a typo cannot silently ship.
3. Reconsider the default at `main.rs:54` (`"prod"`) against `build.sh:19`
   (`dev`), or at minimum document at the call sites that clade-build is the
   one tool in the tree whose default is prod.
4. Replace the test at `main.rs:551`
   (`resolve_variant_unknown_defaults_to_prod`) with one asserting the loud
   failure, and add one asserting `resolve_variant("dev")` never names prod,
   so the gate and the behaviour cannot drift apart silently.

## Why this file records the change instead of containing it

The worker image that closed the reachable half of #1356 has no Rust
toolchain - `rustc` and `cargo` are not installed - so a Rust edit to this
builder could not be compiled or tested there, and an unverifiable edit to a
builder that overwrites the user's application was ruled out of scope by the
issue (FR-001). The path by which the hazard was actually reached - the five
skill documents instructing agents to run the command bare - is what was
fixed: those skills now point at the forms documented in
`.claude/skills/agent-safe-build/SKILL.md`, and
`tools/clade-build-guard.mjs` fails the tree if a skill ever instructs an
agent to run a bare `cargo run --bin clade-build` again. The Rust change above
is left to the operator, with a toolchain, on a tree that can prove it.
