# Agent Reliability Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the observe-only safety foundation that gives every chat turn an owned lifecycle, prevents concurrent mutation of one conversation, propagates cancellation, records immutable normalized tool evidence, and rebuilds stale agent sessions from a secret-safe execution fingerprint.

**Architecture:** A minimal `ExecutionRun` and lease live beside the long-lived `AgentSession`, while tool wrappers emit immutable evidence without changing model output. A canonical SHA-256 fingerprint covers every effective agent-constructor input and replaces three partial rebuild decisions with one rebuild. Wave 1 observes outcomes but does not classify intent, buffer prose, retry, or block unsupported success.

**Tech Stack:** TypeScript, Bun 1.3, AI SDK 6, Zod, Bun test, BrowserOS server.

---

## Scope boundaries

Wave 1 intentionally does not:

- change the request or Swift protocol;
- classify conversational versus action intent;
- alter SSE bytes or assistant prose;
- enforce terminal truthfulness;
- retry a model generation;
- treat restored history as current-run evidence;
- add semantic compaction.

The worktree is:

```text
/Users/playra/.config/superpowers/worktrees/BrowserOS-full/agent-reliability
```

Run server commands from:

```text
/Users/playra/.config/superpowers/worktrees/BrowserOS-full/agent-reliability/packages/browseros-agent
```

## File responsibility map

New production files:

- `apps/server/src/agent/execution-types.ts` — shared immutable run/evidence/result types.
- `apps/server/src/agent/execution-run.ts` — pure run transitions and approval-ID extraction.
- `apps/server/src/agent/execution-evidence.ts` — result normalization, immutable evidence append, and tool-set observation wrapper.
- `apps/server/src/agent/session-fingerprint.ts` — canonical, secret-safe execution fingerprint.

New test files:

- `apps/server/tests/agent/execution-run.test.ts`
- `apps/server/tests/agent/session-store.test.ts`
- `apps/server/tests/agent/tool-adapter.test.ts`
- `apps/server/tests/agent/execution-evidence.test.ts`
- `apps/server/tests/agent/session-fingerprint.test.ts`

Existing files modified:

- `apps/server/src/agent/session-store.ts` — turn leases and stored fingerprint.
- `apps/server/src/agent/tool-adapter.ts` — request/timeout signal composition and structured result preservation.
- `apps/server/src/tools/framework.ts` — pass abort signal to handlers and post-actions.
- `apps/server/src/tools/response.ts` — abortable post-action build and optional trusted receipt.
- `apps/server/src/agent/ai-sdk-agent.ts` — attach the evidence observer to the final merged tool set.
- `apps/server/src/api/services/chat-service.ts` — own run lifecycle, observe stream completion, and perform one fingerprint rebuild.
- `apps/server/tests/tools/response.test.ts`
- `apps/server/tests/api/services/chat-service.test.ts`

### Task 1: Immutable execution run

**Files:**

- Create: `apps/server/src/agent/execution-types.ts`
- Create: `apps/server/src/agent/execution-run.ts`
- Test: `apps/server/tests/agent/execution-run.test.ts`

- [ ] **Step 1: Write the failing lifecycle tests**

Create tests that import the not-yet-existing public API and assert:

