# Emit a usage SSE event from the agent-server chat stream

Status: ACTIVATED AND PROVEN 2026-08-21 ~15:50Z. The quiet window arrived
(the #1131 bee settled at the send-back ceiling), the app was relaunched
with TRIOS_EMIT_USAGE=1 + TRIOS_BASH_ENV_ALLOWLIST=1, the 9105 server
respawned with the inherited flags, and `make chat-probe VARIANT=release`
passed THROUGH the transform printing:
    usage: 18308 in / 45 out tokens (usage SSE frame received)
Emission is now ON by default (opt-out TRIOS_EMIT_USAGE=0). Still pending:
a delegated WORKER turn writing nonzero tokens into the registry (`make
spend`), and a worker bash call under the env allowlist - the scrub stays
opt-in until that is observed. The same window also proved on the wire:
conversation.persist.heal_sweep (45 conversations, self-triggered),
keychain.read.served_late x3, and settle tails up to 215.6s (securityd
slow-but-successful, the never-returns theory dead).

Probe gap found and fixed in the same window: tools/ChatProbe.swift never
read TRIOS_<PROVIDER>_API_KEY from the environment (only as a JSON key in
config files), so `make chat-probe VARIANT=release` could not succeed on a
machine whose config.json holds the documented zero-length values. Env is
now the probe's first source, and the probe prints the usage frame so a
probe run IS the wire proof.

## Activation procedure (the next quiet window: zero running workers)

1. `make board` must show zero running/queued.
2. Rebuild + relaunch the app so the pending Swift fixes go live too (heal
   sweep bd08669c8, finished_after_cancel + archive stamp 8bad40780 /
   33f6600ad): `make release && make relaunch`.
   To carry the flags, relaunch manually instead:
   `pkill -f "trios/trios.app/Contents/MacOS"; open trios.app --env TRIOS_EMIT_USAGE=1 --env TRIOS_BASH_ENV_ALLOWLIST=1`
   (AgentServerLauncher inherits the app env and passes it to the bun
   server it spawns; the launcher only spawns when /health does not answer).
3. Kill the 9105 server (`kill <pid of bun ...9105>`) AFTER the app is up;
   the app's watchdog respawns it with the inherited flags.
4. Verify: `make chat-probe VARIANT=release` answers; `make signals` shows
   no new parse errors; after one delegated worker turn, `make spend` stops
   saying "structurally unmeasured" and the registry holds nonzero tokens.
5. Only then consider flipping the defaults.

## Adjacent noise worth fixing in the same window

The PR poller wakes on CLA-bot reds and tries illegal transitions: measured
`queen.pr.gate_red | #74/#75 is red: a check failed` followed by `Cannot
move ... from accepted to rejected` - 23x/day on dev, now recurring on
release for PR #74 (and #79 before its merge). Every queen PR fails the
`cla` check (the bot does not know the Queen), so gate_red is permanent
noise: either exempt the cla check in QueenMergeGate's red-check reading,
or stop attempting accepted->rejected on a red poll (the transition is
illegal anyway; the machine already refuses it).
First candidate for the next improvement cycle THAT CAN RESTART THE SERVER -
this change activates only on a server restart, and restarts are forbidden
while a worker is in flight, which is why it was specified rather than landed
on 2026-08-21 (a bee was live on #1131).

## The measured problem

Every layer of the spend pipeline exists and is fed zeros at the source:

- Swift parser: `rings/SR-01/ChatEvents.swift:154-164` handles SSE data type
  `"usage"` (accepts prompt_tokens/input_tokens/inputTokens and completion/
  output variants). Dead code against this server.
- Transcript: `.recordUsage` increments only from that event
  (`rings/SR-00/QueenWorkerTranscript.swift:102-104`).
- Registry: `QueenDelegationRegistry.recordUsage`
  (`rings/SR-02/QueenDelegationRegistry.swift:319-343`) persists
  inputTokens/outputTokens - measured: 49 of 49 tasks hold 0/0 while
  toolCalls sum to 2,015.
- Budget: `SwarmBudget` ($10/day default, `ModelPricing.swift:97-118`) is
  enforced at dispatch (`ChatViewModel.swift:4062-4084`) and can never trip
  because `spentToday()` sums estimated costs over zero tokens.
- Server side: grep across `agent-server/apps/server/src` finds NO usage
  writes into the chat stream. The only token accounting is internal to
  compaction (`src/agent/compaction/utils.ts` reads `step.usage.inputTokens`)
  - proof the per-step usage IS available server-side.

## The plan

1. Accumulate per-step usage in the agent session. `ToolLoopAgent` (package
   `ai` ^6.0.94) is constructed in `src/agent/ai-sdk-agent.ts` (~line 264);
   `prepareStep` already receives `steps: ReadonlyArray<StepWithUsage>`.
   Either pass `onStepFinish` to the constructor (verify the v6 Agent class
   forwards it) or read the final steps array at finish; sum
   `usage.inputTokens`/`usage.outputTokens`.
2. Inject one SSE frame before the stream terminates, from
   `createAgentUIStreamResponse`'s response in
   `src/api/services/chat-service.ts` (two call sites, ~lines 309 and 365):
   wrap `response.body` in a TransformStream whose flush() writes
   `data: {"type":"usage","usage":{"inputTokens":N,"outputTokens":M}}\n\n`
   BEFORE closing - and verify against the Swift transport whether frames
   after the SDK's own `[DONE]` are still parsed; if not, inject on seeing
   the finish part instead (mind chunk-boundary splits when scanning).
3. Flag-gate: `TRIOS_EMIT_USAGE=1` env on the server process, default off,
   same pattern as `TRIOS_BASH_ENV_ALLOWLIST` in
   `src/tools/filesystem/bash.ts`. Flip the default only after step 4.
4. Verify on the wire: restart the server (only with zero running workers),
   run `make chat-probe`, then confirm (a) the release log carries no parse
   errors, (b) a delegated worker turn writes nonzero
   inputTokens/outputTokens into `.trinity/state/queen_delegation.json`
   (`make spend` stops saying "structurally unmeasured"), (c)
   `queen.worker.expensive` fires past its threshold on a long turn.

## Adjacent facts worth keeping

- Price SSOT is `rings/SR-00/ModelPricing.swift` (micro-USD); the second
  table in `ModelCostService.swift` disagrees on glm-5 ($0.60/$2.20 vs
  $1.00/$2.00) and is tier-classification only. `tools/forensics.py`
  duplicates the ModelPricing table for `make spend` - update together.
- `pruneArchive(limit: 50)` deletes old settled tasks, so registry-based
  aggregates are never all-time; a durable spend ledger (append-only JSONL
  beside the registry) is the follow-up once numbers are real.
- The interactive chat's TokenUsageLedger is in-memory, partly estimated
  ('~' prefix), reset on conversation switch, never persisted - not a spend
  source.
