// SSE End-to-End integration tests for ChatViewModel.
//
// Run with:
//   bash tests/swift/run_chat_sse_e2e.sh
//
// Exits non-zero on the first failed assertion.

import Foundation
import SwiftUI

@main
@MainActor
struct ChatSSEEndToEndTests {
    static var failures = 0
    static let testFingerprintKey = Data(repeating: 0x5A, count: 32)

    static func check(_ condition: @autoclosure () -> Bool, _ name: String) {
        if condition() {
            print("ok   - \(name)")
        } else {
            print("FAIL - \(name)")
            failures += 1
        }
    }

    static func fail(_ name: String) {
        print("FAIL - \(name)")
        failures += 1
    }

    static func main() async {
        await runHappyPathStreaming()
        await runCancellationIsNonError()
        await runDeduplication()
        await runConversationRenamePersistence()
        await runMemoryStoreAndPlannerPersistence()
        await runChatMemoryPlannerIntegration()
        await runPlannerStreamTerminalStates()
        await runUnterminatedStreamFailsClosed()
        await runEmptyStreamDoesNotReusePriorAnswer()
        await runExplicitCancellationWinsTransportErrorRace()
        await runThrownTransportErrorStopsStreamingIndicator()
        await runNewConversationStopsRecallBeforeTransport()
        await runPlannerStorageFailureIsVisible()
        await runAttachmentTurnIsNotRemembered()
        await runDeletionBlocksReentrantSend()
        await runFailedActiveDeletionPersistsRetainedHistory()
        await runImmediateNewConversationSurvivesInitialization()
        await runMemoryClearBlocksInflightWrite()
        await runUnrelatedClearPreservesInflightWrite()
        await runClearWaitsForStartedMemoryWrite()
        await runConversationSwitchPreservesStartedMemoryWrite()
        await runScrollPositionPolicyAndRequestDelivery()
        await runCassetteReplayAndObserver()
        await runSalienceLearnsFromOutcomes()
        await runPureQueenTypes()

        if failures == 0 {
            print("\nAll ChatSSEEndToEnd tests passed.")
            exit(0)
        } else {
            print("\n\(failures) test(s) failed.")
            exit(1)
        }
    }

    // MARK: - Scenario 1: full streaming loop

    static func runHappyPathStreaming() async {
        print("\n# Scenario: happy streaming path")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-e2e") ?? .standard
        let modelStore = ModelConfigurationStore(defaults: testDefaults, environment: [:], reliabilityService: ModelReliabilityService(store: VolatileMemoryStore()))

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(),
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(
                store: VolatileMemoryStore(),
                preferences: testDefaults
            )
        )

        // Let the background init Task settle.
        try? await Task.sleep(nanoseconds: 50_000_000)

        await transport.setEvents([
            .start(id: "msg-1"),
            .textDelta(id: "msg-1", delta: "Hi"),
            .textDelta(id: "msg-1", delta: " there"),
            .finish(id: "msg-1", reason: nil)
        ])

        viewModel.inputText = "hello"
        let conversationId = viewModel.conversationId
        await viewModel.sendMessage()

        // UI state assertions
        check(viewModel.messages.count == 2, "messages contains exactly user + assistant")

        let userMessage = viewModel.messages.first
        check(userMessage?.role == .user, "first message is user")
        check(userMessage?.content == "hello", "user content matches input")

        let assistantMessage = viewModel.messages.last
        check(assistantMessage?.role == .assistant, "last message is assistant")
        check(assistantMessage?.content == "Hi there", "assistant content accumulates text deltas")
        check(assistantMessage?.isStreaming == false, "assistant streaming flag cleared after finish")

        let currentState = await stateMachine.currentState()
        check(currentState == .idle, "state machine returned to idle")

        // Request body assertions
        if let body = await transport.lastBody, let json = body.asJSONObject() {
            check(json["message"] as? String == "hello", "request body contains user message")
            check(json["mode"] as? String == "agent", "request body mode is agent")
            check(json["origin"] as? String == "sidepanel", "request body origin is sidepanel")
            check(json["conversationId"] as? String == conversationId.uuidString, "request body conversationId matches")

            if let messages = json["messages"] as? [[String: Any]] {
                let roles = messages.compactMap { $0["role"] as? String }
                check(roles.first == "system", "messages array starts with system prompt")
                check(roles.last == "user", "messages array ends with current user message")
            } else {
                fail("request body messages array missing or malformed")
            }
        } else {
            fail("transport did not capture a valid request body")
        }