```ts
import { describe, expect, it } from 'bun:test'
import {
  collectPendingApprovalIds,
  completeExecutionRun,
  createExecutionRun,
  markRunWaitingForApproval,
  resumeExecutionRun,
  startExecutionRun,
} from '../../src/agent/execution-run'

describe('ExecutionRun', () => {
  it('creates a frozen planned observe-only run', () => {
    const run = createExecutionRun({
      runId: 'run-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      now: 100,
    })

    expect(run).toEqual({
      runId: 'run-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      intent: 'unknown',
      expectedEffects: [],
      phase: 'planned',
      waitingFor: undefined,
      attempt: 0,
      evidence: [],
      failureReason: undefined,
      effectState: 'none',
      startedAt: 100,
      finishedAt: undefined,
    })
    expect(Object.isFrozen(run)).toBe(true)
    expect(Object.isFrozen(run.evidence)).toBe(true)
  })

  it('moves through running, approval suspension, resume, and success', () => {
    const planned = createExecutionRun({
      runId: 'run-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      now: 100,
    })
    const running = startExecutionRun(planned)
    const waiting = markRunWaitingForApproval(running, ['approval-b', 'approval-a'])
    const resumed = resumeExecutionRun(waiting, ['approval-a', 'approval-b'])
    const succeeded = completeExecutionRun(resumed, {
      status: 'succeeded',
      now: 200,
    })

    expect(waiting.waitingFor?.approvalIds).toEqual([
      'approval-a',
      'approval-b',
    ])
    expect(resumed.phase).toBe('running')
    expect(succeeded.phase).toBe('succeeded')
    expect(succeeded.finishedAt).toBe(200)
    expect(planned.phase).toBe('planned')
  })

  it('rejects mismatched approval IDs and terminal transitions', () => {
    const running = startExecutionRun(
      createExecutionRun({
        runId: 'run-1',
        conversationId: 'conversation-1',
        userMessageId: 'message-1',
      }),
    )
    const waiting = markRunWaitingForApproval(running, ['approval-1'])

    expect(() => resumeExecutionRun(waiting, ['approval-2'])).toThrow(
      'Approval IDs do not match',
    )
    const failed = completeExecutionRun(waiting, {
      status: 'failed',
      failureReason: 'denied',
    })
    expect(() => startExecutionRun(failed)).toThrow(
      'Cannot start a terminal execution run',
    )
  })
})
```

Add a separate `collectPendingApprovalIds` case with duplicate and unordered
`approval-requested` parts and assert one sorted ID list.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test apps/server/tests/agent/execution-run.test.ts
```

Expected: FAIL because `execution-run.ts` does not exist.

- [ ] **Step 3: Add immutable shared types and pure transitions**

Define exact shared unions in `execution-types.ts`:

```ts
export type ExecutionIntent = 'unknown' | 'conversational' | 'action'
export type ExecutionRunPhase =
  | 'planned'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
export type ExecutionRunFailureReason =
  | 'denied'
  | 'aborted'
  | 'no-evidence'
  | 'execution-error'
export type ExecutionEffectState = 'none' | 'partial' | 'complete' | 'unknown'
export type ToolEffect =
  | 'observe'
  | 'filesystem-read'
  | 'filesystem-write'
  | 'command'
  | 'browser-write'
  | 'external-write'
  | 'verify'

export interface NormalizedToolResult {
  readonly transportStatus: 'received' | 'failed'
  readonly executionStatus: 'success' | 'error' | 'denied' | 'aborted'
  readonly effectStatus: 'none' | 'applied' | 'partial' | 'unknown'
  readonly verificationStatus:
    | 'not-run'
    | 'passed'
    | 'failed'
    | 'not-required'
}

export interface EvidenceEvent {
  readonly eventId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: 'requested' | 'settled' | 'verification'
  readonly effects: readonly ToolEffect[]
  readonly retrySafety: 'safe' | 'unsafe' | 'unknown'
  readonly result?: NormalizedToolResult
  readonly argumentDigest: string
  readonly outputDigest?: string
  readonly recordedAt: number
}

