# Make target reachability

*Why this document exists, and how to never again write a brief a worker
cannot run.*

Issue gHashTag/trios#1361 counted seven `python3` invocations in the
Makefile:

```
Makefile:2454:	@python3 "$(ROOT)/tools/dashboard.py"
Makefile:2474:	@python3 "$(ROOT)/tools/forensics.py" forensics --variant "$(LOG_VARIANT)"
Makefile:2481:	@python3 "$(ROOT)/tools/forensics.py" signals --variant "$(LOG_VARIANT)"
Makefile:2525:	@python3 "$(ROOT)/tools/forensics.py" refusals --variant "$(LOG_VARIANT)"
Makefile:2531:	@python3 "$(ROOT)/tools/forensics.py" board --variant "$(LOG_VARIANT)"
Makefile:2537:	@python3 "$(ROOT)/tools/forensics.py" drift
Makefile:2545:	@python3 "$(ROOT)/tools/forensics.py" spend --variant "$(LOG_VARIANT)"
```

(line numbers as counted when the issue was filed; the same seven lines live a
couple of lines higher today - the audit prints the current numbers)

`tools/` contains `dashboard.py`, `forensics.py`, `ChatProbe.swift`,
`keychain_floor.swift` - every one of them needs an interpreter or compiler
the worker container does not have. Six earlier briefs in this project said
"run `make forensics` and quote the output" and had to be rewritten. The
Makefile is the documented interface (CLAUDE.md: *Make is the interface*), so
a task author following the law is led straight into targets no worker can
run.

The repair was not to port the Python - `dashboard.py` and `forensics.py` are
working operator tooling on the machine that has Python, and nothing about
them changed. The repair is legibility: an audit that states, for every
target, whether a worker can run it.

## The worker tool set

Measured in the running worker container:

| present                                   | absent                    |
| ----------------------------------------- | ------------------------- |
| `sh`, `bash`, `node`, `bun`, `git`        | `python3`, `swift`, `make` |

This set lives as data in exactly one place - `WORKER_TOOL_SET` at the top of
[`tools/make-target-reachability.mjs`](../tools/make-target-reachability.mjs) -
and is printed by every audit run. When the image changes, fix the array
there; every verdict is derived from it.

Two things count as "present" without being in the array:

- **Shell keywords and builtins** (`echo`, `cd`, `test`, `:`, `if`, `while`,
  ...). `sh` provides them; no external binary is needed.
- **Repo-local scripts** launched by a recipe (`build.sh`,
  `tests/swift/run_chat_sse_e2e.sh`, `tests/swift/shake_e2e.sh`) are *followed
  one level deep*: the launcher may be `bash`, but what decides reachability
  is the script's own body. `build.sh` is a shell script, and it still makes
  `make dev` unreachable, because its body invokes `swift`, `xcrun`,
  `codesign`, `security`.

Everything else an external command could be - `rm`, `grep`, `sed`, `mkdir`,
`curl`, `pgrep`, `swiftc`, `python3`, `make`, ... - is **not declared
present**, and a recipe that invokes it is reported unreachable with that tool
named. The report is declaration-based on purpose: it says "not in the
declared worker tool set", which is a fact about the image, not a guess about
which coreutils happen to ship with it.

## Running the audit

```
node trios/tools/make-target-reachability.mjs
node trios/tools/make-target-reachability.mjs --recipe dashboard
node trios/tools/make-target-reachability.mjs --makefile other/Makefile --depth 8
```

It runs under `node` with the Node standard library only and never invokes
`make` (or any other subprocess). It reads the Makefile; it never writes it,
and no Python file is opened for anything but a shebang line.

### The three verdicts

- **reachable** - every command word in the recipe (and in every prerequisite
  target and followed script) is a shell builtin or in the worker tool set.
- **unreachable** - some command word names a tool outside the set, directly
  or through inheritance. The line and the tool are printed.
- **undetermined** - honest "cannot tell": a shell variable in command
  position, a script nested beyond follow depth, or a target chain deeper
  than the stated limit (default 16, printed by the run; overridable with
  `--depth`). A chain that exceeds the limit is reported `undetermined`,
  never assumed reachable. Run with `--depth 1` to see it happen:
  `build`, `check` and `verify` flip to `undetermined` because their
  inheritance chains are deeper than one level.

### Inheritance

A target that depends on an unreachable target is itself unreachable, and the
chain is printed. From the current run:

```
build -> dev -> missing 'rm' (Makefile:338)
check -> check-selftest -> missing 'cp' (Makefile:5560)
```

`$(MAKE) target` recursion inside a recipe is treated the same way, plus one
extra fact: invoking `make` at all already requires a tool the worker lacks,
so such lines are flagged directly (e.g. `promote`, Makefile:2418).

## Current results

Over all 67 targets in `trios/Makefile` (run of the audit, this tree):

```
Reachable:    1     help
Unreachable:  66
Undetermined: 0
```

The only reachable target is `help`, whose recipe is nothing but `echo`.
Everything else invokes at least one tool outside the declared set.

**The seven `python3` targets from the issue, as the audit prints them
today:**

