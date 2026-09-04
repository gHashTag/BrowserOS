# Queen backlog supply - the round that looks for work

Issue: gHashTag/trios#1327

## What this document is

Two things, and the second is what makes the first checkable.

1. **The specification of the backlog supply**: what a Queen round does in
   the moment `queend` answers `nothing to choose`. Today that answer ends
   the round - the tick records the refusal, the kanban prints "there is
   nothing she may start", and the swarm waits for a person to file the
   next issue by hand. The obligations below are FR-001 through FR-005 of
   #1327, restated as mechanism.
2. **The ledger.** Every supply round appends its record to this file, and
   the next round reads the most recent round before deriving again, so no
   candidate is derived twice. Round 1 is at the bottom. It was run against
   this repository at commit `7717d927` on 2026-09-04, and every command
   and every output it cites was executed against that tree and can be
   re-executed against it.

One honesty note the house style demands. `docs/queen-work-conserving-swarm.md`
opens by saying nothing in it is aspirational, because every transition it
names is also stated in code. That is not yet true here: the supply attempt,
the source set, the discard rule and this ledger are what #1327 asks for,
specified by this document and demonstrated once by Round 1, which was
performed by hand with its commands recorded. The code the round will
eventually call is named in "Where each piece lives today" so a reader can
see exactly which half exists and which half is the obligation.

## The one-paragraph version

    A round that asks `queend` to choose and is told there is nothing to
    choose does not end there. Before it reports that it has nothing to
    do, it looks for work in the only places work can honestly come from:
    a failing gate the repository itself defines, an unresolved TODO
    marker with a file and a line, a warning the repository's own
    thresholds record. An artefact becomes a candidate only if the
    artefact itself names the files the work would touch; a candidate
    whose boundary would have to be guessed is discarded and counted.
    Candidates are recorded in this file's ledger for a person to
    publish. Nothing files an issue and nothing dispatches a bee: the
    supply produces candidates, and publishing is a separate decision.

## The starvation this exists to remove

Measured 2026-09-03, in the words of #1327: 41 done, 17 in backlog, 12
awaiting a verdict - and `she may start` is **0**. Every issue a bee has
worked in this repository was written by a human or by an agent acting
outside the loop; the Queen has never produced one. Each time the backlog
is fed by hand she drains it within an hour and returns to
`nothing to choose`. That is not idleness caused by a defect; it is the
absence of a supply.

Round 1 read the local board before deriving, with the commands and outputs
recorded in its section below: `pending` is empty (`[]`), one dispatch is
active, nothing is blocked, 38 are done. The board offers no delegatable
issue - the exact precondition the supply exists for.

The doctrine this must not violate is already written down
(`docs/queen-work-conserving-swarm.md`, "Capacity, and what idle means"):
healthy idle "is not a reason to invent fake work or to duplicate a
completed issue". The supply invents nothing. Every candidate cites an
artefact the repository itself produced - a command and its output, a file
and a line - and the discard rule exists precisely so that a plausible
title never becomes a bee's boundary. The same doctrine is stated from the
other side by `QueenSelfAudit` (`rings/SR-00/QueenSelfAudit.swift`), whose
header says why the sources are mechanical and not a model's opinion:
self-improvement that consists of asking a model "what should we do next"
produces plausible roadmaps and no findings. The supply is that principle
applied to the cloud round.

## The rule: a refusal is a cue, not an end (FR-001)

A round asks `queend` to choose
(`agent-server/apps/server/src/api/services/queen-tick.ts:945`). When the
answer is `allowed: false` - no delegatable
issue, whatever the per-candidate skip reasons were - the round MUST run
the supply before it ends. The attempt is mandatory; success is not. A
round that attempts every source and derives nothing still reports the
refusal, but it reports it with the attempt recorded: which sources were
consulted, what each yielded, and why each empty one was empty. "Nothing
to choose" stops being an endpoint and becomes the last line of a round
that looked.

The refusal vocabulary does not change. `queend` still answers
`nothing to choose` (`agent-server/queen-core/Sources/queend/main.swift:324`)
and the public contract still treats that refusal as the `healthy_idle`
voucher (`docs/public-swarm-state.md`). What changes is that the tick's
own decision record carries the supply's counts (see "Where each piece
lives today"), and the ledger holds whatever the round derived.