export interface ExecutionRun {
  readonly runId: string
  readonly conversationId: string
  readonly userMessageId: string
  readonly intent: ExecutionIntent
  readonly expectedEffects: readonly ToolEffect[]
  readonly phase: ExecutionRunPhase
  readonly waitingFor?: {
    readonly kind: 'approval'
    readonly approvalIds: readonly string[]
  }
  readonly attempt: 0 | 1
  readonly evidence: readonly EvidenceEvent[]
  readonly failureReason?: ExecutionRunFailureReason
  readonly effectState: ExecutionEffectState
  readonly startedAt: number
  readonly finishedAt?: number
}
```

Implement pure functions in `execution-run.ts`. Normalize approval IDs with
`[...new Set(ids.filter(Boolean))].sort()`, return a new deeply frozen snapshot,
and throw on invalid transitions. `createExecutionRun` uses `crypto.randomUUID()`
only when the caller did not provide `runId`.

- [ ] **Step 4: Run the lifecycle tests and verify GREEN**

Run:

```bash
bun test apps/server/tests/agent/execution-run.test.ts
```

Expected: all execution-run tests PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/server/src/agent/execution-types.ts \
  apps/server/src/agent/execution-run.ts \
  apps/server/tests/agent/execution-run.test.ts
git commit -m "feat(agent): add immutable execution run lifecycle"
```

### Task 2: Per-conversation turn lease

**Files:**

- Modify: `apps/server/src/agent/session-store.ts`
- Test: `apps/server/tests/agent/session-store.test.ts`

- [ ] **Step 1: Write failing lease ownership tests**

Cover these concrete behaviors:

```ts
const first = createExecutionRun({
  runId: 'run-1',
  conversationId: 'conversation-1',
  userMessageId: 'message-1',
})
const second = createExecutionRun({
  runId: 'run-2',
  conversationId: 'conversation-1',
  userMessageId: 'message-2',
})

expect(store.tryAcquireTurn(first)).toEqual({ acquired: true, run: first })
expect(store.tryAcquireTurn(second)).toEqual({
  acquired: false,
  activeRun: first,
})
expect(store.finishTurn('conversation-1', 'stale-run', {
  status: 'failed',
  failureReason: 'execution-error',
})).toBe(false)
expect(store.getActiveRun('conversation-1')?.runId).toBe('run-1')
expect(store.finishTurn('conversation-1', 'run-1', {
  status: 'succeeded',
})).toBe(true)
expect(store.getActiveRun('conversation-1')).toBeUndefined()
```

Also assert:

- different conversations acquire independently;
- suspension stores a sorted approval set;
- matching approval IDs resume the same `runId`;
- partial, mixed, unknown, and replayed approvals do not mutate the active run;
- replacing an `AgentSession` leaves the lease map intact.

- [ ] **Step 2: Run the tests and verify RED**

```bash
bun test apps/server/tests/agent/session-store.test.ts
```

Expected: FAIL because the lease methods do not exist.

- [ ] **Step 3: Implement owner-checked leases**

Add a private `activeRuns = new Map<string, ExecutionRun>()` to `SessionStore`.
Implement:

```ts
export type AcquireTurnResult =
  | { acquired: true; run: ExecutionRun }
  | { acquired: false; activeRun: ExecutionRun }

tryAcquireTurn(run: ExecutionRun): AcquireTurnResult
getActiveRun(conversationId: string): ExecutionRun | undefined
suspendTurnForApproval(
  conversationId: string,
  runId: string,
  approvalIds: readonly string[],
): ExecutionRun | undefined
tryResumeApprovalTurn(
  conversationId: string,
  approvalIds: readonly string[],
):
  | { resumed: true; run: ExecutionRun }
  | {
      resumed: false
      reason: 'no-active-run' | 'not-waiting' | 'approval-mismatch'
      activeRun?: ExecutionRun
    }
finishTurn(
  conversationId: string,
  runId: string,
  outcome:
    | { status: 'succeeded' }
    | {
        status: 'failed'
        failureReason: ExecutionRunFailureReason
        effectState?: ExecutionEffectState
      },
): boolean
recordEvidence(
  conversationId: string,
  runId: string,
  event: EvidenceEvent,
): boolean
```

Return frozen run snapshots and only delete a lease after matching both
`conversationId` and `runId`. `recordEvidence` rejects a stale owner and stores a
new frozen run containing a new frozen evidence array; Task 5 replaces the local
clone with the shared `appendEvidence` helper after that helper exists. Do not add
timeout-based lease stealing.

- [ ] **Step 4: Verify GREEN and regress SessionStore behavior**

