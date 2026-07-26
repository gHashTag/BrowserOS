# Plan: Trinity Queen Direct Chat — Non-Deletable, Context-Aware, Self-Improving

## Context

Trios already has:
- `ChatViewModel` managing conversations and messages (`rings/SR-02/ChatViewModel.swift`).
- `A2ARegistryClient` for agent discovery/messaging (`rings/SR-02/A2ARegistryClient.swift`).
- `A2AMessageRouter` routing inbound A2A events into the chat (`BR-OUTPUT/A2AMessageRouter.swift`).
- `AgentMemoryService` + `TODOPlanner` for durable memory and per-conversation plans (`rings/SR-02/AgentMemoryService.swift`, `rings/SR-02/TODOPlanner.swift`).
- `QueenStatusViewModel` observing processes/agents/skills (`BR-OUTPUT/QueenStatusViewModel.swift`).
- `QueenMasterViewModel` / `QueenIntelligenceEngine` prototypes for global orchestration (`BR-OUTPUT/QueenMasterViewModel.swift`, `BR-OUTPUT/QueenIntelligenceEngine.swift`).

The user wants a dedicated **Trinity Queen conversation** inside the existing Chat tab with four properties:
1. Non-deletable and always pinned.
2. Direct line to the Trinity network via A2A.
3. Visibility into all open chats + online agent work + ability to act on behalf of the user.
4. Autonomous self-improvement loop.

## Goal

Add a reserved `Trinity Queen` conversation to `ChatViewModel` that:
- Cannot be deleted or unpinned by the user.
- Is wired to the A2A registry as both sender and listener.
- Receives a read/write snapshot of other conversations and live agent status.
- Can create/switch/delete conversations and delegate tasks to other agents.
- Runs a bounded self-improvement loop: memory consolidation, auto-delegation, periodic audit, and optional code-change proposals gated by safety budget.

## Non-Goals

- No new shell scripts on the critical path (L7).
- No rewrite of `CladeGuard.swift`, `RecursionGuard.swift`, or `ChatLogic.swift` (T27-CANON).
- No changes to `ProjectPaths.swift` or `TriosTheme.swift` without L6 waiver (L6).
- No changes to `gHashTag/trinity` QueenUILib; the feature lives entirely in Trios.
- No autonomous merge to `dev` or auto-PR merge without human confirmation.

## User Choices

| Decision | User choice |
|----------|-------------|
| UI shape | Dedicated non-deletable conversation inside the existing Chat tab |
| Transport | A2A registry (`A2ARegistryClient`) |
| Context access | Full control: read/write across conversations and agent tasks |
| Self-improvement | All four modes combined, with safety guardrails |
| Issue anchor | `#TBD` — create or assign before implementation starts (L1) |

## Files to Modify / Create

### Data model
- `trios/rings/SR-01/ChatProtocols.swift`
  - Add `isReserved: Bool?` (or `isDeletable: Bool`) to `ChatConversation`.
  - Add reserved conversation sentinel constants (`trinityQueenConversationId`).

### Conversation lifecycle
- `trios/rings/SR-02/ChatViewModel.swift`
  - Ensure `Trinity Queen` conversation always exists in `conversations` on load.
  - Guard `deleteConversation` against reserved IDs.
  - Guard `togglePin` so reserved conversation is always pinned.
  - Add `sendQueenMessage`, `delegateToAgent`, `broadcastToAll`, `openChatForAgent`.
  - Expose `allChatsSnapshot` and `onlineAgents` publishers.
  - Wire A2A inbound events to the Queen conversation.

### Persistence
- `trios/rings/SR-02/ConversationPersister.swift`
  - Persist reserved flag.
  - Refuse to clear a reserved conversation (return error/ignore).

### Sidebar UI
- `trios/BR-OUTPUT/ChatSidebarView.swift`
  - Render reserved conversation with crown icon and distinct accent.
  - Hide Delete/Unpin context-menu items for reserved conversation.
  - Add "Open Queen workspace" hint.

### A2A routing
- `trios/BR-OUTPUT/A2AMessageRouter.swift`
  - Route `taskUpdate`, `taskResult`, `heartbeat`, `broadcast` into the Queen conversation as system/assistant messages.
  - Add handler for Queen-originated control messages (create chat, switch chat, assign task).