## The three sources, and only these three (FR-004)

The source set is closed. A candidate may be derived from exactly these
three kinds of artefact, each of which the repository itself defines, and
from nothing else - not from a chat, not from a model's suggestion, not
from a hunch about what "would be nice".

### `gate` - a failing gate

The repository defines its own gates in the `check` target
(`Makefile:2024`). A gate failure is evidence when the round can name the
command it ran and the output that failed. Citation format:

    source: make <target> (Makefile:<line>) -> <the failing output line(s)>

A gate that is green yields nothing and is recorded as green. A recorded
failure in the repository's own logs is also a `gate` artefact - the wave
logs under `.trinity/` register defects with their output verbatim - and
Round 1 treats one such registration as a candidate attempt (it is
discarded; see D-1).

### `todo` - an unresolved marker with a file

A `TODO` or `FIXME` marker in a tracked source file, found by a command
the round records. Citation format:

    source: git grep -nE 'TODO|FIXME' -- <globs>  ->  <path>:<line>: <the marker>

Identifiers that merely contain the letters TODO - the TODO-planner
feature's type names, provenance comments - are not markers; the finding
command states its exclusions, and Round 1's command does.

### `warning` - a warning the repository's own thresholds record

The repository counts compiler warnings against a ceiling it writes down
(`WARNING_CEILING := 0`, `Makefile:270`) and records the offending
`<file>:<line>:<col>` lines in `WARN_LIST`
(`$(WARN_BUILD_DIR)/warnings.list`, `Makefile:282`), judged by
`warning-gate` (`Makefile:368`) and counted by `warnings`
(`Makefile:561`). A recorded warning line is evidence. Citation format:

    source: <WARN_LIST path>:<the recorded line>

The supply only **reads** what a build already recorded. A supply round
never compiles anything - the warning source produces candidates from the
existing `warnings.list` or from a build log that already exists, and when
neither exists it says so and yields nothing. A round that built would be
a second build system wearing the Queen's name.

## The boundary is taken, never inferred (FR-002)

Every candidate carries the files it would touch, and those files come
from the evidence that produced the candidate - never from its title.

- A `todo` candidate's boundary is the file(s) the marker sits in. When
  the same marker sentence appears in several files, the boundary is the
  union of those files, because the evidence is the pair, not either copy.
- A `gate` candidate's boundary is the file(s) the failing output itself
  names. Output that names no file has no boundary to take.
- A `warning` candidate's boundary is the file in the recorded
  `<file>:<line>:<col>` line.