```bash
bun test apps/server/tests/agent/session-store.test.ts
bun test apps/server/tests/api/services/chat-service.test.ts
```

Expected: new lease tests and existing ChatService tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/server/src/agent/session-store.ts \
  apps/server/tests/agent/session-store.test.ts
git commit -m "feat(agent): add owner-checked conversation turn leases"
```

### Task 3: Propagate abort signals through BrowserOS tools

**Files:**

- Modify: `apps/server/src/agent/tool-adapter.ts`
- Modify: `apps/server/src/tools/framework.ts`
- Modify: `apps/server/src/tools/response.ts`
- Test: `apps/server/tests/agent/tool-adapter.test.ts`
- Test: `apps/server/tests/tools/response.test.ts`

- [ ] **Step 1: Write failing abort propagation tests**

Create a small `ToolRegistry` containing a `defineTool` handler with a fourth
`signal` argument. Obtain its AI SDK `execute` function from
`buildBrowserToolSet`, invoke it with a controlled `AbortController`, and assert:

```ts
expect(capturedSignal).toBeDefined()
controller.abort('user cancelled')
expect(capturedSignal?.aborted).toBe(true)
```

Add a pre-aborted case proving the handler does not run and returns `isError:
true`. Add a `ToolResponse` case with a never-resolving snapshot and:

```ts
const controller = new AbortController()
const pending = response.build(browser, controller.signal)
controller.abort('cancel post-action')
const result = await pending
expect(result.isError).toBeUndefined()
```

The post-action abort remains non-fatal, matching existing post-action semantics.

- [ ] **Step 2: Run the tests and verify RED**

```bash
bun test apps/server/tests/agent/tool-adapter.test.ts \
  apps/server/tests/tools/response.test.ts
```

Expected: FAIL because the AI SDK request signal is ignored and `build` does not
accept a signal.

- [ ] **Step 3: Add signal composition and boundary propagation**

In `tool-adapter.ts` export:

```ts
export function combineToolAbortSignals(
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return requestSignal
    ? AbortSignal.any([requestSignal, timeoutSignal])
    : timeoutSignal
}
```

Change browser execution to `execute: async (params, options)`, compose
`options.abortSignal` with 120 seconds, and pass it to `executeTool`.

Extend `ToolHandler` with a fourth `AbortSignal` argument. In `executeTool`:

1. keep the pre-abort guard;
2. re-check after asynchronous ACL evaluation;
3. call `tool.handler(args, ctx, response, signal)`;
4. call `response.build(ctx.browser, signal)`.

In `ToolResponse`, race each post-action with both its existing timeout and an
optional abort signal. Always remove the abort listener in `finally`. Preserve
the rule that failed/aborted post-actions do not fail the original tool.

Preserve `structuredContent` in the browser adapter return object.

- [ ] **Step 4: Verify GREEN and tool regressions**

```bash
bun test apps/server/tests/agent/tool-adapter.test.ts \
  apps/server/tests/tools/response.test.ts
bun test apps/server/tests/tools/page-actions.test.ts \
  apps/server/tests/tools/input.test.ts
```

Expected: all selected tests PASS without waiting for production timeouts.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/server/src/agent/tool-adapter.ts \
  apps/server/src/tools/framework.ts \
  apps/server/src/tools/response.ts \
  apps/server/tests/agent/tool-adapter.test.ts \
  apps/server/tests/tools/response.test.ts
git commit -m "fix(agent): propagate request aborts through browser tools"
```

### Task 4: Normalize and record immutable tool evidence

**Files:**

- Create: `apps/server/src/agent/execution-evidence.ts`
- Test: `apps/server/tests/agent/execution-evidence.test.ts`

- [ ] **Step 1: Write the failing normalization table**

Use a table that asserts:

- `{ isError: true }` resolves as `received/error`;
- thrown transport failure resolves as `failed/error`;
- denial is `received/denied/none`;
- abort before start is `received/aborted/none`;
- abort after a mutating tool starts is `received/aborted/unknown`;
- read success is `received/success/none`;
- mutation without a trusted receipt is `received/success/unknown`;
- empty output and literal `"Success"` never become `applied`;
- a trusted receipt may mark `applied`, `partial`, or verification state.

Add immutability:

```ts
const prior: readonly EvidenceEvent[] = Object.freeze([])
const input = {
  eventId: 'event-1',
  toolCallId: 'call-1',
  toolName: 'filesystem_write',
  kind: 'settled' as const,
  effects: ['filesystem-write'] as const,
  retrySafety: 'safe' as const,
  result: normalized,
  argumentDigest: 'args',
  recordedAt: 100,
}
const next = appendEvidence(prior, input)
expect(next).not.toBe(prior)
expect(Object.isFrozen(next)).toBe(true)
expect(Object.isFrozen(next[0])).toBe(true)
expect(prior).toEqual([])
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
bun test apps/server/tests/agent/execution-evidence.test.ts
```

Expected: FAIL because the normalization module does not exist.

- [ ] **Step 3: Implement the pure evidence API**

Define:

```ts
export interface ToolExecutionReceipt {
  readonly effectStatus?: NormalizedToolResult['effectStatus']
  readonly verificationStatus?: NormalizedToolResult['verificationStatus']
}

export interface ToolResultObservation {
  readonly outcome: 'resolved' | 'rejected' | 'denied' | 'aborted'
  readonly started: boolean
  readonly effects: readonly ToolEffect[]
  readonly output?: unknown
  readonly receipt?: ToolExecutionReceipt
}

export function normalizeToolResult(
  observation: ToolResultObservation,
): NormalizedToolResult

export function appendEvidence(
  ledger: readonly EvidenceEvent[],
  event: EvidenceEvent,
): readonly EvidenceEvent[]
```

Semantic errors are detected only from trusted structured fields such as
`isError`; never parse success/failure from prose. Freeze nested arrays and result
objects when appending.

- [ ] **Step 4: Verify GREEN**

```bash
bun test apps/server/tests/agent/execution-evidence.test.ts
```

Expected: all normalization and immutability tests PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/server/src/agent/execution-evidence.ts \
  apps/server/tests/agent/execution-evidence.test.ts
git commit -m "feat(agent): normalize immutable tool execution evidence"
```

### Task 5: Observe the final merged tool set

**Files:**

- Modify: `apps/server/src/agent/execution-evidence.ts`
- Modify: `apps/server/src/agent/ai-sdk-agent.ts`
- Modify: `apps/server/src/agent/session-store.ts`
- Test: `apps/server/tests/agent/execution-evidence.test.ts`

- [ ] **Step 1: Write failing wrapper behavior tests**

Construct real AI SDK tools for:

- successful filesystem read;
- semantic `{ isError: true }`;
- thrown failure;
- abort before and after start;
- mutating success without receipt.

Assert `wrapToolSetWithEvidence`:

- forwards the original return value or rejection unchanged;
- records one `requested` and exactly one `settled` event using
  `options.toolCallId`;
- maps filesystem read/write/edit/bash names to curated effects;
- maps BrowserOS registry categories `observation`/`screenshots` to `observe`
  and other action categories to `browser-write`;
- treats unknown MCP names as `external-write` with retry safety `unknown`;
- works with no sink without changing behavior.

- [ ] **Step 2: Run the tests and verify RED**

```bash
bun test apps/server/tests/agent/execution-evidence.test.ts
```

Expected: FAIL because the wrapper and metadata resolver do not exist.

- [ ] **Step 3: Implement the observe-only wrapper**

Add:

```ts
export interface ToolEvidenceSink {
  record(event: EvidenceEvent): void
}

export interface ToolReliabilityDescriptor {
  readonly effects: readonly ToolEffect[]
  readonly retrySafety: 'safe' | 'unsafe' | 'unknown'
}