```
dashboard     (rule at Makefile:2451)   Makefile:2452: invokes 'python3'
forensics     (rule at Makefile:2471)   Makefile:2472: invokes 'python3'
signals       (rule at Makefile:2478)   Makefile:2479: invokes 'python3'
refusals      (rule at Makefile:2522)   Makefile:2523: invokes 'python3'
board         (rule at Makefile:2528)   Makefile:2529: invokes 'python3'
binary-drift  (rule at Makefile:2534)   Makefile:2535: invokes 'python3'
spend         (rule at Makefile:2542)   Makefile:2543: invokes 'python3'
```

Plus an eighth direct use the issue's count did not reach, because it sits
inside a longer recipe: `release` (Makefile:649) calls `python3 -c` in its
mid-flight-worker guard. `keychain-floor` compiles `tools/keychain_floor.swift`
with `swiftc` and signs it with `codesign`/`security`; the Swift probes build
`ChatProbe.swift` the same way.

**All 66 unreachable targets** (the audit output is the authoritative,
line-cited list; these are the names):

```
dev  warning-gate  warnings  release  chain  build  test  e2e  shake
keychain-doors  queen-core-sync  queen-core  t27-lowering  t27-rings  relaunch
type-floor  make-dollars  dev-queen  dev-queen-stop  recipe-backticks
empty-sources  watch-empties  finish-mark-order  guard-shapes  variant-fence
parse-tests  vendor-step  check-bypass  check  cassette-isolation  test-app
cassettes-bypass  cassettes  run  run-release  serve  stop  promote  dashboard
forensics  signals  keychain-floor  refusals  board  binary-drift  spend
doctor  clean  clean-release  chat-probe  restart  verify  delegate-probe
sources-drift  sources-drift-selftest  xctest-run  xctest-log-complete
run-completeness-selftest  xctest  mutants  mutants-logic  mutants-guard
mutants-changed  drift-guard  backlog-audit  check-selftest
```

Read that list before writing a brief. If a Success Criterion says "run
`make <target>` and quote the output" and `<target>` is above, no bee can
satisfy it.

## Proving a Make recipe from a worker

Workers have no `make`, so a Make target cannot be run as a target. What a
worker *can* do is run the recipe body with `sh` - the recipe is just shell
text once make's syntax is stripped. The technique:

1. **Take the recipe**: the tab-indented lines under `target:` in the
   Makefile, down to the next non-indented line.
2. **Strip make's marks**: drop the leading tab of each line and any leading
   `@` (silence), `-` (ignore errors), `+` (always run). Keep backslash
   continuations - they are shell line-splices.
3. **Undo make's escapes**: replace `$$` with `$`, and expand `$(VAR)`
   references using the `:=` block at the top of the Makefile (`$(ROOT)` is
   this checkout's root).
4. **Run the body with sh**: `sh -c '<body>'`, or save it to a file and
   `sh <file>`.

The audit prints the extracted body on demand, so step 1-3 are mechanical:

```
node trios/tools/make-target-reachability.mjs --recipe <target>
```

### Worked example - an unreachable target (dashboard)

```
$ node trios/tools/make-target-reachability.mjs --recipe dashboard | grep -v '^#'
python3 "/workspace/BrowserOS/.worktrees/queen-1361/trios/tools/dashboard.py"

$ sh -c 'python3 ".../tools/dashboard.py"'
sh: 1: python3: not found          # exit code 127
```

The recipe body runs, the interpreter is missing, and the failure is loud and
quotable. That is the proof: **a missing interpreter is a failed run, not a
passing one.** Quote the `not found` line and the exit code in the report; do
not paraphrase it into "ran the check".

### Worked example - a reachable target (help)

```
$ node trios/tools/make-target-reachability.mjs --recipe help | grep -v '^#' | sh
TriOS targets:
  make            - build the DEV app (safe default; never touches the release)
  make dev        - same as above
  ...
```

The body runs to completion under `sh` and produces the target's output - the
definition of worker-reachable.

## Scope and honest limitations

- The audit is **static and declaration-based**. It does not execute anything;
  it compares command words against the declared set. A tool that exists in
  the image but is not declared will be reported missing - fix the data, not
  the Makefile.
- Make conditionals (`ifeq`) are parsed as a **union of all branches** -
  conservative: a tool used in any branch counts.
- Binaries a recipe builds and then executes (`ring`, `twin`, `t27c` in the
  `chain` target) are reported as invocations of tools outside the set. They
  are artifacts, not interpreters - but they cannot exist without the
  compilers that are missing, so the verdict they carry is true anyway.
- Scripts referenced by followed scripts are recorded but not followed
  (follow depth 1); a target whose only evidence hides two scripts down is
  `undetermined`, not blessed reachable.
- Undefined Make variables expand to nothing, exactly as make treats them.

## What this task did not do

No Python file was rewritten, ported or deleted (FR-001). The Makefile was not
modified in any way - not its recipes, not its comments (FR-002); the audit
reads it. The two files this task added are `tools/make-target-reachability.mjs`
(this audit) and this document.