### Queen orchestrator
- `trios/BR-OUTPUT/QueenMasterViewModel.swift` (harden existing prototype)
  - Add `activeChats: [ChatConversationSnapshot]`, `onlineAgents: [AgentCard]`, `selfImprovementLog: [QueenImprovementEvent]`.
  - Add `observe(chatViewModel:)`, `observe(a2aClient:)`, `observe(statusVM:)`.
- `trios/BR-OUTPUT/QueenIntelligenceEngine.swift` (harden existing prototype)
  - Implement real `analyzeAndPlan` using LLMClient with structured JSON output.
  - Add `proposeImprovements(from audit:)`, `scoreConfidence`.

### Self-improvement service
- `trios/rings/SR-02/QueenSelfImprovementService.swift` (new)
  - Periodic timer (60 min default) that:
    1. Reads recent Queen conversation turns.
    2. Calls `AgentMemoryService.recall` and `rememberCompletedTurn`.
    3. Builds an improvement plan via `QueenIntelligenceEngine`.
    4. Delegates safe tasks to A2A agents (`taskAssign`).
    5. For code changes: creates a worktree patch and opens a PR only if `safetyBudget > 0` and user has pre-authorized auto-PR for the current session.
  - Persist improvement events to SQLite via `MemoryStore`, never to `/tmp`.

### Safety / audit
- `trios/BR-OUTPUT/QueenAuditLog.swift`
  - Move from `/tmp/queen_audit.json` to SQLite-backed `QueenAuditStore`.
  - Log every autonomous action: delegation, chat switch, memory write, PR proposal.

### Specs / claims
- `trios/.trinity/specs/trinity-queen-direct-chat.md` (new)
- Update `trios/.trinity/state/ownership-index.json` for new/modified files.
- Add `AGENT-V-WAIVER` headers where required (L2).

## Implementation Steps

### Step 1 — Reserved conversation model

In `ChatProtocols.swift`:

```swift
struct ChatConversation: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var isPinned: Bool
    var icon: String
    let updatedAt: Date
    var unreadCount: Int
    var isReserved: Bool  // new
}

extension ChatConversation {
    static let trinityQueenId = UUID(uuidString: " trinity-0000-queen-000000000001")!  // placeholder stable UUID
    static var trinityQueen: ChatConversation {
        ChatConversation(
            id: trinityQueenId,
            title: "Trinity Queen",
            isPinned: true,
            icon: "crown.fill",
            updatedAt: Date(),
            unreadCount: 0,
            isReserved: true
        )
    }
}
```

> Note: pick a real stable UUID before implementation.

### Step 2 — Guard conversation lifecycle

In `ChatViewModel`:
- `loadConversations()` inserts `.trinityQueen` if missing.
- `deleteConversation(id:)` returns immediately if `id == .trinityQueenId` (with system message in Queen chat).
- `togglePin(id:)` ignores `.trinityQueenId` (remains pinned).
- `renameConversation(id:, to:)` allows renaming display title but keeps reserved flag.

### Step 3 — Persistence updates

In `ConversationPersister.swift`:
- Encode/decode `isReserved`.
- `clear(conversationId:)` throws or no-ops for reserved ID.
- Ensure reserved conversation survives "delete all" operations.

### Step 4 — Sidebar rendering

In `ChatSidebarView.swift`:
- Reserved conversation always appears in "Pinned" section.
- Use `crown.fill` icon with `.orange` or `.yellow` accent.
- Context menu shows only Rename; Delete/Unpin hidden.
- Add subtle "Trinity" badge.

### Step 5 — A2A direct line

In `A2ARegistryClient` (if needed):
- Add `broadcast(_ message: A2AMessage)` helper.
- Add `observeAgents()` polling wrapper (already have `listAgents()`).

In `ChatViewModel`:
- On app launch, ensure `registerA2A()` runs.
- A2A inbound messages of type `.broadcast` and `.taskUpdate` are appended to the Queen conversation as assistant/system messages.
- When the user sends from the Queen conversation, route via `a2aClient?.sendMessage` as broadcast or direct based on parsed intent.

### Step 6 — Full context snapshot

In `ChatViewModel`:
- Add `allChatsSnapshot()` async -> `[ChatConversationSnapshot]`.
- Snapshot includes conversation ID, title, last message preview, agent/task status, unread count.
- For full-message access, snapshot includes last N (e.g., 20) messages of each chat with redaction of secrets via `AgentMemoryService.redacted`.
- Expose as `@Published var queenContext: QueenContextSnapshot?`.

### Step 7 — Online agent observation