export function wrapToolSetWithEvidence(
  tools: ToolSet,
  options: {
    readonly evidenceSink?: ToolEvidenceSink
    readonly describeTool: (name: string) => ToolReliabilityDescriptor
  },
): ToolSet
```

The wrapper must pass both `(input, executionOptions)` to the original tool,
create safe SHA-256 argument/output digests, and settle once through a guarded
local function. It must not gate, retry, or rewrite output.

Give `AiSdkAgent` one stable mutable sink object at construction. Expose:

```ts
setEvidenceSink(sink: ToolEvidenceSink | undefined): void
```

The final merged browser/MCP/filesystem/memory tool object is wrapped once.
`ChatService` can change the sink per turn without rebuilding tool definitions.
Store evidence on the active `ExecutionRun` through owner-checked SessionStore
methods; restored history never invokes the sink.

- [ ] **Step 4: Verify GREEN and agent type safety**

```bash
bun test apps/server/tests/agent/execution-evidence.test.ts
bun run --filter @browseros/server typecheck
```

Expected: wrapper tests PASS and server typecheck succeeds.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/server/src/agent/execution-evidence.ts \
  apps/server/src/agent/ai-sdk-agent.ts \
  apps/server/src/agent/session-store.ts \
  apps/server/tests/agent/execution-evidence.test.ts
git commit -m "feat(agent): observe evidence across the merged tool set"
```

### Task 6: Secret-safe session execution fingerprint

**Files:**

- Create: `apps/server/src/agent/session-fingerprint.ts`
- Test: `apps/server/tests/agent/session-fingerprint.test.ts`

- [ ] **Step 1: Write failing canonical fingerprint tests**

Build complete fake `AiSdkAgentConfig` values and assert:

- identical effective inputs and reordered object keys/set-like arrays hash
  identically;
- `undefined` and effective constructor defaults hash identically;
- rotating each credential changes the digest;
- each constructor-bound field changes the digest;
- result matches `/^[a-f0-9]{64}$/`;
- digest and exported/loggable material never contain sentinel secrets.

The mutation table must cover provider, model, endpoint, upstream provider,
resource, region, account/access-key identity, three secret credentials,
reasoning settings, context window, system prompt, working directory, image
support, eval/chat/scheduled modes, declined apps, origin, BrowserOS ID,
approval configuration, active page ID, connected/custom MCP projection,
Klavis connection state, registry tool names, devtools, and ACL rules.

- [ ] **Step 2: Run the tests and verify RED**

```bash
bun test apps/server/tests/agent/session-fingerprint.test.ts
```

Expected: FAIL because `session-fingerprint.ts` does not exist.

- [ ] **Step 3: Implement canonical hashing**

Export:

```ts
export type SessionExecutionFingerprint = string

export function deriveSessionExecutionFingerprint(
  config: AiSdkAgentConfig,
): SessionExecutionFingerprint
```

Use `createHash('sha256')` from `node:crypto`. Build a versioned safe material
object by destructuring `apiKey`, `secretAccessKey`, and `sessionToken` out of
`resolvedConfig`; replace them with a SHA-256 digest of a length-prefixed tuple.
Recursively sort object keys. Sort/dedupe set-like arrays such as declined apps,
managed MCP names, registry names, and enabled approval categories. Preserve
custom-MCP order if it controls name-collision precedence.

Normalize defaults exactly as `AiSdkAgent.create` uses them:

```ts
contextWindowSize:
  resolvedConfig.contextWindowSize ?? AGENT_LIMITS.DEFAULT_CONTEXT_WINDOW
supportsImages: resolvedConfig.supportsImages !== false
evalMode: resolvedConfig.evalMode ?? false
chatMode: resolvedConfig.chatMode ?? false
isScheduledTask: resolvedConfig.isScheduledTask ?? false
aiSdkDevtoolsEnabled: config.aiSdkDevtoolsEnabled ?? false
```

Hash execution-relevant projections of process objects instead of object
identity.

- [ ] **Step 4: Verify GREEN**

