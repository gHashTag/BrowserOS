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
    static var checksRun = 0
    static let testFingerprintKey = Data(repeating: 0x5A, count: 32)

    /// Fewest checks this suite may run and still be believed.
    ///
    /// "No failures" is not evidence of coverage. Delete half the bodies below
    /// and this suite still prints that everything passed, because zero
    /// assertions cannot fail - the same shape as a scanner that matches
    /// nothing, one level up, guarding the loop rather than the code.
    ///
    /// Set just under the current count so ordinary edits do not trip it and a
    /// real loss does. Raise it when coverage grows; lowering it is a decision
    /// someone has to make on purpose, which is the entire point.
    static let minimumChecks = 552  // 538 + 14 stale-verdict checks (#1126)

    static func check(_ condition: @autoclosure () -> Bool, _ name: String) {
        checksRun += 1
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

    /// Counts non-overlapping occurrences of `needle` in `haystack`.
    ///
    /// `.contains` answers "does the string appear anywhere?" — a dead
    /// definition satisfies it just as well as a live call. This helper
    /// answers "how many times?" so a threshold can separate a definition
    /// from its uses. Remove the call (the body reference) while leaving
    /// the definition, and the count drops; the test fails. This is the
    /// difference between guarding a string and guarding the thing the
    /// string names. #1118.
    private static func occurrences(_ needle: String, in haystack: String) -> Int {
        guard !needle.isEmpty else { return 0 }
        return haystack.components(separatedBy: needle).count - 1
    }

    static func main() async {
        await runHappyPathStreaming()
        await runCancellationIsNonError()
        await runNewChatAppears()
        await runQueenHearsEveryBee()
        await runSlowReportDoesNotEraseAFasterOne()
        await runQueenAnswersACommand()
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
        await runQueenCorrectsTheWorker()
        await runAcceptanceIsCheckedAgainstCriteria()
        await runDelegationAcceptsCriteria()
        await runGitHubEndpointPaths()
        await runWorkerBriefIsASpecification()
        await runQueenProposesEvolutionOptions()
        await runThreeOptionArrival()
        await runWorkerLivenessIsObservable()
        await runPullRequestOutcomeMapping()
        await runAcceptedWaitsForTheMerge()
        await runNestedBoundariesClash()
        await runPullRequestRefusals()
        await runMergedIsNotTheSameAsClosed()
        await runStalledWorkerIsResumedBeforeCancelled()
        await runQueenTaskLifecycleCloses()
        await runPureQueenTypes()
        await runSelfAuditFindsPlantedDeadCode()
        await runBranchCommitterAgainstScratchRepo()
        await runBeeBoardReflectsStateChanges()
        await runDashboardEntryExitCardButtonsAndEmptyState()
        await runVerdictParserHandlesMarkdownNumbers()
        await runVerdictCarriesTreeState()
        // The interface-drift proof invokes the Swift compiler and is
        // deliberately kept out of the fast suite. Run it explicitly with:
        //   make drift-guard
        if ProcessInfo.processInfo.environment["TRIOS_RUN_DRIFT_GUARD"] != nil {
            await runInterfaceDriftGuardCatchesSignatureMismatch()
        }

        if checksRun < minimumChecks {
            print("\nFAIL - only \(checksRun) checks ran, expected at least \(minimumChecks).")
            print("Coverage was removed, or a scenario returned early without asserting.")
            exit(1)
        }

        if failures == 0 {
            print("\nAll ChatSSEEndToEnd tests passed (\(checksRun) checks).")
            exit(0)
        } else {
            print("\n\(failures) of \(checksRun) test(s) failed.")
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

    /// The Queen answering a command, driven the way the user drives her.
    ///
    /// Last night I recorded that the harness "has no way into the Queen's
    /// command handling". That was inferred from runQueenCommand appearing
    /// nowhere in this file, not from trying it - the same mistake as reading a
    /// scanner's silence as a clean result. It works: the view model this file
    /// already builds is the one the app builds.
    /// Does creating a chat actually create one the user can see?
    static func runNewChatAppears() async {
        print("\n# Scenario: a new chat appears")

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-newchat") ?? .standard
        let persister = InMemoryPersister()
        let viewModel = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: testDefaults, environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(), fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: VolatileMemoryStore(), preferences: testDefaults)
        )
        try? await Task.sleep(nanoseconds: 200_000_000)

        let before = viewModel.conversationId
        viewModel.newConversation()
        try? await Task.sleep(nanoseconds: 400_000_000)
        let after = viewModel.conversationId
        check(after != before, "starting a new chat moves the user into a different conversation")
        check(viewModel.conversations.contains { $0.id == after },
              "and the new chat is in the list the sidebar draws")
        check(viewModel.conversations.contains { $0.id == ChatConversation.trinityQueenId },
              "and the Queen's chat is still there, not replaced by it")
    }

    /// Does the Queen hear every bee, including while the user is elsewhere?
    static func runQueenHearsEveryBee() async {
        print("\n# Scenario: the Queen hears every bee")

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-livequeen") ?? .standard
        let persister = InMemoryPersister()
        let viewModel = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: testDefaults, environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(), fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: VolatileMemoryStore(), preferences: testDefaults)
        )
        try? await Task.sleep(nanoseconds: 200_000_000)

        // The user is looking at some other chat, which is the normal case
        // while bees work: she is supervising, not being read.
        viewModel.newConversation()
        try? await Task.sleep(nanoseconds: 300_000_000)
        check(viewModel.conversationId != ChatConversation.trinityQueenId,
              "the user is somewhere other than the Queen's chat")

        // One notice first: does it even reach her, or land where the user is?
        await viewModel.postQueenNotice("a bee reported")
        let elsewhere = viewModel.messages.filter { $0.role == .system }
        check(elsewhere.isEmpty,
              "a word from the Queen does not land in whichever chat happens to be open")
        let hers = await persister.load(conversationId: ChatConversation.trinityQueenId)
        check(hers.contains { $0.content == "a bee reported" },
              "it lands in her chat, which is where a supervisor's words belong")

        // Several bees report at once. Nothing about finishing is serialised -
        // four workers can end within the same instant.
        await withTaskGroup(of: Void.self) { group in
            for i in 1...6 {
                group.addTask { @MainActor in
                    await viewModel.postQueenNotice("bee \(i) finished")
                }
            }
        }
        // Wait for the writes to settle rather than sleeping a guessed 300ms.
        // The guess held on an idle machine and failed under a parallel build,
        // which is the worst kind of check: it taught you to run it again.
        //
        // Not tautological. If the defect this scenario exists to catch comes
        // back, the notices overwrite each other, the count never reaches six,
        // the deadline expires and the assertion below fails - the same verdict
        // as before, arrived at by waiting instead of by luck.
        func beeNotices() async -> [ChatMessage] {
            await persister.load(conversationId: ChatConversation.trinityQueenId)
                .filter { $0.content.hasPrefix("bee ") }
        }
        let deadline = Date().addingTimeInterval(10)
        var heard = await beeNotices()
        while heard.count < 6, Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
            heard = await beeNotices()
        }

        // Counting only this burst: her chat already holds the single notice
        // from the check above, and "7 of 6" was my arithmetic, not a defect.
        let distinct = Set(heard.map(\.content))
        check(heard.count == 6,
              "every bee that reported is in her chat, none overwritten "
                + "(saw \(heard.count): \(distinct.sorted().joined(separator: ", ")))")
        check(distinct.count == 6,
              "and they are six different bees, not one line saved six times "
                + "(saw \(distinct.count) distinct)")
    }

    /// The scenario above found this once in eight runs, under load, and only
    /// after a guessed sleep was replaced by a wait. This one finds it every
    /// time: the first write to her chat is held open, so the second is certain
    /// to land first, and a stale snapshot arriving afterwards would erase it.
    static func runSlowReportDoesNotEraseAFasterOne() async {
        print("\n# Scenario: a slow report does not erase the one that overtook it")

        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-lostreport") ?? .standard
        let persister = InMemoryPersister()
        let viewModel = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: persister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: testDefaults, environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(), fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: VolatileMemoryStore(), preferences: testDefaults)
        )
        try? await Task.sleep(nanoseconds: 200_000_000)
        viewModel.newConversation()
        try? await Task.sleep(nanoseconds: 300_000_000)

        // Two seconds against a 200ms gap. The margin is the point: the second
        // report has to be well inside the first one's write, and no plausible
        // scheduling delay closes a gap that wide.
        persister.delayedConversation = ChatConversation.trinityQueenId
        persister.delayNanoseconds = 2_000_000_000

        let slow = Task { @MainActor in
            await viewModel.postQueenNotice("the slow bee reported")
        }
        try? await Task.sleep(nanoseconds: 200_000_000)
        await viewModel.postQueenNotice("the quick bee reported")
        await slow.value

        let saved = await persister.load(conversationId: ChatConversation.trinityQueenId)
            .map(\.content)
        check(saved.contains("the slow bee reported"),
              "the report that took longest is still there")
        check(saved.contains("the quick bee reported"),
              "and so is the one that overtook it - a late write does not "
                + "carry a stale copy of her chat over the top")
    }

    static func runQueenAnswersACommand() async {
        print("\n# Scenario: the Queen answers a command")

        let transport = MockChatTransport()
        let healthCheck = MockHealthCheck()
        let persister = InMemoryPersister()
        let parser = UIMessageStreamParser()
        let stateMachine = ConversationStateMachine()
        let testDefaults = UserDefaults(suiteName: "trios-chat-sse-queencmd") ?? .standard
        let modelStore = ModelConfigurationStore(
            defaults: testDefaults, environment: [:],
            reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
        )
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

        await viewModel.runQueenCommand("/definitely-not-a-skill")
        let notices = viewModel.messages.filter { $0.role == .system }.map(\.content)
        check(!notices.isEmpty, "an unknown command is answered rather than swallowed")
        check(notices.contains { $0.contains("no skill called") },
              "and the answer says the skill does not exist, which is one of the two failures")
        check(notices.contains { $0.contains("/skills") },
              "and points at how to find out what does exist")
        check(viewModel.conversationId == ChatConversation.trinityQueenId,
              "a Queen command lands in the Queen's chat, whichever one was open")

        // The other half of the answer, which needed the skill store to become
        // injectable to reach: yesterday this test could not switch a skill off
        // without switching off a real one on whoever ran the suite.
        let root = NSTemporaryDirectory() + "queen-cmd-skills-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: root) }
        try? FileManager.default.createDirectory(
            atPath: "\(root)/.claude/skills/probe", withIntermediateDirectories: true
        )
        try? "---\nname: probe\ndescription: A probe skill.\n---\nDo the thing."
            .write(toFile: "\(root)/.claude/skills/probe/SKILL.md", atomically: true, encoding: .utf8)
        let skills = SkillStore(projectRoot: root, home: root, statePath: "\(root)/state.json")
        guard let probe = skills.skill(named: "/probe") else {
            fail("the probe skill was not discovered"); return
        }
        skills.setEnabled(false, for: probe)

        let offVM = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(),
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: VolatileMemoryStore(), preferences: testDefaults),
            skillStore: skills
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await offVM.runQueenCommand("/probe")
        let offNotices = offVM.messages.filter { $0.role == .system }.map(\.content)
        check(offNotices.contains { $0.contains("switched off") },
              "a skill that exists but is off is refused for that reason, not for being missing")
        check(!offNotices.contains { $0.contains("no skill called") },
              "and is not reported as absent, which is the distinction the whole message exists for")
        // The assertions above are not enough on their own, which I found by
        // mutating the enabled check away and watching them both pass. The
        // phrase survives because SkillStore.run refuses a disabled skill too
        // and says so in the same words - the behaviour is guarded twice, and
        // "switched off" appears either way.
        //
        // What the outer guard is actually for is not letting her announce work
        // she will not do. Without it she says "Running /probe" and only then
        // discovers it is off, which reads to the user as a skill that ran and
        // failed rather than one that was never going to start.
        check(!offNotices.contains { $0.contains("Running `/probe`") },
              "and she does not announce running something she is about to refuse")
        check(offNotices.count == 1,
              "one answer, not an announcement followed by a retraction")

        // Delegation, driven the way the user drives it. Until the registry
        // became injectable this could not run at all: /delegate writes to the
        // real .trinity state, so testing it meant leaving tasks behind on
        // whoever ran the suite.
        let regPath = NSTemporaryDirectory() + "queen-cmd-reg-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: regPath) }
        // Delegation creates a real git branch in this checkout - the registry
        // is injectable but ProjectPaths is not, and createVirtualBranch runs
        // `git branch` for real. The first run of this test left
        // queen/4242-do-a-thing and queen/4243-do-a-thing behind, and the
        // cassette sweep no longer collects those: it was narrowed to
        // queen/1086-cassette-* precisely so it would stop eating branches that
        // hold work. So this cleans up after itself, by name, deleting only the
        // two it makes.
        defer {
            for issue in [4242, 4243, 4244] {
                let list = Process()
                list.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                list.arguments = ["branch", "--list", "queen/\(issue)-*", "--format=%(refname:short)"]
                list.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.root)
                let pipe = Pipe()
                list.standardOutput = pipe
                list.standardError = Pipe()
                guard (try? list.run()) != nil else { continue }
                let out = String(
                    data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8
                ) ?? ""
                list.waitUntilExit()
                for name in out.components(separatedBy: .newlines)
                where name.hasPrefix("queen/\(issue)-") {
                    let remove = Process()
                    remove.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                    remove.arguments = ["branch", "-D", name]
                    remove.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.root)
                    remove.standardOutput = Pipe()
                    remove.standardError = Pipe()
                    try? remove.run()
                    remove.waitUntilExit()
                }
            }
        }
        let registry = QueenDelegationRegistry(storePath: regPath)
        let delegateVM = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(),
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: VolatileMemoryStore(), preferences: testDefaults),
            skillStore: skills,
            delegationRegistry: registry,
            // Offline. Delegation reads the issue's contract, and a suite that
            // reaches github.com is a suite that stops finishing - which is
            // exactly what happened the first time this shipped.
            fetchIssueBody: { _ in "## Готово, когда\n- docs/probe.md exists" }
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        // The consent gate first. She refuses an issue nobody named, which is
        // the rule the user asked for by name - she does not open chats on her
        // own initiative.
        await delegateVM.runQueenCommand("/delegate gHashTag/trios#4242 queen-swift Do a thing")

        // Approving is not enough on its own, which the first run of this test
        // discovered: she refuses to open a task she cannot staff rather than
        // leaving an orphan for someone to find later. Worth asserting - it is
        // the difference between a queue of real work and a queue of intentions.
        await delegateVM.runQueenCommand("/approve gHashTag/trios#4242")
        await delegateVM.runQueenCommand(
            "/delegate gHashTag/trios#4242 queen-swift --paths docs Do a thing"
        )
        check(registry.task(forIssue: IssueReference(owner: "gHashTag", repo: "trios", number: 4242)) == nil,
              "with no worker runner she opens no task, rather than one nobody will start")
        check(
            delegateVM.messages.contains { $0.role == .system && $0.content.contains("no worker runner") },
            "and says why, because a delegation that vanishes silently looks like a bug in the command"
        )

        // Now with one, which is the path the application takes. The Queen and
        // the runner share a persister here, as they do in the app - separate
        // ones would make an isolation check meaningless, since nothing could
        // leak between two stores that cannot see each other.
        let sharedPersister = InMemoryPersister()
        let staffed = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: sharedPersister,
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: modelStore,
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(),
                fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(store: VolatileMemoryStore(), preferences: testDefaults),
            workerRunner: QueenWorkerRunner(
                persister: sharedPersister,
                modelStore: modelStore,
                makeTransport: { MockChatTransport() }
            ),
            skillStore: skills,
            delegationRegistry: registry,
            // Offline. Delegation reads the issue's contract, and a suite that
            // reaches github.com is a suite that stops finishing - which is
            // exactly what happened the first time this shipped.
            fetchIssueBody: { _ in "## Готово, когда\n- docs/probe.md exists" }
        )
        try? await Task.sleep(nanoseconds: 50_000_000)
        await staffed.runQueenCommand("/approve gHashTag/trios#4243")
        await staffed.runQueenCommand(
            "/delegate gHashTag/trios#4243 queen-swift --paths docs Do a thing"
        )
        guard let opened = registry.task(
            forIssue: IssueReference(owner: "gHashTag", repo: "trios", number: 4243)
        ) else {
            let said = staffed.messages.filter { $0.role == .system }.map(\.content)
            print("    [delegate] notices: \(said)")
            fail("an approved issue with a runner still opened no task"); return
        }
        check(opened.worker == "queen-swift", "the named worker is the one recorded")
        check(opened.ownedPaths == ["docs"], "and the boundary from --paths reaches the task")
        // The global output budget and its per-conversation override. Nothing
        // covered either, and the global one is currently unreachable: the
        // store has setRequestedOutputTokens, the sibling setting
        // contextWindowMargin has the same shape *and* a control in the Models
        // tab, and this one has no control anywhere. So the fallback below can
        // only ever be nil in the shipped app. Asserting it now means the day
        // someone adds the missing field, the behaviour it depends on is
        // already known to work.
        modelStore.setRequestedOutputTokens(4096)
        check(staffed.effectiveConversationOutputTokens == 4096,
              "a conversation with no override inherits the global budget")
        await staffed.setConversationRequestedOutputTokens(512)
        check(staffed.effectiveConversationOutputTokens == 512,
              "and an override wins over it, which is the only reason to have both")
        check(staffed.hasConversationOutputTokensOverride,
              "and the view model says the override exists, so the UI can offer to clear it")
        await staffed.setConversationRequestedOutputTokens(nil)
        check(staffed.effectiveConversationOutputTokens == 4096,
              "and clearing the override falls back rather than to nothing")
        modelStore.setRequestedOutputTokens(nil)

        check(opened.virtualBranch?.hasPrefix("queen/4243-") == true,
              "and a branch is named for the issue, so the work is attributable")

        // No --criteria on the command line, and the task still has a contract:
        // she read it from the issue. Requiring it to be retyped is why every
        // delegation in this project's history went out with nothing to judge.
        check(opened.acceptanceCriteria == ["docs/probe.md exists"],
              "delegation with no criteria takes the contract the issue states")

        // The chat the Queen just opened - is it in the list the sidebar draws?
        await staffed.loadConversations()
        check(staffed.conversations.contains { $0.id == opened.conversationId },
              "the chat she opened for the issue is in the sidebar")
        check(
            staffed.conversations.first { $0.id == opened.conversationId }?
                .title.contains(opened.issue.slug) == true,
            "and it is named for its issue, so the list says which task it is"
        )
        check(staffed.conversations.contains { $0.id == ChatConversation.trinityQueenId },
              "and the Queen's own chat is still there beside it")

        // What the swarm list must not do: lose a failure. The sidebar drew
        // registry.active, which is "not terminal", and failed is terminal - so
        // a bee that fell over left the list the instant it did. The registry
        // already knows better: `open` keeps unacknowledged failures, and the
        // comment beside it says why - a failure nobody has looked at is still
        // work, and filing it away silently is how it never gets looked at.
        registry.transition(taskID: opened.id, to: .failed)
        check(!registry.active.contains { $0.id == opened.id },
              "a failed bee is gone from `active`, which is what the sidebar used to draw")
        check(registry.open.contains { $0.id == opened.id },
              "but `open` keeps it, because nobody has looked at the failure yet")

        // And a settled task must leave the swarm list, because that is what
        // lets its chat fall back into the ordinary one. Before this, the
        // sidebar excluded every conversation that had a task at all, so a
        // finished bee's chat was in neither list and could not be opened to
        // see what it had done.
        // Cancelled, not accepted: the state machine only allows failed to go
        // to running or cancelled, which is right - work that fell over is
        // retried or abandoned, not quietly approved. My first fixture tried
        // failed to accepted and the refusal was the machine being correct.
        registry.transition(taskID: opened.id, to: .cancelled)
        check(!registry.open.contains { $0.id == opened.id },
              "an acknowledged task leaves the swarm list")
        check(staffed.conversations.contains { $0.id == opened.conversationId },
              "while its chat is still a conversation, so the sidebar has somewhere to put it")

        // The consent gate, checked on the staffed view model on purpose. I
        // first asserted it on the unstaffed one, where no task opens whatever
        // the gate does - so removing the gate entirely left the assertion
        // green. Passing for the wrong reason is the third time in three
        // cycles, each caught only by mutating the thing under test.
        await staffed.runQueenCommand("/delegate gHashTag/trios#4244 queen-swift Unapproved work")
        check(registry.task(forIssue: IssueReference(owner: "gHashTag", repo: "trios", number: 4244)) == nil,
              "an issue nobody approved opens no task, even with a worker standing by")
        check(
            staffed.messages.contains { $0.role == .system && $0.content.contains("has not been approved") },
            "and she says so, naming the approval she is waiting for"
        )

        // Context control. The supervisor pattern's whole claim is that a bee
        // carries its own task and nothing else - not the Queen's history, not
        // another bee's. Worth proving rather than assuming, because until this
        // week a notice from the Queen landed in whichever chat was open, which
        // meant her words could be saved into a bee's conversation and replayed
        // to it as history on the next brief.
        // Standing in the bee's chat, which is where a user is while it works -
        // and the case that used to put her words in the wrong conversation.
        // Posting from her own chat would make the routing trivially right and
        // prove nothing.
        await staffed.switchConversation(id: opened.conversationId)
        await staffed.postQueenNotice("QUEEN-ONLY-SECRET: the other bee is failing")
        let workerHistory = await sharedPersister.load(conversationId: opened.conversationId)
        check(!workerHistory.contains { $0.content.contains("QUEEN-ONLY-SECRET") },
              "the Queen's own chat does not leak into a worker's conversation")
        let queenHistory = await sharedPersister.load(conversationId: ChatConversation.trinityQueenId)
        check(queenHistory.contains { $0.content.contains("QUEEN-ONLY-SECRET") },
              "and it is in hers, so the check above is about isolation and not about a lost message")
        check(workerHistory.contains { $0.content.contains(opened.issue.slug) },
              "the worker's chat does carry its own issue")
        check(workerHistory.contains { $0.content.contains("docs") },
              "and its own boundary")
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

        // Every fixture above and every cassette calls the same tool,
        // filesystem_write. Removing "edit" from isWriteTool entirely left the
        // suite and all four cassettes green, so half the detector's vocabulary
        // was never exercised by anything.
        func transcript(tool: String, path: String) -> QueenWorkerTranscript {
            QueenWorkerTranscript(seed: [
                ChatMessage(role: .assistant, content: "", toolCalls: [
                    ToolCall(id: "1", name: tool,
                             arguments: "{\"path\":\"\(path)\"}", output: nil, isComplete: true)
                ])
            ])
        }
        for tool in ["filesystem_write", "fs_write", "file_edit", "MultiEdit"] {
            check(
                QueenObserver.outOfBoundsPaths(
                    in: transcript(tool: tool, path: "rings/SR-00/NotYours.swift"),
                    ownedPaths: ["docs"]
                ) == ["rings/SR-00/NotYours.swift"],
                "a stray write through \(tool) is seen"
            )
        }

        // The blind spot, now closed from the other side. A shell write is
        // still invisible to the tool names - nothing about filesystem_bash
        // says "write" and its arguments carry no path - but the observer no
        // longer has to guess from names when something can tell it what
        // actually changed.
        check(
            QueenObserver.outOfBoundsPaths(
                in: transcript(tool: "filesystem_bash", path: "rings/SR-00/NotYours.swift"),
                ownedPaths: ["docs"],
                observedWrites: ["rings/SR-00/NotYours.swift"]
            ) == ["rings/SR-00/NotYours.swift"],
            "a write measured after the fact is seen, whichever tool made it"
        )
        check(
            QueenObserver.outOfBoundsPaths(
                in: transcript(tool: "filesystem_bash", path: "docs/fine.md"),
                ownedPaths: ["docs"],
                observedWrites: ["docs/fine.md"]
            ).isEmpty,
            "and a measured write inside the boundary is still not a complaint"
        )
        check(
            QueenObserver.outOfBoundsPaths(
                in: transcript(tool: "filesystem_write", path: "rings/A.swift"),
                ownedPaths: ["docs"],
                observedWrites: ["rings/B.swift"]
            ) == ["rings/A.swift", "rings/B.swift"],
            "and the two sources are joined rather than one replacing the other"
        )

        // git reports paths from the repository root and a boundary is written
        // from the project, so the measured list has to come down a level
        // before it can be compared. Getting this backwards would report every
        // file as a stray, or none.
        check(QueenBranchCommitter.projectRelative("trios/docs/x.md") == "docs/x.md",
              "a measured path comes down to the project the boundary is written in")
        check(QueenBranchCommitter.projectRelative("docs/x.md") == "docs/x.md",
              "one already at that level is left alone rather than stripped twice")
        check(QueenBranchCommitter.projectRelative("other-project/x.md") == "other-project/x.md",
              "and a path outside the project keeps its shape, since disguising where it is helps nobody")
        check(
            QueenBranchCommitter.repositoryRelative(
                QueenBranchCommitter.projectRelative("trios/docs/x.md")
            ) == "trios/docs/x.md",
            "and the two directions undo each other, which is the only reason to trust either"
        )

        // The old blind spot, kept as the transcript-only answer, because
        // observeWorker runs on every SSE delta and cannot afford a git call.
        //
        // filesystem_bash is neither write-named nor path-argumented, so a
        // worker that writes with `echo >` or `sed -i` is invisible here. The
        // committer still refuses to put those files on the branch - it filters
        // the diff against the same boundary - so nothing wrong lands. What is
        // lost is the warning: the worker spends its turn, and the file simply
        // never appears, with no one saying why.
        //
        // This assertion fails the day someone teaches the observer about
        // shells, which is the right moment to delete it.
        check(
            QueenObserver.outOfBoundsPaths(
                in: transcript(tool: "filesystem_bash", path: "rings/SR-00/NotYours.swift"),
                ownedPaths: ["docs"]
            ).isEmpty,
            "a stray write through the shell is NOT seen - the committer catches it, the observer cannot"
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
    /// Walks a delegated task the whole way round: opened, worked, reviewed,
    /// archived - and the two ways it can go wrong.
    ///
    /// The cassettes prove single moments of a worker's life. Nothing proved the
    /// shape of the life itself, so nothing would have noticed if the cycle
    /// stopped closing: a state that cannot be left, or settled work that never
    /// leaves the open list, looks exactly like a healthy swarm from outside.
    /// A silent worker is restarted before it is written off, and only a
    /// certain number of times.
    ///
    /// The complaint that prompted this was a chat left hanging mid-sentence.
    /// The old behaviour turned an hour of silence straight into a cancelled
    /// task, which is "unfinished" relabelled as "abandoned" - it looks like a
    /// decision and teaches nobody anything. These checks pin both halves: that
    /// a restart happens, and that restarting is bounded.
    /// A merged pull request and an abandoned one must not decode to the same
    /// answer.
    ///
    /// GitHub reports `state` as only "open" or "closed", so a task archived on
    /// `state == "closed"` would file away work whose changes never landed. The
    /// delegation spec turns on this distinction: the chat closes when the forge
    /// says merged, which is a fact, rather than when review said yes, which is
    /// an opinion. Decoded from the shapes the API actually returns.
    /// Opening a pull request is refused for every reason it should be.
    ///
    /// The network call cannot be exercised here, so the decision is kept apart
    /// from it and this pins the decision. Each refusal is a case where opening
    /// would publish something wrong: an empty branch, a second pull request for
    /// work that already has one, or a task nobody finished.
    /// Accepted work with a pull request open is not finished.
    ///
    /// This is the whole point of R5: acceptance is the Queen's opinion, a merge
    /// is a fact from the forge, and the chat should close on the fact. The risk
    /// in saying so is the opposite failure - tasks that will never have a pull
    /// request waiting forever for one - so both halves are pinned here.
    /// The forge's answer maps to one of three actions, and an unreachable
    /// forge maps to none of them.
    /// The signal the supervisor pills depend on actually fires.
    ///
    /// `runningConversationIds` is @Published, but until this cycle nothing
    /// subscribed to it: the runner is held as a plain property on the view
    /// model and no view observes the runner. A worker that stopped kept its
    /// green "Working" pill until some unrelated change forced a redraw. The
    /// view model now forwards this publisher; these checks pin the half that
    /// could silently stop being true - that the set is observable and that
    /// stopping a worker moves it.
    /// The Queen proposes three things to do next, and does not invent a third.
    ///
    /// She may no longer open a chat on her own judgement, so proposing is the
    /// only way she moves the project. That makes the honesty of the list load
    /// bearing: padding it to three would dress an empty audit as a choice.
    /// The worker is handed a contract, not a description.
    ///
    /// The old brief said what the issue was and asked for a report when done.
    /// It never said what done meant, so a worker that stopped and a worker
    /// that finished sent the same signal. These checks pin the sections that
    /// make the difference, and the one case that is easy to paper over: a task
    /// with no criteria has to say so rather than read as ordinary.
    /// Criteria can actually be given, and survive the trip to the brief.
    ///
    /// The contract was built last cycle with nothing able to fill it, which is
    /// the "capability with no caller" shape this project keeps finding. These
    /// checks pin the whole path: command text in, criteria on the task,
    /// numbered list out.
    /// Acceptance is decided by the criteria, not by an impression.
    ///
    /// Without this the specification is decoration: the Queen writes down what
    /// done means and then signs off on a feeling anyway. The three-state
    /// verdict is the load-bearing bit - collapsing "not checked" into either
    /// neighbour is how work gets accepted on a glance.
    /// The Queen corrects the worker, not just the report.
    ///
    /// The observer already noticed looping and out-of-bounds writes, and told
    /// the user about them - the worker was never addressed. Telling you a bee
    /// is heading the wrong way while saying nothing to the bee is observation,
    /// not supervision: it leaves the only remaining choice a decision about
    /// wreckage.
    static func runQueenCorrectsTheWorker() async {
        print("\n# Scenario: the correction reaches the worker")

        let text = QueenObserver.correctionText(concerns: ["writing outside docs/"])
        check(text.contains("writing outside docs/"), "the correction says what is wrong")
        check(text.contains("Adjust before continuing"), "and what to do about it")
        // A correction the worker cannot argue with turns a mistaken Queen into
        // a stuck task.
        check(text.contains("say so here"),
              "and invites the worker to push back rather than work around her")

        // Interventions accumulate on the task so review can see how much
        // steering it took.
        let store = NSTemporaryDirectory() + "queen-intervene-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)
        guard let issue = IssueReference.parse("gHashTag/trios#51"),
              let task = registry.delegate(
                  issue: issue, title: "probe", worker: "queen-swift",
                  conversationId: UUID(), ownedPaths: ["docs"]
              )
        else {
            fail("could not open a probe task"); return
        }
        check(registry.task(forIssue: issue)?.interventions.isEmpty == true,
              "a fresh task has not been corrected")

        registry.recordIntervention(taskID: task.id, text: "first")
        registry.recordIntervention(taskID: task.id, text: "second")
        let corrected = registry.task(forIssue: issue)
        check(corrected?.interventions.count == 2, "each correction is counted, not just the last")
        check(corrected?.interventions.first == "first",
              "and kept in order, so review can read how the work drifted")

        // recordVerdict refuses a criterion the task does not have, and nothing
        // checked that until now: removing the guard left every check green.
        // The refusal matters because QueenAcceptancePolicy builds its table by
        // walking the task's criteria and looking each one up. A verdict filed
        // under a criterion that is not in that list is invisible - the Queen
        // would believe she had answered it, the table would still read
        // unchecked, and acceptance would stay blocked with no way to see why.
        guard let scored = registry.delegate(
            issue: IssueReference(owner: "gHashTag", repo: "trios", number: 52),
            title: "scored", worker: "queen-swift",
            // A path of its own: the registry allows one owner per path, and
            // the task above already holds docs.
            conversationId: UUID(), ownedPaths: ["scratch"],
            acceptanceCriteria: ["make check passes"]
        ) else {
            fail("could not open a task with criteria"); return
        }
        check(registry.recordVerdict(taskID: scored.id, criterion: "make check passes", verdict: .met),
              "a verdict against a real criterion is recorded")
        check(!registry.recordVerdict(taskID: scored.id, criterion: "a criterion nobody set", verdict: .met),
              "and one against a criterion the task never had is refused, not filed where nothing reads it")
        check(registry.task(forConversation: scored.conversationId)?.criterionVerdicts.count == 1,
              "so the task carries exactly the verdicts its own criteria can show")
    }

    static func runAcceptanceIsCheckedAgainstCriteria() async {
        print("\n# Scenario: accepted means the criteria say so")

        typealias P = QueenAcceptancePolicy

        // What the Queen can settle without taking the worker's word. A bee
        // saying it met a criterion is the same agent grading its own homework;
        // a gate that accepts that is decoration. A file either changed or it
        // did not.
        let contract = [
            "docs/queen-review-gate.md exists",
            "it names what blocks a merge",
            "docs/missing.md is updated"
        ]
        let judged = P.mechanicalVerdicts(
            criteria: contract,
            changedPaths: ["docs/queen-review-gate.md", "docs/other.md"]
        )
        check(judged["docs/queen-review-gate.md exists"] == .met,
              "a criterion naming a file that changed is met on the evidence")
        check(judged["docs/missing.md is updated"] == .unmet,
              "and one naming a file that did not change is unmet, not left open")
        check(judged["it names what blocks a merge"] == nil,
              "a criterion naming no file gets no verdict - guessing is worse than leaving it")
        check(
            P.acceptanceBlockReason(criteria: contract, recorded: judged) != nil,
            "so acceptance still stops, on the one question a person has to answer"
        )
        check(
            P.acceptanceBlockReason(
                criteria: ["docs/queen-review-gate.md exists"],
                recorded: P.mechanicalVerdicts(
                    criteria: ["docs/queen-review-gate.md exists"],
                    changedPaths: ["docs/queen-review-gate.md"]
                )
            ) == nil,
            "and a contract made only of checkable facts needs nobody"
        )

        // The contract an issue already states. Requiring it on the command
        // line meant it was retyped, which in practice meant skipped - every
        // delegation in this project's history went out with nothing to judge.
        let issueBody = """
        ## Зачем

        Что-то важное.

        ## Что уже сделано

        - [x] это было раньше и не является контрактом

        ## Готово, когда

        - docs/queen-verdicts.md exists
        - [ ] the gate refuses an unchecked criterion
        * a bullet with a star counts too

        ## Замечание

        - not a criterion either
        """
        let fromIssue = QueenTaskSpec.criteriaFromIssue(body: issueBody)
        check(fromIssue == [
            "docs/queen-verdicts.md exists",
            "the gate refuses an unchecked criterion",
            "a bullet with a star counts too"
        ], "the criteria come from the done-when list, in the author's own words")
        check(!fromIssue.contains { $0.contains("было раньше") },
              "and not from what is already done, which is a claim about the past")
        check(!fromIssue.contains { $0.contains("not a criterion") },
              "and the list stops at the next heading")
        check(QueenTaskSpec.criteriaFromIssue(body: "no headings here").isEmpty,
              "an issue that states no contract yields none, rather than something invented")
        check(
            QueenTaskSpec.criteriaFromIssue(body: "## Acceptance criteria\n- it builds")
                == ["it builds"],
            "and the English heading works too, since half these issues are written in it"
        )

        let criteria = ["make check passes", "the tab paginates"]

        check(P.acceptanceBlockReason(criteria: criteria, recorded: [:]) != nil,
              "work with nothing checked cannot be accepted")
        check(P.acceptanceBlockReason(
                criteria: criteria,
                recorded: ["make check passes": .met]
              ) != nil,
              "nor work where only some criteria were answered")
        check(P.acceptanceBlockReason(
                criteria: criteria,
                recorded: ["make check passes": .met, "the tab paginates": .unmet]
              ) != nil,
              "nor work that failed one")
        check(P.acceptanceBlockReason(
                criteria: criteria,
                recorded: ["make check passes": .met, "the tab paginates": .met]
              ) == nil,
              "work that met every criterion can be accepted")

        // Unchecked must not read as either neighbour.
        let reason = P.acceptanceBlockReason(criteria: criteria, recorded: [:]) ?? ""
        check(reason.contains("never checked"), "an unanswered criterion is named as unchecked")
        check(reason.contains("not a pass"), "and the report says plainly that it is not a pass")

        // A task predating criteria must not be stranded.
        check(P.acceptanceBlockReason(criteria: [], recorded: [:]) == nil,
              "a task with no criteria can still be accepted, as it always could")
        check(P.table(criteria: [], recorded: [:]).contains("on judgement"),
              "but the table says that acceptance is then a judgement, not a check")

        // The table shows every criterion, including the ones nobody answered.
        let table = P.table(criteria: criteria, recorded: ["make check passes": .met])
        check(table.contains("[x] 1. make check passes"), "a met criterion is marked met")
        check(table.contains("[?] 2. the tab paginates"),
              "and an unanswered one still appears rather than vanishing from the table")

        // The command that records a verdict.
        guard case .verifyCriterion(let issue, let criterion, let verdict) =
            QueenCommandParser.parse("/verify gHashTag/trios#41 the tab paginates met")
        else {
            fail("/verify did not parse"); return
        }
        check(issue.slug == "gHashTag/trios#41", "the issue is read")
        check(criterion == "the tab paginates",
              "the criterion keeps its spaces, so it needs no quoting")
        check(verdict == .met, "and the verdict is the last word")
        if case .unknown = QueenCommandParser.parse("/verify gHashTag/trios#41 something unchecked") {
            check(true, "unchecked cannot be recorded by hand - it is the absence of an answer")
        } else {
            fail("unchecked cannot be recorded by hand - it is the absence of an answer")
        }
    }

    static func runDelegationAcceptsCriteria() async {
        print("\n# Scenario: the Queen can state what done means")

        guard case .delegateIssue(let issue, let worker, let title, let paths, _, let criteria) =
            QueenCommandParser.parse(
                "/delegate gHashTag/trios#31 queen-swift --paths docs "
                    + "--criteria make check passes; the tab renders 50 rows, then paginates"
            )
        else {
            fail("a delegation with criteria did not parse"); return
        }
        check(issue.slug == "gHashTag/trios#31", "the issue survives the flags")
        check(worker == "queen-swift", "so does the worker")
        check(paths == ["docs"], "and the boundary")
        check(criteria.count == 2, "two criteria are read as two")
        check(criteria.first == "make check passes", "the first is intact")
        // The reason for splitting on semicolons rather than commas.
        check(criteria.last == "the tab renders 50 rows, then paginates",
              "a criterion containing a comma stays one criterion")
        check(title.isEmpty || !title.contains("--criteria"),
              "the flag does not leak into the title")

        // And the whole way through to what the worker reads.
        let task = DelegatedTask(
            issue: issue, title: "probe", worker: worker,
            ownedPaths: paths, acceptanceCriteria: criteria
        )
        let brief = QueenBriefing.text(for: task)
        check(brief.contains("1. make check passes"), "criteria reach the brief, numbered")
        check(brief.contains("2. the tab renders 50 rows, then paginates"),
              "including the one with a comma in it")
        check(QueenTaskSpec.isActionable(task), "a task delegated with criteria is actionable")

        // Omitting them still works and still says so.
        guard case .delegateIssue(_, _, _, _, _, let none) =
            QueenCommandParser.parse("/delegate gHashTag/trios#32 queen-swift Fix the thing")
        else {
            fail("a delegation without criteria did not parse"); return
        }
        check(none.isEmpty, "criteria are optional, and absent means absent")

        // Quoted criteria must end at the closing quote. They did not: the flag
        // took everything to the end of the line, so a real run produced a task
        // titled "Work on gHashTag/trios#1095" - the fallback - whose last
        // criterion was `it is under 40 lines" Extend docs/...`. The one flag
        // that turns a brief into a contract was destroying the brief.
        guard case .delegateIssue(_, _, let quotedTitle, _, _, let quotedCriteria) =
            QueenCommandParser.parse(
                "/delegate gHashTag/trios#7 queen-swift --paths docs "
                    + "--criteria \"the file exists; it is short\" Write the file"
            )
        else {
            fail("a delegation with quoted criteria did not parse"); return
        }
        check(quotedCriteria == ["the file exists", "it is short"],
              "quoted criteria stop at the closing quote and carry no quote marks")
        check(quotedTitle == "Write the file",
              "and the words after them are the title, not more contract")

        // One token that opens and closes its own quote.
        guard case .delegateIssue(_, _, let oneTitle, _, _, let oneCriterion) =
            QueenCommandParser.parse(
                "/delegate gHashTag/trios#8 queen-swift --criteria \"builds\" Make it build"
            )
        else {
            fail("a single quoted criterion did not parse"); return
        }
        check(oneCriterion == ["builds"], "a single quoted criterion is just itself")
        check(oneTitle == "Make it build", "and the title survives it")
    }

    static func runGitHubEndpointPaths() async {
        print("\n# Scenario: the paths the Queen calls GitHub with")

        // Every one of these is a bug that shipped and survived, because the
        // pull-request half of the client had never been called once. No test
        // looked at a finished URL, so nothing could have noticed.

        // The Queen passes "owner/repo". The old builder pasted that after a
        // hardcoded owner: /repos/gHashTag/gHashTag/trios/pulls.
        check(
            (try? GitHubEndpoint.repositoryPath("gHashTag/trios", "/pulls")) == "/repos/gHashTag/trios/pulls",
            "a repository given as owner/name is addressed once, not twice"
        )
        // The dashboard passes a bare name and relies on the default owner.
        check(
            (try? GitHubEndpoint.repositoryPath("trios", "/issues")) == "/repos/gHashTag/trios/issues",
            "a bare name still resolves against the default owner"
        )
        // A different owner is now honoured rather than silently mangled.
        check(
            (try? GitHubEndpoint.repositoryPath("browseros-ai/BrowserOS", "/pulls/7/merge"))
                == "/repos/browseros-ai/BrowserOS/pulls/7/merge",
            "an owner that is not the default is addressed as written"
        )

        // The merge and fetch calls passed "pulls/7/merge" with no leading
        // slash, which glued itself to the repository name.
        var missingSlashRefused = false
        do { _ = try GitHubEndpoint.repositoryPath("trios", "pulls/7/merge") }
        catch { missingSlashRefused = true }
        check(missingSlashRefused, "a suffix without its leading slash is refused, not concatenated")

        var malformedRefused = false
        do { _ = try GitHubEndpoint.repositoryPath("a/b/c", "/pulls") }
        catch { malformedRefused = true }
        check(malformedRefused, "a repository with two slashes is refused rather than guessed at")

        var emptyOwnerRefused = false
        do { _ = try GitHubEndpoint.repositoryPath("/trios", "/pulls") }
        catch { emptyOwnerRefused = true }
        check(emptyOwnerRefused, "an empty owner is refused")

        // The old code encoded with .urlPathAllowed, which permits "/" and so
        // protected against nothing.
        check(
            GitHubEndpoint.escape("a/b") == "a%2Fb",
            "a slash inside one component is encoded instead of becoming a separator"
        )
        check(
            (try? GitHubEndpoint.repositoryPath("owner/na me", "/pulls")) == "/repos/owner/na%20me/pulls",
            "and a space is encoded without disturbing the separators around it"
        )
    }

    static func runWorkerBriefIsASpecification() async {
        print("\n# Scenario: the brief is a specification")

        guard let issue = IssueReference.parse("gHashTag/trios#21") else {
            fail("could not build a test issue"); return
        }
        func task(criteria: [String], paths: [String] = ["docs"]) -> DelegatedTask {
            DelegatedTask(
                issue: issue, title: "Make the logs tab paginate", worker: "queen-swift",
                ownedPaths: paths, acceptanceCriteria: criteria, virtualBranch: "queen/21-probe"
            )
        }

        let spec = QueenTaskSpec.render(for: task(criteria: [
            "make check passes", "the tab renders 50 rows at a time"
        ]))
        // A heading is not a section. This loop used to assert only that each
        // "## X" appeared, which reads as thorough - all five, none forgotten -
        // and passes with every one of them empty. Emptying Out of scope
        // entirely left all 342 checks green, so the specification could have
        // lost a whole instruction to the worker without a word from the suite.
        //
        // Splitting on the headings and requiring text underneath is the same
        // loop asking the question it looked like it was asking, and it covers
        // sections nobody has written yet.
        let sectionBodies = QueenTaskSpec.sectionTitles.map { title -> (String, String) in
            guard let start = spec.range(of: "## \(title)") else { return (title, "") }
            let rest = spec[start.upperBound...]
            let end = rest.range(of: "\n## ")?.lowerBound ?? rest.endIndex
            return (title, String(rest[..<end]).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        for (title, body) in sectionBodies {
            check(spec.contains("## \(title)"), "the specification has a \(title) section")
            check(!body.isEmpty, "and the \(title) section says something under its heading")
        }
        check(spec.contains("1. make check passes"), "criteria are numbered so they can be answered one by one")
        // A worker has no clock, and the first live delegation proved it: asked
        // for the date it wrote 2025 during 2026 and marked the criterion met.
        let stamped = QueenTaskSpec.render(
            for: task(criteria: ["x"]),
            today: Date(timeIntervalSince1970: 1_774_000_000)
        )
        check(stamped.contains("Today is "), "the specification states the date rather than expecting it to be known")
        check(
            stamped.contains(QueenTaskSpec.dateStamp(Date(timeIntervalSince1970: 1_774_000_000))),
            "and states the date it was given, not the day the test happens to run"
        )
        check(spec.contains("docs"), "the boundary names the paths the worker owns")
        check(spec.contains("queen/21-probe"), "and the branch its edits belong to")
        // Naming the branch is not enough. The first live delegation ended with
        // the shared checkout standing on the worker's branch, because "every
        // edit belongs to X" reads as "go to X" and the worker obliged.
        // Compared against the shared source rather than a fragment. A test
        // that greps for a phrase passes as soon as some document contains it;
        // this one only passes while both documents carry the same sentence.
        let rule = QueenBranchPolicy.ownershipRule(branch: "queen/21-probe")
        check(spec.contains(rule),
              "the boundary carries the branch rule verbatim from its one source")
        check(rule.contains("Do not check that branch out") && rule.contains("shared"),
              "and that rule forbids checking out and says why the checkout is not yours")
        check(rule.contains("queen/21-probe"),
              "the shared rule names the branch it was given")
        check(QueenBranchPolicy.ownershipRule(branch: "queen/99-other") != rule,
              "and is not a constant that merely looks personalised")

        // The case worth protecting.
        let empty = QueenTaskSpec.render(for: task(criteria: []))
        check(empty.contains("None were set"),
              "a task with no criteria says so instead of reading like any other")
        check(empty.contains("not ready"),
              "and tells the worker that saying the task is not ready is a correct outcome")
        check(!QueenTaskSpec.isActionable(task(criteria: [])),
              "a task without criteria is not actionable")
        check(QueenTaskSpec.isActionable(task(criteria: ["x"])),
              "one with criteria is")

        // The brief must BE the specification, not carry one alongside prose.
        let brief = QueenBriefing.text(for: task(criteria: ["make check passes"]))
        check(brief.contains("## Acceptance criteria"),
              "the brief the worker actually receives is the specification")
        check(brief.contains("reviews against the criteria"),
              "and says review happens against them, not against a summary")

        // The standing orders had no coverage at all until now, which is how
        // they kept the wording the specification had already been corrected
        // for. They outrank the brief in practice: an agent trusts its system
        // prompt over a message in the conversation, so a rule stated in both
        // places is only as strong as the weaker statement.
        let orders = QueenWorkerRunner.workerSystemPrompt(for: task(criteria: ["x"]))
        check(orders.contains(rule),
              "the standing orders carry the identical sentence, not a paraphrase of it")

        // The other two rules that were written twice. The boundary had not
        // diverged in meaning yet; the report rule had, and in the direction
        // that costs the Queen her verdicts - the specification said not to
        // summarise while the orders asked for "a short report".
        let boundary = QueenBranchPolicy.boundaryRule(ownedPaths: ["docs"])
        check(spec.contains(boundary) && orders.contains(boundary),
              "both documents state the path boundary in the same words")
        check(QueenBranchPolicy.boundaryRule(ownedPaths: []) != boundary,
              "and having no paths at all says something different from having some")
        check(spec.contains(QueenBranchPolicy.reportRule)
                && orders.contains(QueenBranchPolicy.reportRule),
              "and both ask for the same report")
        check(!orders.contains("short report"),
              "which is no longer a short one, because short contradicted do-not-summarise")
        check(!orders.contains("Attribute every edit to the branch"),
              "the wording that made a worker switch branches is gone from both places")

        // A skill still arrives verbatim, after the rules.
        let withSkill = QueenBriefing.text(for: task(criteria: ["x"]), skillBody: "STEP ONE")
        check(withSkill.contains("STEP ONE"), "a skill is still handed over verbatim")
        if let rules = withSkill.range(of: "## Boundary"), let recipe = withSkill.range(of: "STEP ONE") {
            check(rules.lowerBound < recipe.lowerBound,
                  "and still comes after the boundary, so a skimming worker meets the rules first")
        }
    }

    static func runQueenProposesEvolutionOptions() async {
        print("\n# Scenario: three options, or fewer if there are fewer")

        func finding(_ severity: QueenSelfAudit.Finding.Severity, _ subject: String) -> QueenSelfAudit.Finding {
            QueenSelfAudit.Finding(
                severity: severity, kind: "probe", subject: subject,
                explanation: "why \(subject) matters", proposal: "do something about \(subject)"
            )
        }

        let many = [
            finding(.fragile, "fragile-one"),
            finding(.dead, "dead-one"),
            finding(.unverified, "unverified-one"),
            finding(.dead, "dead-two"),
        ]
        let options = QueenEvolutionOptions.options(from: many)
        check(options.count == 3, "four findings yield three options, not four")
        check(options.map(\.label) == ["A", "B", "C"], "options are lettered so one can be picked in a word")
        check(options.first?.subject.hasPrefix("dead") == true,
              "dead code is offered first, matching how the roadmap ranks it")

        // Dead code can be removed without asking what it should have done.
        check(options.first?.needsUserDecision == false,
              "removing something unreachable does not need a decision")
        check(options.contains { $0.needsUserDecision },
              "but unproven or fragile work does, and says so")

        // The part that would be easy to fake.
        let two = QueenEvolutionOptions.options(from: [finding(.dead, "only-one"), finding(.fragile, "only-two")])
        check(two.count == 2, "two findings yield two options rather than a padded three")
        let none = QueenEvolutionOptions.options(from: [])
        check(none.isEmpty, "no findings yield no options")

        let empty = QueenEvolutionOptions.message(for: none)
        check(empty.contains("nothing to propose"), "an empty audit says so plainly")
        check(empty.contains("about my checks"),
              "and admits the silence is about the checks, not a clean bill of health")

        let message = QueenEvolutionOptions.message(for: options)
        check(message.contains("/approve"), "the message ends with the command that authorises one")
        check(message.contains("will not open a chat"),
              "and restates that she waits rather than starts")
    }

    // MARK: - Scenario: three options arrive, each justified, each actionable, not repeated

    /// #1097 — asserts the three-option arrival the Queen posts after a
    /// self-audit: three options, each with a justification and the command
    /// that launches it; the consent gate is the last thing she says; and she
    /// does not come with the same set of options twice in a row.
    static func runThreeOptionArrival() async {
        print("\n# Scenario: three options arrive in the chat, each justified, each actionable, not repeated")

        func finding(_ severity: QueenSelfAudit.Finding.Severity, _ subject: String) -> QueenSelfAudit.Finding {
            QueenSelfAudit.Finding(
                severity: severity, kind: "probe", subject: subject,
                explanation: "why \(subject) matters", proposal: "do something about \(subject)"
            )
        }

        let findings = [
            finding(.dead, "ghost-A"),
            finding(.unverified, "ghost-B"),
            finding(.fragile, "ghost-C"),
        ]

        // ── Criterion 1: the message carries three options, each with its
        // own justification and the command that launches it. ──
        let options = QueenEvolutionOptions.options(from: findings)
        let message = QueenEvolutionOptions.message(for: options)

        // Each option's subject, rationale and action must appear in the
        // posted message. The user reads the message, not the Option struct;
        // a field that exists on the type but is absent from the prose might
        // as well not exist.
        for opt in options {
            check(message.contains(opt.subject),
                  "the message names option \(opt.label)'s subject (\(opt.subject))")
            check(message.contains(opt.rationale),
                  "the message justifies option \(opt.label) — why it is worth doing")
            check(message.contains(opt.action),
                  "the message states what option \(opt.label) would do")
        }

        // The command that authorises one.
        check(message.contains("/approve"),
              "the message carries the command that starts an option")

        // ── Criterion 2: the consent gate is the last thing she says. ──
        // The end-to-end gate (approvalBlockReason refusing an unapproved
        // issue) is tested in runQueenHearsEveryBee. Here we assert that the
        // proposal message itself ends with the gate — so the proposal the
        // user reads is also the boundary the Queen will not cross.
        check(message.contains("will not open a chat"),
              "the message restates that she waits, never starts")
        check(
            message.range(of: "will not open a chat")!.lowerBound
                > message.range(of: options.last!.action)!.upperBound,
            "the consent gate appears after every option, not before them"
        )

        // ── Criterion 3: she does not come with the same thing twice in a row.
        // The dedup comparison is on option subjects (the Finding.subject
        // strings), not on message prose. Same subjects → the caller must
        // suppress the full message, because posting it again would be the
        // same wall of text the user already ignored. ──
        let previous = QueenEvolutionOptions.options(from: findings)
        check(options.map(\.subject) == previous.map(\.subject),
              "two audits with the same findings yield identical subjects — the repeat the caller must catch")
        check(
            QueenEvolutionOptions.message(for: options) == QueenEvolutionOptions.message(for: previous),
            "identical subjects mean an identical message, so repeating is posting the same thing twice"
        )

        // When the repository changes and a finding drops off or changes,
        // the subjects differ and the message is genuinely new.
        let afterFix = [
            finding(.dead, "ghost-A"),
            finding(.unverified, "ghost-B"),
            finding(.fragile, "ghost-FIXED"),
        ]
        let fresh = QueenEvolutionOptions.options(from: afterFix)
        check(options.map(\.subject) != fresh.map(\.subject),
              "a finding that changed makes the subjects differ, so the next post is not a repeat")
        check(
            QueenEvolutionOptions.message(for: options) != QueenEvolutionOptions.message(for: fresh),
            "and the messages differ, so a changed repository produces a changed proposal"
        )
    }

    static func runWorkerLivenessIsObservable() async {
        print("\n# Scenario: a stopped worker stops reading as live")

        let runner = QueenWorkerRunner(
            persister: InMemoryPersister(),
            modelStore: ModelConfigurationStore(
                defaults: UserDefaults(suiteName: "liveness-\(UUID().uuidString)")!,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            makeTransport: { MockChatTransport() }
        )
        let conversation = UUID()

        var notifications = 0
        let subscription = runner.$runningConversationIds.sink { _ in notifications += 1 }
        defer { subscription.cancel() }
        let baseline = notifications

        check(!runner.isRunning(conversationId: conversation),
              "a conversation nobody started is not live")

        runner.stop(conversationId: conversation)
        check(notifications > baseline,
              "changing the live set notifies subscribers, so a pill can be redrawn")
        check(!runner.isRunning(conversationId: conversation),
              "and the stopped conversation is not live afterwards")

        // The rule that consumes this lives in QueenTaskStyle, a SwiftUI file
        // outside this suite's sources. Pulling a view into a logic suite to
        // reach it would be a bad trade, so it stays unproved here and is named
        // rather than quietly skipped.
    }

    static func runPullRequestOutcomeMapping() async {
        print("\n# Scenario: reading what the forge actually said")

        let base = #""id":1,"number":7,"title":"t","html_url":"u","head":null,"base":null"#
        func pr(_ json: String, _ label: String) -> GitHubPullRequest? {
            guard let decoded = try? JSONDecoder().decode(GitHubPullRequest.self, from: Data(json.utf8)) else {
                fail("could not decode \(label)"); return nil
            }
            return decoded
        }
        typealias P = QueenDelegationPolicy

        if let merged = pr("{\(base),\"state\":\"closed\",\"merged\":true,\"merged_at\":\"2026-07-30T00:00:00Z\"}", "merged") {
            check(P.outcome(merged: merged.isMerged, closedUnmerged: merged.isClosedUnmerged) == .landed, "a merged pull request means the work landed")
            check(P.nextState(for: .landed) == .merged, "and the task settles as merged")
        }
        if let closed = pr("{\(base),\"state\":\"closed\",\"merged\":false,\"merged_at\":null}", "closed unmerged") {
            check(P.outcome(merged: closed.isMerged, closedUnmerged: closed.isClosedUnmerged) == .abandoned, "closed without merging means nothing landed")
            check(P.nextState(for: .abandoned) == .awaitingReview,
                  "so the task goes back to the queue rather than the archive")
        }
        if let open = pr("{\(base),\"state\":\"open\"}", "open") {
            check(P.outcome(merged: open.isMerged, closedUnmerged: open.isClosedUnmerged) == .pending, "an open pull request decides nothing yet")
            check(P.nextState(for: .pending) == nil, "and moves the task nowhere")
        }

        // The distinction that makes the whole poll worth writing: two answers
        // whose `state` is the same word lead to opposite actions.
        if let merged = pr("{\(base),\"state\":\"closed\",\"merged\":true,\"merged_at\":null}", "merged"),
           let closed = pr("{\(base),\"state\":\"closed\",\"merged\":false,\"merged_at\":null}", "closed") {
            check(
                P.nextState(for: P.outcome(merged: merged.isMerged, closedUnmerged: merged.isClosedUnmerged)) != P.nextState(for: P.outcome(merged: closed.isMerged, closedUnmerged: closed.isClosedUnmerged)),
                "identical state, opposite destinations - archive versus back to the queue"
            )
        }
    }

    static func runAcceptedWaitsForTheMerge() async {
        print("\n# Scenario: the chat closes on the merge, not on the opinion")

        guard let issue = IssueReference.parse("gHashTag/trios#11") else {
            fail("could not build a test issue"); return
        }
        func task(_ state: DelegatedTaskState, pr: Int? = nil) -> DelegatedTask {
            DelegatedTask(
                issue: issue, title: "probe", worker: "queen-swift",
                state: state, virtualBranch: "queen/11-probe", pullRequestNumber: pr
            )
        }

        check(!task(.accepted, pr: 4).isSettled,
              "accepted work with a pull request open is still waiting on the merge")
        check(task(.merged, pr: 4).isSettled,
              "once it merges the task is finished")

        // The regression this could easily have caused.
        check(task(.accepted).isSettled,
              "accepted work with no pull request settles as it always did")
        check(task(.cancelled).isSettled, "a cancelled task still settles")
        check(!task(.failed).isSettled, "a failure still stays visible rather than filing itself away")

        typealias P = QueenDelegationPolicy
        check(P.canTransition(from: .accepted, to: .merged),
              "a merge can settle accepted work")
        check(P.canTransition(from: .accepted, to: .awaitingReview),
              "and a pull request closed without merging sends it back to the queue")
        check(!P.canTransition(from: .merged, to: .running),
              "landed work does not reopen")
        check(!P.canTransition(from: .awaitingReview, to: .merged),
              "work cannot merge before it has been accepted")

        check(DelegatedTaskState.merged.isTerminal, "merged is an end state")
        check(!DelegatedTaskState.merged.needsQueenAttention,
              "and needs nothing further from the Queen")
    }

    /// Two bees at once is the whole point of the design, and the first time it
    /// actually ran it exposed this: the ownership rule compared boundaries as
    /// strings, so `docs` and `docs/live` looked unrelated and both claims were
    /// admitted. Meanwhile a write is judged by containment, so the bee owning
    /// `docs` was entitled to write `docs/live/x.md` - the same file the other
    /// bee owned. Two writers, one file, nothing complaining until the merge.
    static func runNestedBoundariesClash() async {
        print("\n# Scenario: two bees cannot claim boundaries that contain each other")

        typealias P = QueenDelegationPolicy

        check(P.pathsOverlap("docs", "docs/live"),
              "a directory overlaps anything beneath it")
        check(P.pathsOverlap("docs/live", "docs"),
              "and the question is symmetric - claim order must not decide it")
        check(P.pathsOverlap("rings", "rings/SR-02/ChatViewModel.swift"),
              "the ordinary case: a wide boundary and a file inside it")
        check(P.pathsOverlap("docs", "docs"),
              "identical boundaries still clash")
        check(P.pathsOverlap("./docs/", "docs") == P.pathsOverlap("docs", "docs"),
              "normalization does not change the verdict")

        // The other half. A rule that answers yes to everything would pass every
        // check above and stop all parallel work, which is the failure mode that
        // looks like safety.
        check(!P.pathsOverlap("docs", "docsite"),
              "a shared prefix is not containment - comparison is by component")
        check(!P.pathsOverlap("docs/live", "docs/spec"),
              "siblings do not overlap, or no two bees could ever run")
        check(!P.pathsOverlap("rings/SR-00", "rings/SR-02"),
              "two rings are two boundaries")
        check(!P.pathsOverlap("", "docs"),
              "an empty boundary claims nothing rather than everything")

        guard let first = IssueReference.parse("gHashTag/trios#1093"),
              let second = IssueReference.parse("gHashTag/trios#1098") else {
            fail("could not build the two test issues"); return
        }
        let held = DelegatedTask(
            issue: first, title: "spec header", worker: "queen-swift",
            state: .running, ownedPaths: ["docs"]
        )

        check(!P.conflictingTasks(for: ["docs/live"], among: [held]).isEmpty,
              "the registry refuses a boundary inside one already held")
        check(!P.conflictingTasks(for: ["docs"], among: [held]).isEmpty,
              "and refuses the identical boundary")
        check(P.conflictingTasks(for: ["rings/SR-00"], among: [held]).isEmpty,
              "a disjoint boundary is still allowed - this is parallel work")
        check(P.conflictingTasks(for: [], among: [held]).isEmpty,
              "delegating without a boundary is not blocked by this rule")

        // Terminal work owns nothing. Otherwise the first bee to finish would
        // hold its files against every bee after it, and the fleet would
        // deadlock on its own history.
        let done = DelegatedTask(
            issue: second, title: "live strip", worker: "queen-swift",
            state: .merged, ownedPaths: ["docs"]
        )
        check(P.conflictingTasks(for: ["docs/live"], among: [done]).isEmpty,
              "a finished task releases its boundary")

        // The two rules have to agree. Writing inside your own boundary stays
        // legal - fixing the clash must not make every nested write a stray.
        check(QueenObserver.outOfBoundsPaths(
                  in: QueenWorkerTranscript(),
                  ownedPaths: ["docs"],
                  observedWrites: ["docs/live/queen-live-strip.md"]
              ).isEmpty,
              "owning a directory still licenses writing beneath it")
        check(!QueenObserver.outOfBoundsPaths(
                  in: QueenWorkerTranscript(),
                  ownedPaths: ["docs/live"],
                  observedWrites: ["docs/queen-spec-header.md"]
              ).isEmpty,
              "but owning a subdirectory does not license writing the parent")
    }

    static func runPullRequestRefusals() async {
        print("\n# Scenario: when the Queen refuses to open a pull request")

        guard let issue = IssueReference.parse("gHashTag/trios#9") else {
            fail("could not build a test issue"); return
        }
        func task(
            _ state: DelegatedTaskState,
            branch: String? = "queen/9-probe",
            files: Int? = 3,
            pr: Int? = nil
        ) -> DelegatedTask {
            DelegatedTask(
                issue: issue, title: "probe", worker: "queen-swift", state: state,
                virtualBranch: branch, committedFiles: files, pullRequestNumber: pr
            )
        }
        typealias P = QueenDelegationPolicy

        check(P.pullRequestBlockReason(for: task(.awaitingReview)) == nil,
              "reviewed work with a branch and commits can be proposed")
        check(P.pullRequestBlockReason(for: task(.accepted)) == nil,
              "so can work the Queen already accepted")

        check(P.pullRequestBlockReason(for: task(.running)) != nil,
              "work still in progress is not proposed")
        check(P.pullRequestBlockReason(for: task(.queued)) != nil,
              "work that has not started is not proposed")
        check(P.pullRequestBlockReason(for: task(.rejected)) != nil,
              "work sent back and not redone is not proposed")
        check(P.pullRequestBlockReason(for: task(.cancelled)) != nil,
              "a closed task is not proposed")
        check(P.pullRequestBlockReason(for: task(.failed)) != nil,
              "a failed task is not proposed")

        check(P.pullRequestBlockReason(for: task(.accepted, branch: nil)) != nil,
              "no branch means there is nothing to propose")
        check(P.pullRequestBlockReason(for: task(.accepted, files: 0)) != nil,
              "a worker that committed nothing would open an empty pull request")
        check(P.pullRequestBlockReason(for: task(.accepted, pr: 12)) != nil,
              "a task that already has a pull request does not get a second one")

        // Unknown is not zero: a task from before commit counting existed has
        // nil files, and refusing those would block real work.
        check(P.pullRequestBlockReason(for: task(.accepted, files: nil)) == nil,
              "an unrecorded commit count is not treated as an empty branch")

        // The command has to reach the handler at all.
        check(QueenCommandParser.parse("/pr gHashTag/trios#9") == .openPullRequest(issue: issue),
              "/pr reaches the handler")
        check(QueenCommandParser.parse("/pull-request gHashTag/trios#9") == .openPullRequest(issue: issue),
              "and so does the long form")
        if case .unknown = QueenCommandParser.parse("/pr not-an-issue") {
            check(true, "a malformed issue is refused rather than guessed")
        } else {
            fail("a malformed issue is refused rather than guessed")
        }
    }

    static func runMergedIsNotTheSameAsClosed() async {
        print("\n# Scenario: merged and closed are different answers")

        func decode(_ json: String, _ label: String) -> GitHubPullRequest? {
            guard let pr = try? JSONDecoder().decode(GitHubPullRequest.self, from: Data(json.utf8)) else {
                fail("could not decode \(label)")
                return nil
            }
            return pr
        }

        let base = #""id":1,"number":7,"title":"t","html_url":"u","head":null,"base":null"#

        if let merged = decode("{\(base),\"state\":\"closed\",\"merged\":true,\"merged_at\":\"2026-07-30T00:00:00Z\"}", "a merged PR") {
            check(merged.isMerged, "a merged pull request reads as merged")
            check(!merged.isClosedUnmerged, "and is not mistaken for abandoned work")
        }

        if let abandoned = decode("{\(base),\"state\":\"closed\",\"merged\":false,\"merged_at\":null}", "a closed unmerged PR") {
            check(!abandoned.isMerged, "a closed pull request that never merged does not read as merged")
            check(abandoned.isClosedUnmerged, "it reads as abandoned, so the task can go back to the queue")
            check(abandoned.state == "closed", "even though its state is the same word as the merged one")
        }

        // List endpoints omit both fields. Absent must mean "nobody asked",
        // never "no" - guessing false here would archive nothing, guessing true
        // would archive everything.
        if let unasked = decode("{\(base),\"state\":\"open\"}", "a PR from a list endpoint") {
            check(!unasked.isMerged, "an open pull request has not merged")
            check(!unasked.isClosedUnmerged, "and an open one is not abandoned either")
        }

        // The trap this exists to close.
        if let merged = decode("{\(base),\"state\":\"closed\",\"merged\":true,\"merged_at\":null}", "merged without a timestamp"),
           let abandoned = decode("{\(base),\"state\":\"closed\",\"merged\":false,\"merged_at\":null}", "abandoned") {
            check(
                merged.isMerged != abandoned.isMerged,
                "two pull requests with identical state disagree about whether work landed"
            )
        }
    }

    static func runStalledWorkerIsResumedBeforeCancelled() async {
        print("\n# Scenario: a silent worker gets restarted, not written off")

        let store = NSTemporaryDirectory() + "queen-resume-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)

        guard let issue = IssueReference.parse("gHashTag/trios#1") else {
            fail("could not build a test issue"); return
        }
        guard let task = registry.delegate(
            issue: issue, title: "resume probe", worker: "queen-swift",
            conversationId: UUID(), ownedPaths: ["docs"]
        ) else {
            fail("registry refused a clean delegation"); return
        }
        check(registry.transition(taskID: task.id, to: .running), "the probe task is running")

        check(
            QueenDelegationPolicy.maxResumeAttempts >= 1,
            "silence is answered by at least one restart, not by giving up immediately"
        )
        // Stop here rather than build `1...0` below. A test that traps instead
        // of failing prints nothing, and "no FAIL lines" then reads as success -
        // which is how this very check nearly went unverified.
        guard QueenDelegationPolicy.maxResumeAttempts >= 1 else { return }

        // Count up to the budget and confirm each attempt is recorded.
        var attempt = 0
        for expected in 1...QueenDelegationPolicy.maxResumeAttempts {
            attempt = registry.recordResumeAttempt(taskID: task.id)
            check(attempt == expected, "restart \(expected) is counted")
        }
        check(
            registry.task(forIssue: issue)?.resumeAttempts == QueenDelegationPolicy.maxResumeAttempts,
            "the count survives on the task, so the next sweep knows how often this already happened"
        )

        // The bump is the load-bearing part: stalled() measures silence from
        // updatedAt, so a restart that did not touch it would be reaped again
        // immediately and the retry would accomplish nothing.
        check(
            registry.stalled(now: Date()).isEmpty,
            "a just-restarted worker is not immediately stale again"
        )
        check(
            !registry.stalled(now: Date().addingTimeInterval(QueenDelegationPolicy.stallThreshold + 60)).isEmpty,
            "and it does become stale again once the threshold passes"
        )

        // Still running: restarting must not quietly settle the task.
        check(
            registry.task(forIssue: issue)?.state == .running,
            "restarting leaves the task running rather than closing it"
        )
    }

    static func runQueenTaskLifecycleCloses() async {
        print("\n# Scenario: the delegation cycle closes")

        typealias P = QueenDelegationPolicy

        // The happy round trip.
        check(P.canTransition(from: .queued, to: .running), "a queued task can start")
        check(P.canTransition(from: .running, to: .awaitingReview), "work finishes into review")
        check(P.canTransition(from: .awaitingReview, to: .accepted), "review can accept")
        check(DelegatedTaskState.accepted.isArchivable, "accepted work leaves the open list")

        // Rejection sends it back rather than ending it, which is the whole
        // point of having a review step.
        check(P.canTransition(from: .awaitingReview, to: .rejected), "review can send work back")
        check(P.canTransition(from: .rejected, to: .running), "rejected work can be redone")
        check(!DelegatedTaskState.rejected.isArchivable, "rejected work stays open, it is not finished")

        // Failure is terminal only in the sense that the worker stopped. There
        // must still be a way out, or the swarm accumulates corpses.
        check(DelegatedTaskState.failed.isTerminal, "a failed worker is not still running")
        check(
            P.canTransition(from: .failed, to: .running) || P.canTransition(from: .failed, to: .cancelled),
            "a failed task can be retried or abandoned, so it is not stuck forever"
        )

        // Every state must be reachable out of, except the two that are
        // genuinely the end. Stated as a rule rather than a list, so adding a
        // state does not quietly add a dead end.
        for state in [DelegatedTaskState.queued, .running, .awaitingReview, .rejected, .failed] {
            let hasExit = DelegatedTaskState.allCases.contains { P.canTransition(from: state, to: $0) }
            check(hasExit, "\(state.rawValue) has somewhere to go")
        }
        check(
            DelegatedTaskState.accepted.isArchivable && DelegatedTaskState.cancelled.isArchivable,
            "the two end states are the two that archive"
        )

        // Backwards moves are refused. Re-running an accepted task would redo
        // work that was already signed off.
        check(!P.canTransition(from: .accepted, to: .running), "accepted work cannot silently restart")
        check(!P.canTransition(from: .queued, to: .accepted), "work cannot be accepted before it is done")
    }

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

        // CompactCount. A 580-character skill displayed as "0k chars", which
        // reads as an empty file rather than a short one - the same failure as
        // "$0.00" for a sub-cent spend.
        check(CompactCount.format(580) == "580", "a small count is shown exactly, not rounded to zero")
        check(CompactCount.format(0) == "0", "zero is zero")
        check(CompactCount.format(999) == "999", "the last value below the threshold stays exact")
        check(CompactCount.format(1000) == "1k", "the threshold itself abbreviates")
        check(CompactCount.format(12_500) == "12k", "a large count abbreviates")
        check(
            CompactCount.format(580, unit: "chars") == "580 chars",
            "the unit form follows the same rule"
        )

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

        // The rule that the Queen does not edit code existed twice: as prose
        // she reads, and as QueenDelegationPolicy.queenForbiddenTools, a named
        // list with tests and no caller anywhere in the application. Tested and
        // unenforced is the worst of the two states, because the test reads as
        // proof. The prompt now carries the list itself.
        for tool in QueenDelegationPolicy.queenForbiddenTools {
            check(allOn.contains(tool),
                  "the Queen is told by name that she may not call \(tool)")
        }
        check(allOn.contains("delegate rather than to reach for it"),
              "and told what to do instead, since a prohibition without an alternative invites a workaround")
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
        // The subjects fight the answer on purpose. This fixture used to name
        // the dead finding "a" and the fragile one "b", so the tie-break on
        // subject produced the same order as the severity rule and the
        // assertion passed with the severity rule deleted - a correct test that
        // its own data had made unable to fail. Naming them the other way round
        // means only severity can put dead first.
        let findings = [
            QueenSelfAudit.Finding(severity: .fragile, kind: "k", subject: "a",
                                   explanation: "e", proposal: "p"),
            QueenSelfAudit.Finding(severity: .unverified, kind: "k", subject: "m",
                                   explanation: "e", proposal: "p"),
            QueenSelfAudit.Finding(severity: .dead, kind: "k", subject: "z",
                                   explanation: "e", proposal: "p")
        ]
        let ranked = QueenSelfAudit.roadmap(from: findings)
        check(ranked.map(\.severity) == [.dead, .unverified, .fragile],
              "the whole roadmap is ordered by severity, not just its first entry")
        check(ranked.map(\.subject) == ["z", "m", "a"],
              "and severity beats the alphabet, which is the only way to tell the rule is there")
        // Ordering is not academic: options() hands the user the top three, so
        // whichever the rank puts first is what the Queen proposes.
        check(QueenEvolutionOptions.options(from: findings).map(\.subject) == ["z", "m", "a"],
              "the three options offered follow that same order")
        check(
            QueenSelfAudit.roadmap(from: [
                QueenSelfAudit.Finding(severity: .dead, kind: "k", subject: "b",
                                       explanation: "e", proposal: "p"),
                QueenSelfAudit.Finding(severity: .dead, kind: "k", subject: "a",
                                       explanation: "e", proposal: "p")
            ]).map(\.subject) == ["a", "b"],
            "and within one severity the subject decides, so the order is stable"
        )
        check(
            QueenSelfAudit.report(findings: [], now: Date())
                .contains("statement about my checks"),
            "an empty audit says so about itself rather than claiming health"
        )

        // The function half of the audit shells out, and a wrong path there
        // returns an empty string rather than an error - I shipped
        // "/usr/bin/sh" for a few minutes, which does not exist on macOS, and
        // the effect would have been an audit reporting no dead functions at
        // all. Silence that reads as health is the exact failure this file
        // exists to prevent, so the scan is required to find something.
        let counts = ChatViewModel.functionOccurrences(
            root: ProjectPaths.root,
            scopes: [
                "\(ProjectPaths.root)/rings/SR-00", "\(ProjectPaths.root)/rings/SR-01",
                "\(ProjectPaths.root)/rings/SR-02", "\(ProjectPaths.root)/BR-OUTPUT"
            ]
        )
        check(counts.count > 50, "the function scan finds the Queen's own methods, not nothing")

        // canRun(_:) was deleted this cycle, and what it would have destroyed
        // is worth holding: "there is no such skill" and "that skill is
        // switched off" are different problems with different fixes, and both
        // places that decide whether to run one say so differently. A single
        // Bool cannot. These two primitives are what the distinction rests on.
        let skillRoot = NSTemporaryDirectory() + "queen-skills-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: skillRoot) }
        try? FileManager.default.createDirectory(
            atPath: "\(skillRoot)/.claude/skills/probe", withIntermediateDirectories: true
        )
        try? "---\nname: probe\ndescription: A probe skill.\n---\nDo the thing."
            .write(toFile: "\(skillRoot)/.claude/skills/probe/SKILL.md", atomically: true, encoding: .utf8)
        let store = SkillStore(
            projectRoot: skillRoot, home: skillRoot,
            statePath: "\(skillRoot)/state.json"
        )
        check(store.skill(named: "/probe") != nil, "a skill on disk is found by name")
        check(store.skill(named: "/nothing-like-this") == nil,
              "and a name nobody installed is absent, which is one of the two answers")
        guard let probe = store.skill(named: "/probe") else {
            fail("the probe skill vanished between two lines"); return
        }
        check(store.isEnabled(probe), "a freshly discovered skill is on")
        store.setEnabled(false, for: probe)
        check(store.skill(named: "/probe") != nil && !store.isEnabled(probe),
              "and switching it off leaves it present but disabled - the other answer, and not the same one")

        // The safety budget guards every autonomous mutation and, until now,
        // nothing decremented it: QueenProposalApplier read it before touching
        // a file and there was no reachable way to spend it, so it sat at its
        // default forever. A budget that cannot run out is a switch painted on
        // the wall.
        let budgetRoot = NSTemporaryDirectory() + "queen-budget-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: budgetRoot) }
        try? FileManager.default.createDirectory(
            atPath: "\(budgetRoot)/.trinity/state", withIntermediateDirectories: true
        )
        let start = QueenSelfImprovementService.loadBudget(projectRoot: budgetRoot)?.budget ?? 0
        check(start > 0, "a fresh checkout starts with something to spend")
        let after = QueenSelfImprovementService.consumeBudget(amount: 1.0, projectRoot: budgetRoot)
        check(after?.budget == start - 1, "spending reduces it, rather than reporting a number nothing changed")
        check(
            QueenSelfImprovementService.loadBudget(projectRoot: budgetRoot)?.budget == start - 1,
            "and the reduction survives being read back, which is the only part the next run sees"
        )
        for _ in 0..<Int(start) { _ = QueenSelfImprovementService.consumeBudget(amount: 1.0, projectRoot: budgetRoot) }
        check(
            QueenSelfImprovementService.loadBudget(projectRoot: budgetRoot)?.isActive == false,
            "and it runs out, which is the whole point of having one"
        )
        check(
            QueenSelfImprovementService.consumeBudget(amount: 1.0, projectRoot: budgetRoot) == nil,
            "spending past empty refuses instead of going negative"
        )
        check(counts["ownershipRule"] ?? 0 >= 2,
              "and counts a method that is called, not only declared")
    }

    // MARK: - Scenario: the self-audit scanner actually matches

    /// The scanner behind `/roadmap` once matched nothing at all and reported a
    /// clean bill of health it had not earned - it looked for `func Queen...`,
    /// but Swift methods are named after what they do and only types carry the
    /// prefix. Zero declarations found means zero findings, which reads exactly
    /// like success.
    ///
    /// So the scanner is run against a known-bad input. A check nobody has seen
    /// fail is a check nobody should believe.
    static func runSelfAuditFindsPlantedDeadCode() async {
        print("\n# Scenario: self-audit finds planted dead code")

        let root = NSTemporaryDirectory() + "trios-audit-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: root) }
        let manager = FileManager.default
        for dir in ["rings/SR-00", "rings/SR-01", "rings/SR-02", "BR-OUTPUT"] {
            try? manager.createDirectory(
                atPath: "\(root)/\(dir)", withIntermediateDirectories: true
            )
        }

        // Declared once, called from nowhere.
        try? "enum QueenGhostService {\n    static let unused = 1\n}\n"
            .write(toFile: "\(root)/rings/SR-02/QueenGhostService.swift",
                   atomically: true, encoding: .utf8)

        // Declared once and genuinely used, so it must not be reported.
        try? "enum QueenLiveThing {\n    static let value = 1\n}\n"
            .write(toFile: "\(root)/rings/SR-00/QueenLiveThing.swift",
                   atomically: true, encoding: .utf8)
        try? "let x = QueenLiveThing.value\nlet y = QueenLiveThing.value\n"
            .write(toFile: "\(root)/BR-OUTPUT/Caller.swift",
                   atomically: true, encoding: .utf8)

        let findings = ChatViewModel.auditRepository(root: root)
        let subjects = Set(findings.map(\.subject))

        check(
            subjects.contains("QueenGhostService"),
            "the scanner finds a type nothing references"
        )
        check(
            !subjects.contains("QueenLiveThing"),
            "the scanner leaves a type that is actually used alone"
        )
        check(
            findings.first(where: { $0.subject == "QueenGhostService" })?.severity == .dead,
            "an unreferenced type is ranked dead, not merely noted"
        )

        // And the empty case must still read as a statement about the checks
        // rather than a clean bill of health.
        let emptyRoot = NSTemporaryDirectory() + "trios-audit-empty-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: emptyRoot) }
        try? manager.createDirectory(
            atPath: "\(emptyRoot)/rings/SR-00", withIntermediateDirectories: true
        )
        check(
            ChatViewModel.auditRepository(root: emptyRoot).isEmpty,
            "an empty tree yields no findings rather than erroring"
        )
    }

    // MARK: - Scenario: the branch committer, against a scratch repository

    /// This is the piece that touches git, so it is the piece where a mistake
    /// costs real work. It went untested for four cycles because its root was a
    /// constant; making that a parameter is what let it be pointed at a
    /// throwaway repository instead of the live checkout.
    static func runBranchCommitterAgainstScratchRepo() async {
        print("\n# Scenario: branch committer against a scratch repo")

        let root = NSTemporaryDirectory() + "trios-git-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: root) }
        try? FileManager.default.createDirectory(
            atPath: "\(root)/docs", withIntermediateDirectories: true
        )

        func git(_ args: [String]) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: root)
            p.standardOutput = Pipe()
            p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }
        git(["init", "-q", "-b", "main"])
        git(["config", "user.email", "t@example.com"])
        git(["config", "user.name", "T"])
        try? "seed\n".write(toFile: "\(root)/seed.txt", atomically: true, encoding: .utf8)
        git(["add", "-A"])
        git(["commit", "-q", "-m", "seed"])
        git(["branch", "queen/1-test"])

        let head = ProcessInfo.processInfo.environment["PATH"] // keep the compiler honest
        _ = head

        let baseline = await QueenBranchCommitter.snapshotWorkingTree(projectRoot: root)
        check(baseline != nil, "a baseline snapshot is taken from a clean tree")

        // The worker writes inside its boundary, and something else writes
        // outside it at the same time.
        try? "bee\n".write(toFile: "\(root)/docs/inside.md", atomically: true, encoding: .utf8)
        try? "not the bee\n".write(toFile: "\(root)/outside.md", atomically: true, encoding: .utf8)

        let outcome = await QueenBranchCommitter.commitWorkerChanges(
            branch: "queen/1-test",
            baselineTree: baseline,
            message: "queen: test",
            ownedPaths: ["docs"],
            projectRoot: root
        )
        check(outcome.committed, "the committer records the worker's file")
        check(outcome.fileCount == 1, "only the file inside the boundary is counted")
        check(
            outcome.summary.contains("docs/inside.md"),
            "the summary names what landed"
        )

        // HEAD must not have moved - that is the whole point of the design.
        let headBranch = Process()
        headBranch.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        headBranch.arguments = ["branch", "--show-current"]
        headBranch.currentDirectoryURL = URL(fileURLWithPath: root)
        let out = Pipe(); headBranch.standardOutput = out; headBranch.standardError = Pipe()
        try? headBranch.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        headBranch.waitUntilExit()
        let current = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        check(current == "main", "HEAD stays where it was; the branch moved, not the checkout")

        // The stray file outside the boundary must still be uncommitted.
        let status = Process()
        status.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        status.arguments = ["status", "--short"]
        status.currentDirectoryURL = URL(fileURLWithPath: root)
        let sOut = Pipe(); status.standardOutput = sOut; status.standardError = Pipe()
        try? status.run()
        let sData = sOut.fileHandleForReading.readDataToEndOfFile()
        status.waitUntilExit()
        let statusText = String(data: sData, encoding: .utf8) ?? ""
        check(
            statusText.contains("outside.md"),
            "a file outside the boundary is left in the working tree, not swept onto the branch"
        )

        // No baseline means refuse, rather than guess which edits were the bee's.
        let refused = await QueenBranchCommitter.commitWorkerChanges(
            branch: "queen/1-test", baselineTree: nil, message: "m",
            ownedPaths: ["docs"], projectRoot: root
        )
        check(!refused.committed, "without a baseline the committer refuses rather than guessing")
    }

    // MARK: - Scenario: the bee board reflects state transitions without a reload

    /// The bee board is the strip of cards at the top of the Queen's master
    /// chat. It shows one card per live task, grouped into "Working" and
    /// "Waiting on you" sections. When a task transitions state, the card's
    /// label changes and it may jump between sections.
    ///
    /// The board is a SwiftUI `View` backed by `QueenDelegationRegistry` via
    /// `@ObservedObject`. That contract has two halves: the registry must fire
    /// `objectWillChange` on every mutation (so the view knows to redraw), and
    /// the derived data the view reads must actually change (so the redraw
    /// shows something different). This test proves both halves against the
    /// model — the view layer itself is a framework guarantee once the model is
    /// correct.
    static func runBeeBoardReflectsStateChanges() async {
        print("\n# Scenario: the bee board reflects state transitions without a reload")

        let store = NSTemporaryDirectory() + "queen-bee-board-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)

        guard let issue = IssueReference.parse("gHashTag/trios#1098") else {
            fail("could not build the test issue"); return
        }

        let conversationId = UUID()
        guard let task = registry.delegate(
            issue: issue, title: "bee board live update",
            worker: "queen-swift", conversationId: conversationId,
            ownedPaths: ["BR-OUTPUT"]
        ) else {
            fail("registry refused a clean delegation"); return
        }

        // The task starts as queued. Move it to running so the board shows it
        // as quiet work — the "Working" section.
        check(registry.transition(taskID: task.id, to: .running),
              "the task enters running")

        // What the board draws: `registry.open` filtered by `needsQueenAttention`.
        // Tasks that do not need the Queen go in "Working"; those that do go in
        // "Waiting on you".
        let running = registry.open.first { $0.id == task.id }
        check(running != nil,
              "the running bee is visible in the master chat (registry.open)")
        check(running?.state.needsQueenAttention == false,
              "a running bee sits in the Working section, not Waiting")
        check(running?.state.displayName == "Working",
              "the card reads 'Working'")

        // Subscribe to the same publisher SwiftUI's @ObservedObject listens to.
        // If this does not fire, the board cannot know it needs to redraw —
        // which is exactly the bug "changes only after a reload" describes.
        var notifications = 0
        let subscription = registry.objectWillChange.sink { _ in notifications += 1 }
        defer { subscription.cancel() }
        let baseline = notifications

        // Drive the transition: running → awaitingReview.
        check(registry.transition(taskID: task.id, to: .awaitingReview),
              "the task moves to review")

        // Criterion 1 — the board changes without a reload. The registry must
        // fire objectWillChange so the @ObservedObject in QueenBeeBoard redraws.
        check(notifications > baseline,
              "the registry fires objectWillChange on transition, so the board redraws live")

        // Criterion 2 — the transition changes what is visible in the bee's card.
        let review = registry.open.first { $0.id == task.id }
        check(review?.state == .awaitingReview,
              "the bee's state is now awaitingReview")
        check(review?.state.needsQueenAttention == true,
              "the bee moved to the Waiting section — needsQueenAttention flipped")
        check(review?.state.displayName == "Needs review",
              "the card now reads 'Needs review', not 'Working'")

        // The board's two sections are derived by filtering `open` on the flag.
        // Prove the filter produces different results after the transition —
        // the card is in one section before and the other after.
        let waiting = registry.open.filter { $0.state.needsQueenAttention }
        let working = registry.open.filter { !$0.state.needsQueenAttention }
        check(waiting.contains(where: { $0.id == task.id }),
              "the Waiting section contains the bee after the transition")
        check(!working.contains(where: { $0.id == task.id }),
              "the Working section no longer contains the bee")

        // A second transition proves the board does not freeze after one update.
        // A registry that fires once and then stops would pass every check above
        // and still leave the board stale on the second change.
        //
        // The legal path back to "Working" runs through .rejected, so we take
        // two hops and assert each one. This also proves the card's text changes
        // on the intermediate hop — "Sent back" is neither "Working" nor "Needs
        // review", so it cannot be confused with either prior state.
        let baseline2 = notifications
        check(registry.transition(taskID: task.id, to: .rejected),
              "the Queen sends the work back")
        check(notifications > baseline2,
              "the second transition fires objectWillChange, so the board tracks every change, not just the first")
        let sent = registry.open.first { $0.id == task.id }
        check(sent?.state.displayName == "Sent back",
              "the card now reads 'Sent back' — a third label, proving the board did not freeze")
        check(sent?.state.needsQueenAttention == true,
              "rejected work still needs the Queen, so the card stays in the Waiting section")

        let baseline3 = notifications
        check(registry.transition(taskID: task.id, to: .running),
              "the bee returns to running after being sent back")
        check(notifications > baseline3,
              "the third transition also fires")
        let back = registry.open.first { $0.id == task.id }
        check(back?.state.needsQueenAttention == false,
              "the bee is back in the Working section after returning to running")
    }

    // MARK: - Dashboard entry/exit, card buttons, and empty state (#1118)

    /// Proves every acceptance criterion of #1118:
    ///
    /// 1. The dashboard opens from the compact panel via a visible action
    ///    (Open Dashboard) and closes back (Close Dashboard). The toggle is
    ///    in `FullscreenChatWorkspace.swift` — not just the bee board toggle
    ///    inside ChatPanelView, which was the mistake three previous bees made.
    /// 2. Each card button — open chat, accept, cancel — is driven through its
    ///    registry transition.
    /// 3. The empty state (no live tasks) is a calm message, not a broken box.
    /// 4. Removing the entry point from the source breaks a structural check,
    ///    so a screen that cannot be opened fails the suite instead of
    ///    silently disappearing. The check reads `FullscreenChatWorkspace.swift`
    ///    because that is where the entry point lives.
    static func runDashboardEntryExitCardButtonsAndEmptyState() async {
        print("\n# Scenario: dashboard opens and closes; card buttons are driven; empty state holds (#1118)")

        // --- Two source files, two roles ------------------------------------
        //
        // ChatPanelView.swift holds the bee board (card buttons, empty state).
        // FullscreenChatWorkspace.swift holds the dashboard toggle — the user-
        // facing entry and exit that makes the expanded layout reachable from
        // the compact panel. The previous three bees checked only
        // ChatPanelView.swift; the toggle there satisfied a plausible reading
        // of criterion 1 but was the wrong surface. #1118 is about the
        // dashboard, not the board.

        let panelSource = (try? String(
            contentsOfFile: "\(ProjectPaths.brOutput)/ChatPanelView.swift",
            encoding: .utf8
        )) ?? ""

        let workspaceSource = (try? String(
            contentsOfFile: "\(ProjectPaths.brOutput)/FullscreenChatWorkspace.swift",
            encoding: .utf8
        )) ?? ""

        check(!panelSource.isEmpty,
              "ChatPanelView.swift is readable — the card-button and empty-state checks have something to read")

        check(!workspaceSource.isEmpty,
              "FullscreenChatWorkspace.swift is readable — the dashboard entry/exit checks have something to read")

        // --- Criterion 1: dashboard opens and closes from the compact panel --
        //
        // Every check below counts occurrences rather than testing presence.
        // `.contains` passes when a symbol is *defined* but never *called* —
        // a dead property, a screen with no caller, a button that exists as
        // code but is never rendered. Counting uses catches the removal of
        // the call while leaving the definition intact, which is exactly the
        // failure #1118 guards. The threshold for each count is set to the
        // number of structurally necessary references: one for the
        // definition, one for each use that must exist for the feature to
        // work. Remove any use and the count drops below the threshold.

        let isExpandedCount = occurrences("isDashboardExpanded", in: workspaceSource)
        check(isExpandedCount >= 4,
              "criterion 1: isDashboardExpanded appears \(isExpandedCount) times (need ≥ 4: definition, body condition, open action, close action) — counting uses, not just strings")

        let openLabelCount = occurrences("\"Open Dashboard\"", in: workspaceSource)
        check(openLabelCount >= 2,
              "criterion 1: 'Open Dashboard' appears \(openLabelCount) times (need ≥ 2: button label + accessibility label) — counting uses, not just strings")

        let closeLabelCount = occurrences("\"Close Dashboard\"", in: workspaceSource)
        check(closeLabelCount >= 2,
              "criterion 1: 'Close Dashboard' appears \(closeLabelCount) times (need ≥ 2: help tooltip + accessibility label) — counting uses, not just strings")

        // The toggle must gate the layout switch in the body. If the condition
        // is removed, the expanded layout is unreachable from the compact
        // panel — back to the original bug.
        check(occurrences("!isDashboardExpanded", in: workspaceSource) >= 1,
              "criterion 1: the compact branch gates on !isDashboardExpanded — the toggle controls the layout")

        // --- Criterion 2: card buttons wired and driven ---------------------
        //
        // The bee board (QueenBeeBoard in ChatPanelView) has three actions:
        // tap to open the bee's chat, Accept, Cancel. Each calls
        // runQueenCommand with the task slug, which transitions the registry.
        //
        // The source checks below count occurrences (uses) rather than
        // testing presence (strings). A callback that is *declared* as a
        // parameter but never *connected* to a button passes `.contains`
        // because the declaration has the name. Counting requires the name
        // to appear in enough places — declaration, callback binding, button
        // action — that removing any one drops the count below threshold.
        // The registry transitions below those source checks are the real
        // proof: each button is driven through its state-machine transition,
        // not just checked for the existence of a handler.

        let onAcceptUses = occurrences("onAccept", in: panelSource)
        check(onAcceptUses >= 4,
              "onAccept appears \(onAcceptUses) times (need ≥ 4: QueenBeeBoard parameter, callback binding, BeeCard parameter, button action) — wiring is used, not just defined")
        let onCancelUses = occurrences("onCancel", in: panelSource)
        check(onCancelUses >= 4,
              "onCancel appears \(onCancelUses) times (need ≥ 4: QueenBeeBoard parameter, callback binding, BeeCard parameter, button action) — wiring is used, not just defined")
        check(occurrences("/accept", in: panelSource) >= 1,
              "the Accept button issues a /accept command")
        check(occurrences("/cancel", in: panelSource) >= 1,
              "the Cancel button issues a /cancel command")
        let onSelectBeeUses = occurrences("onSelectBee", in: panelSource)
        check(onSelectBeeUses >= 3,
              "onSelectBee appears \(onSelectBeeUses) times (need ≥ 3: QueenBeeBoard parameter, callback binding, card tap) — wiring is used, not just defined")

        // --- Registry-level proof: drive each button ------------------------
        //
        // The buttons call viewModel.runQueenCommand("/accept slug") etc.,
        // which transitions the task in the registry. We prove each button by
        // driving the same transition and asserting the result — a run, not a
        // handler existence check.

        let store = NSTemporaryDirectory() + "queen-1118-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)

        guard let issue = IssueReference.parse("gHashTag/trios#1118") else {
            fail("could not parse gHashTag/trios#1118"); return
        }

        let convId = UUID()
        guard let task = registry.delegate(
            issue: issue, title: "dashboard entry/exit test",
            worker: "queen-swift", conversationId: convId,
            ownedPaths: ["BR-OUTPUT"]
        ) else {
            fail("registry refused a clean delegation for #1118"); return
        }

        // -- Open chat button ------------------------------------------------
        // The card's onTap calls onSelectBee(task.conversationId). Prove the
        // conversation ID is the right one.
        check(task.conversationId == convId,
              "the open-chat callback uses the task's own conversation ID")

        // -- Accept button ---------------------------------------------------
        // Path: queued → running → awaitingReview → accepted.
        // The Accept button is visible when state.needsQueenAttention is true,
        // which is the case for awaitingReview.
        check(registry.transition(taskID: task.id, to: .running),
              "the task enters running (worker starts)")
        check(registry.transition(taskID: task.id, to: .awaitingReview),
              "the worker reports back — Accept button is now visible")

        let reviewTask = registry.tasks.first { $0.id == task.id }
        check(reviewTask?.state.needsQueenAttention == true,
              "awaitingReview makes needsQueenAttention true, so the Accept button appears")

        check(registry.transition(taskID: task.id, to: .accepted),
              "Accept fires: the task moves to accepted")

        let acceptedTask = registry.tasks.first { $0.id == task.id }
        check(acceptedTask?.state == .accepted,
              "the task is .accepted after the Accept button's command runs")
        check(acceptedTask?.isSettled == true,
              "an accepted task (no PR) is settled and leaves the live board")

        // -- Cancel button ---------------------------------------------------
        // Path: delegate a fresh task → running → cancelled.
        // The Cancel button is visible when state == .running.
        let cancelIssue = IssueReference(owner: "gHashTag", repo: "trios", number: 1119)
        let cancelConv = UUID()
        guard let cancelTask = registry.delegate(
            issue: cancelIssue, title: "cancel test",
            worker: "queen-swift", conversationId: cancelConv,
            ownedPaths: ["BR-OUTPUT"]
        ) else {
            fail("registry refused a clean delegation for #1119"); return
        }

        check(registry.transition(taskID: cancelTask.id, to: .running),
              "the second task enters running — Cancel button is now visible")

        let runningTask = registry.tasks.first { $0.id == cancelTask.id }
        check(runningTask?.state == .running,
              "the task is running, so the Cancel button appears")

        check(registry.transition(taskID: cancelTask.id, to: .cancelled),
              "Cancel fires: the task moves to cancelled")

        let cancelledTask = registry.tasks.first { $0.id == cancelTask.id }
        check(cancelledTask?.state == .cancelled,
              "the task is .cancelled after the Cancel button's command runs")
        check(cancelledTask?.isSettled == true,
              "a cancelled task is settled and leaves the live board")
        check(!registry.open.contains(where: { $0.id == cancelTask.id }),
              "the cancelled task no longer appears in registry.open — it left the board")

        // --- Criterion 3: empty state is calm, not broken --------------------
        //
        // A registry with no open tasks must present gracefully, not crash or
        // show a broken box.

        let emptyStore = NSTemporaryDirectory() + "queen-empty-1118-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: emptyStore) }
        let emptyRegistry = QueenDelegationRegistry(storePath: emptyStore)

        check(emptyRegistry.open.isEmpty,
              "a fresh registry has no open tasks — empty state applies")
        check(emptyRegistry.running.isEmpty,
              "a fresh registry has no running tasks")
        check(emptyRegistry.reviewQueue.isEmpty,
              "a fresh registry has nothing awaiting review")
        check(emptyRegistry.active.isEmpty,
              "a fresh registry has no active tasks")

        check(occurrences("No bees in flight", in: panelSource) >= 1,
              "the board shows a calm empty-state message when the swarm is idle")
        check(occurrences("emptyMessage", in: panelSource) >= 2,
              "the empty state is its own named view, referenced and defined — not an accidental gap")
        check(occurrences("moon.zzz", in: panelSource) >= 1,
              "the empty state has an icon (moon.zzz) — it looks intentional, not broken")

        // --- Criterion 4: a screen with no caller must break the test --------
        //
        // The dashboard entry point lives in FullscreenChatWorkspace.swift.
        // If isDashboardExpanded is removed, the "Open Dashboard" button is
        // removed, or the ExpandedChatWorkspace constructor stops receiving the
        // binding, the expanded layout becomes unreachable from the compact
        // panel — the exact shape criterion 4 describes: "a screen that opens
        // from nowhere must fail the test, not silently disappear."
        //
        // Every guard below uses `occurrences` (counting uses) rather than
        // `.contains` (testing string presence). The distinction matters for
        // `dashboardToggleButton`: it is both a *definition* (the computed
        // property) and a *call* (the reference in the compact panel's body).
        // `.contains("dashboardToggleButton")` passes if the definition
        // remains but the body reference is deleted — the button exists as
        // dead code and the dashboard is unreachable, yet the test is green.
        // Counting ≥ 2 (definition + call) fails when the call is removed,
        // because the definition alone leaves only one occurrence.

        let toggleUses = occurrences("isDashboardExpanded", in: workspaceSource)
        check(toggleUses >= 4,
              "criterion 4: isDashboardExpanded appears \(toggleUses) times (need ≥ 4: definition, body condition, open action, close action) — removing the toggle or any critical use breaks the test")

        // The key guard: dashboardToggleButton must be *called* from the body,
        // not just *defined*. Two occurrences = definition + body reference.
        // Remove the body reference and the count drops to 1 — the test fails.
        let toggleBtnUses = occurrences("dashboardToggleButton", in: workspaceSource)
        check(toggleBtnUses >= 2,
              "criterion 4: dashboardToggleButton appears \(toggleBtnUses) times (need ≥ 2: definition + body reference) — removing the call from the compact body breaks the test")

        // `ExpandedChatWorkspace(` (with open paren) only appears at the
        // constructor call site in the body. If the call is removed, the
        // expanded view is defined but never shown — a screen with no caller.
        check(occurrences("ExpandedChatWorkspace(", in: workspaceSource) >= 1,
              "criterion 4: ExpandedChatWorkspace is instantiated — the expanded layout renders, not just exists")

        // The binding must be passed to the expanded view, so the "Close
        // Dashboard" button inside it can toggle it back. Without the binding,
        // the dashboard opens but cannot close.
        check(occurrences("isDashboardExpanded: $isDashboardExpanded", in: workspaceSource) >= 1,
              "criterion 4: the toggle binding is passed to ExpandedChatWorkspace — the way out works")

        // If "Open Dashboard" is removed, the compact panel has no visible
        // entry point — the screen is unreachable. Counting ≥ 2 requires both
        // the Text label and the accessibility label; removing either one
        // weakens the entry point and drops the count below threshold.
        check(openLabelCount >= 2,
              "criterion 4: 'Open Dashboard' appears \(openLabelCount) times (need ≥ 2: label + a11y) — removing the entry button text breaks the test")

        // If "Close Dashboard" is removed, the expanded view has no visible
        // exit — the user is trapped.
        check(closeLabelCount >= 2,
              "criterion 4: 'Close Dashboard' appears \(closeLabelCount) times (need ≥ 2: help + a11y) — removing the exit button text breaks the test")
    }

    /// A verdict whose number is wrapped in markdown is still recognised,
    /// without the parser becoming willing to guess.
    ///
    /// The reviewer agent formats its response in markdown — bold numbers
    /// (`**1.`), bullet lists (`- 1.`), checkboxes (`[x] 1.`) — and the
    /// parser's number-matching strategy must see through the decoration
    /// to the number underneath. But seeing through decoration must not
    /// become seeing verdicts that are not there: a line with a number
    /// and no keyword stays absent, decorated or not.
    static func runVerdictParserHandlesMarkdownNumbers() async {
        print("\n# Scenario: a verdict whose number is wrapped in markdown is still recognised")

        // Criterion 3: a real reviewer response, captured verbatim from a
        // live delegation (#1105), not invented. The reviewer wrapped each
        // verdict keyword in bold markdown. Four criteria, four verdicts —
        // the parser must return all four. This response already parses
        // with bare numbers; it guards against regression while the
        // decoration tests below guard the new code path.
        let criteria = [
            "the interval comes from configuration",
            "the report is prose not a table",
            "each proposal says why",
            "an unchanged hive suppresses the report"
        ]
        let realResponse = """
        1. **met** — `reportingIntervalSeconds` defaults to `30 * 60` (1800 s), is `@Published` so callers can change it before `start()`, and `startReportLoop()` launches a `Task` that sleeps on that interval and calls `walkRegistryAndReport()`, which posts to the Queen chat via `appendQueenSystemMessage`.

        2. **met** — The report is composed as prose ("I checked the hive at…", "I have a proposal for the repository: …"), not a table; it calls out what moved (swarm digest), what stalled (`stallParagraph`), and what she proposes (`proposalsDigest`).

        3. **met** — `proposalsDigest` includes `p.rationale` (the "why") alongside the target file, and the surrounding doc comments explicitly frame the paragraph as explaining reasoning, not just listing facts.

        4. **met** — `registrySignature` builds a fingerprint of task slug+state, proposal id+status, and rounded spend; when it matches `lastReportSignature`, the Queen posts a single line ("Nothing has changed since my last look — all quiet.") and returns early instead of repeating the full report.
        """
        let parsed = QueenReviewVerdictRequest.parse(realResponse, criteria: criteria)
        check(parsed.count == 4,
              "all four verdicts parsed from the real response (\(parsed.count) of 4)")
        for criterion in criteria {
            check(parsed[criterion] == .met,
                  "and '\(criterion)' is met, not left unchecked")
        }

        // Criterion 1: the number prefix may be wrapped in markdown —
        // **1., [x] 1., - 1. — and the verdict must still be recognised.
        // Each line carries the keyword "met" so the only thing that can
        // fail is the number-matching strategy.
        let singleCriterion = ["the only criterion"]
        for decoration in ["**1.", "1.", "[x] 1.", "- 1."] {
            let single = QueenReviewVerdictRequest.parse(
                "\(decoration) met — explanation",
                criteria: singleCriterion
            )
            check(single["the only criterion"] == .met,
                  "a verdict prefixed '\(decoration)' is recognised")
        }

        // Criterion 2: a line with the number but no verdict keyword must
        // not produce a verdict. Lenience to decoration must not become a
        // willingness to guess. [x] is excluded because it is itself a
        // verdict marker; the others carry no verdict meaning.
        let twoCriteria = ["first criterion", "second criterion"]
        for decoration in ["**2.", "2.", "- 2."] {
            let noKeyword = QueenReviewVerdictRequest.parse(
                "\(decoration) I looked at this and it seems fine",
                criteria: twoCriteria
            )
            check(noKeyword["second criterion"] == nil,
                  "a '\(decoration)' line with no verdict keyword stays absent, not guessed")
        }

        // Criterion 4 is implicit: removing the markdown-decoration
        // stripping from lineStartsWithNumber breaks the **1. and - 1.
        // checks above. The bare 1. and [x] 1. checks survive without
        // the fix, which is why only the decorated variants are the
        // guard — they are the ones that fail when support is removed.
    }

    // MARK: - Scenario: a verdict judged against one tree state is stale against another

    /// A verdict carries the fingerprint of the code tree it was checked against,
    /// and acceptance treats that fingerprint as load-bearing: a verdict carved
    /// against yesterday's tree is not "met" today, and it is not "unchecked"
    /// either — it was looked at, but the code moved. Collapsing stale into
    /// either neighbour is how work gets accepted on a glance or sent back to
    /// a reviewer who already settled it. #1126.
    ///
    /// The four criteria this scenario proves:
    ///
    /// 1. A verdict carries the state it was derived against.
    /// 2. Acceptance rejects a verdict against a different state and names it
    ///    separately from one that was never checked.
    /// 3. A re-review after changes does not silently inherit old verdicts.
    /// 4. The check breaks if the state binding is stripped.
    static func runVerdictCarriesTreeState() async {
        print("\n# Scenario: a verdict judged against one tree state reads stale against another")

        typealias P = QueenAcceptancePolicy
        let criterion = "the tab paginates under load"

        // --- Criterion 1: the verdict carries the state it was judged against.
        //
        // The DelegatedTask stores a treeStateFingerprint at review time, and
        // the acceptance policy threads it through as verdictTreeState. When
        // that state matches the current tree, a met verdict reads met — the
        // binding is present and agrees, so there is nothing to invalidate.
        let task = DelegatedTask(
            issue: IssueReference(owner: "gHashTag", repo: "trios", number: 1126),
            title: "probe", worker: "queen-swift",
            acceptanceCriteria: [criterion],
            criterionVerdicts: [criterion: .met],
            treeStateFingerprint: "tree-v1"
        )
        check(task.treeStateFingerprint == "tree-v1",
              "a task carries the tree state fingerprint its verdicts were derived against")
        let same = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: task.treeStateFingerprint,
            currentTreeState: "tree-v1"
        )
        check(same.first?.verdict == .met,
              "a verdict checked against the current tree reads met, not stale")

        // --- Criterion 2: acceptance rejects a verdict against a different
        // state, and names it separately from unchecked.
        //
        // "Checked against different code" is a different instruction from
        // "never checked": the first asks the reviewer to re-examine something
        // they already looked at; the second asks them to look for the first
        // time. Collapsing them wastes the reviewer's attention on the wrong
        // question.
        let staleRow = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: "tree-v1",
            currentTreeState: "tree-v2"
        )
        check(staleRow.first?.verdict == .stale,
              "a verdict checked against a different tree reads stale, not met")

        let staleReason = P.acceptanceBlockReason(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: "tree-v1",
            currentTreeState: "tree-v2"
        )
        check(staleReason != nil,
              "a stale verdict blocks acceptance — it is not a pass")
        check(staleReason?.contains("different code") == true,
              "the reason says it was checked against different code")
        check(staleReason?.contains("never checked") == false,
              "and does not call it unchecked, which is a different instruction")

        // The contrast: a criterion nobody answered has its own message.
        let uncheckedReason = P.acceptanceBlockReason(
            criteria: [criterion],
            recorded: [:]
        )
        check(uncheckedReason?.contains("never checked") == true,
              "an unanswered criterion is named as never checked")
        check(uncheckedReason?.contains("different code") == false,
              "and that message is not the stale one")

        // --- Criterion 3: a re-review after changes does not silently
        // inherit old verdicts.
        //
        // When the tree moves from v1 to v2, every verdict carved against v1
        // goes stale. The acceptance gate blocks and says so — the reviewer
        // is told which criteria need re-checking, not left to assume the
        // old verdicts still hold. This is what stops a re-review from
        // rubber-stamping yesterday's verdict onto today's code.
        let multiCriteria = ["builds cleanly", "the tab paginates", "no warnings"]
        let afterChange = P.verdicts(
            criteria: multiCriteria,
            recorded: ["builds cleanly": .met, "the tab paginates": .unmet, "no warnings": .met],
            verdictTreeState: "tree-v1",
            currentTreeState: "tree-v2"
        )
        check(afterChange.allSatisfy { $0.verdict == .stale },
              "every checked verdict goes stale when the tree state changes — none are silently inherited")
        let reReviewReason = P.acceptanceBlockReason(
            criteria: multiCriteria,
            recorded: ["builds cleanly": .met, "the tab paginates": .unmet, "no warnings": .met],
            verdictTreeState: "tree-v1",
            currentTreeState: "tree-v2"
        )
        check(reReviewReason != nil,
              "a re-review that inherits stale verdicts cannot pass")
        // The table renders stale verdicts with [~], so the staleness is
        // visible to the reviewer — not hidden behind a pass that reads as
        // current.
        let staleTable = P.table(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: "tree-v1",
            currentTreeState: "tree-v2"
        )
        check(staleTable.contains("[~]"),
              "a stale verdict is rendered with [~] in the review table, so it is visible, not silent")

        // --- Criterion 4: the check breaks if the state binding is removed.
        //
        // When currentTreeState is known but verdictTreeState is nil — the
        // binding was stripped, or the task predates state tracking — the
        // verdict is stale. This is what keeps the binding load-bearing: if
        // you remove treeStateFingerprint, the acceptance gate stops trusting
        // the verdict and blocks, instead of silently treating it as current.
        // The test fails if isStale ever returns false for a nil binding
        // against a known current state.
        let stripped = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: nil,
            currentTreeState: "tree-v1"
        )
        check(stripped.first?.verdict == .stale,
              "a verdict whose state binding was stripped is stale when the current state is known")
        check(P.acceptanceBlockReason(
                criteria: [criterion],
                recorded: [criterion: .met],
                verdictTreeState: nil,
                currentTreeState: "tree-v1"
              ) != nil,
              "removing the state binding causes acceptance to block — the binding is load-bearing")

        // Backward compatibility: when neither state is tracked, the
        // function behaves as it did before #1126. Old callers that never
        // heard of tree states are left alone — no verdict is marked stale.
        let noTracking = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: nil,
            currentTreeState: nil
        )
        check(noTracking.first?.verdict == .met,
              "without state tracking, the old behaviour is preserved — no verdict is marked stale")
    }

    // MARK: - Scenario: the interface-drift guard catches a signature mismatch

    /// `QueenBranchCommitter.verifyCombinedBuild` is the gate that catches
    /// interface drift: when one lane changes a function's signature and
    /// another lane's caller was written against the old one, each branch
    /// compiles in isolation but the combined tree does not.
    ///
    /// This scenario builds a minimal Swift package in a scratch repository,
    /// creates two divergent branches, and proves the guard fails the
    /// combined build. A third branch with a compatible change is accepted,
    /// so the guard is proven to discriminate — not just always refuse.
    /// #1111.
    static func runInterfaceDriftGuardCatchesSignatureMismatch() async {
        print("\n# Scenario: the interface-drift guard catches a signature mismatch")

        // --- Fast-path guard (#1125) ---
        // This scenario invokes the Swift compiler, so it must only run under
        // the explicit slow target (make drift-guard, which sets
        // TRIOS_RUN_DRIFT_GUARD).  If it runs in the fast suite without that
        // flag the proof was put back silently — "a bit slower today" instead
        // of a failure the next day.  Fail loudly so the regression is
        // visible, not gradual.
        guard ProcessInfo.processInfo.environment["TRIOS_RUN_DRIFT_GUARD"] != nil else {
            fail("the interface-drift proof ran in the fast suite; it belongs in 'make drift-guard', not run_chat_sse_e2e.sh (#1125)")
            return
        }

        let root = NSTemporaryDirectory() + "trios-drift-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: root) }

        func git(_ args: [String]) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: root)
            p.standardOutput = Pipe()
            p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }

        func writeFile(_ relativePath: String, _ content: String) {
            let fullPath = "\(root)/\(relativePath)"
            let dir = (fullPath as NSString).deletingLastPathComponent
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            try? content.write(toFile: fullPath, atomically: true, encoding: .utf8)
        }

        // --- Base: a minimal Swift package that compiles ---
        git(["init", "-q", "-b", "main"])
        git(["config", "user.email", "drift@example.com"])
        git(["config", "user.name", "Drift Test"])

        writeFile("Package.swift", """
            // swift-tools-version: 5.9
            import PackageDescription

            let package = Package(
                name: "DriftTest",
                targets: [
                    .target(name: "Lib", path: "Sources/Lib"),
                    .target(name: "App", dependencies: ["Lib"], path: "Sources/App"),
                ]
            )
            """)

        writeFile("Sources/Lib/Lib.swift", """
            public func greet(_ name: String) -> String {
                return "Hello, \\(name)!"
            }
            """)

        writeFile("Sources/App/App.swift", """
            import Lib

            public func runApp() -> String {
                return greet("world")
            }
            """)

        git(["add", "-A"])
        git(["commit", "-q", "-m", "base"])

        // --- Lane A: change the function signature (and update its own
        // caller so the branch compiles in isolation). ---
        git(["checkout", "-q", "-b", "queen/drift-signature"])

        writeFile("Sources/Lib/Lib.swift", """
            public func greet(_ name: String, _ greeting: String) -> String {
                return "\\(greeting), \\(name)!"
            }
            """)

        writeFile("Sources/App/App.swift", """
            import Lib

            public func runApp() -> String {
                return greet("world", "Hello")
            }
            """)

        git(["add", "-A"])
        git(["commit", "-q", "-m", "change signature"])
        git(["checkout", "-q", "main"])

        // --- Lane B: add a new caller using the old, single-argument
        // signature. This branch compiles against the base, but the call
        // is stale once Lane A's two-parameter signature is overlaid. ---
        git(["checkout", "-q", "-b", "queen/drift-caller"])

        writeFile("Sources/App/Caller.swift", """
            import Lib

            public func callGreet() -> String {
                return greet("world")
            }
            """)

        git(["add", "-A"])
        git(["commit", "-q", "-m", "add caller with old signature"])
        git(["checkout", "-q", "main"])

        // --- Drive the guard: the combined tree must not build. ---
        // Criterion 1: a signature change in one lane and a stale caller
        // in another leave the combined tree non-compiling, and the guard
        // says so rather than letting the broken tree land silently.
        let driftResult = await QueenBranchCommitter.verifyCombinedBuild(
            branches: ["queen/drift-signature", "queen/drift-caller"],
            baseRef: "main",
            projectRoot: root
        )
        check(driftResult.combinedTreeSha != nil,
              "the combined tree is assembled before the build is judged")
        check(!driftResult.builds,
              "the drift guard fails a combined tree whose signature and caller disagree")
        check(driftResult.summary.contains("FAILED"),
              "the drift summary reports the build failure, not just a boolean")

        // --- Criterion 2: the guard must discriminate, not always refuse.
        // A branch whose change is compatible with the base must still be
        // accepted. If this passes while the drift case fails, removing
        // the build step from verifyCombinedBuild (the "former behaviour")
        // breaks both: the drift case wrongly returns true, and this case
        // still passes — but the drift check catches the lie. ---
        git(["checkout", "-q", "-b", "queen/drift-compatible"])

        writeFile("Sources/App/Helper.swift", """
            import Lib

            public func helper() -> String {
                return greet("helper")
            }
            """)

        git(["add", "-A"])
        git(["commit", "-q", "-m", "add compatible helper"])
        git(["checkout", "-q", "main"])

        let okResult = await QueenBranchCommitter.verifyCombinedBuild(
            branches: ["queen/drift-compatible"],
            baseRef: "main",
            projectRoot: root
        )
        check(okResult.builds,
              "a compatible change is accepted by the drift guard")
    }
}