In `QueenStatusViewModel`:
- Already polls processes. Extend to poll `a2aClient?.listAgents()` when A2A is registered.
- Publish `onlineAgentCards: [AgentCard]`.

In `ChatViewModel`:
- Subscribe to `queenStatusVM.onlineAgentCards` and feed them into Queen conversation as system context updates (throttled, e.g., every 30s).

### Step 8 — Full-control actions

In `ChatViewModel`:
- `createChatAndSwitch(title:)` — create a new conversation and switch to it.
- `delegateTaskToAgent(task: AgentTask, agentId: AgentId)` — use `a2aClient.assignTask`.
- `broadcastToAllAgents(message:)` — use `a2aClient.sendMessage` as broadcast.
- `executeQueenCommand(_ command: QueenCommand)` parser for commands like `/open <chat>`, `/delegate <agent> <task>`, `/audit`, `/improve`.

### Step 9 — Self-improvement service

Create `QueenSelfImprovementService`:
- Actor-backed to run off main thread.
- Configurable interval (default 60 min, overridable via `TRIOS_QUEEN_IMPROVE_INTERVAL_MINUTES`).
- Loop:
  1. `auditCurrentState()` — gather recent turns, plans, agent status.
  2. `recallPatterns()` — `AgentMemoryService.recall`.
  3. `proposeImprovements()` — `QueenIntelligenceEngine.analyzeAndPlan`.
  4. `executeSafeImprovements()` — delegate tasks via A2A, update memory.
  5. `proposeCodeChanges()` — only if safety budget > 0; generate worktree diff, open PR as draft, notify user in Queen chat.
- Every action logged to `QueenAuditStore`.

### Step 10 — Audit store

Replace `/tmp/queen_audit.json`:
- Use existing `MemoryStore` table or add a new `queen_audit_log` table.
- Store timestamp, action type, outcome, safety budget, diff hash.

### Step 11 — Tests

1. **Unit tests in `tests/TriOSKitTests/` or `tests/swift/:`**
   - Reserved conversation is created on load and cannot be deleted.
   - `togglePin` on reserved conversation is no-op.
   - A2A broadcast message appears in Queen conversation.
   - Queen command parser recognizes `/open`, `/delegate`, `/audit`, `/improve`.
   - `QueenSelfImprovementService` respects safety budget and does not open PR when budget <= 0.
   - Audit log persists across app restart.

2. **Build & runtime verification:**
   - `./build.sh` passes.
   - `cargo test --workspace` passes.
   - `./trios` launches; Queen conversation visible and A2A registered.
   - Health check returns `status=ok`.

3. **E2E / smoke:**
   - Send message from Queen conversation; verify broadcast reaches A2A registry.
   - Create new chat via Queen command; verify conversation appears in sidebar.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Reserved conversation UUID collides with a user's existing chat | Use a v5 UUID derived from a stable DNS namespace + "trinity.queen"; check on load and migrate if collision detected. |
| Full context access leaks secrets into Queen chat | Redact via `AgentMemoryService.redacted` before snapshot; never include raw tool payloads or file contents. |
| Auto-delegation runs destructive actions without confirmation | Mark destructive actions as `requiresConfirmation`; only delegate to trusted agents; require positive safety budget. |
| Self-improvement loop writes bad code / opens spam PRs | PRs are drafts; user must review/approve merge; safety budget decremented on each proposal; halt if budget <= 0. |
| A2A registry unavailable breaks Queen chat | Fall back to local echo + retry; show "A2A offline" status in Queen row. |
| T27 canon violations | Add `AGENT-V-WAIVER` to all modified BR-OUTPUT/rings files; update `ownership-index.json`; do not touch T27-CANON files. |

## T27 / Canon Compliance

- All new/modified `BR-OUTPUT/*.swift` and `rings/SR-0x/*.swift` files must start with an `// AGENT-V-WAIVER:` block referencing `#TBD` (replace with real issue before code).
- `ChatLogic.swift`, `CladeGuard.swift`, `RecursionGuard.swift` are **not modified**.
- `ProjectPaths.swift` and `TriosTheme.swift` are **not modified**.
- New spec created under `.trinity/specs/trinity-queen-direct-chat.md`.
- Ownership index updated for new files.

## Follow-ups

- Add Queen command natural-language parser (currently slash-command based).
- Wire mesh network as fallback transport if A2A is down.
- Add SwiftUI test snapshots for Queen conversation row.
- Move `QueenSelfImprovementService` PR logic to `clade-improve` Rust bin for heavier sandboxing.