```bash
bun test apps/server/tests/agent/session-fingerprint.test.ts
```

Expected: every canonicalization, mutation, and secrecy case PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add apps/server/src/agent/session-fingerprint.ts \
  apps/server/tests/agent/session-fingerprint.test.ts
git commit -m "feat(agent): derive secret-safe session fingerprints"
```

### Task 7: Rebuild stale sessions exactly once

**Files:**

- Modify: `apps/server/src/agent/session-store.ts`
- Modify: `apps/server/src/api/services/chat-service.ts`
- Test: `apps/server/tests/api/services/chat-service.test.ts`

- [ ] **Step 1: Write failing rebuild tests**

Extend the existing real behavior tests so:

- unchanged fingerprint creates one agent and reuses it;
- model-only and credential-only changes dispose/recreate before streaming;
- simultaneous model, MCP, workspace, and approval changes cause one dispose and
  one create, not three;
- reordered managed apps and approval keys do not rebuild;
- compatible history is preserved and sanitized;
- logger calls contain neither old nor new sentinel credentials.

- [ ] **Step 2: Run the service tests and verify RED**

```bash
bun test apps/server/tests/api/services/chat-service.test.ts
```

Expected: model/credential mutations reuse the stale agent or simultaneous
mutations rebuild more than once.

- [ ] **Step 3: Integrate one fingerprint comparison**

Construct one `AiSdkAgentConfig` object per request and pass that same object to
both `deriveSessionExecutionFingerprint` and `AiSdkAgent.create`.

Add required `executionFingerprint` to `AgentSession`. Keep legacy MCP/workspace/
approval keys temporarily for human-readable context-change notices, but replace
their three sequential rebuild branches with:

```ts
if (
  session &&
  session.executionFingerprint !== currentExecutionFingerprint
) {
  session = await this.rebuildSession(
    session,
    request,
    agentConfig,
    browserContext,
    currentExecutionFingerprint,
  )
}
```

Compute all notice deltas before rebuilding. Store the fingerprint on initial and
rebuilt sessions. Log only the fingerprint digest and safe change categories.

- [ ] **Step 4: Verify GREEN and grouped regressions**

```bash
bun test apps/server/tests/agent/session-fingerprint.test.ts \
  apps/server/tests/api/services/chat-service.test.ts
bun run --filter @browseros/server typecheck
```

Expected: all tests PASS and every effective configuration change rebuilds once.

- [ ] **Step 5: Commit Task 7**

```bash
git add apps/server/src/agent/session-store.ts \
  apps/server/src/api/services/chat-service.ts \
  apps/server/tests/api/services/chat-service.test.ts
git commit -m "fix(agent): rebuild sessions from execution fingerprints"
```

### Task 8: Integrate observe-only run ownership with ChatService

**Files:**

- Modify: `apps/server/src/agent/errors.ts`
- Modify: `apps/server/src/agent/ai-sdk-agent.ts`
- Modify: `apps/server/src/api/services/chat-service.ts`
- Test: `apps/server/tests/api/services/chat-service.test.ts`

- [ ] **Step 1: Write failing service lifecycle tests**

Assert:

- lease acquisition happens before LLM resolution or session mutation;
- a second ordinary turn for one conversation receives a 409 busy error;
- different conversations run independently;
- normal finish releases the matching lease;
- pre-stream exception releases the lease and closes a scheduled hidden page;
- abort/error releases as failed;
- approval-requested finish retains the run;
- matching approval continuation resumes the same run and appends no user message;
- partial, mixed, unknown, or replayed approvals are rejected atomically;
- stale duplicate `onFinish` cannot release a newer run;
- observe-only regression: zero-tool completion prose is streamed and persisted
  unchanged in Wave 1.

- [ ] **Step 2: Run the service tests and verify RED**

```bash
bun test apps/server/tests/api/services/chat-service.test.ts
```

Expected: overlapping turns are accepted and approval continuation has no owned
run.

- [ ] **Step 3: Implement owned lifecycle without enforcement**

Add `ConversationBusyError extends HttpAgentError` with status 409 and safe
`conversationId`/`activeRunId` metadata.

For ordinary turns, create and acquire `ExecutionRun` before the first `await`.
Allocate `userMessageId` in advance and update:

```ts
appendUserMessage(content: string, id = crypto.randomUUID()): string
```

For approval continuations, atomically match all approval IDs and reuse the
waiting run. Skip destructive session rebuild while a matching approval
continuation is active.

Use one finish helper for ordinary and approval streams:

- persist the existing messages;
- suspend when approval IDs remain;
- otherwise finish with observed success/failure;
- record metrics and release only by matching run ID;
- release/cleanup in every pre-stream exception path.

Set the current run's evidence sink before streaming and clear it only when the
run becomes terminal. Do not interpret observed success as verified action
success.

- [ ] **Step 4: Verify GREEN**

```bash
bun test apps/server/tests/agent/execution-run.test.ts \
  apps/server/tests/agent/session-store.test.ts \
  apps/server/tests/api/services/chat-service.test.ts
