# Queen supervisor - how the swarm actually works

Written at WAVE-064. Read this before touching delegation, the worker runner,
or the Queen's chat.

## The shape

```
Queen chat (E621E1F8-...)          reserved, pinned, never deleted
  |
  +-- /delegate owner/repo#N worker [--paths a,b] title
  |     -> QueenDelegationRegistry.shared   one live task per issue, max 4
  |     -> git branch queen/<N>-<slug> HEAD  ref only; HEAD never moves
  |     -> QueenBranchCommitter.snapshotWorkingTree()   baseline
  |     -> QueenWorkerRunner.start()   own SSETransport, own conversation
  |
  +-- worker chat            brief as first user turn, no Queen history
  |     -> on finish: diff baseline vs now, commit owned paths to the branch
  |     -> registry: running -> awaitingReview (or failed)
  |
  +-- /swarm | /accept <issue> | /review <issue> reject <why>
  +-- QueenReviewScheduler   every 30 min, silent when idle
```

## Invariants

1. **HEAD never moves.** Branch creation is `git branch <name> HEAD`; commits go
   through a throwaway `GIT_INDEX_FILE` plus `commit-tree` / `update-ref`.
   `git checkout -b` once dragged the whole shared checkout onto one bee's
   branch.
2. **Run git plumbing at `git rev-parse --show-toplevel`, not `ProjectPaths.root`.**
   trios sits inside the BrowserOS checkout, so git reports `trios/docs/...`
   while owned paths are written `docs`.
3. **Workers get `workingDirectory: ProjectPaths.root`.** The default is the
   user's home, and a bee once "successfully" wrote its file into an unrelated
   checkout at `~/gitbutler/trios`.
4. **Worker transports get `resourceTimeout: 3600`.** The 600s chat default is a
   whole-stream cap and killed a worker after 17 successful tool calls.
5. **The Queen never edits code.** `QueenDelegationPolicy.queenForbiddenTools`
   encodes it so the rule is testable rather than aspirational.
6. **Workers never see the Queen's history**, only their own chat. Context
   subsetting is the point of the supervisor pattern.

## Gotchas

- Without `--paths`, the brief tells the worker to ask before editing shared
  files, so a write task legitimately produces no writes.
- A task reading `running` in the registry may have a dead stream. The dashboard
  cross-checks `QueenWorkerRunner.runningConversationIds` and shows `no stream`.
- System notices carry ASCII severity markers (`[ok] `, `[i] `, `[!] `, `[x] `).
  Post through `postQueenNotice` with a marker or it renders as guessed severity.
- An aborted turn leaves an orphaned tool call that poisons the conversation
  permanently. `repairOrphanToolCalls` fixes it server-side; do not remove it.

## Proving a change

```bash
make delegate-probe REVIEW=accept PATHS=docs TASK="Create the file docs/x.md with exactly one line: y"
```

Then read `.trinity-dev/logs/trios-app.jsonl` for `queen.delegate`,
`queen.worker.start`, `queen.worker.finish` (with an answer preview),
`queen.branch.committed`, `queen.selftest.passed`, `queen.review.posted`.

## Added at WAVE-065

- **Archive.** `state.isArchivable` is `accepted | cancelled` only. `failed` is
  terminal but stays in `registry.open`, because a failure nobody read is still
  work. `pruneArchive(limit: 50)` runs on every wake.
- **Economics.** SSE `.usage` accumulates in `QueenWorkerTranscript` and is
  recorded *additively* per task - a rejected bee is re-briefed in the same chat
  and its second attempt is not free. `workerTokenWarningThreshold` warns; it
  never kills, because cutting a bee mid-edit leaves the repo in a state nobody
  chose.
- **Autonomy.** `qualifiesForAutoAccept` needs an explicit boundary, at least
  one committed file, and normal cost. Off unless `TRIOS_QUEEN_AUTONOMY=1`.
- **Reaping.** `reapStalledWorkers` cancels `running` tasks with no live stream
  after an hour. Checks the runner, not just the registry.
- **OTLP.** `TRIOS_OTLP_ENDPOINT` (+ optional `TRIOS_OTLP_HEADERS=k=v,k2=v2`)
  turns on `TriosOTLPExporter`. Batches of 32, queue capped at 512 dropping
  oldest, backs off after 3 consecutive failures.

### Two ordering rules that caused wrong reports

1. **Commit and tally before transitioning to `awaitingReview`.** Otherwise a
   wake landing in between describes a finished task as having changed nothing.
2. **Never print a metric that was not measured.** `committedFiles == nil` means
   "not tallied yet", not zero. Token counts of 0 mean the provider sent no
   usage, not that the bee was free. Omit, do not print zero.

## Added at WAVE-066

- **Skills are files, not a literal.** `SkillCatalog` scans `.claude/skills`,
  `.trinity/skills` and `~/.claude/skills` for `SKILL.md`; project beats trinity
  beats user on a name clash. `QueenCommandParser` hands any unrecognised slash
  command to `SkillStore`, which refuses unknown or disabled ones. Adding a skill
  needs no rebuild. Manage at Cmd+4; disabled set lives in
  `.trinity/state/queen_skills.json` and is enforced for the Queen as well as
  the tab.
- **Cost in money.** `ModelPricing` matches by longest prefix so a point release
  inherits its family. Unknown model -> `nil`, never an average.
  `SwarmBudget.default` is $10/day and declines to START new work; running bees
  are never killed.
