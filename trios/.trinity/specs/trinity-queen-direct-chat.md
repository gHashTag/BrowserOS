# Spec: Trinity Queen Direct Chat

**Status**: Draft  
**Issue**: browseros-ai/BrowserOS#2023  
**Law priority**: L1 (traceability) → L4 (testability) → L2 (canon) → L7 (no new scripts)

## Summary

Add a reserved, non-deletable **Trinity Queen** conversation inside the existing Chat tab. It is pinned at the top of the sidebar, uses a crown icon, and serves as the single A2A inbox for all agent activity.

## Requirements

### R1 — Reserved conversation
- A deterministic sentinel UUID (`E621E1F8-C36C-495A-93FC-0C247A3E6E5F`) identifies the Queen conversation.
- `ChatConversation.isReserved == true` for the sentinel.
- `ConversationPersister` refuses to clear it.
- `ChatViewModel.deleteConversation(_:)` and `togglePin(_:)` ignore the reserved ID.

### R2 — Always present and pinned
- `ChatViewModel.loadConversations()` inserts the Queen conversation if missing, pins it, and sets the canonical title/icon.
- `ChatSidebarView` sorts the reserved conversation above all other pinned rows and shows a `crown.fill` icon with orange accent.

### R3 — Direct A2A line
- `A2AMessageRouter` routes every inbound A2A event (`direct`, `broadcast`, `taskAssign`, `taskUpdate`, `taskResult`, `heartbeat`, `error`) into the Queen conversation.
- When the Queen chat is active, messages append live; otherwise they are persisted via `ConversationPersister`.
- `A2ARegistryClient.broadcast(payload:)` convenience helper lets Trios broadcast to all online agents.

### R4 — Context and online agents
- `ChatViewModel.persister` is exposed `private(set)` so Queen orchestrators can read other conversations through the persister protocol.
- `QueenCommandParser` turns slash commands in the Queen chat into actions:
  - `/help`, `/status`, `/agents`, `/chats`, `/switch`, `/new`, `/delete`, `/delegate`, `/broadcast`, `/audit`, `/memory`.
- `ChatViewModel.executeQueenCommand(_:originalText:)` implements each action, including listing all chats, switching the active chat, delegating tasks to online agents via A2A, and broadcasting to the agent network.

### R5 — Self-improvement
- `QueenSelfImprovementService` (MainActor) runs a safety-budget-gated periodic audit.
- `QueenSafetyBudget` is persisted to `.trinity/state/safety_budget.json`; if halted or depleted, audits are skipped.
- Each audit loads recent Queen turns, recalls long-term memory, writes an audit record to memory, and discovers online A2A agents.

## Files changed

- `rings/SR-01/ChatProtocols.swift` — `isReserved`, sentinel UUID, `trinityQueen` factory.
- `rings/SR-01/A2AMessage.swift` — `AgentTask.result`, `AgentTaskState.displayName`.
- `rings/SR-02/AgentMemoryService.swift` — raw `saveMemory(_:)` wrapper for audit records.
- `rings/SR-02/ConversationPersister.swift` — encryption at rest, refuse clear for reserved ID.
- `rings/SR-02/ChatViewModel.swift` — auto-insert/pin Queen, guards, slash commands, `executeQueenCommand`.
- `rings/SR-02/A2ARegistryClient.swift` — `broadcast(payload:)` helper.
- `rings/SR-02/QueenCommandParser.swift` — slash command parser (includes `/evolve`, `/proposals`, `/apply`, `/reject`).
- `rings/SR-02/QueenSelfImprovementService.swift` — safety-budget audit loop + weak-spot detection + proposal generation.
- `rings/SR-02/QueenProposalApplier.swift` — human-in-the-loop applier: git branch → patch → build → commit → push → draft PR.
- `BR-OUTPUT/A2AMessageRouter.swift` — route all A2A events to Queen conversation.
- `BR-OUTPUT/ChatSidebarView.swift` — crown icon, reserved sorting, hide Delete/Unpin.

## Test criteria

1. `./build.sh` passes (including ChatSSEEndToEnd tests).
2. `./trios` launches and sovereign health returns `{"status":"ok"}`.
3. Queen conversation appears in the sidebar with crown icon and cannot be deleted or unpinned.
4. Inbound A2A messages append to the Queen conversation timeline.
5. Queen slash commands (`/agents`, `/chats`, `/memory`, `/evolve`, `/proposals`) return system messages in the Queen chat.
6. `QueenSelfImprovementService` compiles, the safety-budget file defaults to active, and `/evolve` generates structured proposals saved to `.trinity/state/queen-proposals.json`.
7. `/apply <uuid>` creates a feature branch, writes the patch, runs `./build.sh`, commits, pushes, and opens a draft PR (human-in-the-loop).

## Non-goals

- No new `.sh` files on the critical path.
- No changes to `ProjectPaths.swift` or `TriosTheme.swift`.
- No autonomous merge to `dev`; human confirmation required.