        // Persister assertions
        let stored = persister.messages(for: conversationId)
        check(stored.count == 2, "persister stored exactly two messages")
        check(stored.first?.content == "hello", "stored user content matches")
        check(stored.last?.content == "Hi there", "stored assistant content matches")
    }

    // MARK: - Scenario 2: cancellation is not a user-visible error

    static func runCancellationIsNonError() async {
        print("\n# Scenario: cancellation is non-error")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-cancel") ?? .standard
        let modelStore = ModelConfigurationStore(defaults: testDefaults, environment: [:], reliabilityService: ModelReliabilityService(store: VolatileMemoryStore()))

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(),
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(
                store: VolatileMemoryStore(),
                preferences: testDefaults
            )
        )

        try? await Task.sleep(nanoseconds: 50_000_000)

        await transport.setNextError(URLError(.cancelled))

        viewModel.inputText = "cancel me"
        let conversationId = viewModel.conversationId
        await viewModel.sendMessage()

        let currentState = await stateMachine.currentState()
        check(currentState == .idle, "state is idle after cancellation")

        let hasSystemError = viewModel.messages.contains { $0.role == .system }
        check(!hasSystemError, "no system error message appended for cancellation")

        let userMessage = viewModel.messages.first(where: { $0.role == .user })
        check(userMessage?.content == "cancel me", "user message remains after cancellation")

        let stored = persister.messages(for: conversationId)
        check(stored.first(where: { $0.role == .user })?.content == "cancel me",
              "persister saved user message after cancellation")
    }

    // MARK: - Scenario 3: message deduplication

    static func runDeduplication() async {
        print("\n# Scenario: message deduplication")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-dedup") ?? .standard
        let modelStore = ModelConfigurationStore(defaults: testDefaults, environment: [:], reliabilityService: ModelReliabilityService(store: VolatileMemoryStore()))

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(),
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(
                store: VolatileMemoryStore(),
                preferences: testDefaults
            )
        )

        try? await Task.sleep(nanoseconds: 50_000_000)

        let duplicateId = UUID()
        viewModel.messages = [
            ChatMessage(id: duplicateId, role: .assistant, content: "first"),
            ChatMessage(id: duplicateId, role: .assistant, content: "second")
        ]
        viewModel.rebuildCache()

        check(viewModel.messages.count == 1, "duplicate UUIDs collapse to a single message")
        check(viewModel.messages.first?.content == "first", "first duplicate survives")
    }

    // MARK: - Scenario 4: custom conversation title persistence

    static func runConversationRenamePersistence() async {
        print("\n# Scenario: conversation title survives reload")

        let suiteName = "trios-chat-title-\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            fail("isolated title preferences unavailable")
            return
        }
        defaults.removePersistentDomain(forName: suiteName)

        let conversationId = UUID()
        let originalMessages = [
            ChatMessage(role: .user, content: "Original generated title"),
            ChatMessage(role: .assistant, content: "Response")
        ]
        let persister = ConversationPersister(suiteName: suiteName)
        await persister.save(
            messages: originalMessages,
            conversationId: conversationId
        )
        await persister.renameConversation(
            id: conversationId,
            title: "  Editable\n   release   plan  "
        )

        let renamed = await persister.listAllConversations()
        check(renamed.first?.title == "Editable release plan",
              "rename normalizes whitespace")

        let reloadedPersister = ConversationPersister(suiteName: suiteName)
        let reloaded = await reloadedPersister.listAllConversations()
        check(reloaded.first?.title == "Editable release plan",
              "custom title survives persister reload")

        let storedMessages = await reloadedPersister.load(
            conversationId: conversationId
        )
        check(storedMessages == originalMessages,
              "rename leaves message history unchanged")

        await reloadedPersister.renameConversation(
            id: conversationId,
            title: String(repeating: "x", count: 100)
        )
        let limited = await reloadedPersister.listAllConversations()
        check(limited.first?.title.count == 80,
              "custom title is limited to 80 characters")

        await reloadedPersister.renameConversation(
            id: conversationId,
            title: " \n\t "
        )
        let untitled = await reloadedPersister.listAllConversations()
        check(untitled.first?.title == "Untitled",
              "blank title becomes Untitled")

        await reloadedPersister.clear(conversationId: conversationId)
        await reloadedPersister.save(
            messages: originalMessages,
            conversationId: conversationId
        )
        let recreated = await reloadedPersister.listAllConversations()
        check(recreated.first?.title == "Original generated title",
              "clearing a conversation also clears its custom title")

        await reloadedPersister.clear(conversationId: conversationId)
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - Scenario 5: durable memory and TODO plan persistence

    static func runMemoryStoreAndPlannerPersistence() async {
        print("\n# Scenario: durable memory and TODO plan persistence")

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("trios-memory-\(UUID().uuidString)", isDirectory: true)
        let databaseURL = directory.appendingPathComponent("agent-memory.sqlite3")
        let encryptedURL = directory.appendingPathComponent("agent-memory.sqlite3.enc")
        let suiteName = "trios-memory-planner-\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: suiteName) ?? .standard
        preferences.removePersistentDomain(forName: suiteName)

        do {
            let store = try MemoryStore(
                databaseURL: databaseURL,
                encryptedURL: encryptedURL
            )
            let schemaVersion = await store.schemaVersion()
            check(schemaVersion == 5,
                  "memory database schema is version 5")
            let journalMode = await store.journalMode()
            check(journalMode == "wal",
                  "memory database uses WAL journal mode for SQLCipher encryption")

            let memoryService = AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            )
            let conversationId = UUID()
            let sourceMessageId = UUID()
            let unicodeText = "\u{041F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442}"
            let parameterizedRecord = AgentMemoryRecord(
                id: UUID(),
                conversationId: conversationId,
                sourceMessageId: UUID(),
                body: """
                Goal: Parameterized "quoted" \(unicodeText)
                Result: Completed successfully.
                Recall: parameterizedprobe
                """,
                createdAt: Date(timeIntervalSince1970: 1)
            )
            try await store.saveMemory(parameterizedRecord)
            let stored = await memoryService.rememberCompletedTurn(
                conversationId: conversationId,
                sourceMessageId: sourceMessageId,
                goal: "Trinity release \"quoted\" \(unicodeText) sk-testSecret1234567890",
                assistantResult: "Prepared the release plan and verification."
            )
            check(stored != nil, "completed turn is stored as memory")
            check(stored?.body.contains("Sensitive values were redacted") == true,
                  "memory records that sensitive values were removed")
            check(stored?.body.contains("sk-testSecret") == false,
                  "raw secret is absent from memory")
            check(stored?.body.contains("\"quoted\"") == false,
                  "raw goal prose is not copied into memory")
            check(stored?.body.contains(unicodeText) == false,
                  "goal text is represented by private recall features")
            check(stored?.body.contains("Prepared the release plan") == false,
                  "raw assistant output is not copied into memory")

            let longPEM = """
            -----BEGIN CUSTOM PRIVATE KEY-----
            \(String(repeating: "sensitive-key-payload-", count: 160))
            -----END CUSTOM PRIVATE KEY-----
            """
            let pemMemory = await memoryService.rememberCompletedTurn(
                conversationId: conversationId,
                sourceMessageId: UUID(),
                goal: "Audit \(longPEM) before release",
                assistantResult: "The credential audit completed."
            )
            check(pemMemory?.body.contains("sensitive-key-payload") == false,
                  "long PEM payload is redacted before truncation")
            check(pemMemory?.body.contains("Sensitive values were redacted") == true,
                  "long PEM redaction is recorded")

            let embeddedFile = await memoryService.rememberCompletedTurn(
                conversationId: conversationId,
                sourceMessageId: UUID(),
                goal: "Review this file:\n```\nsecret file body\n```",
                assistantResult: "Review completed."
            )
            check(embeddedFile == nil,
                  "explicit embedded file payload is rejected")

            let unmarkedPaste = await memoryService.rememberCompletedTurn(
                conversationId: conversationId,
                sourceMessageId: UUID(),
                goal: "alpha confidential clause beta",
                assistantResult: "The request completed."
            )
            check(unmarkedPaste?.body.contains("confidential clause") == false,
                  "short unmarked pasted content is not stored verbatim")

            let fuzzyMatches = await memoryService.recall(
                for: "trinitt relese",
                limit: 3
            )
            check(fuzzyMatches.first?.record.id == stored?.id,
                  "misspelled query finds relevant memory")
            check(fuzzyMatches.count <= 3,
                  "memory search respects result limit")
            let repeatedMatches = await memoryService.recall(
                for: "trinitt relese",
                limit: 3
            )
            check(
                fuzzyMatches.map(\.record.id) == repeatedMatches.map(\.record.id),
                "repeated memory search has deterministic ordering"
            )
            let wrongKeyService = AgentMemoryService(
                store: store,
                fingerprintKey: Data(repeating: 0x33, count: 32)
            )
            let wrongKeyMatches = await wrongKeyService.recall(
                for: "Trinity release",
                limit: 3
            )
            check(wrongKeyMatches.isEmpty,
                  "recall fingerprints cannot be matched without the Keychain key")

            let planner = TODOPlanner(store: store, preferences: preferences)
            await planner.startPlan(
                conversationId: conversationId,
                goal: "Ship the verified Trinity release"
            )
            // A plan now starts with the one step we can honestly claim is
            // happening and grows with the observed work, so the old
            // three-row template no longer applies.
            check(planner.activePlan?.items.count == 1,
                  "a new plan opens with a single honest step")
            check(planner.activePlan?.items.first?.state == .inProgress,
                  "understand starts while the request is prepared")

            // A tool call appends a step named after the work.
            await planner.markToolActivity(name: "filesystem_read")
            check(planner.activePlan?.items.count == 2,
                  "observed work appends a step rather than filling a template")
            check(planner.activePlan?.items.first?.state == .completed,
                  "starting the next step completes the previous one")
            check(planner.activePlan?.items.last?.state == .inProgress,
                  "the newest step is the running one")
            check(planner.activePlan?.items.map(\.order) == [0, 1],
                  "appended steps keep a deterministic order")
            check(
                planner.activePlan?.items.filter { $0.state == .inProgress }.count == 1,
                "exactly one step is in progress at a time"
            )

            await planner.completePlan()
            check(planner.activePlan?.state == .completed,
                  "successful plan reaches completed state")
            check(planner.activePlan?.progress == 1,
                  "completed plan reports full progress")

            await store.close()

            let reloadedStore = try MemoryStore(
                databaseURL: databaseURL,
                encryptedURL: encryptedURL
            )
            let reloadedPlan = try await reloadedStore.loadPlan(
                conversationId: conversationId
            )
            check(reloadedPlan?.state == .completed,
                  "plan survives closing and reopening SQLite")

            let reloadedService = AgentMemoryService(
                store: reloadedStore,
                fingerprintKey: testFingerprintKey
            )
            let reloadedMatches = await reloadedService.recall(
                for: "Trinity release",
                limit: 3
            )
            check(reloadedMatches.first?.record.id == stored?.id,
                  "memory survives closing and reopening SQLite")
            let parameterizedRows = try await reloadedStore.memoryCandidates(
                for: "parameterizedprobe",
                limit: 10
            )
            let parameterizedReload = parameterizedRows.first {
                $0.id == parameterizedRecord.id
            }
            check(parameterizedReload?.body == parameterizedRecord.body,
                  "parameterized storage round-trips quotes and Unicode")

            let otherConversationId = UUID()
            let otherRecord = AgentMemoryRecord(
                id: UUID(),
                conversationId: otherConversationId,
                sourceMessageId: UUID(),
                body: """
                Topics: memory controls
                Result: Completed successfully.
                Recall: otherconversationprobe
                """,
                createdAt: Date(timeIntervalSince1970: 10)
            )
            try await reloadedStore.saveMemory(otherRecord)

            let recent = try await reloadedService.recentMemories(limit: 2)
            check(recent.count == 2,
                  "recent memory browsing respects its limit")
            let recentRecords = recent.map(\.record)
            let isNewestFirst = zip(
                recentRecords,
                recentRecords.dropFirst()
            ).allSatisfy { lhs, rhs in
                lhs.createdAt > rhs.createdAt
                    || (
                        lhs.createdAt == rhs.createdAt
                            && lhs.id.uuidString < rhs.id.uuidString
                    )
            }
            check(isNewestFirst,
                  "recent memory browsing is deterministic and newest first")

            let didForget = try await reloadedService.forgetMemory(
                id: parameterizedRecord.id
            )
            check(didForget,
                  "forgetting one durable memory reports a deleted row")
            let didForgetAgain = try await reloadedService.forgetMemory(
                id: parameterizedRecord.id
            )
            check(didForgetAgain == false,
                  "forgetting an unknown durable memory is idempotent")
            let forgottenRows = try await reloadedStore.memoryCandidates(
                for: "parameterizedprobe",
                limit: 10
            )
            check(forgottenRows.contains {
                $0.id == parameterizedRecord.id
            } == false,
                  "forgotten memory is removed from FTS candidates")

            let clearedCount = try await reloadedService
                .clearConversationMemories(
                    conversationId: conversationId
                )
            check(clearedCount > 0,
                  "scoped clear removes current-conversation memories")
            let preservedOther = try await reloadedService
                .recentMemories(limit: 64)
            check(preservedOther.contains {
                $0.record.id == otherRecord.id
            },
                  "scoped clear preserves another conversation's memory")
            let preservedPlan = try await reloadedStore.loadPlan(
                conversationId: conversationId
            )
            check(preservedPlan?.state == .completed,
                  "memory-only clear preserves the TODO plan")

            let volatileStore = VolatileMemoryStore()
            let volatileConversationId = UUID()
            let volatileRecord = AgentMemoryRecord(
                id: UUID(),
                conversationId: volatileConversationId,
                sourceMessageId: UUID(),
                body: otherRecord.body,
                createdAt: Date(timeIntervalSince1970: 20)
            )
            let volatileNeighbor = AgentMemoryRecord(
                id: UUID(),
                conversationId: UUID(),
                sourceMessageId: UUID(),
                body: otherRecord.body,
                createdAt: Date(timeIntervalSince1970: 30)
            )
            try await volatileStore.saveMemory(volatileRecord)
            try await volatileStore.saveMemory(volatileNeighbor)
            let volatileDeleted = try await volatileStore.deleteMemory(
                id: volatileRecord.id
            )
            check(
                volatileDeleted,
                "volatile store forgets one memory"
            )
            let volatileDeletedAgain = try await volatileStore.deleteMemory(
                id: volatileRecord.id
            )
            check(
                volatileDeletedAgain == false,
                "volatile forget is idempotent"
            )
            let volatileCleared = try await volatileStore.deleteMemories(
                conversationId: volatileNeighbor.conversationId
            )
            check(volatileCleared == 1,
                  "volatile scoped clear matches durable semantics")

            let cancelledConversationId = UUID()
            let terminalPlanner = TODOPlanner(
                store: reloadedStore,
                preferences: preferences
            )
            await terminalPlanner.startPlan(
                conversationId: cancelledConversationId,
                goal: "Cancel this plan"
            )
            await terminalPlanner.markExecutionStarted()
            await terminalPlanner.cancelPlan()
            check(terminalPlanner.activePlan?.state == .cancelled,
                  "cancelled plan reaches cancelled state")
            // Plans are dynamic now, so assert on the item's state rather than
            // on a fixed row index; the old items[1] assumed the retired
            // three-step template and crashed with Index out of range.
            check(terminalPlanner.activePlan?.items.contains { $0.state == .cancelled } == true,
                  "cancellation marks the item that was in progress")
            check(terminalPlanner.activePlan?.items.contains { $0.state == .inProgress } == false,
                  "no item is left running after cancellation")

            let failedConversationId = UUID()
            await terminalPlanner.startPlan(
                conversationId: failedConversationId,
                goal: "Fail this plan"
            )
            await terminalPlanner.markExecutionStarted()
            await terminalPlanner.failPlan(message: "Network unavailable")
            check(terminalPlanner.activePlan?.state == .failed,
                  "failed plan reaches failed state")
            check(terminalPlanner.activePlan?.items.contains { $0.state == .failed } == true,
                  "failure marks the item that was in progress")
            check(terminalPlanner.activePlan?.items.contains { $0.state == .inProgress } == false,
                  "no item is left running after failure")

            let customConversationId = UUID()
            await terminalPlanner.startPlan(
                conversationId: customConversationId,
                goal: "Keep user tasks independent"
            )
            await terminalPlanner.markExecutionStarted()
            await terminalPlanner.addTask(title: "User follow-up")
            await terminalPlanner.completePlan()
            check(terminalPlanner.activePlan?.items.last?.state == .pending,
                  "stream success does not complete user-added tasks")
            check(terminalPlanner.activePlan?.state == .active,
                  "plan stays active while a user-added task remains")

            try await reloadedStore.deleteConversationData(
                conversationId: conversationId
            )
            let deletedPlan = try await reloadedStore.loadPlan(
                conversationId: conversationId
            )
            let deletedMemories = await reloadedService.recall(
                for: "Trinity release",
                limit: 3
            )
            check(deletedPlan == nil,
                  "conversation deletion removes its plan")
            check(deletedMemories.isEmpty,
                  "conversation deletion removes scoped memories")
            await reloadedStore.close()
        } catch {
            fail("durable memory setup failed: \(error.localizedDescription) [directory: \(directory.path)]")
        }

        // Intentionally leave directory for SQLCipher forensic inspection.
        // try? FileManager.default.removeItem(at: directory)
        preferences.removePersistentDomain(forName: suiteName)
    }

    // MARK: - Scenario 6: chat integration

    static func runChatMemoryPlannerIntegration() async {
        print("\n# Scenario: chat recalls memory and advances TODO plan")

        let store = VolatileMemoryStore()
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let testDefaults = UserDefaults(
            suiteName: "trios-chat-memory-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(store: store, preferences: testDefaults)
        let remembered = await memoryService.rememberCompletedTurn(
            conversationId: UUID(),
            sourceMessageId: UUID(),
            goal: "Trinity deployment checklist",
            assistantResult: "Verify signature, health, and CDP."
        )
        check(remembered != nil, "integration fixture memory is stored")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()
        let modelStore = ModelConfigurationStore(
            defaults: testDefaults,
            environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
        )
        let conversationId = UUID()
        await persister.setCurrentConversationId(conversationId)

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: memoryService,
            todoPlanner: planner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        await transport.setEvents([
            .start(id: "memory-msg"),
            .textDelta(id: "memory-msg", delta: "Deployment verified."),
            .finish(id: "memory-msg", reason: nil)
        ])
        viewModel.inputText = "Use the Trinty deployment cheklist"
        await viewModel.sendMessage()

        check(planner.activePlan?.conversationId == conversationId,
              "chat creates a plan for the active conversation")
        check(planner.activePlan?.state == .completed,
              "successful stream completes the active plan")
        check(viewModel.recalledMemories.isEmpty == false,
              "chat exposes recalled memories to the UI")

        if let body = await transport.lastBody,
           let json = body.asJSONObject(),
           let messages = json["messages"] as? [[String: Any]],
           let system = messages.first?["content"] as? String {
            check(system.contains("UNTRUSTED LONG-TERM MEMORY"),
                  "request labels recalled memory as untrusted")
            check(system.lowercased().contains("trinity"),
                  "request contains a safe topic summary")
            check(system.contains("deployment checklist") == false,
                  "request does not expose raw historical goal prose")
            check(system.contains("Recall: m") == false,
                  "request does not expose private recall fingerprints")
        } else {
            fail("memory-aware request body is missing")
        }

        if let remembered {
            do {
                let didForget = try await viewModel.forgetMemory(
                    id: remembered.id
                )
                check(didForget,
                      "chat confirms individual memory deletion")
                check(viewModel.recalledMemories.contains {
                    $0.record.id == remembered.id
                } == false,
                      "chat removes a forgotten record from recalled state")
            } catch {
                fail("chat memory deletion failed: \(error.localizedDescription)")
            }
        }

        do {
            let clearedCount = try await viewModel
                .clearCurrentConversationMemories()
            check(clearedCount >= 1,
                  "chat clears only current-task memory")
            check(planner.activePlan?.state == .completed,
                  "chat memory clear preserves the execution plan")
            let storedMessages = await persister.load(
                conversationId: conversationId
            )
            check(storedMessages.count == 2,
                  "chat memory clear preserves message history")
        } catch {
            fail("chat scoped memory clear failed: \(error.localizedDescription)")
        }

        let failingMemory = AgentMemoryService(
            store: AlwaysFailingMemoryStore(),
            fingerprintKey: testFingerprintKey
        )
        var deletionFailedAsExpected = false
        do {
            _ = try await failingMemory.forgetMemory(id: UUID())
        } catch {
            deletionFailedAsExpected = true
        }
        check(deletionFailedAsExpected,
              "memory deletion surfaces storage failure")
    }

    // MARK: - Scenario 7: planner stream terminal states

    static func runPlannerStreamTerminalStates() async {
        print("\n# Scenario: stream abort and error update planner")

        let cancelStore = VolatileMemoryStore()
        let cancelDefaults = UserDefaults(
            suiteName: "trios-chat-plan-cancel-\(UUID().uuidString)"
        ) ?? .standard
        let cancelPlanner = TODOPlanner(
            store: cancelStore,
            preferences: cancelDefaults
        )
        let cancelTransport = MockChatTransport()
        let cancelViewModel = ChatViewModel(
            transport: cancelTransport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: cancelDefaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: cancelStore,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: cancelPlanner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await cancelTransport.setEvents([
            .start(id: "cancel-plan"),
            .abort(id: "cancel-plan")
        ])
        cancelViewModel.inputText = "Cancel this streamed task"
        await cancelViewModel.sendMessage()
        check(cancelPlanner.activePlan?.state == .cancelled,
              "stream abort marks the plan cancelled")
        check(cancelPlanner.activePlan?.items.contains { $0.state == .cancelled } == true,
              "stream abort marks execute cancelled")

        let failureStore = VolatileMemoryStore()
        let failureDefaults = UserDefaults(
            suiteName: "trios-chat-plan-failure-\(UUID().uuidString)"
        ) ?? .standard
        let failurePlanner = TODOPlanner(
            store: failureStore,
            preferences: failureDefaults
        )
        let failureTransport = MockChatTransport()
        let failureViewModel = ChatViewModel(
            transport: failureTransport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: failureDefaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: failureStore,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: failurePlanner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await failureTransport.setEvents([
            .start(id: "failed-plan"),
            .error(id: "failed-plan", message: "Provider unavailable")
        ])
        failureViewModel.inputText = "Fail this streamed task"
        await failureViewModel.sendMessage()
        check(failurePlanner.activePlan?.state == .failed,
              "stream error marks the plan failed")
        check(failurePlanner.activePlan?.items.contains { $0.state == .failed } == true,
              "stream error marks execute failed")
        check(
            failureViewModel.messages
                .first(where: { $0.role == .assistant })?
                .isStreaming == false,
            "stream error stops the assistant streaming indicator"
        )
    }

    // MARK: - Scenario 8: unterminated stream fails closed

    static func runUnterminatedStreamFailsClosed() async {
        print("\n# Scenario: unterminated stream fails closed")

        let store = VolatileMemoryStore()
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let defaults = UserDefaults(
            suiteName: "trios-chat-unterminated-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(store: store, preferences: defaults)
        let transport = MockChatTransport()
        let stateMachine = ConversationStateMachine()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: planner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await transport.setEvents([
            .start(id: "unterminated"),
            .textDelta(
                id: "unterminated",
                delta: "Partial build output"
            )
        ])

        viewModel.inputText = "Verify build and test results"
        await viewModel.sendMessage()

        check(planner.activePlan?.state == .failed,
              "unterminated EOF marks the plan failed")
        do {
            let memories = try await memoryService.recentMemories(limit: 20)
            check(memories.isEmpty,
                  "unterminated EOF creates no durable memory")
        } catch {
            fail("unterminated EOF memory inspection failed")
        }

        let assistant = viewModel.messages.last {
            $0.role == .assistant
        }
        check(assistant?.content == "Partial build output",
              "unterminated EOF preserves partial chat history")
        check(assistant?.isStreaming == false,
              "unterminated EOF clears the streaming indicator")

        let finalState = await stateMachine.currentState()
        let isVisibleError: Bool
        if case .error = finalState {
            isVisibleError = true
        } else {
            isVisibleError = false
        }
        check(isVisibleError,
              "unterminated EOF leaves a visible error state")
    }

    // MARK: - Scenario 9: empty stream memory isolation

    static func runEmptyStreamDoesNotReusePriorAnswer() async {
        print("\n# Scenario: empty stream does not reuse prior answer")

        let store = VolatileMemoryStore()
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let defaults = UserDefaults(
            suiteName: "trios-chat-empty-memory-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(store: store, preferences: defaults)
        let transport = MockChatTransport()
        let persister = InMemoryPersister()
        let conversationId = UUID()
        await persister.setCurrentConversationId(conversationId)
        await persister.save(
            messages: [
                ChatMessage(role: .user, content: "Old request"),
                ChatMessage(role: .assistant, content: "Old unique answer")
            ],
            conversationId: conversationId
        )

        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: planner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await transport.setEvents([
            .finish(id: "empty", reason: nil)
        ])
        viewModel.inputText = "Brand new empty stream request"
        await viewModel.sendMessage()

        let matches = await memoryService.recall(
            for: "brand new empty stream",
            limit: 3
        )
        check(matches.isEmpty,
              "empty stream stores no memory from an earlier assistant")
    }

    // MARK: - Scenario 9: explicit cancellation ordering

    static func runExplicitCancellationWinsTransportErrorRace() async {
        print("\n# Scenario: explicit cancellation wins transport error race")

        let store = VolatileMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-chat-cancel-race-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(store: store, preferences: defaults)
        let transport = CancellationRaceTransport()
        let persister = InMemoryPersister()
        let stateMachine = ConversationStateMachine()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: planner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        let conversationId = viewModel.conversationId
        viewModel.inputText = "Stop this task safely"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<50 {
            if viewModel.messages.contains(where: {
                $0.role == .assistant
                    && $0.content == "Partial answer before explicit Stop."
            }) {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        viewModel.cancelStreaming()
        await sendTask.value
        try? await Task.sleep(nanoseconds: 100_000_000)

        check(planner.activePlan?.state == .cancelled,
              "explicit stop remains cancelled when transport emits an error")
        check(viewModel.messages.contains(where: { $0.role == .system }) == false,
              "explicit stop does not append a transport error")
        let finalState = await stateMachine.currentState()
        check(finalState == .idle,
              "explicit stop leaves the state machine idle")
        check(
            viewModel.messages
                .first(where: { $0.role == .assistant })?
                .isStreaming == false,
            "explicit stop clears the assistant streaming indicator"
        )
        let persisted = await persister.load(
            conversationId: conversationId
        )
        check(
            persisted.count == 2
                && persisted[0].role == .user
                && persisted[1].role == .assistant
                && persisted[1].content
                    == "Partial answer before explicit Stop."
                && persisted[1].isStreaming == false,
            "explicit stop persists the finalized partial response"
        )
    }

    // MARK: - Scenario 10: thrown transport error finalizes partial UI

    static func runThrownTransportErrorStopsStreamingIndicator() async {
        print("\n# Scenario: thrown transport error stops streaming UI")

        let store = VolatileMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-chat-transport-error-\(UUID().uuidString)"
        ) ?? .standard
        let transport = MockChatTransport()
        let stateMachine = ConversationStateMachine()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: stateMachine,
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: store, preferences: defaults)
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        viewModel.messages = [
            ChatMessage(
                role: .assistant,
                content: "Partial response",
                isStreaming: true
            )
        ]
        await transport.setNextError(URLError(.cannotConnectToHost))
        viewModel.inputText = "Continue after the partial response"
        await viewModel.sendMessage()

        check(
            viewModel.messages
                .first(where: { $0.role == .assistant })?
                .isStreaming == false,
            "thrown transport error clears a partial streaming indicator"
        )
        let finalState = await stateMachine.currentState()
        if case .error = finalState {
            check(true, "thrown transport error remains visible")
        } else {
            check(false, "thrown transport error remains visible")
        }
    }

    // MARK: - Scenario 11: navigation during recall

    static func runNewConversationStopsRecallBeforeTransport() async {
        print("\n# Scenario: new conversation stops recall before transport")

        let store = DelayedMemoryStore(
            recallDelayNanoseconds: 0,
            waitsForExplicitRecallRelease: true
        )
        let defaults = UserDefaults(
            suiteName: "trios-chat-new-during-recall-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(store: store, preferences: defaults)
        let transport = MockChatTransport()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: planner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        let oldConversationId = viewModel.conversationId
        viewModel.inputText = "Start a request with delayed recall"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<200 {
            if await store.hasStartedRecall() {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        let recallStarted = await store.hasStartedRecall()
        check(recallStarted,
              "recall gate opened before navigation")
        viewModel.newConversation()
        await store.releaseRecall()
        await sendTask.value
        for _ in 0..<100 {
            if viewModel.conversationId != oldConversationId,
               planner.activePlan == nil {
                break
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }

        let transportSendCount = await transport.sendCount
        check(transportSendCount == 0,
              "cancelled recall never reaches transport")
        check(viewModel.conversationId != oldConversationId,
              "new conversation becomes active")
        check(planner.activePlan == nil,
              "old cancelled plan is not shown in the new conversation")
        check(viewModel.recalledMemories.isEmpty,
              "old delayed recall cannot overwrite the new conversation")
    }

    // MARK: - Scenario 11: planner storage failure

    static func runPlannerStorageFailureIsVisible() async {
        print("\n# Scenario: planner storage failure is visible")

        let defaults = UserDefaults(
            suiteName: "trios-planner-store-failure-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(
            store: AlwaysFailingMemoryStore(),
            preferences: defaults
        )
        let conversationId = UUID()
        await planner.startPlan(
            conversationId: conversationId,
            goal: "Continue despite planner storage failure"
        )
        check(planner.activePlan != nil,
              "planner storage failure does not block request planning")
        check(planner.persistenceWarning?.contains("storage unavailable") == true,
              "planner storage failure is exposed to the UI")

        do {
            try await planner.deleteConversationData(
                conversationId: conversationId
            )
            fail("privacy cleanup failure must be returned to the caller")
        } catch {
            check(planner.activePlan != nil,
                  "failed privacy cleanup keeps the visible plan intact")
        }
    }

    // MARK: - Scenario 12: attachment memory exclusion

    static func runAttachmentTurnIsNotRemembered() async {
        print("\n# Scenario: attachment turn is not remembered")

        let store = VolatileMemoryStore()
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let defaults = UserDefaults(
            suiteName: "trios-chat-attachment-memory-\(UUID().uuidString)"
        ) ?? .standard
        let planner = TODOPlanner(store: store, preferences: defaults)
        let transport = MockChatTransport()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: planner
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await transport.setEvents([
            .start(id: "attachment-turn"),
            .textDelta(id: "attachment-turn", delta: "File reviewed."),
            .finish(id: "attachment-turn", reason: nil)
        ])
        viewModel.inputText = """
        Review the attached contract
        <local_attachments>
        [{"name":"contract.txt","path":"/private/contract.txt"}]
        </local_attachments>
        """
        await viewModel.sendMessage()

        let matches = await memoryService.recall(
            for: "attached contract",
            limit: 3
        )
        check(matches.isEmpty,
              "successful attachment turn stores no long-term memory")
        check(planner.activePlan?.state == .completed,
              "attachment turn still completes its execution plan")
    }

    // MARK: - Scenario 13: deletion reentrancy

    static func runDeletionBlocksReentrantSend() async {
        print("\n# Scenario: active deletion blocks reentrant send")

        let store = DelayedMemoryStore(
            recallDelayNanoseconds: 0,
            deletionDelayNanoseconds: 300_000_000
        )
        let defaults = UserDefaults(
            suiteName: "trios-chat-delete-race-\(UUID().uuidString)"
        ) ?? .standard
        let transport = MockChatTransport()
        let persister = InMemoryPersister()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: store, preferences: defaults)
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        let deletedConversationId = viewModel.conversationId
        let seededHistory = [
            ChatMessage(
                role: .user,
                content: "Delete this concrete conversation"
            ),
            ChatMessage(
                role: .assistant,
                content: "This answer must not be resurrected"
            )
        ]
        viewModel.messages = seededHistory
        await persister.save(
            messages: seededHistory,
            conversationId: deletedConversationId
        )
        check(
            persister.containsConversation(deletedConversationId),
            "successful deletion fixture starts with persisted history"
        )

        viewModel.deleteConversation(deletedConversationId)
        viewModel.inputText = "This send must wait for deletion"
        await viewModel.sendMessage()

        for _ in 0..<100 {
            if viewModel.conversationId != deletedConversationId {
                break
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        let sendCount = await transport.sendCount
        check(sendCount == 0,
              "send cannot start while private deletion is pending")
        check(viewModel.conversationId != deletedConversationId,
              "active conversation resets only after cleanup succeeds")
        check(viewModel.inputText == "This send must wait for deletion",
              "blocked send remains available for the new conversation")
        let deletedHistory = await persister.load(
            conversationId: deletedConversationId
        )
        check(
            deletedHistory.isEmpty,
            "successful deletion leaves no loadable message history"
        )
        check(
            !persister.containsConversation(deletedConversationId),
            "successful deletion removes the persisted conversation record"
        )
    }

    // MARK: - Scenario 14: failed deletion retains active history

    static func runFailedActiveDeletionPersistsRetainedHistory() async {
        print("\n# Scenario: failed active deletion preserves chat history")

        let store = DeleteFailingMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-chat-delete-failure-\(UUID().uuidString)"
        ) ?? .standard
        let transport = ControlledCompletionTransport()
        let persister = InMemoryPersister()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: store, preferences: defaults)
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        let retainedConversationId = viewModel.conversationId
        viewModel.inputText = "Keep this chat when private cleanup fails"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<100 {
            if viewModel.messages.contains(where: {
                $0.role == .assistant
                    && $0.content == "This result must not be remembered."
            }) {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        await viewModel.deleteConversation(id: retainedConversationId)
        await sendTask.value

        check(
            viewModel.messages
                .first(where: { $0.role == .assistant })?
                .isStreaming == false,
            "failed deletion finalizes the retained partial response"
        )

        let persisted = await persister.load(
            conversationId: retainedConversationId
        )
        check(
            persisted.count == 3
                && persisted[0].role == .user
                && persisted[1].role == .assistant
                && persisted[1].content
                    == "This result must not be remembered."
                && persisted[1].isStreaming == false
                && persisted[2].role == .system
                && persisted[2].content.contains(
                    "Conversation was not deleted"
                ),
            "failed deletion reloads the chat with its failure receipt"
        )
    }

    // MARK: - Scenario 15: initialization ordering

    static func runImmediateNewConversationSurvivesInitialization() async {
        print("\n# Scenario: immediate new conversation survives initialization")

        let persistedConversationId = UUID()
        let persister = DelayedInitializationPersister(
            currentId: persistedConversationId,
            messages: [
                ChatMessage(role: .user, content: "Persisted conversation"),
                ChatMessage(role: .assistant, content: "Persisted answer")
            ],
            initializationDelayNanoseconds: 300_000_000
        )
        let store = VolatileMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-chat-init-race-\(UUID().uuidString)"
        ) ?? .standard
        let viewModel = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: store,
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: store, preferences: defaults)
        )

        viewModel.newConversation()
        for _ in 0..<100 {
            let persistedCurrentId = await persister.peekCurrentConversationId()
            if viewModel.conversationId == persistedCurrentId,
               persistedCurrentId != persistedConversationId,
               viewModel.messages.isEmpty {
                break
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }

        let finalPersistedId = await persister.peekCurrentConversationId()
        check(viewModel.conversationId == finalPersistedId,
              "new conversation and persister converge after initialization")
        check(finalPersistedId != persistedConversationId,
              "late initialization cannot restore the old conversation")
        check(viewModel.messages.isEmpty,
              "late initialization cannot restore old messages")
    }

    // MARK: - Scenario 15: clearing memory during an active turn

    static func runMemoryClearBlocksInflightWrite() async {
        print("\n# Scenario: memory clear blocks in-flight persistence")

        let store = VolatileMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-memory-clear-race-\(UUID().uuidString)"
        ) ?? .standard
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let transport = ControlledCompletionTransport()
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: TODOPlanner(
                store: store,
                preferences: defaults
            )
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        viewModel.inputText = "Remember this only if memory remains enabled"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<100 {
            if await transport.hasStarted {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        do {
            _ = try await viewModel.clearCurrentConversationMemories()
        } catch {
            fail("in-flight memory clear failed: \(error.localizedDescription)")
        }
        await transport.finish()
        await sendTask.value

        do {
            let recent = try await memoryService.recentMemories(limit: 20)
            check(recent.isEmpty,
                  "cleared in-flight turn cannot recreate memory")
        } catch {
            fail("in-flight memory verification failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Scenario 16: scoped clear leaves another turn intact

    static func runUnrelatedClearPreservesInflightWrite() async {
        print("\n# Scenario: unrelated memory clear preserves in-flight persistence")

        let store = VolatileMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-memory-clear-scope-\(UUID().uuidString)"
        ) ?? .standard
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let transport = ControlledCompletionTransport()
        let persister = InMemoryPersister()
        let activeConversationId = UUID()
        await persister.setCurrentConversationId(activeConversationId)
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: TODOPlanner(
                store: store,
                preferences: defaults
            )
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        viewModel.inputText = "Remember this memory result"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<100 {
            if await transport.hasStarted {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        do {
            _ = try await viewModel.clearConversationMemories(
                conversationId: UUID()
            )
        } catch {
            fail("unrelated memory clear failed: \(error.localizedDescription)")
        }
        await transport.finish()
        await sendTask.value

        do {
            let recent = try await memoryService.recentMemories(limit: 20)
            check(
                recent.contains {
                    $0.record.conversationId == activeConversationId
                },
                "clearing another task cannot suppress active-task memory"
            )
        } catch {
            fail("unrelated memory verification failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Scenario 17: clear is ordered after a started write

    static func runClearWaitsForStartedMemoryWrite() async {
        print("\n# Scenario: memory clear waits for a started write")

        let store = ControlledSaveMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-memory-clear-barrier-\(UUID().uuidString)"
        ) ?? .standard
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let transport = MockChatTransport()
        await transport.setEvents([
            .start(id: "memory-write-barrier"),
            .textDelta(
                id: "memory-write-barrier",
                delta: "Memory write is ready."
            ),
            .finish(id: "memory-write-barrier", reason: nil)
        ])
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: TODOPlanner(
                store: store,
                preferences: defaults
            )
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        viewModel.inputText = "Remember this memory barrier"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<100 {
            if await store.hasStartedSave() {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        let didStartSave = await store.hasStartedSave()
        check(didStartSave, "memory write starts before the clear request")

        let clearTask = Task {
            try await viewModel.clearCurrentConversationMemories()
        }
        for _ in 0..<20 {
            await Task.yield()
        }
        let didStartDeletionEarly = await store.hasStartedDeletion()
        check(
            didStartDeletionEarly == false,
            "canonical deletion waits for the started memory write"
        )

        await store.releaseSave()
        do {
            _ = try await clearTask.value
        } catch {
            fail("barrier memory clear failed: \(error.localizedDescription)")
        }
        await sendTask.value

        do {
            let recent = try await memoryService.recentMemories(limit: 20)
            check(
                recent.isEmpty,
                "successful clear leaves no raced memory behind"
            )
        } catch {
            fail("barrier memory verification failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Scenario 18: navigation preserves a completed turn write

    static func runConversationSwitchPreservesStartedMemoryWrite() async {
        print("\n# Scenario: conversation switch preserves completed memory")

        let store = ControlledSaveMemoryStore()
        let defaults = UserDefaults(
            suiteName: "trios-memory-navigation-race-\(UUID().uuidString)"
        ) ?? .standard
        let memoryService = AgentMemoryService(
            store: store,
            fingerprintKey: testFingerprintKey
        )
        let transport = MockChatTransport()
        await transport.setEvents([
            .start(id: "memory-navigation-race"),
            .textDelta(
                id: "memory-navigation-race",
                delta: "The completed result should remain durable."
            ),
            .finish(id: "memory-navigation-race", reason: nil)
        ])
        let persister = InMemoryPersister()
        let completedConversationId = UUID()
        await persister.setCurrentConversationId(completedConversationId)
        let viewModel = ChatViewModel(
            transport: transport,
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: defaults,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: memoryService,
            todoPlanner: TODOPlanner(
                store: store,
                preferences: defaults
            )
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        viewModel.inputText = "Remember this completed navigation result"
        let sendTask = Task {
            await viewModel.sendMessage()
        }
        for _ in 0..<100 {
            if await store.hasStartedSave() {
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        let didStartSave = await store.hasStartedSave()
        check(didStartSave, "completed turn starts its durable memory write")

        let nextConversationId = UUID()
        await viewModel.switchConversation(id: nextConversationId)
        check(
            viewModel.conversationId == nextConversationId,
            "navigation reaches the next conversation while save is pending"
        )

        await store.releaseSave()
        await sendTask.value

        do {
            let recent = try await memoryService.recentMemories(limit: 20)
            check(
                recent.contains {
                    $0.record.conversationId == completedConversationId
                },
                "navigation preserves memory for the completed conversation"
            )
        } catch {
            fail("navigation memory verification failed: \(error.localizedDescription)")
        }

        let persisted = await persister.load(
            conversationId: completedConversationId
        )
        check(
            persisted.count == 2
                && persisted[0].role == .user
                && persisted[1].role == .assistant
                && persisted[1].content
                    == "The completed result should remain durable."
                && persisted[1].isStreaming == false,
            "navigation preserves completed history for the original conversation"
        )
    }

    // MARK: - Scenario 19: scroll geometry and request delivery

    static func runScrollPositionPolicyAndRequestDelivery() async {
        print("\n# Scenario: scroll policy preserves reader position")

        check(
            ChatScrollPolicy.isNearBottom(
                bottomAnchorY: 580,
                viewportHeight: 500,
                threshold: 100
            ),
            "bottom anchor inside threshold is near bottom"
        )
        check(
            !ChatScrollPolicy.isNearBottom(
                bottomAnchorY: 780,
                viewportHeight: 500,
                threshold: 100
            ),
            "bottom anchor beyond threshold preserves reader position"
        )
        check(
            ChatScrollPolicy.isNearBottom(
                bottomAnchorY: 300,
                viewportHeight: 500,
                threshold: 100
            ),
            "short content remains near bottom"
        )

        let manager = SmoothScrollManager()
        let initialSequence = manager.scrollRequest.sequence
        manager.forceScroll(animated: false)
        check(
            manager.scrollRequest.sequence == initialSequence &+ 1,
            "forced scroll emits a consumable request"
        )
        check(
            manager.scrollRequest.animated == false,
            "scroll request preserves its animation policy"
        )
    }

    // MARK: - Scenario: cassette replay, observer, and the salience learner

    /// Everything the app-level cassette suite proves, minus the app.
    ///
    /// The `.app` version needs a window server and a running agent server, so
    /// it cannot run on CI. These assertions cover the same logic in-process:
    /// same `ReplayTransport`, same `SSEEventParser`, same `QueenObserver`.
    static func runCassetteReplayAndObserver() async {
        print("\n# Scenario: cassette replay and observer")

        let root = FileManager.default.currentDirectoryPath
        let happyPath = "\(root)/tests/cassettes/worker-happy-path.sse"
        let loopPath = "\(root)/tests/cassettes/worker-looping.sse"
        let boundsPath = "\(root)/tests/cassettes/worker-out-of-bounds.sse"
        let orphanPath = "\(root)/tests/cassettes/worker-orphan-tool-call.sse"

        guard let happy = try? String(contentsOfFile: happyPath, encoding: .utf8) else {
            check(false, "cassettes are readable from the project root")
            return
        }

        // Replay must go through the real parser. A cassette of decoded events
        // would test the code below the parser and skip the parser itself.
        let events = ReplayTransport.parse(happy)
        check(!events.isEmpty, "a cassette yields events through the real SSE parser")
        check(
            events.contains { if case .finish = $0 { return true } else { return false } },
            "a happy-path cassette ends with a terminal event"
        )

        let effects = ReplayTransport.parseEffects(happy)
        check(
            effects.contains { $0.relativePath == "docs/replay.md" },
            "an #effect line declares the file the recorded tool call wrote"
        )

        // The looping cassette must trip the observer. Hand-written rather than
        // recorded: waiting for a model to get stuck is not a test.
        var looping = QueenWorkerTranscript()
        await applyCassette(atPath: loopPath, to: &looping)
        let loopConcerns = QueenObserver.evaluate(
            transcript: looping,
            ownedPaths: ["docs"],
            totalTokens: 0
        )
        check(
            loopConcerns.contains { $0.kind == .looping },
            "the observer notices a bee repeating one call"
        )

        var strayed = QueenWorkerTranscript()
        await applyCassette(atPath: boundsPath, to: &strayed)
        check(
            QueenObserver.outOfBoundsPaths(in: strayed, ownedPaths: ["docs"])
                .contains("rings/SR-00/NotYours.swift"),
            "the observer notices a write outside the boundary"
        )
        check(
            QueenObserver.outOfBoundsPaths(in: strayed, ownedPaths: ["rings"]).isEmpty,
            "a write inside the boundary raises nothing"
        )

        var orphaned = QueenWorkerTranscript()
        await applyCassette(atPath: orphanPath, to: &orphaned)
        check(
            orphaned.orphanedToolCallIDs == ["call-orphan"],
            "an aborted stream names the tool call it never answered"
        )
    }

    /// Feeds the parser the way the runner does, so the transcript under test is
    /// built by the same path production uses.
    static func applyCassette(atPath path: String, to transcript: inout QueenWorkerTranscript) async {
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        let parser = UIMessageStreamParser()
        for event in ReplayTransport.parse(contents) {
            if let action = await parser.parse(event) {
                transcript.apply(action)
            }
        }
    }

    /// The learner has to actually move a weight off its prior.
    ///
    /// Driving this through twenty app launches proved too flaky to trust, and a
    /// mechanism verified only by seeded data is a mechanism verified by its
    /// author's arithmetic. This feeds the real API real outcomes.
    static func runSalienceLearnsFromOutcomes() async {
        print("\n# Scenario: salience learns from review outcomes")

        let path = NSTemporaryDirectory() + "queen_salience_test_\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let learner = await SalienceLearner(storePath: path)

        let issue = IssueReference(owner: "gHashTag", repo: "trios", number: 1)
        func task(_ state: DelegatedTaskState) -> DelegatedTask {
            DelegatedTask(
                issue: issue,
                title: "t",
                worker: "queen-swift",
                state: state,
                committedFiles: 1
            )
        }

        let threshold = await learner.minimumObservations
        check(threshold >= 4, "the observation threshold is derived, not zero")

        let prior = QueenSalience.Feature.failed.prior
        let beforeAny = await learner.weight(for: .failed)
        check(beforeAny == prior, "a feature with no evidence keeps its prior")

        // One short of the threshold: still the prior. The boundary is the whole
        // point - a weight that moves on three samples is overfitting with extra
        // steps.
        for _ in 0..<(threshold - 1) {
            await learner.record(task: task(.failed), neededUser: true)
        }
        let justUnder = await learner.weight(for: .failed)
        check(justUnder == prior, "one observation short of the threshold keeps the prior")

        await learner.record(task: task(.failed), neededUser: true)
        let learned = await learner.weight(for: .failed)
        check(learned != prior, "crossing the threshold moves the weight off the prior")
        check(
            learned > QueenSalience.maximumWeight * 0.8,
            "a signal that always needed the user ends up loud"
        )

        // The opposite direction has to work too, or the learner only ever
        // confirms what it was told.
        for _ in 0..<threshold {
            await learner.record(task: task(.rejected), neededUser: false)
        }
        let quiet = await learner.weight(for: .rejected)
        check(
            quiet < QueenSalience.Feature.rejected.prior,
            "a signal that never needed the user gets quieter than its prior"
        )

        let evidence = await learner.evidence(for: .failed)
        check(
            evidence.contains("needed you"),
            "the learner can explain its own weight in words"
        )
    }

    // MARK: - Scenario: the pure Queen types nothing had asserted

    /// Six types with no coverage at all, each one a place a wrong answer is
    /// expensive: money, the skill catalogue, and what the Queen claims about
    /// her own state. Every assertion here is a property that has already gone
    /// wrong once in this project.
    static func runPureQueenTypes() async {
        print("\n# Scenario: pure Queen types")

        // ModelPricing. An unknown model must stay unknown - inventing an
        // average is how a cheap run gets cancelled as expensive.
        check(
            ModelPricing.estimatedCost(
                inputTokens: 1000, outputTokens: 1000,
                model: "some-model-nobody-listed", provider: "acme"
            ) == nil,
            "an unpriced model reports no cost rather than a guess"
        )
        check(
            ModelPricing.estimatedCost(
                inputTokens: 1_000_000, outputTokens: 0,
                model: "llama3.1", provider: "ollama"
            ) == 0,
            "a model running on this machine costs nothing, and that is a measurement"
        )
        if let glm = ModelPricing.estimatedCost(
            inputTokens: 1_000_000, outputTokens: 0, model: "glm-5.2", provider: "zai"
        ) {
            check(abs(glm - 0.60) < 0.001, "a point release inherits its family's price")
        } else {
            check(false, "glm-5.2 should match the glm-5 family by prefix")
        }
        // Sub-cent has to read as "something happened", not as nothing.
        check(ModelPricing.format(0.004) == "<$0.01", "a sub-cent spend is not shown as zero")
        check(ModelPricing.format(0) == "$0.00", "no spend is shown as zero")

        // SwarmBudget. The ceiling declines to start work; it never kills.
        let budget = SwarmBudget(dailyLimitUSD: 10)
        if case .fine = budget.verdict(spentToday: 1) {} else {
            check(false, "a tenth of the ceiling is fine")
        }
        if case .nearingLimit = budget.verdict(spentToday: 8.5) {} else {
            check(false, "the last fifth of the ceiling warns")
        }
        if case .exhausted(let over) = budget.verdict(spentToday: 12) {
            check(abs(over - 2) < 0.001, "an exhausted budget reports how far past it is")
        } else {
            check(false, "spending past the ceiling is exhausted")
        }

        // SkillCatalog. A parse bug silently drops a skill, which reads as the
        // skill not existing.
        let withFrontmatter = """
        ---
        name: doctor
        description: Diagnose and heal the build.
        ---

        # Doctor

        Body text.
        """
        let parsed = SkillCatalog.parse(
            contents: withFrontmatter, directoryName: "ignored",
            source: .project, path: "/tmp/x"
        )
        check(parsed?.id == "/doctor", "frontmatter name wins over the directory name")
        check(
            parsed?.description == "Diagnose and heal the build.",
            "the declared description is used verbatim"
        )

        // No frontmatter: the heading is the author's summary, the first line is
        // whatever happened to be at the top. Two skills read as garbage before
        // this preference existed.
        let headingOnly = "## Chat UI/UX Best Practices\n\n- User: right aligned\n"
        let fallback = SkillCatalog.parse(
            contents: headingOnly, directoryName: "chat-ux-patterns",
            source: .project, path: "/tmp/y"
        )
        check(
            fallback?.description == "Chat UI/UX Best Practices",
            "a skill with no frontmatter is described by its heading, not a stray bullet"
        )

        let clash = [
            SkillDescriptor(id: "/doctor", name: "doctor", description: "user copy",
                            source: .user, path: "u", bodyCharacters: 1),
            SkillDescriptor(id: "/doctor", name: "doctor", description: "project copy",
                            source: .project, path: "p", bodyCharacters: 1)
        ]
        check(
            SkillCatalog.deduplicate(clash).first?.description == "project copy",
            "a project skill overrides a user skill of the same name"
        )

        // QueenSystemPrompt. Given a bare list the model invented an on/off
        // state and told the user a live skill was disabled.
        let skill = SkillDescriptor(
            id: "/ascii-lint", name: "ascii-lint", description: "Keep source ASCII.",
            source: .project, path: "p", bodyCharacters: 10
        )
        let allOn = QueenSystemPrompt.text(
            skills: [skill], disabledSkills: [], runningWorkers: 0, awaitingReview: 0
        )
        check(allOn.contains("/ascii-lint"), "the roster names each available skill")
        check(
            allOn.contains("Nothing is switched off"),
            "with nothing disabled the prompt says so, rather than leaving it to be guessed"
        )
        check(
            allOn.contains("supersedes any earlier skill listing"),
            "the roster declares itself newer than anything in the transcript"
        )
        let someOff = QueenSystemPrompt.text(
            skills: [skill], disabledSkills: ["/doctor"],
            runningWorkers: 2, awaitingReview: 1
        )
        check(someOff.contains("/doctor"), "disabled skills are named, not merely omitted")
        check(
            someOff.contains("2 worker(s) are running"),
            "the prompt carries the live swarm counts"
        )

        // QueenBriefing. A worker briefed without the procedure it was promised
        // looks like it disobeyed, so the body goes in verbatim and last.
        let task = DelegatedTask(
            issue: IssueReference(owner: "o", repo: "r", number: 1),
            title: "t", worker: "w", ownedPaths: ["docs"]
        )
        let plain = QueenBriefing.text(for: task)
        check(plain.contains("o/r#1"), "a brief names the issue it answers to")
        check(plain.contains("docs"), "a brief states the boundary")
        let withSkill = QueenBriefing.text(for: task, skillBody: "STEP ONE")
        check(withSkill.contains("STEP ONE"), "a named skill is handed over verbatim")
        check(
            withSkill.range(of: "docs")!.lowerBound < withSkill.range(of: "STEP ONE")!.lowerBound,
            "the boundary is read before the recipe"
        )

        // QueenSelfAudit. Unreachable code outranks everything else, because
        // every plan downstream of a false capability is wrong.
        let findings = [
            QueenSelfAudit.Finding(severity: .fragile, kind: "k", subject: "b",
                                   explanation: "e", proposal: "p"),
            QueenSelfAudit.Finding(severity: .dead, kind: "k", subject: "a",
                                   explanation: "e", proposal: "p")
        ]
        check(
            QueenSelfAudit.roadmap(from: findings).first?.severity == .dead,
            "dead code is ranked above everything else"
        )
        check(
            QueenSelfAudit.report(findings: [], now: Date())
                .contains("statement about my checks"),
            "an empty audit says so about itself rather than claiming health"
        )
    }
}
