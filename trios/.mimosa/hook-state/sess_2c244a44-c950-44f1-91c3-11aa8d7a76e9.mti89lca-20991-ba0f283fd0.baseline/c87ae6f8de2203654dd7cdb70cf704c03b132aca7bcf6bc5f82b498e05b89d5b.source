# Plan: SSE End-to-End Integration Tests for TRIOS Chat

## Context

The core chat path in `trios/rings/SR-02/ChatViewModel.swift` is now stable after the recent fixes (message ordering, debounce, deduplication, state machine, SSE parsing). To guard against regressions in this exact path we need an automated test that exercises the full loop without requiring a live server:

1. `ChatViewModel.sendMessage(appendUser:)` builds a request body via `ChatRequestBuilder`.
2. The body is handed to a `ChatTransportProtocol` implementation.
3. The returned `AsyncStream<SSEEvent>` is parsed by `UIMessageStreamParser`.
4. `ParserAction`s mutate `@Published messages` and `ConversationState`.
5. On `finish` / `streamComplete`, history is saved via `ChatPersisterProtocol`.

There are already lightweight standalone Swift tests under `trios/tests/swift/` (e.g. `chat_logic_test.swift`, `trios_branding_test.swift`) using a custom `@main` runner. This plan follows the same no-SPM pattern so it does not block on Task #10 (Package.swift / Xcode scaffold).

## Goal

Add an in-process SSE E2E test for `ChatViewModel.sendMessage()` that verifies:

- A user message is appended to `messages`.
- `ChatRequestBuilder` produces a valid JSON body containing `conversationId`, `message`, `mode`, `origin`, `messages`, and runtime provider/model/baseURL fields.
- A mocked transport captures that body and yields a realistic SSE event sequence (`start`, `text-delta` × N, `finish`).
- The assistant message accumulates the deltas, remains `isStreaming` until the stream ends, and the final `messages` array contains exactly one user and one assistant message.
- `ConversationState` transitions `idle → streaming → idle`.
- `ChatPersisterProtocol.save(messages:conversationId:)` is invoked and the stored messages match the UI state.
- Manual cancellation throws `URLError.cancelled` and leaves the model in `idle` without adding a system error message.
- Message deduplication is preserved when two messages with colliding IDs appear (defensive check for `rebuildCache()`).

## Non-Goals