- **Nested traces.** OTLP records carry `traceId` hashed from the issue slug and
  `spanId` from the worker conversation, so a bee's work nests under the Queen's
  decision in a collector.
- **Observer.** `QueenObserver.evaluate` runs on every streamed delta: looping
  (same tool + same args 4x), spinning (25+ calls, no prose), out-of-bounds
  writes, overspending. Pure function over the transcript - not a second agent.
  Each concern is announced once per task, never repeated per delta.

### Where the four-skill limit came from

`QueenStatusViewModel.knownSkills` was `["/tri", "/doctor", "/god-mode",
"/bridge"]`. Everything else in `.claude/skills/` was unreachable. If you find
another allow-list of capability names written as a Swift literal, it is
probably the same bug.

## Added at WAVE-067

- **The Queen's context.** `QueenSystemPrompt.text(skills:disabledSkills:
  runningWorkers:awaitingReview:)` is composed into `userSystemPrompt` for the
  Queen's conversation only (`composedSystemPrompt()` in ChatViewModel). Without
  it she had no idea any skill existed. Verify with `chat.request.payload` ->
  `system_chars` / `system_skills`, counted out of the built body.
- **State must be stated.** The roster is labelled as the *enabled* set and the
  disabled ids are listed. Given only a list, the model invented an on/off
  state and reported a live skill as disabled.
- **Stamp every snapshot.** `/skills` output carries `As of HH:MM`, and the
  charter says it supersedes any earlier listing. An undated listing in the
  transcript outranked the live roster.
- **`--skill /name`** hands the SKILL.md body to the worker verbatim. Missing or
  disabled skill -> the delegation is rolled back, not silently briefed without.
- **`/cancel <issue> [why]`** stops a worker; Stop buttons in the swarm strip and
  the task banner call the same command.
- **Editing** is plain text over the whole file, validated on save. No form over
  the frontmatter: the file is the contract with the CLI, and an editor that
  hides part of it will eventually write something the CLI reads differently.

## Added at WAVE-068

- **Two layouts, two surfaces.** `AdaptiveChatWorkspace` switches at 760pt.
  Above it: `QueenDashboardView` + `QueenTaskBanner` + sidebar. Below it (the
  default 400pt panel): `QueenCompactSupervisorBar` only. Anything added to the
  expanded layout alone is invisible in the panel the user actually keeps open.

## Added at WAVE-069

- **Deterministic replay.** `TRIOS_REPLAY_CASSETTE=<path>` swaps the worker's
  transport for `ReplayTransport`. Cassettes live in `tests/cassettes/*.sse`,
  one raw SSE payload per line, `#` comments allowed. They feed the real
  `SSEEventParser`, so the parser is under test rather than bypassed.
  `make delegate-probe CASSETTE=$(pwd)/tests/cassettes/worker-happy-path.sse`.
  `worker-orphan-tool-call.sse` is the regression cassette for
  `AI_MissingToolResultsError`.
  Limit: a cassette proves stream handling, not filesystem effects. The replayed
  tool call writes nothing, so `queen.branch.empty` is correct, not a failure.
- **Salience.** `QueenSalience.reviewQueue` replaces age-only ordering.
  Weights: failed 40, rejected 25, expensive 20, committed nothing 15, age 1/hour
  capped at 24. The cap is the point - uncapped age drowns every other signal.
  `QueenSalience.reason(for:)` explains the ranking in the digest.
- **Expand is reversible.** `WindowManager.shared` holds the panel.
  `toggleFullScreen` used `NSApplication.keyWindow`, which is nil once focus
  leaves the panel, so expanding was one-way.

## Added at WAVE-070

- **Recording.** `TRIOS_RECORD_CASSETTE=<path>` makes `SSETransport` write raw
  wire payloads while a real stream runs. Flushed at stream end, never per
  event - an interrupted recording looks complete.
- **Cassette effects.** `#effect: write <relative-path> <content>` lines in a
  `.sse` cassette make `ReplayTransport` write those files before yielding, so
  the commit path runs. Paths are resolved against `ProjectPaths.root` and
  refused if they escape it.
- **Learned salience.** `SalienceLearner` (`.trinity/state/queen_salience.json`)
  tallies `seen` / `intervened` per `QueenSalience.Feature`. Weight becomes
  `rate * maximumWeight` after 8 observations, prior before that. Laplace
  smoothing on `rate` - without it one observation pins a feature at 0 or 1
  forever. Fed from `/accept` (no intervention), `/review ... reject` and
  `/cancel` (intervention). Installed via
  `QueenDelegationPolicy.learnedWeight` so the policy stays pure for tests.

## Added at WAVE-071

- **`make cassettes`** (also part of `make check`) replays every cassette and
  asserts an expected log marker. ~2s each, no provider. Add a case by adding a
  `cassette:marker:label` triple to the loop in the Makefile.
- **Observer cassettes.** `worker-looping.sse` and `worker-out-of-bounds.sse`
  trip `QueenObserver` on demand. Hand-written, not recorded: waiting for a real
  model to get stuck is not a test.
- **Clean fixtures before, not only after.** A cassette effect writes
  `docs/replay.md`; if it survives from the previous run the baseline diff is
  empty and the commit assertion fails on a working commit path. Cleaning only
  at the end makes the first run pass and the rest fail, which reads as flake.