A boundary is never widened by reasoning ("the fix will probably also
touch..."). Widening is a publishing decision, made by a person who can
read the code, not by a round that read a marker. This is the same rule
the issue states as its reason for existing: an issue with a guessed
boundary sends a bee at the wrong files, and the Queen allocates files to
concurrent workers, so a guessed boundary is not a small error - it is a
collision someone else pays for.

## The discard rule (FR-003)

A candidate whose boundary cannot be taken from evidence is discarded, not
filed, not recorded-as-open. The round says how many it discarded and why,
one line each, in the round's summary. The two shapes this catches:

- The artefact names no file at all (a gate failure whose output points at
  no source path).
- The artefact names a file but the work's location is genuinely unknown
  even to the artefact's author - Round 1's D-1 is exactly this case, a
  registered failure the registering log itself calls "someone's
  post-bundle step".

Discarding is separate from coalescing. Markers that repeat the same
sentence in the same file or across files are one candidate with a union
boundary, and the round reports the coalesced count; those markers are not
discarded, they are folded. Discarded means: a candidate was attempted and
refused for want of a boundary.

## Record, don't publish (FR-005)

Nothing in the supply files a GitHub issue. Filing is an outward action -
it creates a number the swarm will dispatch bees at - and this mechanism
produces candidates and records them. A separate decision, made by a
person, publishes: takes a recorded candidate, writes it to the
spec shape `docs/issue-spec-template.md` demands (scenarios, requirements,
success criteria, boundary), checks it with the `spec` question the
template documents, and files it.

The division of labour, stated once:

| Who | Does | Does not |
|---|---|---|
| the round | derives, discards, records in this ledger | file, dispatch, widen a boundary |
| a person | publishes, rejects, widens, files | - |

A candidate record therefore carries a `done-check` - the mechanical half
of success criteria, checkable by a command - and a `needs` line for what
only a person can decide. The published issue completes the criteria; the
ledger never pretends to.

## Where the record lives, and what the next round does

The ledger is this file. A round appends one section per supply round,
under "The ledger" below, with a header in the fixed form
`### Round N - <UTC timestamp> - commit <sha> - branch <branch>`. The next
round reads the most recent round section before deriving, because the
ledger's open candidates are the de-dup set:

- A candidate already recorded by an earlier round is not recorded again
  (same source artefact, same boundary). The round counts it as
  `already recorded (Round N)` and moves on.
- A candidate whose artefact matches an issue already open or already done
  on the board is not recorded; the round counts it as a duplicate and
  names the issue. The board the round reads for this is the same one it
  reads to choose - the registry and the dispatch table
  (`queen-tick.ts` reads both every round).
- A candidate whose boundary overlaps a non-terminal task's held paths is
  still recorded - recording holds nothing - with the holder named in the
  record, and publishing waits.

Statuses, and who may set them: a round sets `recorded`. Only a person
moves a candidate to `published` (with the issue number) or `rejected`
(with a reason). Rounds never edit a status forward.

The freshness limit, stated rather than hidden: the ledger lives in the
repository, and a round reads it from its own checkout. A round whose
checkout is behind reads an older ledger, and its de-dup is only as good
as that copy; the record's commit line exists so the next reader can see
exactly which tree a round saw. A round that cannot read the ledger at
all says so in its summary and still records - a missing ledger is a
first round, not a failure.

```
 queend choose --allowed--> dispatch loop (unchanged)
      |
 refused: allowed=false, "nothing to choose"
      |
      v
 THE SUPPLY (this document):
   read the board + this ledger (de-dup set)
   for each source in {gate, todo, warning}:
     run/read the artefact commands, record command+output
     derive candidates; boundary from the evidence only
     boundary not takeable -> DISCARD (counted, reason one line)
   append this round's section to the ledger
   tick decision carries supply counts
      |
      v
 round ends. The refusal on the wire is unchanged;
 the ledger holds the candidates; a person publishes.
```

## Where each piece lives today

For a reader who wants to verify against source, and to see which half is
specification and which half exists:

- The refusal the supply answers: `queend`'s choose,
  `refusal: pick == nil ? "nothing to choose" : nil`
  (`agent-server/queen-core/Sources/queend/main.swift:323-324`).
- The round: `runQueenTickOnce` / `runRound`
  (`agent-server/apps/server/src/api/services/queen-tick.ts:696,744`),
  the choose question at `:945`, the tick record at `:952`
  (`recordTick`, `:1599`).
- The sentence the operator reads when the supply's precondition holds:
  "Nothing is running, and there is nothing she may start"
  (`agent-server/apps/server/src/api/routes/queen-kanban.ts:909-917`).
- The gates: the `check` target (`Makefile:2024`) and its read-only
  sub-gates, three of which Round 1 ran: `type-floor` (`Makefile:1302`),
  `empty-sources` (`Makefile:1478`), `finish-mark-order`
  (`Makefile:1533`).
- The warning thresholds: `WARNING_CEILING := 0` (`Makefile:270`),
  `WARN_LIST` (`Makefile:282`), `warning-gate` (`Makefile:368`),
  `warnings` (`Makefile:561`).
- The spec shape a published candidate must take:
  `docs/issue-spec-template.md`, with its checker question.

The one wire change this issue implies, stated here because it belongs to
the specification and does not exist in code yet: the decision JSON that
`recordTick` writes gains a closed `supply` object -
`{ attempted: boolean, sources: { gate, todo, warning }, derived: number,
discarded: number, discardedWhy: string[] }` - so the round's own summary
is queryable where every other round fact already lives. The public
`/queen/status` contract is untouched: its closed vocabulary does not
grow, and the kanban's idle sentence may read the counts but introduces no
new state.

## The ledger

---

### Round 1 - 2026-09-04T07:07Z - commit 7717d927 - branch queen-1327

**Precondition - the empty delegatable backlog.**

    $ for f in active pending blocked done; do printf "%s: " $f; \
        grep -c '"task_id"' .trinity/queue/$f.json; done
    active: 1
    pending: 0
    blocked: 0
    done: 38
    $ cat .trinity/queue/pending.json
    []

One dispatch is active (GH-1313, "Expose a signed public FPGA registry
for Queen"); nothing is pending, nothing is blocked, and the one active
dispatch is running, not owed a verdict. The board offers no delegatable
issue. (The production board,
measured 2026-09-03 in #1327, read 41 done / 17 backlog / 12 awaiting
verdict / `she may start` 0 - the local board is the same shape at a
smaller count.)

**Machine limits, stated.** `make` is not installed on this machine
(`sh: 1: make: not found`) and `agent-server/node_modules` is empty
(0 entries), so the `gate` source ran the exact read-only pipelines of
three Makefile targets, verbatim from their recipes, rather than the
targets; targets needing a toolchain (`guard-shapes`, `recipe-backticks`,
the build) were not run and are not claimed. The lint command named in
C-9 and C-10 was not run for the same reason.

**Source `gate` - three gates run, all green; one recorded failure
discarded.**

`type-floor` (`Makefile:1302`), its pipeline verbatim:

    $ grep -rn '\.system(size: [0-9]' --include='*.swift' BR-OUTPUT rings \
        | grep -v 'BR-OUTPUT/TriosTheme.swift'
    (no output - no offenders)  [green]

`empty-sources` (`Makefile:1478`):

    $ git ls-files -- 'rings/' 'BR-OUTPUT/' | grep '\.swift$' \
        | while IFS= read -r f; do [ ! -s "$f" ] && echo "$f"; done
    (no output - no empty sources)  [green]

`finish-mark-order` (`Makefile:1533`), both arms:

    $ awk '/runner\.onFinish[[:space:]]*=/{f=1} f&&/recordCompletedTurn/{rc=NR} \
        f&&/Task[[:space:]]*\{/{tk=NR;f=0} END{exit !(rc>0&&tk>0&&rc<tk)}' \
        rings/SR-02/ChatViewModel.swift        -> rc=5686 tk=5687  [green]
    $ awk '<same program>' tests/fixtures/finish-mark-wrong.swift
    -> fixture correctly rejected  [green]

The repository's own log registers one failure that is not green:
`.trinity/wave-loop-130.md:22-25` (tracked) records, in translation from
the Russian original with the error string verbatim: "A late `swift test`
step failed: 'unexpected input file:
.trinity/build/QueenCore/libQueenCore.a' - module flags leak into the
swift-test invocation. REGISTERED, not fixed (window; a separate
diagnosis - someone's post-bundle step)." Its own "not done" list
(`:49-50`) names it the next diagnosis. See D-1.

**Source `todo` - 27 markers, 10 candidates.**

The finding command, exactly as run:

    $ git grep -nE 'TODO|FIXME' -- '*.swift' '*.ts' '*.tsx' '*.js' '*.sh' '*.py' | grep -vE 'TODOPlan|TODOItem|TODOPlanner|todoPlanner|TODO plan|TODO-plan|TODOList|TODOAnimation|TODOActive|TODOInsert|TODOProgress|TODOCompletion|TODOAction|AGENT-MEMORY-TODO-001'

The exclusions drop identifiers of the TODO-planner feature and
provenance comments - lines that contain the letters TODO but are not
markers. Output, 27 lines, verbatim:

    agent-server/apps/agent/entrypoints/background/scheduledJobRuns.ts:152:  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO(dani) refactor to reduce complexity
    agent-server/apps/agent/entrypoints/newtab/index/lib/searchSuggestions/getSearchSuggestions.ts:48: * TODO: Move search suggestions fetching to background script to avoid CORS issues
    agent-server/apps/agent/lib/constants/mediaUrls.ts:33: * TODO: Replace with actual video URL
    agent-server/apps/agent/lib/constants/mediaUrls.ts:40: * TODO: Replace with actual video URL
    agent-server/apps/agent/lib/constants/mediaUrls.ts:47: * TODO: Replace with actual video URL
    agent-server/apps/agent/lib/graphql/getQueryKeyFromDocument.ts:18:  // biome-ignore lint/suspicious/noExplicitAny: TODO(dani) type GraphQL variables properly
    agent-server/apps/agent/lib/graphql/useGraphqlInfiniteQuery.ts:16:  // biome-ignore lint/suspicious/noExplicitAny: TODO(dani) type GraphQL variables properly
    agent-server/apps/agent/lib/graphql/useGraphqlQuery.ts:11:  // biome-ignore lint/suspicious/noExplicitAny: TODO(dani) type GraphQL variables properly
    agent-server/apps/agent/lib/llm-providers/useLlmProviders.ts:75:        // TODO: Record error to error recording service
    agent-server/apps/agent/lib/schedules/syncSchedulesToBackend.ts:83:// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO(dani) refactor to reduce complexity
    agent-server/apps/agent/web-ext.config.ts:14:  // TODO: replace with --browseros-cdp-port once we fix the browseros bug
    agent-server/apps/server/src/lib/agents/acpx-runtime.ts:444: * TODO: drop this once acpx/runtime exposes a real system-prompt
    agent-server/apps/server/tests/__helpers__/browser.ts:106:      // TODO: replace with --browseros-cdp-port once we fix the browseros bug
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-highlevel.ts:20:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-highlevel.ts:54:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-highlevel.ts:81:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-highlevel.ts:109:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-context.ts:136:    // TODO: Replace placeholder implementation with actual LLM calls
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-context.ts:148:        name: 'BrowserOS', // TODO: get from gitbutler config
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-context.ts:149:        head: 'unknown', // TODO: get from git status
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-stage.ts:32:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-stage.ts:65:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-stage.ts:94:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-stage.ts:116:    // TODO: Call GitButler MCP tool
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision.ts:49:    // TODO: Call Anthropic API or use local vision model
    agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision.ts:70:    // TODO: Replace mock implementation with actual Anthropic/Vision API call
    agent-server/scripts/dev/start.ts:197:    // TODO: replace with --browseros-cdp-port once we fix the browseros bug

De-dup against the board before recording: the 38 done titles and the one
active title in `.trinity/queue/` were checked; none matches any marker
family below; `.trinity/claims/` holds only released claims, holding no
paths. No candidate duplicates open or completed work.

**Source `warning` - threshold exists, nothing recorded to read.**

    $ grep -n 'WARNING_CEILING :=' Makefile
    270:WARNING_CEILING := 0
    $ ls .trinity/build
    ls: cannot access '.trinity/build': No such file or directory
    $ ls /tmp/trios_build_dev.log
    ls: cannot access '/tmp/trios_build_dev.log': No such file or directory

The ceiling is 0 and `WARN_LIST` (`Makefile:282`) would hold any recorded
`<file>:<line>:<col>` line, but this checkout holds no build directory and
no last build log, so the source has no artefact to read. The supply does
not build (see "The three sources"), so this source yields 0 candidates
and discards nothing this round. It is recorded here so the next round
knows the source was consulted, not skipped.

**Candidates recorded (10).**

#### C-1 Move search-suggestions fetching to the background script
- source: the `todo` command above ->
  `agent-server/apps/agent/entrypoints/newtab/index/lib/searchSuggestions/getSearchSuggestions.ts:48:
  * TODO: Move search suggestions fetching to background script to avoid CORS issues`
- boundary: `agent-server/apps/agent/entrypoints/newtab/index/lib/searchSuggestions/getSearchSuggestions.ts`
- evidence: one marker; the sentence states both the remedy (background
  script) and the reason (CORS).
- done-check: `git grep -n 'Move search suggestions fetching' -- agent-server`
  returns nothing, and the suggestion fetch no longer runs in the newtab
  context.
- needs: nothing beyond the spec shape.
- status: recorded

#### C-2 Record provider-hook errors where a person can see them
- source: the `todo` command above ->
  `agent-server/apps/agent/lib/llm-providers/useLlmProviders.ts:75:
  // TODO: Record error to error recording service`
- boundary: `agent-server/apps/agent/lib/llm-providers/useLlmProviders.ts`
- evidence: one marker in the provider error path.
- done-check: `git grep -n 'Record error to error recording service' -- agent-server`
  returns nothing, and the catch path it marks no longer drops the error.
- needs: the destination (which recording service) - not in the evidence.
- status: recorded

#### C-3 Replace the placeholder video URLs
- source: the `todo` command above ->
  `agent-server/apps/agent/lib/constants/mediaUrls.ts:33,40,47:
  * TODO: Replace with actual video URL` (3 markers, one file, coalesced)
- boundary: `agent-server/apps/agent/lib/constants/mediaUrls.ts`
- evidence: three identical markers in one constants file.
- done-check: `git grep -n 'Replace with actual video URL' -- agent-server`
  returns nothing.
- needs: the actual URLs - nowhere in the evidence; a person supplies them.
- status: recorded

#### C-4 Replace the --browseros-cdp-port workaround everywhere it is copied
- source: the `todo` command above ->
  `agent-server/apps/agent/web-ext.config.ts:14`,
  `agent-server/apps/server/tests/__helpers__/browser.ts:106`,
  `agent-server/scripts/dev/start.ts:197` - the same sentence in three
  files (3 markers, coalesced; the boundary is the union of the three)
- boundary: `agent-server/apps/agent/web-ext.config.ts`,
  `agent-server/apps/server/tests/__helpers__/browser.ts`,
  `agent-server/scripts/dev/start.ts`
- evidence: one sentence copied into three files, each naming the same
  upstream condition.
- done-check: `git grep -n 'browseros-cdp-port once we fix' -- agent-server`
  returns nothing.
- needs: the browseros bug fixed (the marker's own condition "once we fix
  the browseros bug"); publishing may defer until then.
- status: recorded (blocked-on named in the marker's own text)

#### C-5 Wire or remove the GitButler MCP tool stubs
- source: the `todo` command above ->
  `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-highlevel.ts:20,54,81,109`
  and `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-stage.ts:32,65,94,116`
  - the same sentence, "TODO: Call GitButler MCP tool", 8 markers, 2 files
  (coalesced; boundary is the union)
- boundary: `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-highlevel.ts`,
  `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-stage.ts`
- evidence: every tool handler in both files is a stub returning before
  doing its work; the markers sit where the call belongs.
- done-check: `git grep -n 'TODO: Call GitButler MCP tool' -- agent-server`
  returns nothing, and each handler either calls the tool or is removed.
- needs: whether the bridge is wanted at all - a publishing decision may
  reject the whole family (C-5, C-6, C-7) as one question.
- status: recorded

#### C-6 Replace the vision-context placeholders
- source: the `todo` command above ->
  `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-context.ts:136,148,149`
  (3 markers, one file, coalesced)
- boundary: `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision-context.ts`
- evidence: the file's context builder is a placeholder LLM call with two
  hardcoded fields ("get from gitbutler config", "get from git status").
- done-check: `git grep -nE 'actual LLM calls|get from gitbutler config|get from git status' -- agent-server/apps/trios-mcp-bridge`
  returns nothing.
- needs: the LLM wiring decision (belongs with C-5/C-7).
- status: recorded

#### C-7 Wire or remove the vision tool stubs
- source: the `todo` command above ->
  `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision.ts:49,70`
  (2 markers, one file, coalesced)
- boundary: `agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision.ts`
- evidence: both markers name their own options ("Anthropic API or local
  vision model").
- done-check: `git grep -nE 'Call Anthropic API|mock implementation' -- agent-server/apps/trios-mcp-bridge/src/tools/gitbutler-vision.ts`
  returns nothing.
- needs: which of the two options the marker names.
- status: recorded

#### C-8 Drop the persisted role block once acpx/runtime exposes a system prompt
- source: the `todo` command above ->
  `agent-server/apps/server/src/lib/agents/acpx-runtime.ts:444:
  * TODO: drop this once acpx/runtime exposes a real system-prompt`
- boundary: `agent-server/apps/server/src/lib/agents/acpx-runtime.ts`
- evidence: one marker, in the doc comment of
  `unwrapBrowserosAcpUserMessage`; the marker's own continuation (lines
  445-447) names the condition and says the debt is "Tracked in the server
  architecture audit".
- done-check: the marker is gone and the role block is no longer persisted
  on every user message.
- needs: the upstream condition (acpx/runtime); and the publishing decision
  must first check the server architecture audit the marker names, so this
  does not become a duplicate of work already tracked there.
- status: recorded (blocked-on named in the marker's own text)

#### C-9 Type the GraphQL variables and drop the suppressions
- source: the `todo` command above ->
  `agent-server/apps/agent/lib/graphql/getQueryKeyFromDocument.ts:18`,
  `agent-server/apps/agent/lib/graphql/useGraphqlInfiniteQuery.ts:16`,
  `agent-server/apps/agent/lib/graphql/useGraphqlQuery.ts:11` - the same
  sentence, "TODO(dani) type GraphQL variables properly", 3 markers,
  3 files (coalesced; boundary is the union)
- boundary: `agent-server/apps/agent/lib/graphql/getQueryKeyFromDocument.ts`,
  `agent-server/apps/agent/lib/graphql/useGraphqlInfiniteQuery.ts`,
  `agent-server/apps/agent/lib/graphql/useGraphqlQuery.ts`
- evidence: three biome-ignore suppressions of
  `lint/suspicious/noExplicitAny`, each carrying the marker.
- done-check: `git grep -n 'TODO(dani) type GraphQL variables' -- agent-server`
  returns nothing, the suppressions are gone, and
  `bun run lint` (biome check, `agent-server/package.json`) passes on the
  three files.
- needs: nothing beyond the spec shape.
- status: recorded

#### C-10 Refactor the two over-complex handlers and drop the suppressions
- source: the `todo` command above ->
  `agent-server/apps/agent/entrypoints/background/scheduledJobRuns.ts:152`,
  `agent-server/apps/agent/lib/schedules/syncSchedulesToBackend.ts:83` -
  the same sentence, "TODO(dani) refactor to reduce complexity", 2
  markers, 2 files (coalesced; boundary is the union)
- boundary: `agent-server/apps/agent/entrypoints/background/scheduledJobRuns.ts`,
  `agent-server/apps/agent/lib/schedules/syncSchedulesToBackend.ts`
- evidence: two biome-ignore suppressions of
  `lint/complexity/noExcessiveCognitiveComplexity`, each carrying the
  marker.
- done-check: `git grep -n 'TODO(dani) refactor to reduce complexity' -- agent-server`
  returns nothing, the suppressions are gone, and `bun run lint` passes on
  the two files.
- needs: nothing beyond the spec shape.
- status: recorded

**Discarded (1).**

#### D-1 The registered swift-test post-bundle failure
- source: `.trinity/wave-loop-130.md:22-25` (registered, with output) and
  `:49-50` (named the next diagnosis) - a `gate` artefact the repository
  itself produced
- reason discarded: the recorded output - `unexpected input file:
  .trinity/build/QueenCore/libQueenCore.a` - names no source file, and the
  registering log's own words ("a separate diagnosis - someone's
  post-bundle step") say the author could not name one either. A boundary
  of `build.sh` or the `Makefile` would be a guess, and a guessed boundary
  sends a bee at the wrong files.
- remedy: the next round re-reads the artefact; if a newer wave log names
  the file the flags leak from, the candidate returns with that boundary.
- status: discarded (boundary not takeable from evidence)

**Counts.**

| | |
|---|---|
| markers found (`todo` source) | 27 |
| recorded candidates | 10 (C-1 .. C-10) |
| markers coalesced into them | 17 (27 markers -> 10 candidates) |
| discarded | 1 (D-1: no boundary from evidence) |
| `gate` source | 3 gates run, all green; 1 recorded failure -> discarded (D-1) |
| `warning` source | consulted; no recorded artefacts in this checkout; 0 candidates, 0 discarded |
| duplicates of board work | 0 (checked against `.trinity/queue/` and `.trinity/claims/`) |

**Summary.** Round 1 derived 10 candidates (all from unresolved TODO
markers), coalesced 17 duplicate markers into them, and discarded 1
candidate whose boundary could not be taken from evidence; the gate source
was green on all three gates it could run and produced the one discard;
the warning source was consulted and held nothing recorded to read.