- No live network calls to BrowserOS server, Ollama, or any LLM provider.
- No changes to production logic unless a hidden bug is uncovered; then it is fixed and covered by the same test.
- No XCTest / Xcode project changes (deferred to Task #10).
- No CI integration on Linux runners (the SwiftUI/AppKit code only compiles on macOS). A macOS CI job may be added later.

## Files to Create / Modify

### New

- `trios/tests/swift/ChatSSEEndToEndTest.swift`
  - `@main @MainActor` test runner.
  - Creates `ChatViewModel` with in-memory fakes.
  - Runs scenarios and exits non-zero on first failure.
- `trios/tests/swift/ChatSSETestMocks.swift`
  - `actor MockChatTransport: ChatTransportProtocol`
  - `actor MockHealthCheck: ChatHealthCheckProtocol`
  - `actor InMemoryPersister: ChatPersisterProtocol`
  - Helpers to build SSE event sequences and parse captured request JSON.
- `trios/tests/swift/run_chat_sse_e2e.sh`
  - Compiles all tracked production Swift sources **except** `main.swift`, plus the two new test files, into `/tmp/trios_chat_sse_e2e_test`.
  - Runs the binary and propagates its exit code.

### Possibly modified

- `.github/workflows/trios-tests.yml` (new macOS-only workflow) — optional, only if the user wants CI in this PR.

## Implementation Steps

### Step 1 — Mocks

Implement fakes that satisfy the production protocols:

- `MockChatTransport`
  - `var lastBody: Data?`
  - `var lastEvents: [SSEEvent]`
  - `var shouldThrow: Error?`
  - `func sendMessage(body:) async throws -> AsyncStream<SSEEvent>` records `lastBody`, then returns a stream that yields `lastEvents` (or throws `shouldThrow`).
  - `func cancel() async` finishes any active stream continuation.
- `MockHealthCheck` always returns `true`.
- `InMemoryPersister`
  - Stores messages keyed by `conversationId` in an actor-isolated dictionary.
  - Tracks `currentConversationId`.
  - Implements `listAllConversations()` by returning summaries from stored keys.

### Step 2 — Test harness

- `ModelConfigurationStore` is instantiated with a dedicated `UserDefaults(suiteName:)` and an empty environment dictionary so it resolves to the default Ollama model without touching the keychain or real env vars.
- `ConversationStateMachine()` is created fresh for each scenario.
- `UIMessageStreamParser()` is the real production parser.
- `ChatViewModel` is created with the above fakes and no `a2aClient`.
- Wait a short tick after init so the background setup Task runs before assertions.

### Step 3 — Scenarios

1. **Happy streaming path**
   - Set `inputText = "hello"`.
   - Configure transport to emit:
     ```swift
     .start(id: "msg-1"),
     .textDelta(id: "msg-1", delta: "Hi"),
     .textDelta(id: "msg-1", delta: " there"),
     .finish(id: "msg-1")
     ```
   - `await viewModel.sendMessage()`.
   - Assert:
     - `messages.count == 2` (user + assistant).
     - User content == `"hello"`.
     - Assistant content == `"Hi there"` and `isStreaming == false`.
     - `state == .idle`.
     - Transport captured a valid JSON body with `message == "hello"`, `mode == "agent"`, `origin == "sidepanel"`, and a `messages` array ending with the user message.
     - Persister stored exactly the same two messages.

2. **Cancellation is non-fatal**
   - Configure transport to throw `URLError(.cancelled)` from `sendMessage`.
   - `await viewModel.sendMessage()`.
   - Assert:
     - `state == .idle`.
     - No system error message appended.
     - User message remains in `messages`.

3. **Deduplication guard**
   - Manually inject two assistant messages with the **same** hard-coded UUID into `viewModel.messages`, then call `viewModel.rebuildCache()`.
   - Assert only one of the duplicates survives.

### Step 4 — Build / run script

`trios/tests/swift/run_chat_sse_e2e.sh` mirrors `trios/build.sh` but:

- Excludes `main.swift` (the test file provides its own `@main`).
- Adds the new test files.
- Links `-framework SwiftUI -framework AppKit -framework WebKit -framework Combine -framework Security`.
- Outputs to `/tmp/trios_chat_sse_e2e_test` and executes it.

### Step 5 — Verification

Run:

```bash
cd trios
bash tests/swift/run_chat_sse_e2e.sh
```

Expected result: binary compiles and exits 0 with output like:

```
ok - happy streaming produces user + assistant messages
ok - request body contains expected fields
ok - cancellation is not a user-visible error
ok - deduplication removes duplicate UUIDs
All ChatSSEEndToEnd tests passed.
```

Then run the existing build to confirm the new files are not accidentally pulled into the app target:

```bash
cd trios
./build.sh
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Compiling the whole app plus tests is slow or fails due to missing frameworks | Match `build.sh` flags and add `-framework Security` for keychain code; test the script before committing. |
| `@MainActor` test runner deadlocks with `ChatViewModel.init` background Task | Keep waits short; do not use `RunLoop` blocking. Use `Task.sleep`. |
| `ConversationPersister` or other production code touches real `UserDefaults`/keychain | Inject in-memory `UserDefaults` suite and empty environment in the test harness. |
| `ChatViewModel` timers / `QueenStatusViewModel` timers keep the test process alive | They use weak captures and are deallocated when the test exits; the process terminates normally. |
| Future production changes break the test | That is the intended signal; fix production and update the test together. |

## Follow-ups

- Task #8: forward mesh-chat sealed frames through transport (depends on Task #9 secure key loading).
- Task #9: replace deterministic mesh crypto seed with secure key loading.
- Task #10: once `Package.swift` / Xcode project exists, migrate these standalone tests to XCTest targets and wire them into `swift test`.