bun run --filter @browseros/server typecheck
```

Expected: all lifecycle, ownership, approval, and type tests PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add apps/server/src/agent/errors.ts \
  apps/server/src/agent/ai-sdk-agent.ts \
  apps/server/src/api/services/chat-service.ts \
  apps/server/tests/api/services/chat-service.test.ts
git commit -m "feat(agent): observe owned chat execution runs"
```

### Task 9: Wave 1 regression and evidence report

**Files:**

- Modify: `.llm/plans/2026-07-24-agent-reliability-wave-1.md`
- Create: `.llm/reports/2026-07-24-agent-reliability-wave-1.md`

- [ ] **Step 1: Run targeted and grouped suites**

```bash
bun test apps/server/tests/agent/execution-run.test.ts \
  apps/server/tests/agent/session-store.test.ts \
  apps/server/tests/agent/tool-adapter.test.ts \
  apps/server/tests/agent/execution-evidence.test.ts \
  apps/server/tests/agent/session-fingerprint.test.ts \
  apps/server/tests/api/services/chat-service.test.ts \
  apps/server/tests/tools/response.test.ts
bun test apps/server/tests/agent/compaction.test.ts \
  apps/server/tests/agent/compaction-e2e.test.ts
bun run --filter @browseros/server typecheck
```

Expected: zero failures.

- [ ] **Step 2: Run repository formatting checks on changed TypeScript**

```bash
bunx biome check \
  apps/server/src/agent \
  apps/server/src/api/services/chat-service.ts \
  apps/server/src/tools/framework.ts \
  apps/server/src/tools/response.ts \
  apps/server/tests/agent \
  apps/server/tests/api/services/chat-service.test.ts \
  apps/server/tests/tools/response.test.ts
```

Expected: zero errors.

- [ ] **Step 3: Record exact verification evidence**

The report must contain:

- commit range;
- changed files grouped by responsibility;
- every RED command and expected failure reason;
- every GREEN/regression command with pass/fail counts;
- review findings and their resolution;
- residual risks explicitly stating that Wave 1 is observe-only and does not yet
  prevent unsupported success prose.

- [ ] **Step 4: Commit the report**

```bash
git add .llm/plans/2026-07-24-agent-reliability-wave-1.md \
  .llm/reports/2026-07-24-agent-reliability-wave-1.md
git commit -m "docs: report agent reliability wave 1 evidence"
```

## Plan self-review

- Spec coverage for the shared Wave 1 foundation: mapped to Tasks 1–8.
- No terminal enforcement, retry, V2 history, compaction, or Swift work leaked
  into this plan.
- All production behavior tasks begin with a test that must be observed failing.
- Shared names are consistent: `ExecutionRun`, `EvidenceEvent`,
  `NormalizedToolResult`, `ToolEvidenceSink`,
  `SessionExecutionFingerprint`.
- Each task has an exact targeted command, regression command, and commit boundary.
