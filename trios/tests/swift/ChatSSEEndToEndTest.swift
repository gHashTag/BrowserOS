// SSE End-to-End integration tests for ChatViewModel.
//
// Run with:
//   bash tests/swift/run_chat_sse_e2e.sh
//
// Exits non-zero on the first failed assertion.

import Foundation
import SwiftUI

/// A transport that replays a fixed sequence of SSE events on every call and
/// counts how many times `sendMessage` was invoked. Used to feed the reviewer
/// agent a controlled response — empty or otherwise — while tracking the retry
/// count (#1117).
actor CountingScriptedTransport: ChatTransportProtocol {
    private(set) var sendCount = 0
    private let events: [SSEEvent]

    init(events: [SSEEvent]) {
        self.events = events
    }

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        sendCount += 1
        let toYield = events
        return AsyncStream { continuation in
            for event in toYield {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    func cancel() async {}
}

@main
@MainActor
struct ChatSSEEndToEndTests {
    static var failures = 0
    static var checksRun = 0
    static let testFingerprintKey = Data(repeating: 0x5A, count: 32)

    // MARK: - Coverage floor
    //
    // "No failures" is not evidence of coverage. Delete half the bodies below
    // and this suite still prints that everything passed, because zero
    // assertions cannot fail - the same shape as a scanner that matches
    // nothing, one level up, guarding the loop rather than the code.
    //
    // The floor used to be one hand-written integer, and its comment claimed
    // it was "set just under the current count" while it was set AT it: 718
    // checks, floor 718, zero slack in either direction. Every added check
    // needed the constant edited in the same commit, and every honest failure
    // that lost a check tripped the floor instead of reporting the failure.
    // A floor that must be re-typed on every change is a floor that is wrong
    // most of the time.
    //
    // So the number is derived instead. Each scenario is run through the
    // `scenarios` table below, its checks are counted separately, and the
    // per-scenario counts plus the total are recorded in a JSON file on every
    // passing run. The next run compares itself against that record with a
    // small tolerance: adding checks is free, losing a handful is free, losing
    // a scenario or twenty checks is not - and the message names the scenario
    // rather than only the arithmetic.

    /// Absolute floor for machines that have no recorded baseline yet (a fresh
    /// clone, a sandbox with a read-only tree, the first run after a reset).
    ///
    /// This is the only hand-set number left, and it never has to be raised
    /// for correctness: it is a lower bound, so coverage growing can only make
    /// it looser. It exists so a checkout with no history still refuses a
    /// suite that lost twenty checks.
    static let seedFloor = 700

    /// How many checks the tracked total may lose before the floor trips.
    ///
    /// Small on purpose: "a sudden loss of twenty trips it, adding three does
    /// not". Losses concentrated in one scenario are caught by name well below
    /// this, by `scenarioSlack`.
    static let totalSlack = 10

    /// How many checks one scenario may lose before it is named.
    static func scenarioSlack(forBaseline baseline: Int) -> Int {
        max(3, baseline / 4)
    }

    /// The recorded high-water mark. High-water rather than last-seen so the
    /// floor cannot be eroded a few checks at a time across many green runs.
    struct CoverageBaseline: Codable {
        var version: Int
        var total: Int
        var scenarios: [String: Int]
    }

    static let coverageBaselineVersion = 1

    /// Where the recorded baseline lives.
    ///
    /// Derived from `#filePath`, not from the working directory: `make
    /// mutants` and the shake loop invoke the runner from wherever they
    /// happen to stand, and a cwd-derived path would quietly seed a fresh
    /// (empty, therefore toothless) baseline in each of them. `.trinity-test/`
    /// is gitignored, so this is per-checkout state, not a tracked artifact.
    static var coverageBaselinePath: String {
        URL(fileURLWithPath: #filePath)              // tests/swift/ChatSSEEndToEndTest.swift
            .deletingLastPathComponent()             // tests/swift
            .deletingLastPathComponent()             // tests
            .deletingLastPathComponent()             // repository root
            .appendingPathComponent(".trinity-test/chat_sse_coverage.json")
            .path
    }

    /// Set `TRIOS_E2E_COVERAGE_RESET=1` for one run to accept the current
    /// counts as the new baseline. Lowering the floor stays a decision someone
    /// makes on purpose, which is the entire point - it is just no longer the
    /// same decision as "I added a test".
    static var coverageResetRequested: Bool {
        ProcessInfo.processInfo.environment["TRIOS_E2E_COVERAGE_RESET"] != nil
    }

    static func loadCoverageBaseline() -> CoverageBaseline? {
        guard !coverageResetRequested,
              let data = FileManager.default.contents(atPath: coverageBaselinePath),
              let decoded = try? JSONDecoder().decode(CoverageBaseline.self, from: data),
              decoded.version == coverageBaselineVersion
        else { return nil }
        return decoded
    }

    /// Everything wrong with this run's coverage, in the order a reader wants
    /// it: which scenario vanished, which one shrank, then the total.
    static func coverageViolations(
        observed: [(name: String, checks: Int)],
        baseline: CoverageBaseline?
    ) -> [String] {
        let trackedTotal = observed.reduce(0) { $0 + $1.checks }
        // A name listed twice in the table is one scenario run twice; sum it,
        // so the comparison is against the same quantity that was recorded.
        let counts = Dictionary(observed.map { ($0.name, $0.checks) }, uniquingKeysWith: +)
        var violations: [String] = []

        if let baseline {
            for name in baseline.scenarios.keys.sorted() {
                let was = baseline.scenarios[name] ?? 0
                guard let now = counts[name] else {
                    violations.append("scenario \(name) is in the baseline (\(was) checks) but did not run at all")
                    continue
                }
                // A scenario that used to assert something and now asserts
                // nothing is gone, whatever the slack arithmetic says. The
                // smallest scenarios here record one or two checks, so the
                // minimum slack of 3 gives them a negative floor: their bodies
                // could be emptied one at a time, several of them, and still
                // stay inside the total slack. Never let the floor fall below
                // "ran at all".
                let allowed = was > 0 ? max(1, was - scenarioSlack(forBaseline: was)) : 0
                if now < allowed {
                    violations.append("scenario \(name) ran \(now) checks, baseline \(was), floor \(allowed)")
                }
            }
            let totalFloor = baseline.total - totalSlack
            if trackedTotal < totalFloor {
                violations.append("only \(trackedTotal) tracked checks ran, floor \(totalFloor) (baseline \(baseline.total) - slack \(totalSlack))")
            }
        }

        // The seed applies with or without a baseline: a truncated or hand-
        // edited record must not be able to talk the floor down to nothing.
        if trackedTotal < seedFloor {
            violations.append("only \(trackedTotal) tracked checks ran, seed floor \(seedFloor)")
        }
        return violations
    }

    /// Records the high-water counts after a green run. Best effort: a tree
    /// that cannot be written to still runs the suite, it just falls back to
    /// the seed floor next time - and says so, rather than degrading silently.
    /// Returns whether the record was written.
    @discardableResult
    static func recordCoverageBaseline(
        observed: [(name: String, checks: Int)],
        previous: CoverageBaseline?
    ) -> Bool {
        var scenarios = previous?.scenarios ?? [:]
        for entry in observed {
            scenarios[entry.name] = max(scenarios[entry.name] ?? 0, entry.checks)
        }
        let trackedTotal = observed.reduce(0) { $0 + $1.checks }
        let updated = CoverageBaseline(
            version: coverageBaselineVersion,
            total: max(previous?.total ?? 0, trackedTotal),
            scenarios: scenarios
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(updated) else { return false }
        let path = coverageBaselinePath
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        // Atomic: two runners sharing a checkout must never read half a file.
        do {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            return true
        } catch {
            return false
        }
    }

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
        // A check that ran and failed still RAN. Counting it only as a failure
        // made a caught mutation *lower* checksRun, which tripped the coverage
        // floor before the failure summary was ever printed - so the suite said
        // "only 717 checks ran" instead of "1 of 718 test(s) failed", and the
        // mutation harness read that as "the suite never ran" and scored three
        // real catches as ERROR.
        checksRun += 1
        failures += 1
    }

    /// Waits until `condition` holds, or until `seconds` of wall-clock time
    /// have passed. Returns whether the condition was ever observed.
    ///
    /// `for _ in 0..<100 { sleep(100ms) }` is a fixed iteration count
    /// wearing the costume of a ten-second budget, and the disguise only
    /// holds on an idle machine. Sleeping is not the thing that gets slower
    /// under load, so counting sleeps measures the one quantity in the
    /// system that does not move: 100 iterations measured 10.91s while nine
    /// suites and a build shared the machine, against 10.0s idle. The work
    /// being waited on has no such ceiling — the Queen's snapshot shells out
    /// to `git add -A` over the whole superproject, ~2s idle and 11-14s
    /// under that same load (#1263). The budget stood still, the work grew
    /// past it, and the loop gave up on a task that was about to arrive.
    ///
    /// A wall-clock deadline is the honest spelling of "wait up to N
    /// seconds": it stretches with the machine exactly as the work does.
    /// The condition is re-tested once after the deadline so a sleep that
    /// straddles it cannot turn an arrived result into a timeout.
    static func wait(
        upTo seconds: Double,
        pollingEvery interval: Double = 0.1,
        until condition: @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
        return condition()
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

    /// Every scenario in this suite, in run order.
    ///
    /// The table is what lets the floor say "runCursorIsACache did not run"
    /// instead of "the number went down": `main` walks it and counts each
    /// scenario's checks separately. Adding a scenario here is the whole of
    /// registering it - the floor picks it up on the next green run.
    ///
    /// The drift guard is deliberately NOT in the table. It runs only under
    /// TRIOS_RUN_DRIFT_GUARD, so recording its checks would raise the
    /// high-water mark on `make drift-guard` and then make every ordinary run
    /// look like a loss.
    static let scenarios: [(name: String, body: @MainActor () async -> Void)] = [
        ("runHappyPathStreaming", { await runHappyPathStreaming() }),
        ("runCancellationIsNonError", { await runCancellationIsNonError() }),
        ("runNewChatAppears", { await runNewChatAppears() }),
        ("runQueenHearsEveryBee", { await runQueenHearsEveryBee() }),
        ("runSlowReportDoesNotEraseAFasterOne", { await runSlowReportDoesNotEraseAFasterOne() }),
        ("runQueenAnswersACommand", { await runQueenAnswersACommand() }),
        ("runDeduplication", { await runDeduplication() }),
        ("runConversationRenamePersistence", { await runConversationRenamePersistence() }),
        ("runMemoryStoreAndPlannerPersistence", { await runMemoryStoreAndPlannerPersistence() }),
        ("runChatMemoryPlannerIntegration", { await runChatMemoryPlannerIntegration() }),
        ("runPlannerStreamTerminalStates", { await runPlannerStreamTerminalStates() }),
        ("runUnterminatedStreamFailsClosed", { await runUnterminatedStreamFailsClosed() }),
        ("runEmptyStreamDoesNotReusePriorAnswer", { await runEmptyStreamDoesNotReusePriorAnswer() }),
        ("runExplicitCancellationWinsTransportErrorRace", { await runExplicitCancellationWinsTransportErrorRace() }),
        ("runThrownTransportErrorStopsStreamingIndicator", { await runThrownTransportErrorStopsStreamingIndicator() }),
        ("runNewConversationStopsRecallBeforeTransport", { await runNewConversationStopsRecallBeforeTransport() }),
        ("runPlannerStorageFailureIsVisible", { await runPlannerStorageFailureIsVisible() }),
        ("runAttachmentTurnIsNotRemembered", { await runAttachmentTurnIsNotRemembered() }),
        ("runDeletionBlocksReentrantSend", { await runDeletionBlocksReentrantSend() }),
        ("runFailedActiveDeletionPersistsRetainedHistory", { await runFailedActiveDeletionPersistsRetainedHistory() }),
        ("runImmediateNewConversationSurvivesInitialization", { await runImmediateNewConversationSurvivesInitialization() }),
        ("runMemoryClearBlocksInflightWrite", { await runMemoryClearBlocksInflightWrite() }),
        ("runUnrelatedClearPreservesInflightWrite", { await runUnrelatedClearPreservesInflightWrite() }),
        ("runClearWaitsForStartedMemoryWrite", { await runClearWaitsForStartedMemoryWrite() }),
        ("runConversationSwitchPreservesStartedMemoryWrite", { await runConversationSwitchPreservesStartedMemoryWrite() }),
        ("runScrollPositionPolicyAndRequestDelivery", { await runScrollPositionPolicyAndRequestDelivery() }),
        ("runCassetteReplayAndObserver", { await runCassetteReplayAndObserver() }),
        ("runSalienceLearnsFromOutcomes", { await runSalienceLearnsFromOutcomes() }),
        ("runQueenCorrectsTheWorker", { await runQueenCorrectsTheWorker() }),
        ("runAcceptanceIsCheckedAgainstCriteria", { await runAcceptanceIsCheckedAgainstCriteria() }),
        ("runDelegationAcceptsCriteria", { await runDelegationAcceptsCriteria() }),
        ("runGitHubEndpointPaths", { await runGitHubEndpointPaths() }),
        ("runWorkerBriefIsASpecification", { await runWorkerBriefIsASpecification() }),
        ("runQueenProposesEvolutionOptions", { await runQueenProposesEvolutionOptions() }),
        ("runThreeOptionArrival", { await runThreeOptionArrival() }),
        ("runWorkerLivenessIsObservable", { await runWorkerLivenessIsObservable() }),
        ("runPullRequestOutcomeMapping", { await runPullRequestOutcomeMapping() }),
        ("runAcceptedWaitsForTheMerge", { await runAcceptedWaitsForTheMerge() }),
        ("runNestedBoundariesClash", { await runNestedBoundariesClash() }),
        ("runPullRequestRefusals", { await runPullRequestRefusals() }),
        ("runMergedIsNotTheSameAsClosed", { await runMergedIsNotTheSameAsClosed() }),
        ("runAskTheForgeWithOwnerBranch", { await runAskTheForgeWithOwnerBranch() }),
        ("runConflictIsNotANotYet", { await runConflictIsNotANotYet() }),
        ("runMergeTheReviewedCommit", { await runMergeTheReviewedCommit() }),
        ("runStalledWorkerIsResumedBeforeCancelled", { await runStalledWorkerIsResumedBeforeCancelled() }),
        ("runReaperDecidesFromEvidence", { await runReaperDecidesFromEvidence() }),
        ("runDigestReadsTheSameEvidenceAsTheReaper", { await runDigestReadsTheSameEvidenceAsTheReaper() }),
        ("runQueenTaskLifecycleCloses", { await runQueenTaskLifecycleCloses() }),
        ("runPureQueenTypes", { await runPureQueenTypes() }),
        ("runSelfAuditFindsPlantedDeadCode", { await runSelfAuditFindsPlantedDeadCode() }),
        ("runBranchCommitterAgainstScratchRepo", { await runBranchCommitterAgainstScratchRepo() }),
        ("runBeeBoardReflectsStateChanges", { await runBeeBoardReflectsStateChanges() }),
        ("runDashboardEntryExitCardButtonsAndEmptyState", { await runDashboardEntryExitCardButtonsAndEmptyState() }),
        ("runVerdictParserHandlesMarkdownNumbers", { await runVerdictParserHandlesMarkdownNumbers() }),
        ("runVerdictCarriesTreeState", { await runVerdictCarriesTreeState() }),
        ("runMissingFingerprintIsNotStale", { await runMissingFingerprintIsNotStale() }),
        ("runFingerprintOnlyCoversBoundary", { await runFingerprintOnlyCoversBoundary() }),
        ("runIssueNumberIsAnIdentifier", { await runIssueNumberIsAnIdentifier() }),
        ("runEmptyReviewerAnswerRetriesOnceAndRecordsAsAskedButUnanswered", { await runEmptyReviewerAnswerRetriesOnceAndRecordsAsAskedButUnanswered() }),
        ("runReviewerReceivesAdversaryPrompt", { await runReviewerReceivesAdversaryPrompt() }),
        ("runBranchPublishNoticeIsEmitted", { await runBranchPublishNoticeIsEmitted() }),
        ("runCursorIsACache", { await runCursorIsACache() }),
        ("runDispatchInboxEntriesConcurrently", { await runDispatchInboxEntriesConcurrently() }),
        ("runInboxPollerIsDevVariantOnly", { await runInboxPollerIsDevVariantOnly() }),
        ("runProposalStoreCollapsesDuplicates", { await runProposalStoreCollapsesDuplicates() }),
        ("runQueenPicksUpWorkHerself", { await runQueenPicksUpWorkHerself() }),
        ("runEachBeeGetsItsOwnCheckout", { await runEachBeeGetsItsOwnCheckout() }),
        ("runAppStartsItsOwnServer", { await runAppStartsItsOwnServer() }),
        ("runEveryBeeIsHandedARehearsal", { await runEveryBeeIsHandedARehearsal() }),
        ("runNothingMergesPastTheGate", { await runNothingMergesPastTheGate() }),
        ("runABeeIsNotSentAtTheSameWallForever", { await runABeeIsNotSentAtTheSameWallForever() }),
        ("runAJudgedTaskDoesNotWaitForAHuman", { await runAJudgedTaskDoesNotWaitForAHuman() }),
        ("runUnreadableHistoryIsNotOverwritten", { await runUnreadableHistoryIsNotOverwritten() }),
        ("runABeeStandsInTheProjectNotTheRepository", { await runABeeStandsInTheProjectNotTheRepository() }),
        ("runABoundaryPathIsAPathNotProse", { await runABoundaryPathIsAPathNotProse() }),
        ("runAnEnglishIssueIsStillDelegatable", { await runAnEnglishIssueIsStillDelegatable() }),
        ("runWorkInASecondEpicIsVisible", { await runWorkInASecondEpicIsVisible() }),
        ("runAbsentIsNotZeroAndTheBeeGetsItsWorktree", { await runAbsentIsNotZeroAndTheBeeGetsItsWorktree() }),
        ("runACountWithNoCommitIsNotEvidence", { await runACountWithNoCommitIsNotEvidence() }),
        ("runTheRecordIsComparedAgainstTheRepository", { await runTheRecordIsComparedAgainstTheRepository() }),
        ("runSheProposesAndWaitsForAWord", { await runSheProposesAndWaitsForAWord() }),
        ("runApplyingAProposalActuallyMovesTheRecord", { await runApplyingAProposalActuallyMovesTheRecord() }),
    ]

    static func main() async {
        // Counted per scenario, not as one running total: see `scenarios`.
        var observed: [(name: String, checks: Int)] = []
        for scenario in scenarios {
            let before = checksRun
            await scenario.body()
            observed.append((scenario.name, checksRun - before))
        }
        // The interface-drift proof invokes the Swift compiler and is
        // deliberately kept out of the fast suite. Run it explicitly with:
        //   make drift-guard
        if ProcessInfo.processInfo.environment["TRIOS_RUN_DRIFT_GUARD"] != nil {
            await runInterfaceDriftGuardCatchesSignatureMismatch()
        }

        // The coverage floor answers "did a scenario vanish?", which is only a
        // meaningful question when nothing failed. When something did fail, the
        // failure is the news and must be printed first: the mutation harness
        // scores on "N of M test(s) failed" and treats anything else as a suite
        // that never ran.
        if failures == 0 {
            let baseline = loadCoverageBaseline()
            let violations = coverageViolations(observed: observed, baseline: baseline)
            if violations.isEmpty {
                let recorded = recordCoverageBaseline(observed: observed, previous: baseline)
                let tracked = observed.reduce(0) { $0 + $1.checks }
                let floor = max((baseline?.total ?? 0) - totalSlack, seedFloor)
                let note = recorded
                    ? ""
                    : " (baseline not writable - the next run falls back to the seed floor)"
                print("\ncoverage floor: \(tracked) tracked checks in \(observed.count) scenarios, floor \(floor)\(note)")
            } else {
                print("\nFAIL - the coverage floor tripped.")
                for violation in violations {
                    print("  - \(violation)")
                }
                print("Coverage was removed, or a scenario returned early without asserting.")
                print("If the loss is deliberate, re-run once with TRIOS_E2E_COVERAGE_RESET=1")
                print("to re-seed \(coverageBaselinePath).")
                exit(1)
            }
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
                    // Null device, not a Pipe: an undrained pipe deadlocks
                    // waitUntilExit once git fills its ~64 KB buffer.
                    remove.standardOutput = FileHandle.nullDevice
                    remove.standardError = FileHandle.nullDevice
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

        // What was actually handed to the runner, not what the registry says
        // afterwards. The dispatcher used to pass a value copied before
        // `prepareWorktree` filled in `worktreePath`, so the struct the bee ran
        // from said it had no checkout while the registry knew otherwise. Two
        // things read that field: the working directory the bee is sent to, and
        // which committer collects its work. Both were wrong, and nothing
        // outside the call site could see it.
        //
        // Asserted against the registry's own copy rather than a literal, so
        // this stays true whether or not a worktree could be created in the
        // harness environment.
        if let dispatched = QueenWorkerRunner.lastDispatched {
            check(
                dispatched.id == opened.id,
                "the runner was handed this task and not another"
            )
            check(
                dispatched.worktreePath == opened.worktreePath,
                "and handed it as the registry holds it - a copy taken before the "
                    + "worktree was prepared sends the bee to the shared checkout"
            )
            check(
                dispatched.virtualBranch == opened.virtualBranch,
                "including its branch, which decides where its commit lands"
            )
        } else {
            fail("nothing reached the runner, so the dispatch cannot be checked")
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

    static func runAskTheForgeWithOwnerBranch() async {
        print("\n# Scenario: ask the forge with owner:branch, verify head.ref, name the refusal code")

        // ── Criterion 1: the head filter uses owner:branch and is escaped ──
        //
        // The old code passed a bare branch name to `?head=`, which returns
        // every open PR in the repo. GitHub requires `owner:branch`, and the
        // slash inside the branch name must be percent-encoded or it injects
        // a path segment.
        check(
            GitHubAPIClient.headFilter(owner: "gHashTag", branch: "queen/1250-ask-the-forge")
                == "gHashTag%3Aqueen%2F1250-ask-the-forge",
            "the head filter is owner:branch, percent-encoded as a single query value"
        )
        check(
            GitHubAPIClient.headFilter(owner: "browseros-ai", branch: "feature/branch with space")
                == "browseros-ai%3Afeature%2Fbranch%20with%20space",
            "a colon, slash, and space are all encoded — nothing raw reaches the URL"
        )

        // The owner is derived from the repo the same way path building does.
        check(
            GitHubAPIClient.ownerFromRepo("trios") == "gHashTag",
            "a bare repo name resolves to the default owner"
        )
        check(
            GitHubAPIClient.ownerFromRepo("gHashTag/trios") == "gHashTag",
            "an explicit owner/repo preserves the owner"
        )
        check(
            GitHubAPIClient.ownerFromRepo("browseros-ai/BrowserOS") == "browseros-ai",
            "a different owner is not replaced with the default"
        )

        // ── Criterion 2: a mismatched head ref is rejected rather than adopted ──

        func decodePR(_ ref: String) -> GitHubPullRequest? {
            let json = """
            {"id":1,"number":7,"title":"t","state":"open","html_url":"u",\
            "head":{"ref":"\(ref)","sha":"abc"},\
            "base":{"ref":"dev","sha":"def"}}
            """
            return try? JSONDecoder().decode(GitHubPullRequest.self, from: Data(json.utf8))
        }

        guard let matching = decodePR("queen/1250-ask-the-forge"),
              let mismatched = decodePR("queen/999-different-work") else {
            fail("could not decode test pull requests"); return
        }

        // The right PR is selected from a list that also contains a wrong one.
        check(
            GitHubAPIClient.matchingPullRequest(
                in: [mismatched, matching], expectedBranch: "queen/1250-ask-the-forge"
            )?.head?.ref == "queen/1250-ask-the-forge",
            "a PR whose head ref matches is selected from a list"
        )
        // A mismatched ref is rejected even when it is the only entry —
        // this is the proof the guard is live: removing the verification and
        // falling back to `.first` would adopt this PR.
        check(
            GitHubAPIClient.matchingPullRequest(
                in: [mismatched], expectedBranch: "queen/1250-ask-the-forge"
            ) == nil,
            "a PR whose head ref differs is rejected rather than adopted"
        )
        check(
            GitHubAPIClient.matchingPullRequest(in: [], expectedBranch: "queen/1250") == nil,
            "an empty list yields nothing, not a guess"
        )
        // The mismatched PR sits in position zero; the old `.first` would have
        // returned it. This is the check that fails if the verification is
        // removed.
        check(
            GitHubAPIClient.matchingPullRequest(
                in: [mismatched, matching], expectedBranch: "queen/1250-ask-the-forge"
            )?.head?.ref == "queen/1250-ask-the-forge",
            "the first PR has a different ref, yet the right one is returned"
        )

        // ── Criterion 3: merge_refused carries the status code ──

        if case .merged = GitHubAPIClient.MergeOutcome.merged {
            check(true, "a merged outcome reads as merged")
        } else {
            fail("a merged outcome reads as merged")
        }
        if case .refused(let code, _, _) = GitHubAPIClient.MergeOutcome.refused(statusCode: 405, mergeable: nil, mergeState: nil) {
            check(code == 405, "a refused merge carries 405 (not mergeable)")
        } else {
            fail("a refused merge carries 405 (not mergeable)")
        }
        if case .refused(let code, _, _) = GitHubAPIClient.MergeOutcome.refused(statusCode: 409, mergeable: nil, mergeState: nil) {
            check(code == 409, "a refused merge carries 409 (head moved)")
        } else {
            fail("a refused merge carries 409 (head moved)")
        }
    }

    static func runConflictIsNotANotYet() async {
        print("\n# Scenario: a conflict is not a not-yet (#1252)")

        // ── Criterion 1: the model carries mergeable and merge state ──
        //
        // The MergeOutcome enum carries mergeable and merge_state on both
        // its refusal and conflict cases, so the caller can inspect the
        // forge's verdict without a second request.

        if case .refused(let code, let mergeable, let mergeState) =
            GitHubAPIClient.MergeOutcome.refused(statusCode: 405, mergeable: true, mergeState: "blocked") {
            check(code == 405, "a refused merge carries the HTTP status code")
            check(mergeable == true, "and carries mergeable from the forge")
            check(mergeState == "blocked", "and carries merge_state from the forge")
        } else {
            fail("a refused merge decodes with mergeable and merge_state")
            check(false, "a refused merge carries the HTTP status code")
            check(false, "and carries mergeable from the forge")
            check(false, "and carries merge_state from the forge")
        }

        if case .conflict(let mergeable, let mergeState) =
            GitHubAPIClient.MergeOutcome.conflict(mergeable: false, mergeState: "dirty") {
            check(mergeable == false, "a conflict carries mergeable = false")
            check(mergeState == "dirty", "and carries merge_state = dirty")
        } else {
            fail("a conflict outcome matches .conflict")
            check(false, "a conflict carries mergeable = false")
            check(false, "and carries merge_state = dirty")
        }

        // ── Criterion 2: a conflicting refusal emits its own event ──
        //
        // isConflict is the pure classifier mergePullRequest uses to split
        // .conflict from .refused. Removing it — collapsing conflicts back
        // into refusals — breaks every check below.

        check(GitHubAPIClient.isConflict(mergeable: false, mergeState: nil),
              "mergeable = false is a permanent conflict")
        check(GitHubAPIClient.isConflict(mergeable: nil, mergeState: "dirty"),
              "merge_state = dirty is a permanent conflict")
        check(GitHubAPIClient.isConflict(mergeable: false, mergeState: "dirty"),
              "both signals agree: conflict")
        check(!GitHubAPIClient.isConflict(mergeable: true, mergeState: "blocked"),
              "a blocked-but-mergeable PR is a not-yet, not a conflict")
        check(!GitHubAPIClient.isConflict(mergeable: nil, mergeState: nil),
              "absence is not a conflict — the forge was not asked")
        check(!GitHubAPIClient.isConflict(mergeable: true, mergeState: "clean"),
              "a clean, mergeable PR is not a conflict")

        // A conflict must not match the .refused pattern. This is the test
        // that fails if the distinction is removed: if .conflict is collapsed
        // into .refused, the conflict-specific event is never emitted and the
        // task is retried forever (#1252 criterion 4).
        let conflict = GitHubAPIClient.MergeOutcome.conflict(mergeable: false, mergeState: "dirty")
        if case .refused = conflict {
            fail("a conflict must not match .refused — it is a different event")
        } else {
            check(true, "a conflict does not match the refused pattern")
        }

        // ── Criterion 3: a conflicting pull request stops being retried ──
        //
        // pollPullRequests selects only tasks in .accepted with a PR number.
        // A conflict transitions to .awaitingReview — a legal transition —
        // which drops the task from the filter. This is what "stops being
        // retried" means.

        let store = NSTemporaryDirectory() + "queen-conflict-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)

        guard let issue = IssueReference.parse("gHashTag/trios#1252") else {
            fail("could not build a test issue"); return
        }
        guard let task = registry.delegate(
            issue: issue, title: "conflict probe", worker: "queen-swift",
            conversationId: UUID(), ownedPaths: ["BR-OUTPUT/GitHubAPIClient.swift"]
        ) else {
            fail("registry refused a clean delegation"); return
        }

        // Walk the task to .accepted with a PR, as the Queen's review would.
        check(registry.transition(taskID: task.id, to: .running),
              "the probe task starts running")
        check(registry.transition(taskID: task.id, to: .awaitingReview),
              "moves to review")
        check(registry.transition(taskID: task.id, to: .accepted),
              "and is accepted")
        registry.recordPullRequest(taskID: task.id, number: 42)

        // Before the conflict: the task IS in the poll filter.
        let beforeFilter = registry.tasks.filter {
            $0.pullRequestNumber != nil && $0.state == .accepted
        }
        check(beforeFilter.contains(where: { $0.id == task.id }),
              "before the conflict, the task is in pollPullRequests' filter")

        // Simulate the conflict: transition to .awaitingReview.
        check(registry.transition(taskID: task.id, to: .awaitingReview),
              "a conflict transitions the task from accepted to awaitingReview")

        // After the conflict: the task is NOT in the poll filter.
        let afterFilter = registry.tasks.filter {
            $0.pullRequestNumber != nil && $0.state == .accepted
        }
        check(!afterFilter.contains(where: { $0.id == task.id }),
              "after the conflict, the task is dropped from the filter — retry stops")

        // ── Criterion 4: removing the distinction breaks a check ──
        //
        // The .conflict case is its own enum case. If it is removed, the
        // pattern-match above fails to compile. If isConflict is removed,
        // the classification checks fail. Either way, the distinction is
        // guarded by a failing check, not by trust.
        check(GitHubAPIClient.isConflict(mergeable: false, mergeState: "dirty"),
              "removing isConflict breaks this check — the distinction is guarded")
    }

    // MARK: - Scenario: merge the reviewed commit, read 409 as branch moved (#1254)

    static func runMergeTheReviewedCommit() async {
        print("\n# Scenario: merge the reviewed commit and read 409 as the branch having moved (#1254)")

        // ── Criterion 1: the task records the reviewed head commit ──
        //
        // DelegatedTask carries reviewedHeadSHA, and the registry records
        // and clears it. If the field is removed, these checks fail to
        // compile — which is the guard criterion 4 asks for.

        let store = NSTemporaryDirectory() + "queen-1254-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)

        guard let issue = IssueReference.parse("gHashTag/trios#1254") else {
            fail("could not build a test issue"); return
        }
        guard let task = registry.delegate(
            issue: issue, title: "sha probe", worker: "queen-swift",
            conversationId: UUID(), ownedPaths: ["BR-OUTPUT/GitHubAPIClient.swift"]
        ) else {
            fail("registry refused a clean delegation"); return
        }

        // A freshly delegated task has no reviewed head SHA.
        check(registry.tasks.first(where: { $0.id == task.id })?.reviewedHeadSHA == nil,
              "a new task has no reviewed head SHA")

        // Recording the SHA persists it.
        registry.recordReviewedHeadSHA(taskID: task.id, sha: "abc123")
        check(registry.tasks.first(where: { $0.id == task.id })?.reviewedHeadSHA == "abc123",
              "recordReviewedHeadSHA persists the SHA")

        // Clearing it removes it.
        registry.clearReviewedHeadSHA(taskID: task.id)
        check(registry.tasks.first(where: { $0.id == task.id })?.reviewedHeadSHA == nil,
              "clearReviewedHeadSHA removes the SHA")

        // ── Criterion 2: the merge request sends it as sha ──
        //
        // mergePullRequest accepts a sha parameter. If the parameter is
        // removed, the call site in pollPullRequests (sha: reviewedSHA)
        // fails to compile, and the switch's .headMoved case becomes
        // unreachable — both are compile-time guards. The pure enum
        // checks below also fail to compile if .headMoved is removed.

        // ── Criterion 3: 409 is distinguished from 405 ──
        //
        // .headMoved is its own case, distinct from .refused and .conflict.
        // If it is removed, the switch in pollPullRequests fails to compile
        // (non-exhaustive), and these checks fail to compile.

        // .headMoved does not match .refused — the distinction that makes
        // the caller handle them differently.
        let headMoved = GitHubAPIClient.MergeOutcome.headMoved
        if case .refused = headMoved {
            fail("headMoved must not match .refused — 409 is not a generic refusal")
        } else {
            check(true, "headMoved does not match the refused pattern")
        }
        if case .conflict = headMoved {
            fail("headMoved must not match .conflict — 409 is not a merge conflict")
        } else {
            check(true, "headMoved does not match the conflict pattern")
        }
        if case .merged = headMoved {
            fail("headMoved must not match .merged — 409 means the merge did not happen")
        } else {
            check(true, "headMoved does not match the merged pattern")
        }

        // A 405 refusal stays in .refused with the status code intact.
        if case .refused(let code, _, _) = GitHubAPIClient.MergeOutcome.refused(statusCode: 405, mergeable: nil, mergeState: nil) {
            check(code == 405, "a 405 refusal carries 405 (not mergeable)")
        } else {
            fail("a 405 refusal should match .refused")
        }

        // ── Criterion 1 (acceptance): mergePayload includes sha when given ──
        //
        // mergePayload is a pure static function. Removing the function
        // definition makes every check below fail to compile.

        let withSHA = GitHubAPIClient.mergePayload(title: "t", sha: "abc123")
        check(withSHA["sha"] as? String == "abc123",
              "mergePayload includes sha when given")
        let withoutSHA = GitHubAPIClient.mergePayload(title: "t", sha: nil)
        check(withoutSHA["sha"] == nil,
              "mergePayload omits sha when nil")
        check(withSHA["merge_method"] as? String == "squash",
              "mergePayload always sets merge_method to squash")
        check(withSHA["commit_title"] as? String == "t",
              "mergePayload always sets commit_title")

        // ── #1254 Criterion 2 + #1259: each branch of outcome is named ──
        //
        // outcome is a pure static function. Removing the function definition
        // makes every check below fail to compile. Each branch is named so
        // that removing it produces a failure whose name identifies the branch
        // that was deleted — a break reads as the defect (#1259).

        // The 409 branch: statusCode == 409 → headMoved.
        // Removing this branch makes 409 fall through to refused. The check
        // name says "409 branch" so the failure identifies the code removed.
        if case .headMoved = GitHubAPIClient.outcome(statusCode: 409, mergeable: nil, mergeState: nil) {
            check(true, "the 409 branch in outcome maps to headMoved")
        } else {
            fail("the 409 branch in outcome maps to headMoved")
        }

        // The isConflict branch: isConflict(mergeable:mergeState:) → conflict.
        // Removing isConflict from outcome makes 405+mergeable=false fall
        // through to refused. The check name says "isConflict" so the failure
        // identifies the branch removed (#1259 criterion 3).
        if case .conflict = GitHubAPIClient.outcome(statusCode: 405, mergeable: false, mergeState: nil) {
            check(true, "the isConflict branch in outcome maps mergeable false to conflict")
        } else {
            fail("the isConflict branch in outcome maps mergeable false to conflict")
        }

        // The default branch: anything the forge refuses without a conflict
        // signal. 405 with mergeable nil is a generic refusal, not a conflict.
        if case .refused(let code, _, _) = GitHubAPIClient.outcome(statusCode: 405, mergeable: nil, mergeState: nil) {
            check(code == 405, "the default branch in outcome maps 405 nil to refused")
        } else {
            fail("the default branch in outcome maps 405 nil to refused")
        }

        // The 200 branch: statusCode == 200 → merged regardless of fields.
        if case .merged = GitHubAPIClient.outcome(statusCode: 200, mergeable: nil, mergeState: nil) {
            check(true, "the 200 branch in outcome maps to merged")
        } else {
            fail("the 200 branch in outcome maps to merged")
        }

        // ── Criterion 4: checks fail if the sha is dropped or 409 is folded into 405 ──
        //
        // After a headMoved, the task is back in the review queue and the
        // SHA is cleared — the same structural test as the conflict
        // scenario, applied to the 409 path.

        // Walk the task to .accepted with a PR, as the Queen's review would.
        check(registry.transition(taskID: task.id, to: .running),
              "the probe task starts running")
        check(registry.transition(taskID: task.id, to: .awaitingReview),
              "moves to review")
        check(registry.transition(taskID: task.id, to: .accepted),
              "and is accepted")
        registry.recordPullRequest(taskID: task.id, number: 99)
        registry.recordReviewedHeadSHA(taskID: task.id, sha: "deadbeef")

        // Before the headMoved: the task IS in the poll filter and has a SHA.
        let beforeFilter = registry.tasks.filter {
            $0.pullRequestNumber != nil && $0.state == .accepted
        }
        check(beforeFilter.contains(where: { $0.id == task.id }),
              "before the headMoved, the task is in pollPullRequests' filter")
        check(registry.tasks.first(where: { $0.id == task.id })?.reviewedHeadSHA == "deadbeef",
              "before the headMoved, the task has the reviewed SHA")

        // Simulate the headMoved: clear SHA and transition to .awaitingReview.
        registry.clearReviewedHeadSHA(taskID: task.id)
        check(registry.transition(taskID: task.id, to: .awaitingReview),
              "a headMoved transitions the task from accepted to awaitingReview")

        // After the headMoved: the task is NOT in the poll filter and SHA is nil.
        let afterFilter = registry.tasks.filter {
            $0.pullRequestNumber != nil && $0.state == .accepted
        }
        check(!afterFilter.contains(where: { $0.id == task.id }),
              "after the headMoved, the task is dropped from the filter — retry stops")
        check(registry.tasks.first(where: { $0.id == task.id })?.reviewedHeadSHA == nil,
              "after the headMoved, the reviewed SHA is cleared for re-capture")
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

    // MARK: - Scenario: the reaper decides from evidence, not from a timeout
    //
    // Three defects came from answering "is this worker dead?" by sampling
    // "is a stream running for this conversation right now": a worker reaped
    // 0.7s after it finished (#1247), the same under parallelism (#1248), and
    // a task the registry called running that no runner ever started, which
    // that sample could not distinguish from a worker mid-answer (#1139).
    //
    // The fix replaced the sample with two pure predicates over facts the
    // runner recorded as they happened - `isStreamOpen` and `wasNeverStarted`,
    // read through `hasGoneSilent` and `lastEvidenceOfLife`. The only proof
    // they worked lived in a throwaway driver outside the repository, so when
    // both were gutted - `isStreamOpen` to `false`, `wasNeverStarted` to
    // "no completed turn" - nothing in the tree noticed, and every running
    // worker without a finished turn became reapable mid-stream.
    //
    // These checks are that proof, brought inside. They drive the shipped
    // predicates through a real `QueenDelegationRegistry`, reading them exactly
    // as `ChatViewModel.reapStalledWorkers` and `QueenDelegationRegistry`
    // .stalled(now:) read them, rather than paraphrasing the decision.

    /// The instant every reaper scenario measures from. Fixed, because the
    /// question is "how long since the worker spoke", and a moving `now`
    /// turns that into "how long since the machine got round to it".
    private static let reaperEpoch = Date(timeIntervalSince1970: 1_700_000_000)

    private static func reaperAt(_ minutes: Double) -> Date {
        reaperEpoch.addingTimeInterval(minutes * 60)
    }

    /// A registry whose clock does not move, so `updatedAt` records the
    /// dispatch and nothing else - which is the situation that made a live
    /// worker look an hour and a half stale (#1247).
    private static func reaperRegistry(_ label: String) -> QueenDelegationRegistry {
        QueenDelegationRegistry(
            storePath: NSTemporaryDirectory() + "queen-reaper-\(label)-\(UUID().uuidString).json",
            dateProvider: { reaperEpoch }
        )
    }

    private static func reaperDispatch(
        _ registry: QueenDelegationRegistry,
        issue number: Int,
        worker: String,
        owns: String
    ) -> DelegatedTask? {
        guard let issue = IssueReference.parse("gHashTag/trios#\(number)") else {
            fail("could not build a test issue for #\(number)"); return nil
        }
        guard let task = registry.delegate(
            issue: issue, title: "worker \(number)", worker: worker,
            conversationId: UUID(), ownedPaths: [owns]
        ) else {
            fail("the registry refused to delegate #\(number): "
                + (registry.lastError ?? "no reason given"))
            return nil
        }
        guard registry.transition(taskID: task.id, to: .running) else {
            fail("the registry refused to start #\(number)"); return nil
        }
        return task
    }

    // The runner speaks in exactly three places. These mirror all three, so
    // the facts under test are the ones the shipped runner files.
    //   start()  -> onStreamFact(.open, nil)
    //   a delta  -> noteByte -> onStreamFact(.open, now)
    //   finish() -> onStreamFact(didComplete ? .terminal : .cut, lastByteAt),
    //               and onFinish -> recordCompletedTurn, synchronously (#1248)

    private static func reaperStart(_ registry: QueenDelegationRegistry, _ task: DelegatedTask) {
        // Stamped at the fixture epoch, not at the wall clock. The first-byte
        // deadline is measured from this moment, so a real `Date()` here would
        // put the whole scenario's arithmetic three years in the future and
        // every "past the deadline" check would silently read as "not yet".
        registry.recordStreamFact(
            taskID: task.id, outcome: .open, lastByteAt: nil, at: reaperEpoch
        )
    }

    private static func reaperByte(
        _ registry: QueenDelegationRegistry,
        _ task: DelegatedTask,
        at when: Date
    ) {
        registry.recordStreamFact(taskID: task.id, outcome: .open, lastByteAt: when)
    }

    private static func reaperFinish(
        _ registry: QueenDelegationRegistry,
        _ task: DelegatedTask,
        terminal: Bool,
        lastByteAt: Date?
    ) {
        registry.recordStreamFact(
            taskID: task.id,
            outcome: terminal ? .terminal : .cut,
            lastByteAt: lastByteAt
        )
        registry.recordCompletedTurn(taskID: task.id)
    }

    /// The orphan list `reapStalledWorkers` builds before it does anything,
    /// transcribed verbatim. Its members skip the stall threshold entirely, so
    /// the only thing between a live worker in here and a worker executed
    /// mid-stream is the `isStreamOpen` guard in the loop below it. Asserted
    /// separately from `reaperWouldTake` on purpose: a bee that survives only
    /// because a second predicate caught the first one's mistake is one
    /// predicate away from death, and the adversary gutted both at once.
    private static func reaperOrphans(_ registry: QueenDelegationRegistry) -> [String] {
        registry.running
            .filter(QueenDelegationPolicy.wasNeverStarted)
            .map(\.issue.slug)
    }

    /// Everything the sweep would take, transcribed from `reapStalledWorkers`:
    /// orphans plus the silent, deduplicated, then each one skipped while the
    /// runner says its turn is still in flight.
    private static func reaperWouldTake(
        _ registry: QueenDelegationRegistry,
        now: Date
    ) -> [String] {
        let orphaned = registry.running.filter(QueenDelegationPolicy.wasNeverStarted)
        let stalled = registry.stalled(now: now)
        var seen = Set<UUID>()
        return (orphaned + stalled)
            .filter { seen.insert($0.id).inserted }
            .filter { !QueenDelegationPolicy.isStreamAlive($0, now: now) }
            .map(\.issue.slug)
    }

    static func runReaperDecidesFromEvidence() async {
        print("\n# Scenario: the stall reaper decides from evidence, not from a timeout")

        typealias P = QueenDelegationPolicy

        // ── 1247: a bee that streamed for 90 minutes and finished 0.7s ago ──
        //
        // Nothing wrote the registry while it streamed, so `updatedAt` is still
        // the dispatch time and an `updatedAt`-only clock calls it 90 minutes
        // stale. The last byte says otherwise.
        do {
            let registry = reaperRegistry("finished")
            guard let bee = reaperDispatch(registry, issue: 1247, worker: "queen-swift", owns: "docs") else {
                return
            }
            reaperStart(registry, bee)
            for minute in stride(from: 1.0, through: 90.0, by: 1.0) {
                reaperByte(registry, bee, at: reaperAt(minute))
            }
            reaperFinish(registry, bee, terminal: true, lastByteAt: reaperAt(90))

            let justAfter = reaperAt(90).addingTimeInterval(0.7)
            guard let settled = registry.task(forConversation: bee.conversationId) else {
                fail("the registry lost the finished bee"); return
            }

            check(
                reaperWouldTake(registry, now: justAfter).isEmpty,
                "1247: a bee that spoke 0.7s ago is NOT reaped - taking it kills a worker that just finished"
            )
            check(
                settled.streamOutcome == .terminal,
                "1247: the runner filed a terminal end, so the reaper has a fact to read instead of a hunch"
            )
            check(
                P.lastEvidenceOfLife(settled) == reaperAt(90),
                "1247: the worker's last sign of life is its last byte, not the dispatch time on updatedAt"
            )
            check(
                !P.hasGoneSilent(settled, now: justAfter),
                "1247: 0.7 seconds of quiet is not an hour of silence"
            )
            check(
                !P.wasNeverStarted(settled),
                "1247: a bee that streamed for 90 minutes was started, whatever its bookkeeping says"
            )
        }

        // ── The other direction: the same history, cut mid-stream and silent ──
        do {
            let registry = reaperRegistry("cut")
            guard let bee = reaperDispatch(registry, issue: 1247, worker: "queen-swift", owns: "docs") else {
                return
            }
            reaperStart(registry, bee)
            for minute in stride(from: 1.0, through: 90.0, by: 1.0) {
                reaperByte(registry, bee, at: reaperAt(minute))
            }
            reaperFinish(registry, bee, terminal: false, lastByteAt: reaperAt(90))

            guard let cut = registry.task(forConversation: bee.conversationId) else {
                fail("the registry lost the cut bee"); return
            }
            check(
                cut.streamOutcome == .cut,
                "a stream that stopped without a terminal event is on the record as cut, not as ended"
            )
            check(
                reaperWouldTake(registry, now: reaperAt(90 + 59)).isEmpty,
                "59 minutes of silence is under the threshold - the reaper waits the hour it promised"
            )
            check(
                reaperWouldTake(registry, now: reaperAt(90 + 61)) == ["gHashTag/trios#1247"],
                "a bee cut off mid-stream and silent past the threshold IS reaped - the detector still detects"
            )
            check(
                P.hasGoneSilent(cut, now: reaperAt(90 + 61)),
                "and it is silence plus a closed stream that condemns it, both halves together"
            )
        }

        // ── The mirror that makes `isStreamOpen` load-bearing ──
        //
        // Identical silence, but the runner never closed the stream. A long
        // think mid-answer is not a death, and cutting it off is the worse form
        // of the same defect: the worker is killed while it is still talking.
        do {
            let registry = reaperRegistry("open-and-quiet")
            guard let bee = reaperDispatch(registry, issue: 1247, worker: "queen-swift", owns: "docs") else {
                return
            }
            reaperStart(registry, bee)
            for minute in stride(from: 1.0, through: 90.0, by: 1.0) {
                reaperByte(registry, bee, at: reaperAt(minute))
            }
            // No finish: the turn is still in flight when the sweep runs.

            guard let live = registry.task(forConversation: bee.conversationId) else {
                fail("the registry lost the still-streaming bee"); return
            }
            let longAfter = reaperAt(90 + 61)
            check(
                P.isStreamOpen(live),
                "a turn the runner opened and never closed reads as open - the fact the reaper asks for"
            )
            check(
                !P.hasGoneSilent(live, now: longAfter),
                "an open stream quiet for 61 minutes is thinking, not dead - silence alone must not condemn it"
            )
            check(
                reaperWouldTake(registry, now: longAfter).isEmpty,
                "and the sweep leaves it alone - reaping an open stream cuts off a live answer mid-sentence"
            )
        }

        // ── 1275: opened a stream, never said a word ──
        //
        // A real specimen, not a hypothesis. Task 3165EF5A on issue #1273 sat
        // in .running with streamOutcome == .open and no lastStreamByteAt for
        // 24 minutes, and was invisible to both detectors at once:
        // `wasNeverStarted` wants streamOutcome == nil and this one is .open,
        // `hasGoneSilent` returns false on sight of an open stream. Neither
        // would ever have taken it - not at 24 minutes, not at 24 hours.
        //
        // The scenario above is the one that must NOT change: a bee that
        // delivered ninety bytes and paused is thinking, and silence alone must
        // not condemn it. The distinction this adds is speech, not silence. An
        // open stream that has spoken keeps its whole hour. An open stream that
        // has never spoken is judged against the time to the FIRST byte, which
        // is a different quantity with a much smaller scale - a provider either
        // answers within a minute or is not going to.
        do {
            let registry = reaperRegistry("open-and-mute")
            guard let mute = reaperDispatch(registry, issue: 1275, worker: "queen-swift", owns: "docs") else {
                return
            }
            reaperStart(registry, mute)
            // No reaperByte, ever. That is the whole specimen.

            guard let dead = registry.task(forConversation: mute.conversationId) else {
                fail("the registry lost the mute bee"); return
            }
            check(
                P.isStreamOpen(dead) && dead.lastStreamByteAt == nil,
                "the specimen: stream open, not one byte - the state neither detector covered"
            )
            check(
                !P.wasNeverStarted(dead),
                "and it is not an orphan either - a stream WAS opened, so the orphan rule passes it by"
            )
            // Inside the first-byte deadline it is still starting up, and a
            // provider that is merely slow to begin must not be cut off.
            check(
                !P.hasGoneSilent(dead, now: reaperAt(0.5)),
                "thirty seconds without a first byte is a slow start, not a death"
            )
            // Past it, nothing is coming.
            let past = reaperEpoch.addingTimeInterval(P.firstByteDeadline + 60)
            check(
                P.hasGoneSilent(dead, now: past),
                "past the first-byte deadline a mute stream is dead, and the hour-long stall clock never applies"
            )
            check(
                reaperWouldTake(registry, now: past) == ["gHashTag/trios#1275"],
                "and the sweep takes it - otherwise it holds a worker slot until the app restarts"
            )
        }

        // ── 1248: one bee finishes while another is still streaming ──
        do {
            let registry = reaperRegistry("parallel")
            guard let quick = reaperDispatch(registry, issue: 1248, worker: "queen-swift", owns: "docs"),
                  let slow = reaperDispatch(registry, issue: 1249, worker: "queen-docs", owns: "rings")
            else { return }

            reaperStart(registry, quick)
            reaperStart(registry, slow)
            for minute in stride(from: 1.0, through: 90.0, by: 1.0) {
                reaperByte(registry, quick, at: reaperAt(minute))
                reaperByte(registry, slow, at: reaperAt(minute))
            }
            reaperFinish(registry, quick, terminal: true, lastByteAt: reaperAt(90))
            // `slow` keeps streaming straight through the moment of the sweep.
            reaperByte(registry, slow, at: reaperAt(90).addingTimeInterval(0.5))

            let now = reaperAt(90).addingTimeInterval(0.7)
            guard let slowNow = registry.task(forConversation: slow.conversationId),
                  let quickNow = registry.task(forConversation: quick.conversationId)
            else { fail("the registry lost one of the two bees"); return }

            check(
                reaperWouldTake(registry, now: now).isEmpty,
                "1248: with one bee finishing while another streams, the sweep takes NEITHER"
            )
            check(
                reaperOrphans(registry).isEmpty,
                "1248: and neither is even classed an orphan - the orphan list skips the stall threshold, so a live bee in it is one predicate away from being executed mid-stream"
            )
            check(
                !P.wasNeverStarted(slowNow),
                "1139 must not eat live workers: a bee with an open stream and no completed turn WAS started"
            )
            check(
                P.isStreamOpen(slowNow),
                "1248: the bee still mid-stream is on the record as open while its neighbour settles"
            )
            check(
                (quickNow.completedTurns ?? 0) == 1 && quickNow.streamOutcome == .terminal,
                "1248: the bee that finished has both a completed turn and a terminal stream on its record"
            )
        }

        // ── 1139: running in the registry, never dispatched to a runner ──
        do {
            let registry = reaperRegistry("orphan")
            guard let ghost = reaperDispatch(registry, issue: 1139, worker: "queen-swift", owns: "docs") else {
                return
            }
            // Three seconds later: no threshold to wait for.
            let now = reaperAt(0.05)
            guard let never = registry.task(forConversation: ghost.conversationId) else {
                fail("the registry lost the orphan"); return
            }

            check(
                P.wasNeverStarted(never),
                "1139: no stream fact was ever filed for this task, so no turn was ever dispatched"
            )
            check(
                reaperWouldTake(registry, now: now) == ["gHashTag/trios#1139"],
                "1139: a task marked running that no runner ever started IS caught immediately"
            )
            check(
                registry.stalled(now: now).isEmpty,
                "1139: the stall clock alone would have left it looking busy for another hour"
            )
        }
    }

    // MARK: - Scenario: the digest reads the same evidence as the reaper
    //
    // `QueenReviewDigest.stalled` measured silence from `updatedAt` while
    // `QueenDelegationRegistry.stalled` measured it from the facts the runner
    // recorded. That is two answers to one question inside one supervisor: the
    // hourly digest could announce a worker as stalled in the same minute the
    // reaper - correctly - left it alone, because `updatedAt` is when the Queen
    // last wrote bookkeeping and has nothing to do with when the worker last
    // spoke. Whichever number the user believed, the other half of the system
    // was acting on the opposite belief. Both now ask
    // `QueenDelegationPolicy.hasGoneSilent`.
    //
    // Every check below calls the SHIPPED `QueenReviewDigest.stalled` and the
    // SHIPPED `QueenReviewScheduler.reviewNow`. Nothing here re-states the
    // rule, and that is the whole design of this scenario: the twenty checks
    // above, named for the reaper's predicates, could not see the stream-open
    // guard being deleted from `ChatViewModel.reapStalledWorkers`, because
    // `reaperWouldTake` carries its own copy of that line and kept passing
    // against the copy. A test that transcribes the code under test can only
    // fail when the transcription is wrong. Gut the digest and these go red.

    /// Catches what the scheduler posted.
    ///
    /// `report` is a non-isolated escaping closure, so the capture cannot be a
    /// local `var` on the main actor. A lock-guarded box keeps the test free of
    /// isolation ceremony that has nothing to do with what is being proven.
    final class QueenDigestReportSink: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?

        func record(_ message: String) {
            lock.lock()
            value = message
            lock.unlock()
        }

        var message: String {
            lock.lock()
            defer { lock.unlock() }
            return value ?? ""
        }
    }

    /// Runs one real review pass over `registry` and returns what the Queen
    /// posted.
    ///
    /// The scheduler is the caller that turns the digest's stalled list into a
    /// sentence a human reads, so driving it proves the whole path instead of
    /// the predicate alone. Wired exactly as `ChatViewModel` wires the shared
    /// one, with a frozen clock in place of the timer.
    private static func digestReport(
        for registry: QueenDelegationRegistry,
        now: Date
    ) async -> String {
        let sink = QueenDigestReportSink()
        let scheduler = QueenReviewScheduler(interval: 3600, dateProvider: { now })
        scheduler.tasks = { [registry] in registry.open }
        scheduler.report = { message in sink.record(message) }
        await scheduler.reviewNow()
        return sink.message
    }

    static func runDigestReadsTheSameEvidenceAsTheReaper() async {
        print("\n# Scenario: the hourly digest and the reaper answer one question")

        typealias P = QueenDelegationPolicy

        // ── A bee mid-answer: streaming for 90 minutes, nothing since ──
        //
        // The runner opened its stream and has never closed it. No registry
        // write followed the dispatch, so `updatedAt` is still the dispatch
        // time - the exact shape that made the old digest and the reaper
        // disagree.
        let quiet = reaperRegistry("digest-quiet")
        guard let liveBee = reaperDispatch(
            quiet, issue: 1247, worker: "queen-swift", owns: "docs"
        ) else { return }
        reaperStart(quiet, liveBee)
        for minute in stride(from: 1.0, through: 90.0, by: 1.0) {
            reaperByte(quiet, liveBee, at: reaperAt(minute))
        }
        let midAnswer = reaperAt(90 + 61)
        guard let live = quiet.task(forConversation: liveBee.conversationId) else {
            fail("the registry lost the streaming bee"); return
        }

        // Without this the fixture proves nothing: a case both rules answer the
        // same way cannot show that the digest changed rules.
        check(
            midAnswer.timeIntervalSince(live.updatedAt) >= P.stallThreshold,
            "the clock the digest used to read calls this bee stale, so this fixture can tell the two rules apart"
        )
        check(
            P.isStreamOpen(live) && !P.hasGoneSilent(live, now: midAnswer),
            "and the evidence says otherwise: the stream is open, so it is thinking rather than dead"
        )
        check(
            QueenReviewDigest.stalled(quiet.open, now: midAnswer).isEmpty,
            "a bee streaming quietly is NOT in the digest's stalled list"
        )
        check(
            quiet.stalled(now: midAnswer).isEmpty,
            "and the reaper leaves it alone, as it already did - the two now agree"
        )
        check(
            QueenReviewDigest.stalled(quiet.open, now: midAnswer).map(\.issue.slug)
                == quiet.stalled(now: midAnswer).map(\.issue.slug),
            "digest and reaper name the same bees, because they ask the same predicate"
        )

        let quietReport = await digestReport(for: quiet, now: midAnswer)
        check(
            !quietReport.contains("shown no sign of life"),
            "the Queen's hourly report does not announce a live worker as stalled"
        )
        check(
            quietReport.hasPrefix(SystemNoticeClassifier.infoMarker),
            "it goes out as information, not as a warning about a stall that is not happening"
        )
        check(
            quietReport.contains("gHashTag/trios#1247"),
            "and the bee is still in the report - described as working, not omitted"
        )

        // ── The other direction: the detector must still detect ──
        let silent = reaperRegistry("digest-silent")
        guard let deadBee = reaperDispatch(
            silent, issue: 1248, worker: "queen-docs", owns: "rings"
        ) else { return }
        reaperStart(silent, deadBee)
        for minute in stride(from: 1.0, through: 90.0, by: 1.0) {
            reaperByte(silent, deadBee, at: reaperAt(minute))
        }
        reaperFinish(silent, deadBee, terminal: false, lastByteAt: reaperAt(90))

        check(
            QueenReviewDigest.stalled(silent.open, now: reaperAt(90 + 59)).isEmpty,
            "59 minutes after the last byte the digest still waits the hour it promised"
        )
        check(
            QueenReviewDigest.stalled(silent.open, now: reaperAt(90 + 61)).map(\.issue.slug)
                == ["gHashTag/trios#1248"],
            "a bee cut off and silent past the threshold IS in the digest's stalled list"
        )
        check(
            silent.stalled(now: reaperAt(90 + 61)).map(\.issue.slug) == ["gHashTag/trios#1248"],
            "and the reaper would take the same bee - one silence, not two"
        )

        let silentReport = await digestReport(for: silent, now: reaperAt(90 + 61))
        check(
            silentReport.contains("shown no sign of life"),
            "the Queen says so in words: this one has stopped"
        )
        check(
            silentReport.hasPrefix(SystemNoticeClassifier.warningMarker),
            "and says it as a warning, which is what a stalled bee is"
        )

        // ── An orphan is not silence ──
        //
        // `hasGoneSilent` is about a worker that spoke and stopped. A task no
        // runner ever started belongs to the orphan sweep, which skips the
        // threshold entirely. Both lists must agree it is not theirs, or the
        // digest announces a stall the reaper does not believe in.
        let orphan = reaperRegistry("digest-orphan")
        guard let ghost = reaperDispatch(
            orphan, issue: 1139, worker: "queen-swift", owns: "docs"
        ) else { return }
        let soonAfter = reaperAt(0.05)
        check(
            orphan.task(forConversation: ghost.conversationId).map(P.wasNeverStarted) == true,
            "1139: the ghost is on the record as never started"
        )
        check(
            QueenReviewDigest.stalled(orphan.open, now: soonAfter).isEmpty
                && orphan.stalled(now: soonAfter).isEmpty,
            "1139: neither list calls a never-started task silent - that one is the orphan sweep's job"
        )

        // ── Only running bees ──
        //
        // A result waiting for review has been quiet for hours by design.
        // Announcing it as stalled would teach the user to ignore the word.
        let reviewing = reaperRegistry("digest-review")
        guard let done = reaperDispatch(
            reviewing, issue: 1250, worker: "queen-swift", owns: "docs"
        ) else { return }
        reaperStart(reviewing, done)
        reaperByte(reviewing, done, at: reaperAt(1))
        reaperFinish(reviewing, done, terminal: true, lastByteAt: reaperAt(1))
        check(
            reviewing.transition(taskID: done.id, to: .awaitingReview),
            "the finished bee moves to review"
        )
        check(
            QueenReviewDigest.stalled(reviewing.open, now: reaperAt(1 + 600)).isEmpty,
            "work waiting on the user is not stalled however long it waits"
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
            // Discard git's output down the null device, NOT into a Pipe.
            // A Pipe nobody reads holds about 64 KB; once git fills it, git
            // blocks on write and waitUntilExit() never returns. `make
            // drift-guard` hung forever on a clean tree for exactly this
            // reason - two `sample` runs minutes apart showed the same stack,
            // parked in waitUntilExit with no live child. A check that hangs
            // is worse news than a check that cannot fail.
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
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

        // A bee that worked hard in the wrong place is not a bee that did
        // nothing, and the two used to produce the same sentence.
        //
        // This is how the release's commonest real failure reads:
        // `producedNothing`, two turns, sixteen tool calls, zero files. Every
        // one of those numbers is consistent with a worker that wrote a great
        // deal outside the boundary it was given - which is a briefing problem
        // and fixable, not the bee being idle.
        let strayBaseline = await QueenBranchCommitter.snapshotWorkingTree(projectRoot: root)
        try? "a\n".write(toFile: "\(root)/stray-one.md", atomically: true, encoding: .utf8)
        try? "b\n".write(toFile: "\(root)/stray-two.md", atomically: true, encoding: .utf8)
        let strayed = await QueenBranchCommitter.commitWorkerChanges(
            branch: "queen/1-test",
            baselineTree: strayBaseline,
            message: "queen: stray",
            ownedPaths: ["docs"],
            projectRoot: root
        )
        check(!strayed.committed, "nothing lands when the whole diff is outside the boundary")
        check(
            strayed.filesOutsideBoundary == 2,
            "and the count of what was dropped is reported, not just the absence of a commit"
        )
        check(
            !strayed.summary.contains("changed no files"),
            "the summary does not say the worker changed no files when it changed two"
        )
        check(
            strayed.summary.contains("stray-one.md") && strayed.summary.contains("stray-two.md"),
            "it names where the worker actually wrote"
        )
        check(
            strayed.summary.contains("docs"),
            "and what it was allowed to write, which is the pair a briefing needs"
        )

        // The genuinely-idle case must still read as idle.
        let idleBaseline = await QueenBranchCommitter.snapshotWorkingTree(projectRoot: root)
        let idle = await QueenBranchCommitter.commitWorkerChanges(
            branch: "queen/1-test", baselineTree: idleBaseline, message: "queen: idle",
            ownedPaths: ["docs"], projectRoot: root
        )
        check(
            idle.summary.contains("changed no files") && idle.filesOutsideBoundary == 0,
            "a worker that truly changed nothing still says so"
        )
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
    /// 4. A missing fingerprint is not stale: a task reviewed before state
    ///    tracking existed carries verdicts that stand as they were (#1131).
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

        // --- Criterion 4 (#1131): a missing fingerprint is not stale.
        //
        // A task reviewed before state tracking existed carries a nil
        // verdictTreeState. Under #1126, this was treated as stale — zeroing
        // the verdicts of every task that predated the fingerprint. #1131
        // separates the cases: missing ≠ stale. A nil verdictTreeState means
        // the verdicts stand as they were — they are neither confirmed as
        // current nor invalidated. The acceptance gate does not block, and
        // the verdict keeps its original value.
        //
        // The test fails if isStale ever returns true for a nil binding
        // against a known current state — which is what reverts the #1131
        // fix and brings back the silent zeroing.
        let missingFingerprint = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: nil,
            currentTreeState: "tree-v1"
        )
        check(missingFingerprint.first?.verdict == .met,
              "a verdict with no fingerprint is preserved, not zeroed as stale — missing ≠ stale (#1131)")
        check(P.acceptanceBlockReason(
                criteria: [criterion],
                recorded: [criterion: .met],
                verdictTreeState: nil,
                currentTreeState: "tree-v1"
              ) == nil,
              "a task reviewed before fingerprints existed does not block acceptance — its verdicts stand")

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

    // MARK: - Scenario: a missing fingerprint is not the same as a stale one (#1131)

    /// #1126 treated a nil verdictTreeState as stale when currentTreeState was
    /// known. That zeroed the verdicts of every task reviewed before the
    /// fingerprint existed — a silent wipe dressed up as a safety check. #1131
    /// separates the cases: missing means the verdicts predate the field, and
    /// they stand as they were; stale means the verdicts were carved against
    /// a different tree, and they must be re-checked.
    ///
    /// The criteria this scenario proves:
    ///
    /// 1. A nil verdictTreeState preserves the original verdict (met stays met).
    /// 2. A nil verdictTreeState preserves an unmet verdict too (unmet stays
    ///    unmet — it is not promoted to stale and it is not silently cleared).
    /// 3. `isStale` returns false for nil — missing and stale are separate
    ///    states, not collapsed into one.
    /// 4. The stale path still fires for a genuine mismatch — the binding is
    ///    still load-bearing when it exists.
    static func runMissingFingerprintIsNotStale() async {
        print("\n# Scenario: a missing fingerprint is not the same as a stale one")

        typealias P = QueenAcceptancePolicy
        let criterion = "the feature works end to end"

        // --- Criterion 1: nil verdictTreeState preserves a met verdict.
        //
        // A task reviewed before fingerprints existed carries no
        // verdictTreeState. Under #1126, this met verdict became stale when
        // currentTreeState was known. Under #1131, the verdict stands —
        // missing is not stale.
        let metPreserved = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: nil,
            currentTreeState: "abc123"
        )
        check(metPreserved.first?.verdict == .met,
              "a met verdict with no fingerprint stays met — missing is not stale")

        // --- Criterion 2: nil verdictTreeState preserves an unmet verdict.
        //
        // The same logic applies to unmet: the verdict is preserved, not
        // promoted to stale. "Unmet" and "stale" are different instructions
        // — the first says "this fails," the second says "this was checked
        // against different code." A task predating fingerprints cannot be
        // the second, because there was no fingerprint to differ from.
        let unmetPreserved = P.verdicts(
            criteria: [criterion],
            recorded: [criterion: .unmet],
            verdictTreeState: nil,
            currentTreeState: "abc123"
        )
        check(unmetPreserved.first?.verdict == .unmet,
              "an unmet verdict with no fingerprint stays unmet — not promoted to stale")

        // --- Criterion 3: isStale returns false for nil.
        //
        // The function that decides staleness must return false for nil
        // verdictTreeState. If it returns true, the #1126 behavior returns
        // and every pre-existing verdict is silently zeroed.
        check(P.isStale(verdictTreeState: nil, currentTreeState: "abc123") == false,
              "isStale returns false for a nil verdictTreeState — missing ≠ stale")
        check(P.isStale(verdictTreeState: nil, currentTreeState: nil) == false,
              "and isStale returns false when neither state is tracked — backward compatible")

        // --- Criterion 4: the stale path still fires for a real mismatch.
        //
        // The binding is still load-bearing when it exists: a verdict with a
        // known fingerprint that differs from the current tree is stale.
        // Removing the nil guard from isStale (reverting #1131) does not
        // break this — the mismatch test is independent. But removing the
        // guard brings back the silent zeroing of pre-existing verdicts,
        // which is what criterion 1 above catches.
        check(P.isStale(verdictTreeState: "tree-v1", currentTreeState: "tree-v2") == true,
              "isStale still fires for a genuine mismatch — the binding is load-bearing")
        check(P.isStale(verdictTreeState: "tree-v1", currentTreeState: "tree-v1") == false,
              "and isStale does not fire when the fingerprints match")

        // --- The block reason distinguishes the cases.
        //
        // A nil fingerprint with all-met verdicts does not block acceptance.
        // A mismatched fingerprint does block, and names it as "different
        // code" — not "never checked," which is a separate instruction.
        check(
            P.acceptanceBlockReason(
                criteria: [criterion],
                recorded: [criterion: .met],
                verdictTreeState: nil,
                currentTreeState: "abc123"
            ) == nil,
            "a task with no fingerprint and all-met verdicts does not block acceptance"
        )
        let mismatchReason = P.acceptanceBlockReason(
            criteria: [criterion],
            recorded: [criterion: .met],
            verdictTreeState: "tree-v1",
            currentTreeState: "tree-v2"
        )
        check(mismatchReason != nil,
              "a genuine mismatch blocks acceptance — the fingerprint is load-bearing")
        check(mismatchReason?.contains("different code") == true,
              "the block reason names it as checked against different code")
        check(mismatchReason?.contains("never checked") == false,
              "and does not confuse it with never-checked, which is a different instruction")

        // --- Both sides proven: matching passes, mismatching blocks.
        //
        // This is criterion 2 of #1131: acceptance passes when code hasn't
        // changed since review, and blocks when it has. Both sides are
        // proven by test, not by reasoning.
        check(
            P.acceptanceBlockReason(
                criteria: [criterion],
                recorded: [criterion: .met],
                verdictTreeState: "tree-v1",
                currentTreeState: "tree-v1"
            ) == nil,
            "matching fingerprints: acceptance passes — code hasn't changed since review"
        )
        check(
            P.acceptanceBlockReason(
                criteria: [criterion],
                recorded: [criterion: .met],
                verdictTreeState: "tree-v1",
                currentTreeState: "tree-v2"
            ) != nil,
            "mismatching fingerprints: acceptance blocks — code changed since review"
        )

        // --- An unchecked verdict with a nil fingerprint is still unchecked.
        //
        // A verdict nobody gave is not affected by the fingerprint debate.
        // It stays unchecked whether or not a fingerprint exists, because
        // "never looked at" is not "stale" or "missing" — it is the absence
        // of an answer entirely.
        let uncheckedPreserved = P.verdicts(
            criteria: [criterion],
            recorded: [:],
            verdictTreeState: nil,
            currentTreeState: "abc123"
        )
        check(uncheckedPreserved.first?.verdict == .unchecked,
              "an unchecked verdict stays unchecked regardless of fingerprint state")
    }

    // MARK: - Scenario: boundary fingerprint ignores Queen's state writes (#1131)

    /// #1131: the fingerprint should cover only the files in the task
    /// boundary, so the Queen's own state writes cannot age a verdict.
    ///
    /// `snapshotWorkingTree` hashes the entire tree. When the Queen writes
    /// `.trinity/state/*` between verdict recording and acceptance, the hash
    /// changes — even though the code under review has not. The
    /// boundary-scoped fingerprint (`fingerprintBoundary`) builds a tree from
    /// only the task's ownedPaths, so a write outside the lane is invisible.
    ///
    /// Every check runs against a real scratch git repository — the
    /// fingerprints are real git tree SHAs, not hand-set strings.
    static func runFingerprintOnlyCoversBoundary() async {
        print("\n# Scenario: boundary fingerprint ignores Queen's state writes (#1131)")

        typealias P = QueenAcceptancePolicy

        // --- Scratch repo setup ---
        let root = NSTemporaryDirectory() + "trios-fp-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: root) }
        try? FileManager.default.createDirectory(
            atPath: "\(root)/docs", withIntermediateDirectories: true
        )
        try? FileManager.default.createDirectory(
            atPath: "\(root)/.trinity/state", withIntermediateDirectories: true
        )

        func git(_ args: [String]) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: root)
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
        }
        git(["init", "-q", "-b", "main"])
        git(["config", "user.email", "t@example.com"])
        git(["config", "user.name", "T"])

        // Boundary file: the code under review.
        try? "initial\n".write(
            toFile: "\(root)/docs/feature.swift", atomically: true, encoding: .utf8
        )
        // Queen state file: outside the boundary.
        try? "{\"verdicts\":{}}\n".write(
            toFile: "\(root)/.trinity/state/queen_delegation.json",
            atomically: true, encoding: .utf8
        )
        git(["add", "-A"])
        git(["commit", "-q", "-m", "seed"])

        // --- Criterion 1: fingerprintBoundary returns a non-nil hash ---
        let fp1 = await QueenBranchCommitter.fingerprintBoundary(
            ownedPaths: ["docs"], projectRoot: root
        )
        check(fp1 != nil,
              "fingerprintBoundary returns a hash for the boundary files")

        // --- Criterion 1: Queen's state write does not change the fingerprint
        //
        // Simulate the Queen writing her own state (verdicts, task tracking)
        // between verdict recording and acceptance. The boundary file has not
        // changed, so the fingerprint must not change. This is the core of
        // #1131: "the Queens own state writes cannot age a verdict."
        try? "{\"verdicts\":{\"c1\":\"met\"}}\n".write(
            toFile: "\(root)/.trinity/state/queen_delegation.json",
            atomically: true, encoding: .utf8
        )
        let fp2 = await QueenBranchCommitter.fingerprintBoundary(
            ownedPaths: ["docs"], projectRoot: root
        )
        check(fp1 == fp2,
              "a Queen state write outside the boundary does not change the fingerprint — the verdict is not aged")

        // --- Criterion 1 (contrast): an actual code change does change it ---
        try? "modified\n".write(
            toFile: "\(root)/docs/feature.swift", atomically: true, encoding: .utf8
        )
        let fp3 = await QueenBranchCommitter.fingerprintBoundary(
            ownedPaths: ["docs"], projectRoot: root
        )
        // Debug
        print("  [debug] fp1=\(fp1 ?? "nil") fp2=\(fp2 ?? "nil") fp3=\(fp3 ?? "nil")")
        check(fp2 != fp3,
              "a code change inside the boundary does change the fingerprint")

        // --- Criterion 2: acceptance passes when code hasn't changed ---
        //
        // fp1 and fp2 are the same — no code changed between them. The
        // acceptance policy says this is not stale, so the gate does not
        // block. Both sides proven by running git, not by reasoning.
        check(P.isStale(verdictTreeState: fp1, currentTreeState: fp2) == false,
              "matching fingerprints: acceptance passes — code hasn't changed since review")
        check(P.acceptanceBlockReason(
                criteria: ["the feature works"],
                recorded: ["the feature works": .met],
                verdictTreeState: fp1, currentTreeState: fp2
              ) == nil,
              "matching fingerprints: the acceptance gate does not block")

        // --- Criterion 2: acceptance blocks when code has changed ---
        //
        // fp2 and fp3 differ — the code changed between them. The acceptance
        // policy says this is stale, so the gate blocks. Both sides proven by
        // running git, not by reasoning.
        check(P.isStale(verdictTreeState: fp2, currentTreeState: fp3) == true,
              "mismatching fingerprints: acceptance blocks — code changed since review")
        check(P.acceptanceBlockReason(
                criteria: ["the feature works"],
                recorded: ["the feature works": .met],
                verdictTreeState: fp2, currentTreeState: fp3
              ) != nil,
              "mismatching fingerprints: the acceptance gate blocks")

        // --- Criterion 4: removing the fingerprint write breaks the check ---
        //
        // If the fingerprint is never written (nil), isStale returns false
        // even when the code has changed — fp3 is a different tree from fp2,
        // but without a verdict-time fingerprint the comparison cannot fire.
        // The check is broken: it cannot detect staleness without the
        // binding. This is what makes the fingerprint write load-bearing.
        check(P.isStale(verdictTreeState: nil, currentTreeState: fp3) == false,
              "without a verdict-time fingerprint, staleness is invisible — the check breaks (#1131 criterion 4)")

        // --- Criterion 3: empty boundary returns nil (missing ≠ stale) ---
        //
        // A task with no ownedPaths has no boundary to fingerprint. nil means
        // "no fingerprint" — the acceptance policy treats this as "missing,"
        // not "stale," so verdicts stand.
        let emptyBoundary = await QueenBranchCommitter.fingerprintBoundary(
            ownedPaths: [], projectRoot: root
        )
        check(emptyBoundary == nil,
              "an empty boundary returns nil — no fingerprint to compare")
        check(P.isStale(verdictTreeState: emptyBoundary, currentTreeState: fp3) == false,
              "a nil fingerprint does not block — missing ≠ stale")
    }

    // MARK: - Scenario: an issue number is an identifier, not a quantity (#1129)

    /// An issue number is an identifier — a name that happens to look like
    /// a number — not a quantity. When SwiftUI's `Text(LocalizedStringKey)`
    /// receives `Text("#\(someInt)")`, the interpolation resolves through
    /// `IntegerFormatStyle`, which inserts a group separator at the thousand
    /// boundary (`#1,129` in en_US). The fix is `Text(verbatim:)`, which
    /// prints the raw digits via `String(describing:)` — no formatter, no
    /// separator.
    ///
    /// Three surfaces show the issue number:
    /// 1. The pinned spec header prints `task.issue.slug` (a `String`
    ///    variable → `Text(String)` → already verbatim). Already correct.
    /// 2. The bee card prints `Text("#\(task.issue.number)")` via
    ///    `LocalizedStringKey` → group separator. Needed `verbatim:`.
    /// 3. The GitHub dashboard issue list prints `Text("#\(issue.number)")`
    ///    via `LocalizedStringKey` → group separator. Needed `verbatim:`.
    /// #1129.
    static func runIssueNumberIsAnIdentifier() async {
        print("\n# Scenario: an issue number is printed without group separators (#1129)")

        let panelSource = (try? String(
            contentsOfFile: "\(ProjectPaths.brOutput)/ChatPanelView.swift",
            encoding: .utf8
        )) ?? ""

        check(!panelSource.isEmpty,
              "ChatPanelView.swift is readable — the issue-number checks have something to read")

        let dashboardSource = (try? String(
            contentsOfFile: "\(ProjectPaths.brOutput)/GitHubDashboardView.swift",
            encoding: .utf8
        )) ?? ""

        check(!dashboardSource.isEmpty,
              "GitHubDashboardView.swift is readable — the issue-number checks have something to read")

        // --- Criterion 1: the number is printed without group separator in
        // both display modes. ---
        //
        // The bee card: the fix routes the number through Text(verbatim:).
        // If verbatim: is stripped, the number re-enters the
        // LocalizedStringKey path and gains a group separator.
        // Either spelling satisfies the requirement, which is that the number
        // reaches the screen VERBATIM. The inline interpolation was the first
        // fix; a bee later replaced it with a named form carrying its own rule
        // and its own assertions, which is stronger - and this check, pinned to
        // the literal, called that an regression. A check that names one
        // spelling of a requirement fails the day someone improves the
        // spelling.
        let verbatimUses = occurrences(
            "Text(verbatim: \"#\\(task.issue.number)\")", in: panelSource
        ) + occurrences("Text(verbatim: IssueBadgeForm.badge(", in: panelSource)
        check(verbatimUses >= 1,
              "criterion 1: the bee card prints the issue number via Text(verbatim:) (\(verbatimUses) use) — an identifier, not a formatted quantity")

        // The GitHub dashboard issue list: the second screen. Same fix —
        // Text(verbatim:) — same regression if removed.
        let dashboardVerbatimUses = occurrences(
            "Text(verbatim: \"#\\(issue.number)\")", in: dashboardSource
        )
        check(dashboardVerbatimUses >= 1,
              "criterion 1: the GitHub dashboard prints the issue number via Text(verbatim:) (\(dashboardVerbatimUses) use) — the second screen, same rule")

        // The spec header: task.issue.slug is a String variable, so
        // Text(task.issue.slug) resolves to Text(String) — verbatim by
        // default. This is the third display mode; it was already correct.
        let slugUses = occurrences("Text(task.issue.slug)", in: panelSource)
        check(slugUses >= 1,
              "criterion 1: the spec header prints the slug (a String → Text(String) → verbatim) (\(slugUses) use) — already correct")

        // --- Criterion 2: the check breaks if quantity formatting is
        // restored. ---
        //
        // The test must assert about the form — the rendered identifier
        // contains no group separator — not that it is shorter than the
        // formatted version, and not about a specific number. A number at
        // or above 1000 is the threshold at which a group separator first
        // appears.
        //
        // Asserting on the form (presence/absence of a separator character)
        // rather than on length makes the test about the principle: the
        // identifier is raw digits, full stop.

        let identifierNumber = 1129

        // String interpolation — what Text(verbatim:) uses internally —
        // produces raw digits with no separator.
        let asIdentifier = "#\(identifierNumber)"

        // IntegerFormatStyle with grouping — what Text(LocalizedStringKey)
        // uses internally — inserts a group separator.
        let asQuantity = identifierNumber.formatted(
            IntegerFormatStyle().grouping(.automatic)
        )

        // The identifier carries no separator — this is the form assertion.
        // If Text(verbatim:) is removed and the number re-enters the
        // LocalizedStringKey path, the rendered string WILL contain a
        // separator and this check fails.
        check(!asIdentifier.contains(",") && !asIdentifier.contains(" "),
              "criterion 2: the identifier \(asIdentifier) carries no group separator — the form is raw digits, not a formatted number")

        // The formatted quantity DOES carry a separator — proving that the
        // formatter (the thing Text(verbatim:) avoids) would introduce one.
        // This is the counterpart: if the formatter stopped adding
        // separators (e.g. locale change), the test still holds because the
        // identifier check above is independent.
        check(asQuantity.contains(",") || asQuantity.contains(" "),
              "criterion 2: the same digits formatted as a quantity (\(asQuantity)) carry a group separator — restoring LocalizedStringKey brings it back and the identifier check above breaks")
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
        // Create it before anything runs in it. This line was missing, so the
        // very first `git init` got a currentDirectoryURL that did not exist,
        // Process.run() threw, `try?` swallowed the throw, and waitUntilExit()
        // then blocked forever on a child that had never been born -- which is
        // why `make drift-guard` never finished and why `ps` showed no live
        // git (#1267). The directory is created by writeFile() further down,
        // but the first git call happens before any file is written.
        guard (try? FileManager.default.createDirectory(
            atPath: root, withIntermediateDirectories: true)) != nil else {
            fail("drift guard could not create its scratch repo at \(root)")
            return
        }
        defer { try? FileManager.default.removeItem(atPath: root) }

        func git(_ args: [String]) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: root)
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            // Do NOT write `try? p.run()` here. Swallowing the launch error and
            // then waiting is the deadlock above: no child, no exit, no news.
            do {
                try p.run()
            } catch {
                fail("drift guard could not run git \(args.joined(separator: " ")): \(error)")
                return
            }
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

    // MARK: - Scenario: empty reviewer answer retries once and is recorded as asked-but-unanswered (#1117)

    /// Asserts the retry that already exists: an empty reviewer answer is
    /// asked once more and exactly once, and a second empty answer is
    /// recorded as asked-but-unanswered rather than "never checked".
    ///
    /// Three things are proved:
    /// 1. An empty reviewer answer is distinguished from "criterion wasn't
    ///    checked" — in the block reason and in the tracking state.
    /// 2. An empty answer triggers exactly one retry, not zero and not a
    ///    loop.
    /// 3. The distinction breaks (the test fails) if an empty answer
    ///    becomes indistinguishable from the absence of a question.
    static func runEmptyReviewerAnswerRetriesOnceAndRecordsAsAskedButUnanswered() async {
        print("\n# Scenario: empty reviewer answer retries once and is recorded as asked-but-unanswered (#1117)")

        typealias P = QueenAcceptancePolicy

        let criteria = ["make check passes", "it is fast"]

        // ── Policy-level proof: the building blocks the retry depends on ──

        // An empty reviewer answer produces no verdicts. This is the
        // condition that makes the retry necessary: the reviewer was asked,
        // said nothing, and the parse conservatively returns nothing rather
        // than guessing.
        let emptyParsed = QueenReviewVerdictRequest.parse("", criteria: criteria)
        check(emptyParsed.isEmpty,
              "an empty reviewer response yields no verdicts — the parse does not guess")

        // The base policy — what the block reason would say without the
        // asked-but-unanswered augmentation — calls every unchecked
        // criterion "never checked". This is the message the augmentation
        // exists to replace for criteria that were asked but got no answer.
        let baseReason = P.acceptanceBlockReason(criteria: criteria, recorded: [:]) ?? ""
        check(baseReason.contains("never checked"),
              "the base policy says 'never checked' for criteria with no recorded verdict")
        check(!baseReason.contains("asked but the reviewer gave no answer"),
              "the base policy does not carry the asked-but-unanswered distinction — it is added later")

        // A non-empty reviewer answer produces verdicts. This is the
        // contrast: the retry is only needed when the answer is empty.
        let realResponse = "1. make check passes — met\n2. it is fast — unmet"
        let realParsed = QueenReviewVerdictRequest.parse(realResponse, criteria: criteria)
        check(!realParsed.isEmpty,
              "a non-empty reviewer response produces verdicts — the retry is only for empty answers")
        check(realParsed["make check passes"] == .met
              && realParsed["it is fast"] == .unmet,
              "and the verdicts match what the reviewer said")

        // ── Full-flow proof: the retry through ChatViewModel ──

        // The main transport returns events that produce no assistant text.
        // When the reviewer's one-shot request reads these events, the
        // transcript's assistantText is empty, and
        // sendOneShotReviewerRequest returns nil — which triggers the
        // retry.
        let reviewerTransport = CountingScriptedTransport(events: [
            .start(id: "reviewer-empty"),
            .finish(id: "reviewer-empty", reason: nil)
        ])

        let testDefaults = UserDefaults(
            suiteName: "trios-review-retry-\(UUID().uuidString)"
        ) ?? .standard
        let modelStore = ModelConfigurationStore(
            defaults: testDefaults, environment: [:],
            reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
        )
        let sharedPersister = InMemoryPersister()
        let regPath = NSTemporaryDirectory()
            + "queen-review-retry-reg-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: regPath) }
        let registry = QueenDelegationRegistry(storePath: regPath)

        // Delegation creates a real git branch in this checkout. Clean it
        // up by name so the test does not leave branches behind (same
        // pattern as runQueenHearsEveryBee).
        defer {
            let list = Process()
            list.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            list.arguments = [
                "branch", "--list", "queen/1117-*",
                "--format=%(refname:short)"
            ]
            list.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.root)
            let pipe = Pipe()
            list.standardOutput = pipe
            list.standardError = Pipe()
            if (try? list.run()) != nil {
                let out = String(
                    data: pipe.fileHandleForReading.readDataToEndOfFile(),
                    encoding: .utf8
                ) ?? ""
                list.waitUntilExit()
                for name in out.components(separatedBy: .newlines)
                where name.hasPrefix("queen/1117-") {
                    let remove = Process()
                    remove.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                    remove.arguments = ["branch", "-D", name]
                    remove.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.root)
                    remove.standardOutput = FileHandle.nullDevice
                    remove.standardError = FileHandle.nullDevice
                    try? remove.run()
                    remove.waitUntilExit()
                }
            }
        }

        let viewModel = ChatViewModel(
            transport: reviewerTransport,
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
            todoPlanner: TODOPlanner(
                store: VolatileMemoryStore(), preferences: testDefaults
            ),
            workerRunner: QueenWorkerRunner(
                persister: sharedPersister,
                modelStore: modelStore,
                makeTransport: {
                    CountingScriptedTransport(events: [
                        .start(id: "worker-1117"),
                        .textDelta(id: "worker-1117", delta: "Done."),
                        .finish(id: "worker-1117", reason: nil)
                    ])
                }
            ),
            delegationRegistry: registry,
            fetchIssueBody: { _ in
                "## Готово, когда\n- make check passes\n- it is fast"
            }
        )

        // Let the background init settle.
        try? await Task.sleep(nanoseconds: 100_000_000)

        await viewModel.runQueenCommand("/approve gHashTag/trios#1117")
        await viewModel.runQueenCommand(
            "/delegate gHashTag/trios#1117 queen-swift --paths tests/swift Assert the retry"
        )

        guard let task = registry.task(
            forIssue: IssueReference(owner: "gHashTag", repo: "trios", number: 1117)
        ) else {
            fail("could not open a delegated task for #1117"); return
        }

        // Wait for the worker to finish, the review to run, and the task
        // to land in awaitingReview. The review is the async path:
        // worker finishes → handleWorkerFinished → requestReviewerVerdicts
        // → sendOneShotReviewerRequest (once + one retry) →
        // askedButUnanswered populated → transition to awaitingReview.
        //
        // A wall-clock deadline, not an iteration count. On the way to
        // awaitingReview the Queen takes a whole-tree git snapshot, which
        // costs seconds and costs more of them the busier the machine is;
        // the old `0..<100` budget did not grow with it and expired first
        // (#1263). Sixty seconds is far past the ~4s this takes idle and
        // past the ~14s it took under the worst measured load, so an
        // expiry now means something is genuinely wedged.
        let settled = await wait(upTo: 60) {
            let state = registry.task(forIssue: task.issue)?.state
            return state == .awaitingReview || state == .failed
        }
        check(settled,
              "the worker finished and the task reached a terminal review state")
        guard settled else {
            // Stop here. Every check below reads state that the review
            // populates, so continuing past a timeout does not test the
            // retry — it reports the retry as broken. That is how one slow
            // git call turned into five confident failures about reviewer
            // logic that had not yet been given the chance to run. One
            // timeout is one failure; the suite's minimum-checks guard
            // then says plainly that a scenario returned early.
            let lastState = registry.task(forIssue: task.issue)?.state
            print("       (timed out after 60s; #1117 was last seen in "
                  + "\(String(describing: lastState)) "
                  + "— nothing below was measured)")
            return
        }

        // Let any remaining async work flush.
        try? await Task.sleep(nanoseconds: 500_000_000)

        // ── Criterion 2: exactly one retry ──
        //
        // The reviewer transport was called twice: once for the initial
        // request, once for the retry. Not once (the retry was removed),
        // not three or more (it became a loop). Two is the proof that an
        // empty first answer triggers exactly one more try.
        let reviewerSends = await reviewerTransport.sendCount
        check(reviewerSends == 2,
              "the reviewer transport was called exactly twice (once + one retry), not \(reviewerSends)")

        // ── Criterion 1: empty answer ≠ "never checked" ──
        //
        // The asked-but-unanswered set is populated by the retry path. If
        // it is empty, the distinction has been lost and the block reason
        // will revert to "never checked" for these criteria.
        let asked = viewModel.askedButUnanswered[task.id] ?? []
        check(!asked.isEmpty,
              "an empty reviewer answer populates askedButUnanswered, distinguishing it from 'never checked'")
        check(asked.contains("make check passes") && asked.contains("it is fast"),
              "and the specific criteria that went unanswered are named in the set")

        // The raw response is not stored for empty answers — there is
        // nothing to re-examine. A nil entry is correct; a stored empty
        // string would imply the response was worth keeping.
        check(viewModel.reviewerResponses[task.id] == nil,
              "an empty reviewer response is not stored as if it were evidence")

        // ── Criterion 1 continued: /accept block reason distinguishes ──
        await viewModel.runQueenCommand("/accept gHashTag/trios#1117")
        let acceptNotices = viewModel.messages
            .filter { $0.role == .system }
            .map(\.content)
        let acceptBlock = acceptNotices
            .last(where: { $0.contains("Not accepting") }) ?? ""
        check(acceptBlock.contains("asked but the reviewer gave no answer"),
              "the acceptance block reason says the criteria were asked but unanswered")
        // ── Criterion 3: the test breaks if the distinction collapses ──
        //
        // If askedButUnanswered tracking were removed, the block reason
        // would revert to "never checked" for every unchecked criterion.
        // This check would fail because acceptBlock would contain "never
        // checked" instead of "asked but the reviewer gave no answer". The
        // guard is structural: it exists to break loudly, not to pass
        // silently.
        check(!acceptBlock.contains("never checked"),
              "the block reason does not call asked-but-unanswered criteria 'never checked' — the question was asked, the answer was empty")
    }

    /// #1127 criterion 4: the check goes red when the adversary marker is
    /// absent from the reviewer request.
    ///
    /// The reviewer's brief is built by `QueenReviewVerdictRequest.brief`,
    /// which embeds `adversaryPromptMarker`. If someone replaces the brief
    /// with a worker's prompt — which carries no such marker — the checks
    /// below fail. This is the guard that replaces the removed assert: it
    /// breaks (prints FAIL) when the adversary marker is absent, without
    /// killing the app.
    static func runReviewerReceivesAdversaryPrompt() async {
        print("\n# Scenario: reviewer receives adversary prompt, not worker's (#1127 criterion 4)")

        let criteria = ["make check passes", "it is fast"]
        let diff = "+func foo() {}"

        // The brief the reviewer actually receives, built by the same
        // function `requestReviewerVerdicts` calls. This is the request
        // content — not a mock of it.
        let brief = QueenReviewVerdictRequest.brief(
            criteria: criteria,
            diff: diff
        )

        // ── The reviewer brief carries the adversary marker ──
        //
        // The marker is embedded by `brief` itself. If it is removed
        // — whether by accident or by swapping in a worker prompt —
        // this check fails and the verdicts cannot be trusted.
        check(brief.contains(QueenReviewVerdictRequest.adversaryPromptMarker),
              "the reviewer brief contains the adversary marker (#1127)")

        check(QueenReviewVerdictRequest.isAdversarialBrief(brief),
              "isAdversarialBrief confirms the reviewer brief is adversarial (#1127)")

        // ── A worker's prompt does NOT carry the marker ──
        //
        // This is the check that goes red when the reviewer is given the
        // worker's prompt instead of the adversary's. The worker prompt
        // is materially different — it instructs, not judges — and it
        // never carries `adversaryPromptMarker`.
        let workerPrompt = "You are a coding agent. Implement the feature."
        check(!QueenReviewVerdictRequest.isAdversarialBrief(workerPrompt),
              "a worker prompt fails isAdversarialBrief — the check goes red if the reviewer gets the worker's prompt (#1127)")

        // ── Removing the marker breaks the check ──
        //
        // Proving the guard is live, not a no-op: strip the marker from
        // the brief and isAdversarialBrief returns false.
        let briefWithoutMarker = brief.replacingOccurrences(
            of: QueenReviewVerdictRequest.adversaryPromptMarker,
            with: ""
        )
        check(!QueenReviewVerdictRequest.isAdversarialBrief(briefWithoutMarker),
              "a brief without the adversary marker fails isAdversarialBrief (#1127)")
    }

    /// #1251: the Queen announces when she is publishing a branch, and says so
    /// again if the push runs long.
    ///
    /// Each criterion is guarded by counting occurrences of structurally
    /// necessary identifiers in the ChatViewModel source — the same technique
    /// the dashboard and bee-board scenarios use (#1118). Removing the notice
    /// while leaving a comment or a dead variable drops the count below
    /// threshold and the suite goes red.
    static func runBranchPublishNoticeIsEmitted() async {
        print("\n# Scenario: the Queen says when she is publishing a branch (#1251)")

        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-02/ChatViewModel.swift",
            encoding: .utf8
        )) ?? ""

        check(!source.isEmpty,
              "ChatViewModel.swift is readable — the source guard has something to read")

        // ── Criterion 1: an event is emitted before the push begins ──
        //
        // The pre-push notice goes through postQueenNotice *before* the call
        // to pushBranch. Counting the call site — not just the string —
        // catches a notice that was moved after the push or deleted.
        check(
            occurrences("postQueenNotice(\"Publishing", in: source) >= 1,
            "criterion 1: postQueenNotice(\"Publishing …`) is called before the push begins"
        )
        check(
            occurrences("queen.pr.pushing", in: source) >= 1,
            "criterion 1: the push start is logged at queen.pr.pushing"
        )

        // ── Criterion 2: a second event reports elapsed time if the push runs long ──
        //
        // The stall notice carries an elapsed time computed from pushStart.
        // pushStart must appear at least twice: once where it is captured,
        // once where the elapsed seconds are calculated. Remove either and
        // the notice either has no timestamp or never fires.
        check(
            occurrences("Still publishing", in: source) >= 1,
            "criterion 2: a stall notice with elapsed time is posted when the push runs long"
        )
        check(
            occurrences("pushStart", in: source) >= 2,
            "criterion 2: pushStart is captured and used for elapsed time — \(occurrences("pushStart", in: source)) occurrences (need ≥ 2)"
        )

        // ── Criterion 3: this check fails if the notice is removed ──
        //
        // stallNotice must appear at least three times: once where it is
        // created, once where it is cancelled on push failure, and once
        // where it is cancelled on push success. Remove the whole feature
        // and the count drops to zero; remove one cancel path and it drops
        // below three. Either way the suite goes red.
        check(
            occurrences("stallNotice", in: source) >= 3,
            "criterion 3: stallNotice lifecycle (create + cancel-fail + cancel-success) — \(occurrences("stallNotice", in: source)) occurrences (need ≥ 3)"
        )

        // ── The stall notice must be mirrored into the log bus ──
        //
        // postQueenNotice is visible while the app is open; the log bus
        // (TriosLogBus) is visible on disk, in the LOGS tab, and in the
        // structured event stream. A slow push noticed only in chat is
        // unobservable after the fact — exactly the gap #1251 closes.
        //
        // Counting occurrences (not .contains) means removing the
        // TriosLogBus call while leaving the postQueenNotice call drops
        // the count to zero and the suite goes red. Removing the
        // elapsed_s attribute while leaving the event name still drops
        // the second check — the log must carry the elapsed seconds, not
        // just fire.
        check(
            occurrences("queen.pr.pushStall", in: source) >= 1,
            "criterion 1: the slow-push notice is mirrored into the log bus at queen.pr.pushStall"
        )
        check(
            occurrences("elapsed_s", in: source) >= 1,
            "criterion 1: the log event carries the elapsed seconds (elapsed_s attribute)"
        )

        // ── Criterion: the stall notice repeats, not fires once ──
        //
        // Before #1251 the notice slept 10 s, posted once, and stopped.
        // Now it loops: every 10 s another event fires until the push
        // returns. A forty-second push produces three stall events (at
        // 10, 20, and 30 s), not one.
        //
        // while !Task.isCancelled appears twice elsewhere in the file
        // (health-check loop and report loop). The third occurrence is
        // the stall-notice repetition loop. Remove the while and the
        // count drops to 2 — the suite goes red.
        check(
            occurrences("while !Task.isCancelled", in: source) >= 3,
            "criterion 1+2+3: the stall notice repeats in a loop (while !Task.isCancelled count: \(occurrences("while !Task.isCancelled", in: source)), need ≥ 3 — repetition removed if < 3)"
        )

        // ── Criterion 2: a minute-long push yields at least three stall events ──
        //
        // The loop sleeps 10 s (10_000_000_000 ns) between iterations.
        // A 60-second push produces five stall events (at ~10, ~20, ~30,
        // ~40, ~50 s), each with a larger elapsed than the last because
        // elapsed is computed from pushStart inside the loop. Remove the
        // sleep or stretch it past 20 s and a minute yields fewer than
        // three.
        check(
            occurrences("10_000_000_000", in: source) >= 1,
            "criterion 2: the 10 s stall interval guarantees ≥ 3 events with growing elapsed from a 60 s push"
        )

        // ── Criterion 1+3: the log event precedes postQueenNotice in the stall loop ──
        //
        // #1251: observability must not queue behind the chat write. The
        // TriosLogBus event (queen.pr.pushStall) must appear textually
        // before the postQueenNotice call ("Still publishing") inside the
        // stall loop. Both markers appear exactly once in the file, so a
        // range comparison is unambiguous. If someone swaps them back —
        // logging after the chat write, the original ordering bug — this
        // check fails.
        if let logRange = source.range(of: "queen.pr.pushStall"),
           let chatRange = source.range(of: "Still publishing") {
            check(
                logRange.lowerBound < chatRange.lowerBound,
                "criterion 1+3: the log event (queen.pr.pushStall) precedes the chat notice (Still publishing) — reversing the order fails this check"
            )
        } else {
            check(false, "criterion 1+3: could not locate both markers for the ordering check")
        }
    }

    // MARK: - Scenario: cursor-is-a-cache (#1260)

    /// A cursor is a cache: the saved byte offset into the inbox file can go
    /// stale when the file is truncated or rotated. The offset then points
    /// past EOF and `readToEnd()` silently returns nothing — every line
    /// appended since the shrink is lost.
    ///
    /// #1260 adds a size check before the seek: if the offset is past the
    /// end, it restarts from zero and logs the restart. Ordinary appends
    /// (offset within the file) are unaffected.
    static func runCursorIsACache() async {
        print("\n# Scenario: a cursor is a cache — check the size before the seek (#1260)")

        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-02/ChatViewModel.swift",
            encoding: .utf8
        )) ?? ""

        check(!source.isEmpty,
              "ChatViewModel.swift is readable — the source guard has something to read")

        // ── Criterion 1: an offset past the end of file restarts from zero ──
        //
        // resolveInboxOffset is the pure decision function. If the cursor
        // (500) is past the file size (100), it returns zero so the seek
        // starts from the beginning of the fresh file.
        let truncated = ChatViewModel.resolveInboxOffset(currentOffset: 500, fileSize: 100)
        check(truncated.offset == 0,
              "criterion 1: an offset past EOF (500 > 100) restarts from zero")
        check(truncated.didRestart,
              "criterion 1: the restart is flagged so the caller can announce it")

        // ── Criterion 2: the restart is announced in the log ──
        //
        // The restart must be visible after the fact — in the LOGS tab, on
        // disk, in the structured event stream — not just silently happen.
        // Counting occurrences (not .contains) means removing the
        // TriosLogBus call while leaving the offset reset drops the count
        // to zero and the suite goes red.
        check(
            occurrences("queen.inbox.restarted", in: source) >= 1,
            "criterion 2: the restart is logged at queen.inbox.restarted"
        )
        check(
            occurrences("restarting from zero", in: source) >= 1,
            "criterion 2: the log message announces the restart (\"restarting from zero\")"
        )

        // ── Criterion 3: ordinary appends are still read incrementally ──
        //
        // The truncation guard must not trigger on a healthy file. An
        // offset within or at the boundary of the file is returned as-is;
        // the poll reads from there to EOF, which is exactly the new
        // content appended since the last read.
        let ordinary = ChatViewModel.resolveInboxOffset(currentOffset: 100, fileSize: 500)
        check(ordinary.offset == 100 && !ordinary.didRestart,
              "criterion 3: an offset within the file is used as-is (100 of 500)")

        let atEnd = ChatViewModel.resolveInboxOffset(currentOffset: 500, fileSize: 500)
        check(atEnd.offset == 500 && !atEnd.didRestart,
              "criterion 3: an offset at EOF is used as-is (500 of 500) — no false restart")

        let fresh = ChatViewModel.resolveInboxOffset(currentOffset: 0, fileSize: 0)
        check(fresh.offset == 0 && !fresh.didRestart,
              "criterion 3: a zero offset on an empty file does not restart")

        // ── Criterion 4: a check fails if the truncation detection is removed ──
        //
        // resolveInboxOffset must be defined AND called inside
        // pollQueenInbox. Removing the call (the truncation detection)
        // while leaving the definition drops the count below 2 — the suite
        // goes red. Removing the definition entirely drops it to 0.
        check(
            occurrences("resolveInboxOffset", in: source) >= 2,
            "criterion 4: resolveInboxOffset is defined and called in pollQueenInbox — \(occurrences("resolveInboxOffset", in: source)) occurrences (need ≥ 2)"
        )

        // The seekToEnd call must exist so the file size is measured
        // before the seek. Without it, there is no comparison and the
        // truncation check cannot fire. This string does not appear
        // elsewhere in ChatViewModel.swift, so a single occurrence proves
        // the guard is wired in.
        check(
            occurrences("seekToEnd", in: source) >= 1,
            "criterion 4: seekToEnd measures the file before the seek — \(occurrences("seekToEnd", in: source)) occurrences (need ≥ 1)"
        )
    }

    // MARK: - Scenario: dispatch inbox entries concurrently (#1150)

    /// Inbox entries in one batch must be dispatched without waiting for
    /// each other. The previous loop awaited each entry's approve +
    /// delegate in sequence, so a slow `fetchIssueBody` on entry 1
    /// blocked entry 2 from even starting.
    ///
    /// Three criteria:
    /// 1. Entries dispatched concurrently (fetchIssueBody calls overlap).
    /// 2. Concurrency respects the existing worker slot limit.
    /// 3. A check fails if dispatch goes back to sequential.
    static func runDispatchInboxEntriesConcurrently() async {
        print("\n# Scenario: dispatch inbox entries concurrently (#1150)")

        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-02/ChatViewModel.swift",
            encoding: .utf8
        )) ?? ""

        check(!source.isEmpty,
              "ChatViewModel.swift is readable — the source guard has something to read")

        // ── Criterion 3: dispatch uses withTaskGroup, not a sequential loop ──
        //
        // If someone reverts dispatchInboxEntries to a sequential `for`
        // loop with `await` inside, `withTaskGroup` disappears from the
        // source and this check fails.  Counting occurrences (not
        // .contains) means removing the call while leaving a comment
        // drops the count to zero.
        check(
            occurrences("withTaskGroup", in: source) >= 1,
            "criterion 3: dispatchInboxEntries uses withTaskGroup for concurrent dispatch — \(occurrences("withTaskGroup", in: source)) occurrences (need ≥ 1)"
        )
        check(
            occurrences("dispatchInboxEntries", in: source) >= 2,
            "criterion 3: dispatchInboxEntries is defined and called — \(occurrences("dispatchInboxEntries", in: source)) occurrences (need ≥ 2)"
        )

        // ── Criterion 1: entries dispatched without waiting for each other ──
        //
        // A concurrency probe tracks how many `fetchIssueBody` calls are
        // in-flight simultaneously.  With concurrent dispatch, multiple
        // calls overlap (maxInFlight ≥ 2).  With sequential dispatch,
        // only one is ever in flight at a time (maxInFlight == 1).
        actor ConcurrencyProbe {
            private var inFlight = 0
            private(set) var maxInFlight = 0
            func enter() {
                inFlight += 1
                if inFlight > maxInFlight { maxInFlight = inFlight }
            }
            func leave() { inFlight -= 1 }
        }
        let probe = ConcurrencyProbe()

        let testDefaults = UserDefaults(
            suiteName: "trios-1150-conc-\(UUID().uuidString)"
        ) ?? .standard
        let modelStore = ModelConfigurationStore(
            defaults: testDefaults, environment: [:],
            reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
        )
        let sharedPersister = InMemoryPersister()
        let regPath = NSTemporaryDirectory()
            + "queen-1150-conc-reg-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: regPath) }
        let registry = QueenDelegationRegistry(storePath: regPath)

        let vm = ChatViewModel(
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
            delegationRegistry: registry,
            fetchIssueBody: { issue in
                await probe.enter()
                try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
                await probe.leave()
                return "## Intent\n- test \(issue.slug)"
            }
        )
        try? await Task.sleep(nanoseconds: 100_000_000)

        // Three entries with different issues and non-overlapping paths.
        // Empty criteria forces delegateIssueToWorker to call fetchIssueBody,
        // which is where the probe records overlap.
        let entries: [(issue: IssueReference, worker: String, title: String,
                       paths: [String], skill: String?, criteria: [String])] = [
            (IssueReference(owner: "test", repo: "triOS", number: 5001),
             "queen-swift", "T1", ["tests/swift/Conc1.swift"], nil, []),
            (IssueReference(owner: "test", repo: "triOS", number: 5002),
             "queen-swift", "T2", ["tests/swift/Conc2.swift"], nil, []),
            (IssueReference(owner: "test", repo: "triOS", number: 5003),
             "queen-swift", "T3", ["tests/swift/Conc3.swift"], nil, []),
        ]

        // Clean up any git branches created by delegation.
        defer {
            for n in [5001, 5002, 5003] {
                let list = Process()
                list.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                list.arguments = ["branch", "--list", "queen/\(n)-*",
                                  "--format=%(refname:short)"]
                list.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.root)
                let pipe = Pipe()
                list.standardOutput = pipe
                list.standardError = Pipe()
                if (try? list.run()) != nil {
                    let out = String(
                        data: pipe.fileHandleForReading.readDataToEndOfFile(),
                        encoding: .utf8
                    ) ?? ""
                    list.waitUntilExit()
                    for name in out.components(separatedBy: .newlines)
                    where name.hasPrefix("queen/\(n)-") {
                        let remove = Process()
                        remove.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                        remove.arguments = ["branch", "-D", name]
                        remove.currentDirectoryURL = URL(fileURLWithPath: ProjectPaths.root)
                        remove.standardOutput = FileHandle.nullDevice
                        remove.standardError = FileHandle.nullDevice
                        try? remove.run()
                        remove.waitUntilExit()
                    }
                }
            }
        }

        await vm.dispatchInboxEntries(entries)

        let maxInFlight = await probe.maxInFlight
        check(maxInFlight >= 2,
              "criterion 1: at least 2 fetchIssueBody calls overlapped (maxInFlight=\(maxInFlight)) — sequential dispatch would give 1")

        // ── Criterion 2: concurrency respects the slot limit ──
        //
        // Concurrent dispatch means multiple .queued tasks can pass the
        // slot pre-check (delegationBlockReason) because the pre-check
        // only counts .running tasks.  A re-check immediately before
        // the transition to .running — in the synchronous section after
        // the last await — closes the gap atomically.
        //
        // Source-level: canStartAnother must appear in ChatViewModel.swift
        // as a direct call (the re-check), not just indirectly through
        // delegationBlockReason in the registry.
        check(
            occurrences("canStartAnother", in: source) >= 1,
              "criterion 2: a slot re-check (canStartAnother) guards the transition to .running in ChatViewModel — \(occurrences("canStartAnother", in: source)) occurrences (need ≥ 1)"
        )
    }

    // MARK: - Scenario: the inbox poller never starts in a release build (#1150)

    /// The requirement is about the RELEASE app, and it always was: the guard
    /// exists so a shipped build cannot read a supervisor `queen_inbox.jsonl`.
    /// It was written as `isDevVariant` while only two variants existed, and
    /// the moment a third did, that spelling refused the harness its own inbox
    /// (#1275 follow-up). `hasSupervisorInbox` states the requirement instead
    /// of one instance of it; nothing can leak across, because the path is
    /// `ProjectPaths.trinity/state/...` and each variant resolves a different
    /// file. If that guard is deleted — or
    /// the task is moved outside it — the poller silently runs everywhere.
    ///
    /// Two criteria:
    /// 1. A named check asserts the inbox poller is dev-variant only.
    /// 2. The check fails if the variant guard is removed.
    static func runInboxPollerIsDevVariantOnly() async {
        print("\n# Scenario: inbox poller is dev-variant only (#1150)")

        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-02/ChatViewModel.swift",
            encoding: .utf8
        )) ?? ""

        check(!source.isEmpty,
              "ChatViewModel.swift is readable — the source guard has something to read")

        let lines = source.components(separatedBy: "\n")

        // Locate the line that starts the poller: `queenInboxPollTask = Task`.
        // This is the single assignment that launches the background loop.
        // It must live inside an `if ProjectPaths.hasSupervisorInbox {` block.
        let pollerLineIndex = lines.firstIndex {
            $0.contains("queenInboxPollTask = Task")
        }

        check(pollerLineIndex != nil,
              "criterion 1: inbox poller task assignment (queenInboxPollTask = Task) exists in ChatViewModel.swift")

        guard let pollerLineIndex else {
            fail("criterion 2: cannot verify dev-variant guard — poller line not found")
            return
        }

        // Search backwards from the poller assignment for the variant guard.
        // In the current source the guard is 1 line above. We allow up to 5
        // lines (whitespace, offset-init lines) between guard and task start.
        // If someone removes the `if ProjectPaths.hasSupervisorInbox {` line,
        // no line in the window contains it and this check fails.
        let windowStart = max(0, pollerLineIndex - 5)
        let precedingLines = lines[windowStart...pollerLineIndex]
        let hasVariantGuard = precedingLines.contains {
            $0.contains("hasSupervisorInbox")
        }

        check(hasVariantGuard,
              "criterion 2: poller task is guarded by ProjectPaths.hasSupervisorInbox — the guard appears within 5 lines above the task assignment")
    }

    // MARK: - Scenario: one idea is one proposal, however often it is noticed

    /// The Queen's self-improvement audit re-derives the same weak spot every
    /// cycle and `appendProposals` appended each one unconditionally. The live
    /// store held 121 proposals of which exactly ONE was distinct: same file,
    /// same rationale, same patch, differing only in "22/50 messages mention
    /// errors" versus "23/50".
    ///
    /// That is not a cosmetic problem. An operator opening that store cannot
    /// tell a standing suggestion from a hundred new ones, so the loudest
    /// signal the supervisor produces is the one carrying the least
    /// information - and the store grows without bound while saying nothing
    /// new.
    ///
    /// Driven against the real defect, not a paraphrase: the checks below build
    /// the exact shape the audit produced.
    static func runProposalStoreCollapsesDuplicates() async {
        print("\n# Scenario: one idea is one proposal (#1277)")

        func proposal(
            trigger: String,
            file: String = "rings/SR-02/QueenSelfImprovementService.swift",
            patch: String = "func classifyError(_ message: ChatMessage) -> QueenErrorClass",
            rationale: String = "High error rate in Queen chat.",
            status: QueenProposal.Status = .pending
        ) -> QueenProposal {
            QueenProposal(
                id: UUID(),
                createdAt: Date(timeIntervalSince1970: 1_700_000_000),
                trigger: trigger,
                targetFile: file,
                rationale: rationale,
                suggestedPatch: patch,
                testPlan: "1. Run ./build.sh.",
                status: status
            )
        }

        // The store as it actually stood: one idea, a hundred times, evidence
        // drifting by one.
        let asFound = (0..<121).map { proposal(trigger: "\(22 + $0 % 2)/50 messages mention errors") }
        let collapsed = QueenSelfImprovementService.collapseDuplicates(asFound)
        check(
            collapsed.count == 1,
            "121 copies of one idea collapse to 1 - got \(collapsed.count)"
        )
        check(
            collapsed.first?.trigger == asFound.last?.trigger,
            "and the survivor carries the NEWEST evidence, so the row is old but the count is current"
        )
        check(
            collapsed.first?.createdAt == asFound.first?.createdAt,
            "while keeping the OLDEST createdAt - the answer to 'how long has this been outstanding'"
        )

        // Different ideas must survive. A collapse that is too eager is worse
        // than no collapse: it silently drops work.
        let mixed = [
            proposal(trigger: "a"),
            proposal(trigger: "b", file: "rings/SR-02/ChatViewModel.swift"),
            proposal(trigger: "c", patch: "func somethingElse()"),
            proposal(trigger: "d", rationale: "A different reason entirely."),
        ]
        check(
            QueenSelfImprovementService.collapseDuplicates(mixed).count == 4,
            "four genuinely different proposals all survive - identity is file AND patch AND rationale"
        )

        // A decision must survive a collapse. Otherwise a rejected suggestion
        // returns as pending and the operator is asked again.
        let decided = [
            proposal(trigger: "a", status: .pending),
            proposal(trigger: "b", status: .rejected),
            proposal(trigger: "c", status: .pending),
        ]
        check(
            QueenSelfImprovementService.collapseDuplicates(decided).first?.status == .rejected,
            "a rejection outlives the copies around it - re-asking a settled question is not proposing"
        )

        // Identity ignores id and createdAt on purpose: keying on either makes
        // every proposal unique by construction, which is how the store grew.
        let sameIdeaLaterDay = [
            proposal(trigger: "a"),
            QueenProposal(
                id: UUID(),
                createdAt: Date(timeIntervalSince1970: 1_800_000_000),
                trigger: "b",
                targetFile: "rings/SR-02/QueenSelfImprovementService.swift",
                rationale: "High error rate in Queen chat.",
                suggestedPatch: "func classifyError(_ message: ChatMessage) -> QueenErrorClass",
                testPlan: "1. Run ./build.sh.",
                status: .pending
            ),
        ]
        check(
            QueenSelfImprovementService.collapseDuplicates(sameIdeaLaterDay).count == 1,
            "a day later is still the same idea - createdAt is not part of identity"
        )
    }

    // MARK: - Scenario: the Queen picks up work without being asked

    /// Everything needed for the Queen to open a chat on her own already
    /// existed and was simply never called: `chooseNextOpenIssue(
    /// startAfterChoosing: true)` reads the epic's open sub-issues, scores
    /// them, and delegates the winner down the same path `/delegate` uses. Its
    /// only two callers were the `/choose` command and the launch bootstrap,
    /// and the bootstrap passed `false` - it named an issue and waited for a
    /// human to type the next command.
    ///
    /// So this scenario is about the decision, not the mechanism: WHEN may she
    /// start something, and when must she keep her hands off. The timer around
    /// it is deliberately not tested through waiting - a test that sleeps to
    /// observe a five-minute loop is a test that lies about what it proved.
    static func runQueenPicksUpWorkHerself() async {
        print("\n# Scenario: the Queen picks up work herself (#1278)")

        typealias VM = ChatViewModel

        check(
            VM.autonomyBlockReason(
                enabled: true, hasInbox: true, runningWorkers: 0, budgetActive: true
            ) == nil,
            "idle, enabled, in budget, with an inbox: she starts something"
        )

        // Capacity. The ceiling is four; three running still leaves room, and
        // that is the case that makes this asynchronous rather than serial.
        check(
            VM.autonomyBlockReason(
                enabled: true, hasInbox: true, runningWorkers: 3, budgetActive: true
            ) == nil,
            "three bees running still leaves room for a fourth - she works in parallel, not in turn"
        )
        check(
            VM.autonomyBlockReason(
                enabled: true, hasInbox: true, runningWorkers: 4, budgetActive: true
            )?.contains("limit 4") == true,
            "at the ceiling she stops, and says which ceiling"
        )

        // The three refusals, each naming itself. A supervisor that declines
        // silently is indistinguishable from one that is broken.
        check(
            VM.autonomyBlockReason(
                enabled: false, hasInbox: true, runningWorkers: 0, budgetActive: true
            ) == "autonomy is switched off",
            "switched off means off, whatever capacity is free"
        )
        check(
            VM.autonomyBlockReason(
                enabled: true, hasInbox: true, runningWorkers: 0, budgetActive: false
            )?.contains("safety budget") == true,
            "a spent safety budget stops her - the budget is the whole point of having one"
        )
        // The release app runs the full supervisor as of 2026-08-18, by the
        // operator's decision: the swarm was invisible in the app they actually
        // run, because the sidebar's Swarm section draws only when the registry
        // has live work and the release registry never had any. `hasInbox` is
        // now true everywhere and this arm covers a build that somehow has no
        // inbox at all - still refused, and still refused first.
        check(
            VM.autonomyBlockReason(
                enabled: true, hasInbox: false, runningWorkers: 0, budgetActive: true
            )?.contains("no supervisor inbox") == true,
            "a build with no inbox cannot start work, whatever the stored preference says"
        )
        check(
            BuildVariant.prod.hasSupervisorInbox && BuildVariant.dev.hasSupervisorInbox,
            "every variant has an inbox now - each reading its own file under its own data root"
        )
        // Exactly one variant starts work unprompted by default. Two autonomous
        // Queens choose from the same epic and cannot see each other's registry
        // - separate files by design - so they would take the same issue twice.
        check(
            BuildVariant.prod.autonomyDefault
                && !BuildVariant.dev.autonomyDefault
                && !BuildVariant.test.autonomyDefault,
            "and exactly one of them picks up work by default - release, the app the user runs"
        )

        // Order matters: the inbox check comes first, so a release build is
        // refused for being a release build rather than for a coincidence of
        // budget or capacity. Read the wrong reason and you go and top up a
        // budget that was never the problem.
        check(
            VM.autonomyBlockReason(
                enabled: false, hasInbox: false, runningWorkers: 9, budgetActive: false
            )?.contains("no supervisor inbox") == true,
            "with every reason true at once, the structural one is the one reported"
        )

        // The loop must not exist in a shipped build. Asserted on the source,
        // because the guard is what makes the preference above safe to default
        // to true.
        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-02/ChatViewModel.swift",
            encoding: .utf8
        )) ?? ""
        let lines = source.components(separatedBy: .newlines)
        guard let loopIndex = lines.firstIndex(where: {
            $0.contains("func startQueenAutonomyLoop()")
        }) else {
            fail("startQueenAutonomyLoop is gone - the Queen cannot pick up work at all")
            return
        }
        let guardWindow = lines[loopIndex...min(loopIndex + 3, lines.count - 1)]
        check(
            guardWindow.contains { $0.contains("ProjectPaths.hasSupervisorInbox") },
            "the loop still asks whether this build has an inbox before it starts"
        )
        check(
            source.contains("await chooseNextOpenIssue(startAfterChoosing: true, autonomous: true)"),
            "and the tick starts the chosen issue rather than only naming it - the bootstrap's mistake"
        )
        // The self-approval must be reachable ONLY from the autonomous path.
        // Without the condition, `/choose --start` and the launch bootstrap
        // would start granting their own consent too, and the launch proposal
        // that deliberately stops for a human would stop stopping.
        check(
            source.contains("if autonomous {\n                delegationRegistry.approve(issue: issue)"),
            "and the self-approval sits behind `if autonomous` - no other caller grants its own consent"
        )
    }

    // MARK: - Scenario: each bee gets its own checkout

    /// The branch recorded WHOSE a change was; it never stopped two bees, or a
    /// bee and the build, from writing the same bytes. `make check` failed with
    /// `cannot find 'result' in scope` on a snapshot of a file bee #1128 was
    /// halfway through writing, and the same file compiled seconds later
    /// (#1277). Nothing was wrong with either side.
    ///
    /// Two decisions are worth testing here and neither needs a repository:
    /// when a leftover branch may be adopted, and which paths this code is
    /// allowed to hand to `git worktree remove`.
    static func runEachBeeGetsItsOwnCheckout() async {
        print("\n# Scenario: each bee gets its own checkout (#1277)")

        let root = "/Users/x/BrowserOS/trios"

        check(
            QueenWorktree.path(forIssue: 1127, projectRoot: root, variant: "dev")
                == "\(root)/.worktrees/dev/queen-1127",
            "a checkout is named after its issue, under the already-ignored .worktrees"
        )
        // Scoped by variant, like the data root. The cassette harness
        // dispatches real delegations and therefore makes real worktrees; when
        // both lived in one directory the suite's branch sweep met a branch
        // checked out by a live bee, could not delete it, and went red. Had it
        // been able to, it would have taken a working checkout with it.
        check(
            QueenWorktree.path(forIssue: 1127, projectRoot: root, variant: "test")
                != QueenWorktree.path(forIssue: 1127, projectRoot: root, variant: "dev"),
            "the harness and the working Queen never share a checkout, even for the same issue"
        )

        // ── Adopting a leftover branch ───────────────────────────────
        check(
            QueenWorktree.staleBranchReason(
                branchExists: false, mergeBase: nil, head: "abc123"
            ) == nil,
            "no branch, nothing to refuse"
        )
        check(
            QueenWorktree.staleBranchReason(
                branchExists: true, mergeBase: "abc123", head: "abc123"
            ) == nil,
            "a branch that already contains HEAD is the task being resumed - adopt it"
        )
        // The live case: queen/1127 was still on disk from a run 140 commits
        // earlier and was adopted in silence. Its diff against the tip read as
        // 641 insertions and 12,508 deletions; the bee's own change was 34
        // lines. A diff is not a merge - but QueenBranchCommitter assembles by
        // OVERLAY, and an overlay onto a base that old drops everything newer.
        check(
            QueenWorktree.staleBranchReason(
                branchExists: true, mergeBase: "old999", head: "abc123"
            )?.contains("cut before the current HEAD") == true,
            "a branch cut before HEAD is a leftover, not a resumption - refuse it by name"
        )
        check(
            QueenWorktree.staleBranchReason(
                branchExists: true, mergeBase: nil, head: "abc123"
            )?.contains("shares no history") == true,
            "an unrelated branch that happens to share the name is refused too"
        )
        check(
            QueenWorktree.staleBranchReason(
                branchExists: true, mergeBase: "abc123", head: ""
            )?.contains("HEAD could not be resolved") == true,
            "and when HEAD cannot be read the answer is refuse, not assume - the age is unknown"
        )

        // Refusing must not mean deleting: a leftover branch may hold the only
        // copy of somebody's work, and this code cannot know.
        check(
            QueenWorktree.freshBranchName(base: "queen/1127", attempt: 0) == "queen/1127",
            "the first attempt uses the wanted name"
        )
        check(
            QueenWorktree.freshBranchName(base: "queen/1127", attempt: 2) == "queen/1127-r2",
            "and a taken one is sidestepped with a suffix, never freed by deleting it"
        )

        // ── What may be removed ──────────────────────────────────────
        // This hands a path to `git worktree remove`, so the shape of the
        // mistake is deleting the checkout somebody is sitting in.
        check(
            QueenWorktree.isOwnedWorktree(
                path: "\(root)/.worktrees/dev/queen-1127", projectRoot: root, variant: "dev"
            ),
            "a checkout this code made is removable"
        )
        // The last one is the point of the variant scoping: the harness must
        // not be able to remove a working bee's checkout by naming it.
        for hostile in [root, "\(root)/..", "\(root)/rings", "/",
                        "\(root)/.worktrees", "\(root)/.worktrees/dev",
                        "\(root)/.worktrees/dev/queen-",
                        "\(root)/.worktrees/dev/other",
                        "\(root)/.worktrees/dev/queen-1127/rings",
                        "/other/BrowserOS/trios/.worktrees/dev/queen-1127"] {
            check(
                !QueenWorktree.isOwnedWorktree(path: hostile, projectRoot: root, variant: "dev"),
                "refuses to remove \(hostile)"
            )
        }
        check(
            !QueenWorktree.isOwnedWorktree(
                path: "\(root)/.worktrees/dev/queen-1127", projectRoot: root, variant: "test"
            ),
            "and the harness cannot remove a dev checkout even by full path"
        )
    }

    // MARK: - Scenario: the app starts the server it cannot work without

    /// `ProjectPaths.agentServerEntrypoint` pointed at the runtime for as long
    /// as the runtime has lived in this tree, and nothing ever called it. The
    /// app depended on a server it did not start, so the server was whatever
    /// somebody had left running - and after a reboot, nothing. The Queen would
    /// then choose an issue, delegate it, and the worker would find no
    /// transport, which reads like a broken supervisor and is not.
    static func runAppStartsItsOwnServer() async {
        print("\n# Scenario: the app starts its own server (#1279)")

        check(
            !AgentServerLauncher.bunCandidates.isEmpty,
            "the launcher knows where to look for bun"
        )
        // Absolute paths, not a bare name: an app launched from Finder does not
        // inherit a login shell's PATH, which is the commonest way "works in the
        // terminal, not in the app" happens.
        check(
            AgentServerLauncher.bunCandidates.allSatisfy { $0.hasPrefix("/") },
            "and looks by absolute path, because a Finder-launched app has no login PATH"
        )
        check(
            AgentServerLauncher.resolveBun(existsAt: { _ in false }) == nil,
            "with nothing on disk it resolves nothing rather than guessing a name"
        )
        let second = AgentServerLauncher.bunCandidates[1]
        check(
            AgentServerLauncher.resolveBun(existsAt: { $0 == second }) == second,
            "and finds the one that is actually there, wherever in the list it sits"
        )
        check(
            AgentServerLauncher.resolveBun(existsAt: { _ in true })
                == AgentServerLauncher.bunCandidates.first,
            "preferring the first when several exist - one answer, not an arbitrary one"
        )

        // The entrypoint must be a real file in this checkout, or the launcher
        // reports a missing entrypoint at every launch and the app never has a
        // server.
        check(
            FileManager.default.fileExists(atPath: ProjectPaths.agentServerEntrypoint),
            "the entrypoint the launcher spawns exists: \(ProjectPaths.agentServerEntrypoint)"
        )

        // Idempotence is what lets two variants both call this at launch.
        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-01/AgentServerLauncher.swift",
            encoding: .utf8
        )) ?? ""
        check(
            source.contains("if await isHealthy(port: port) {"),
            "and it asks the port before spawning, so a second caller finds the first one's server"
        )
        // The output is kept. The first version sent it to /dev/null, the
        // server died, and the one question this launcher exists to answer had
        // been thrown away.
        check(
            !source.contains("FileHandle.nullDevice"),
            "the spawned server's output is kept, not discarded - a server that dies must say why"
        )
    }

    // MARK: - Scenario: a bee is handed a rehearsal, not left to improvise

    /// Twenty-six skills sit in `.claude/skills/`, the briefing has carried a
    /// `skillBody` slot since it was written, `/delegate --skill` has always
    /// accepted a name - and not one delegation in this project's history has
    /// ever carried one. The field was always nil, so every bee worked from
    /// first principles beside a shelf of written procedures.
    ///
    /// The match is conservative on purpose: a worker briefed with the WRONG
    /// rehearsal is worse off than one briefed with none, because it will
    /// follow it.
    static func runEveryBeeIsHandedARehearsal() async {
        print("\n# Scenario: a bee is handed a rehearsal (#1090)")

        let installed: Set<String> = ["e2e-testing", "agent-safe-build", "tri-pipeline"]

        check(
            QueenSkillMatch.skill(
                forBoundary: ["tests/TriOSKitTests/ChatFailureTests.swift"], available: installed
            ) == "e2e-testing",
            "a test boundary is handed the testing procedure"
        )
        check(
            QueenSkillMatch.skill(forBoundary: ["build.sh"], available: installed)
                == "agent-safe-build",
            "a build boundary is handed the safe-build procedure"
        )
        check(
            QueenSkillMatch.skill(
                forBoundary: ["rings/SR-02/ChatViewModel.swift"], available: installed
            ) == "agent-safe-build",
            "ordinary Swift work is handed the procedure that keeps the running app alive"
        )

        // Order inside the rules matters: a path under tests/ that also ends in
        // .swift must read as a test, not as ordinary Swift.
        check(
            QueenSkillMatch.skill(
                forBoundary: ["tests/swift/ChatSSEEndToEndTest.swift"], available: installed
            ) == "e2e-testing",
            "a .swift file under tests/ reads as a test, not as ordinary Swift"
        )

        // Silence rather than a guess. Each of these would be a plausible
        // wrong answer, and a bee follows what it is handed.
        check(
            QueenSkillMatch.skill(forBoundary: [], available: installed) == nil,
            "no boundary, no rehearsal - there is nothing to match on"
        )
        check(
            QueenSkillMatch.skill(forBoundary: ["docs/note.md"], available: installed) == nil,
            "prose matches no rule, so nothing is handed over"
        )
        check(
            QueenSkillMatch.skill(
                forBoundary: ["tests/x.swift", "build.sh"], available: installed
            ) == nil,
            "a boundary spanning two rehearsals has no single one - picking the first would be a coin toss"
        )
        check(
            QueenSkillMatch.skill(
                forBoundary: ["tests/x.swift"], available: ["agent-safe-build"]
            ) == nil,
            "a switched-off skill is not quietly handed over - the operator turning it off was a decision"
        )

        // The store's OWN shape, not a convenient one.
        //
        // Identifiers there carry a leading slash. Every check above supplies a
        // bare-name set and agrees with itself, so the match was inert in the
        // running app while the scenario stayed green - a check validated
        // against a cheaper thing than the one it guards.
        check(
            QueenSkillMatch.skill(
                forBoundary: ["tests/x.swift"], available: ["/e2e-testing", "/agent-safe-build"]
            ) == "e2e-testing",
            "a boundary matches against identifiers in the store's slash-prefixed shape"
        )

        // Every skill a rule names must exist on disk.
        //
        // The match returns nil for a skill that is not installed, which is
        // safe and silent - so a rule naming a skill that never existed simply
        // never fires, and nothing says so. Mine named `tri-pipeline` while the
        // installed one is `t27-tri-pipeline`, and the Rust rule was dead from
        // the moment it was written.
        let skillsRoot = "\(ProjectPaths.root)/.claude/skills"
        let installedOnDisk = Set(
            (try? FileManager.default.contentsOfDirectory(atPath: skillsRoot)) ?? []
        )
        for named in Set(QueenSkillMatch.rules.map(\.skill)) {
            check(
                installedOnDisk.contains(named),
                "the rule naming `\(named)` points at a skill that exists - a rule naming a missing one never fires and says nothing"
            )
        }

        // The wiring: an explicit name must still win over the match.
        let source = (try? String(
            contentsOfFile: "\(ProjectPaths.root)/rings/SR-02/ChatViewModel.swift",
            encoding: .utf8
        )) ?? ""
        check(
            source.contains("let skill = skill ?? QueenSkillMatch.skill("),
            "the match only fills a silence - a named skill still wins"
        )
    }

    // MARK: - Scenario: nothing merges past the gate, and red wakes the bee

    /// The Queen asked the forge to merge and took the answer. GitHub refuses a
    /// red pull request only when branch protection makes it refuse; without
    /// that the merge succeeds and a failing change lands. Three of hers merged
    /// that way and only luck decided they were green.
    ///
    /// Red is not the Queen's to fix. The bee that opened the pull request is
    /// woken with the names of the failing checks and works on the same branch
    /// until the gate is green.
    // MARK: - Scenario: applying a proposal actually moves the record

    /// The proposal machinery was proven at the level of the decision and not
    /// at the level of the effect - I said so at the time. A gate that refuses
    /// correctly and an `apply` that does nothing look identical from the
    /// outside, and only one of them is any use.
    ///
    /// This drives the command against a real registry: a task claiming a file
    /// with a branch that does not exist, listed as a proposal, then applied.
    static func runApplyingAProposalActuallyMovesTheRecord() async {
        print("\n# Scenario: applying a proposal actually moves the record")

        let store = NSTemporaryDirectory() + "reconcile-apply-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: store) }
        let registry = QueenDelegationRegistry(storePath: store)

        let issue = IssueReference(owner: "gHashTag", repo: "trios", number: 4310)
        guard let task = registry.delegate(
            issue: issue,
            title: "A claim with nothing behind it",
            worker: "queen-swift",
            conversationId: UUID(),
            ownedPaths: ["docs"],
            acceptanceCriteria: ["docs/x.md exists"]
        ) else {
            fail("could not open a task to reconcile")
            return
        }
        // A branch name nothing will ever resolve, and a count that claims work
        // landed on it. This is #1280's shape exactly.
        registry.setVirtualBranch(taskID: task.id, branch: "queen/4310-does-not-exist")
        registry.recordCommittedFiles(taskID: task.id, count: 1)
        check(
            registry.tasks.first(where: { $0.id == task.id })?.committedFiles == 1,
            "the registry starts out claiming one file"
        )

        let vm = ChatViewModel(
            transport: MockChatTransport(),
            healthCheck: MockHealthCheck(),
            parser: UIMessageStreamParser(),
            persister: InMemoryPersister(),
            stateMachine: ConversationStateMachine(),
            a2aClient: nil,
            modelStore: ModelConfigurationStore(
                defaults: UserDefaults(suiteName: "trios-reconcile-apply") ?? .standard,
                environment: [:],
                reliabilityService: ModelReliabilityService(store: VolatileMemoryStore())
            ),
            memoryService: AgentMemoryService(
                store: VolatileMemoryStore(), fingerprintKey: testFingerprintKey
            ),
            todoPlanner: TODOPlanner(
                store: VolatileMemoryStore(),
                preferences: UserDefaults(suiteName: "trios-reconcile-apply") ?? .standard
            ),
            delegationRegistry: registry
        )
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Showing must not change anything. That is the whole reason the verb
        // is a separate word.
        await vm.runQueenCommand("/reconcile")
        check(
            registry.tasks.first(where: { $0.id == task.id })?.committedFiles == 1,
            "listing the proposals leaves the record exactly as it was"
        )
        check(
            vm.messages.contains { $0.content.contains("4310") && $0.content.contains("clear") },
            "and the list names the task and what would be done to it"
        )

        // Out of range while the list still has something in it. Asked after
        // applying, this passes for the wrong reason: with no proposals left
        // the command correctly answers "everything agrees", which is a
        // different sentence entirely.
        await vm.runQueenCommand("/reconcile apply 9")
        check(
            vm.messages.contains { $0.content.contains("is not one of them") },
            "a proposal number out of range is refused by name"
        )
        check(
            registry.tasks.first(where: { $0.id == task.id })?.committedFiles == 1,
            "and refusing it changed nothing"
        )

        await vm.runQueenCommand("/reconcile apply 1")
        check(
            registry.tasks.first(where: { $0.id == task.id })?.committedFiles == 0,
            "applying it clears the count that had nothing behind it"
        )
        check(
            vm.messages.contains { $0.content.contains("file count cleared") },
            "and she says what she did rather than only that she did something"
        )

        // And once there is nothing left to fix, she says so rather than
        // listing an empty list.
        await vm.runQueenCommand("/reconcile")
        check(
            vm.messages.contains { $0.content.contains("agree on every task") },
            "with the disagreement gone she says the record and the repository agree"
        )
    }

    // MARK: - Scenario: she proposes the repair and waits for a word

    /// Eight disagreements sat visible and motionless for a whole round,
    /// because seeing them was all the machinery could do. Reporting was the
    /// half that did not exist; acting on the report is the half after that,
    /// and the two must not be the same step.
    ///
    /// Every correction asks first. A registry made to agree with the
    /// repository by construction stops being evidence about anything - the
    /// disagreement IS the finding.
    static func runSheProposesAndWaitsForAWord() async {
        print("\n# Scenario: she proposes the repair and waits for a word")

        typealias R = QueenReconciliation

        check(
            R.correction(for: .agrees) == .none,
            "agreement needs no repair"
        )
        check(
            R.correction(for: .countWithoutCommit) == .none,
            "and neither does a historical count - proposing thirteen no-ops is noise"
        )
        guard case .sendToReview(let reviewWhy) = R.correction(
            for: .unrecordedWork(commits: 2)
        ) else {
            fail("unrecorded work must propose putting the task in front of someone")
            return
        }
        check(
            reviewWhy.contains("HEAD does not hold"),
            "and says why in terms of the repository, not of the record: \(reviewWhy)"
        )
        guard case .clearUnsupportedCount(let clearWhy) = R.correction(for: .branchMissing)
        else {
            fail("a claim with no branch behind it must propose dropping the claim")
            return
        }
        check(
            clearWhy.contains("nothing behind it"),
            "naming what makes the number empty: \(clearWhy)"
        )
        check(
            R.correction(for: .commitMissing) != .none,
            "a named commit that is absent is also repairable"
        )

        // The gate: nothing applies itself.
        check(
            R.Correction.sendToReview(reason: "x").needsOperator
                && R.Correction.clearUnsupportedCount(reason: "x").needsOperator,
            "every correction that changes anything waits for a word"
        )
        check(
            !R.Correction.none.needsOperator,
            "and the one that changes nothing does not ask"
        )

        check(
            R.describeCorrection(index: 1, issue: "gHashTag/trios#1132",
                                 correction: .sendToReview(reason: "two commits"))
                == "1. gHashTag/trios#1132 -> review: two commits",
            "each proposal is numbered so `apply 2` can mean exactly one thing"
        )
        check(
            R.describeCorrection(index: 1, issue: "x", correction: .none) == nil,
            "and a no-op is not listed at all"
        )

        // Parsing: showing and doing are separate words, not a flag.
        check(
            QueenCommandParser.parse("/reconcile") == .reconcile(apply: nil),
            "`/reconcile` alone never changes anything"
        )
        check(
            QueenCommandParser.parse("/reconcile apply 2") == .reconcile(apply: "apply 2"),
            "and applying takes a word plus a number"
        )
        check(
            QueenCommandParser.parse("/reconcile apply all") == .reconcile(apply: "apply all"),
            "or the word all"
        )
    }

    // MARK: - Scenario: the record is compared against the repository

    /// The registry is a claim and the repository is a fact, and nothing
    /// compared them. A scan of thirty-five tasks found twenty-two branches
    /// carrying the bees' own commits, and for eleven of those the registry
    /// said `queued` or `failed` - work that exists and that the Queen does not
    /// know about. #1281 is `queued` beside a 363-line harness; #1282 is
    /// `failed` beside a 288-line one.
    ///
    /// Detection before correction. Advancing a state from a git scan is a
    /// judgement about work nobody reviewed; saying the two disagree is not.
    static func runTheRecordIsComparedAgainstTheRepository() async {
        print("\n# Scenario: the record is compared against the repository")

        typealias R = QueenReconciliation
        func facts(branch: Bool = true, commits: Int = 0, commit: Bool = true,
                   unlanded: Int = 1) -> R.RepositoryFacts
        {
            R.RepositoryFacts(
                branchExists: branch, branchCommits: commits, commitExists: commit,
                unlandedFiles: unlanded
            )
        }

        check(
            R.check(state: .accepted, committedFiles: 1, committedSHA: "abc",
                    facts: facts(commits: 2)) == .agrees,
            "an accepted task with work on its branch is the record being right"
        )
        check(
            R.check(state: .queued, committedFiles: nil, committedSHA: nil,
                    facts: facts(commits: 1, unlanded: 1)) == .unrecordedWork(commits: 1),
            "a queued task with a commit HEAD does not hold is work nobody is looking at"
        )
        // The refinement that turned twelve warnings into two. Every bee commit
        // touched exactly one file - its own boundary - and all but two of
        // those files were already in HEAD, swept in by somebody else's
        // `git add -A`. Work that arrived by another road is not stranded, and
        // raising it is the noise this report exists to avoid.
        check(
            R.check(state: .failed, committedFiles: nil, committedSHA: nil,
                    facts: facts(commits: 3, unlanded: 0)) == .agrees,
            "a commit whose files HEAD already holds is not stranded work"
        )
        check(
            R.check(state: .failed, committedFiles: nil, committedSHA: nil,
                    facts: facts(commits: 1, unlanded: 1)) == .unrecordedWork(commits: 1),
            "and so is a failed one - this is #1282"
        )
        check(
            R.check(state: .running, committedFiles: nil, committedSHA: nil,
                    facts: facts(commits: 1)) == .agrees,
            "a running task is expected to be building something; that is not a disagreement"
        )
        check(
            R.check(state: .accepted, committedFiles: 1, committedSHA: nil,
                    facts: facts(branch: false)) == .branchMissing,
            "files claimed with no branch to hold them - this is #1280"
        )
        check(
            R.check(state: .accepted, committedFiles: 1, committedSHA: "deadbeef",
                    facts: facts(commit: false)) == .commitMissing,
            "a named commit that is not in the repository is the sharpest disagreement"
        )
        check(
            R.check(state: .accepted, committedFiles: 1, committedSHA: nil,
                    facts: facts(commits: 1)) == .countWithoutCommit,
            "a count with no commit named is historical, not alarming"
        )

        // Urgency separates what needs a person now from what every record
        // written before the commit field looks like.
        check(
            !R.Finding.countWithoutCommit.isUrgent,
            "seventeen historical rows must not read as seventeen emergencies"
        )
        check(
            R.Finding.unrecordedWork(commits: 1).isUrgent
                && R.Finding.branchMissing.isUrgent
                && R.Finding.commitMissing.isUrgent,
            "and the three that mean something do"
        )

        let line = R.describe(issue: "gHashTag/trios#1282",
                              finding: .unrecordedWork(commits: 1))
        check(
            line.contains("#1282") && line.contains("nobody is looking at it"),
            "each disagreement names its issue and says what is wrong: \(line)"
        )
        let sum = R.summary(findings: [.agrees, .agrees, .unrecordedWork(commits: 1),
                                       .countWithoutCommit])
        check(
            sum.contains("4 task(s) checked") && sum.contains("2 agree")
                && sum.contains("1 disagree"),
            "and the summary counts rather than judging: \(sum)"
        )
    }

    // MARK: - Scenario: a count with no commit behind it is not evidence

    /// A task was found recorded `accepted` with `committedFiles: 1` and a
    /// branch that did not exist. Nothing in the record could have caught it:
    /// the count was true at the instant it was measured and unverifiable ever
    /// after, because no commit identity was kept.
    ///
    /// The Queen may now close her own worker's work only when she can name the
    /// commit it is in.
    static func runACountWithNoCommitIsNotEvidence() async {
        print("\n# Scenario: a count with no commit behind it is not evidence")

        func task(files: Int?, sha: String?) -> DelegatedTask {
            var t = DelegatedTask(
                issue: IssueReference(owner: "gHashTag", repo: "trios", number: 1280),
                title: "Ring 0",
                worker: "queen-swift",
                state: .awaitingReview,
                ownedPaths: ["rings/T27-00/queen_core.t27"],
                acceptanceCriteria: ["it generates valid Rust"]
            )
            t.committedFiles = files
            t.committedSHA = sha
            return t
        }

        check(
            !QueenDelegationPolicy.qualifiesForAutoAccept(
                task(files: 1, sha: nil), committedFiles: 1
            ),
            "one file and no commit to name does not qualify - this is the live case"
        )
        check(
            !QueenDelegationPolicy.qualifiesForAutoAccept(
                task(files: 1, sha: ""), committedFiles: 1
            ),
            "and an empty string is not a commit either"
        )
        check(
            QueenDelegationPolicy.qualifiesForAutoAccept(
                task(files: 1, sha: "9120ba77b"), committedFiles: 1
            ),
            "with the commit named, the same task qualifies"
        )
        check(
            !QueenDelegationPolicy.qualifiesForAutoAccept(
                task(files: 0, sha: "9120ba77b"), committedFiles: 0
            ),
            "a commit that landed nothing still does not - the file rule is not replaced"
        )

        // The state gate is what makes recording on the failure path safe: a
        // failed task cannot be accepted by acquiring a count.
        var failed = task(files: 3, sha: "deadbeef")
        failed.state = .failed
        check(
            !QueenDelegationPolicy.qualifiesForAutoAccept(failed, committedFiles: 3),
            "a failed task with a real commit is still not auto-accepted"
        )
    }

    // MARK: - Scenario: absent is not zero, and the bee gets its own worktree

    /// Two defects found by a forensic pass over a task that was recorded
    /// `accepted` with `committedFiles: 1` and a branch that does not exist.
    ///
    /// First: `classify` collapsed `nil` into `0`. Absent means the branch was
    /// never tallied; zero means it was tallied and held nothing, and only the
    /// second says anything about the worker. The collapse labelled #1282
    /// `producedNothing` while its branch carried a 288-line commit - a false
    /// claim that counts against the issue exactly as a real failure does.
    /// `QueenReviewDigest` in the same ring had always kept the two apart.
    ///
    /// Second, the discriminator that explained the whole picture: the task
    /// struct handed to the runner was a value captured before
    /// `prepareWorktree` filled in `worktreePath`. #1280 was refused at first
    /// dispatch and re-sent by the key-warmup path, which re-reads the registry
    /// and therefore had the worktree - "Committed 1 file(s) in worktree".
    /// #1282 went out on the ordinary path with the stale copy, so the bee was
    /// sent to the shared checkout and its file is still untracked there. Same
    /// code, two paths, two outcomes.
    static func runAbsentIsNotZeroAndTheBeeGetsItsWorktree() async {
        print("\n# Scenario: absent is not zero, and the bee gets its own worktree")

        typealias P = QueenRetryPolicy

        check(
            P.classify(streamOutcome: "terminal", completedTurns: 1, toolCalls: 9,
                       committedFiles: nil) == .unmeasured,
            "an untallied branch is unmeasured, not empty"
        )
        check(
            P.classify(streamOutcome: "terminal", completedTurns: 1, toolCalls: 9,
                       committedFiles: 0) == .producedNothing,
            "a tallied branch holding nothing is still producedNothing"
        )
        check(
            QueenFailureKind.unmeasured.countsAgainstTheIssue,
            "unmeasured still counts against the issue - the attempt did end in failure"
        )
        check(
            !QueenFailureKind.unmeasured.briefingLine.contains("committed nothing"),
            "but the next bee is not told the last one committed nothing"
        )
        check(
            QueenFailureKind.unmeasured.briefingLine.contains("look at the branch"),
            "it is told to look at the branch instead: \(QueenFailureKind.unmeasured.briefingLine)"
        )

        // The interruption rule must survive the new case.
        check(
            P.decision(priorAttempts: [.interrupted, .unmeasured]) == .attempt(number: 2),
            "one unmeasured attempt earns a second; the interruption beside it still does not count"
        )
        guard case .escalate = P.decision(priorAttempts: [.unmeasured, .unmeasured]) else {
            fail("two unmeasured attempts must stop the loop like any other pair")
            return
        }

        // And the dispatch fix, at the level that can be checked without a
        // network: the worker's directory is a function of the task it is
        // handed, so handing it a copy without the worktree sends it to the
        // shared tree.
        let root = "/r/trios"
        let withTree = QueenWorktree.workerDirectory(
            worktreePath: "/r/trios/.worktrees/prod/queen-1282",
            projectRoot: root,
            repositoryRoot: "/r"
        )
        check(
            withTree == "/r/trios/.worktrees/prod/queen-1282/trios",
            "a task carrying its worktree sends the bee into that checkout"
        )
        check(
            withTree != root,
            "which is not the shared tree - the difference the stale copy erased"
        )
    }

    // MARK: - Scenario: work in a second epic is visible

    /// The epic number was written into eight places, one of them a URL. Six
    /// well-formed sub-issues were opened under #1279 - acceptance criteria,
    /// disjoint boundaries, everything the selection needs - and the Queen
    /// could not see one of them. Not refuse them: see them. She reported "all
    /// 24 candidates look already done" while six untouched tasks sat one epic
    /// away.
    ///
    /// Which work exists is the operator's decision, so it is stored and the
    /// code supplies only a default.
    static func runWorkInASecondEpicIsVisible() async {
        print("\n# Scenario: work in a second epic is visible")

        typealias E = QueenEpics

        check(
            E.defaultEpics.contains(1090) && E.defaultEpics.contains(1279),
            "both epics are read by default - the supervisor one and the T27 backend"
        )
        check(
            E.deduplicated([1090, 1279, 1090]) == [1090, 1279],
            "a repeated epic is read once; twice would double-count every sub-issue in it"
        )
        check(
            E.deduplicated([1279, 1090]) == [1279, 1090],
            "and the operator's order survives - sorting would overrule a statement of priority"
        )

        guard let url = E.timelineURL(epic: 1279) else {
            fail("an epic must produce a timeline URL")
            return
        }
        check(
            url.absoluteString
                == "https://api.github.com/repos/gHashTag/trios/issues/1279/timeline?per_page=100",
            "the URL is built from the number rather than written out"
        )
        check(
            E.timelineURL(epic: 1090)?.absoluteString.contains("/issues/1090/") == true,
            "and each epic gets its own, so one number cannot fetch another's board"
        )
        check(
            E.describedList.contains("#1090") && E.describedList.contains("#1279"),
            "log lines name the epics actually read: \(E.describedList)"
        )
    }

    // MARK: - Scenario: an English issue is still delegatable

    /// The repository writes its documentation and code in English. Every issue
    /// written before that rule opens its boundary with `## Границы`, and the
    /// parser knew only that spelling - so the first English issue would have
    /// been skipped with "no Границы section, so there is nothing to delegate",
    /// which is true of the parser and not of the issue.
    ///
    /// The heading is a parser token. Both spellings open the same section.
    static func runAnEnglishIssueIsStillDelegatable() async {
        print("\n# Scenario: an English issue is still delegatable")

        check(
            ChatViewModel.isBoundaryHeading("## Границы"),
            "the spelling every existing issue uses still opens the section"
        )
        check(
            ChatViewModel.isBoundaryHeading("## Boundary"),
            "and so does the one every new issue will use"
        )
        check(
            !ChatViewModel.isBoundaryHeading("## Готово, когда"),
            "another heading does not open it"
        )
        check(
            !ChatViewModel.isBoundaryHeading("## Boundaries of the approach"),
            "and neither does prose that merely starts with the word"
        )
    }

    // MARK: - Scenario: a boundary path is a path, not prose

    /// Five of the sixty-three boundary paths in the live registries carried a
    /// trailing backtick - all of them `rings/SR-02/ChatViewModel.swift` with
    /// one stuck to the end. A path like that matches nothing: `git add --`
    /// will not stage it, and the boundary filter drops the worker\'s real
    /// edits to that file as being outside its own boundary. The bee is then
    /// recorded as having produced nothing, which is the commonest failure in
    /// the registry.
    ///
    /// The cause was the order of two cleanups. Backticks were stripped from
    /// both ends first, then trailing prose punctuation - and the commonest
    /// shape of all is a backticked path followed by a comma, where the
    /// trailing character is the comma, so the backtick strip never reaches the
    /// backtick and the punctuation strip then leaves it exposed at the end.
    static func runABoundaryPathIsAPathNotProse() async {
        print("\n# Scenario: a boundary path is a path, not prose")

        typealias V = ChatViewModel
        let path = "rings/SR-02/ChatViewModel.swift"

        check(V.boundaryPathToken(from: path) == path, "a bare path is taken as it is")
        check(
            V.boundaryPathToken(from: "`\(path)`") == path,
            "backticks around a path come off"
        )
        // The shape that produced all five corrupted entries.
        check(
            V.boundaryPathToken(from: "`\(path)`, see notes") == path,
            "a backticked path followed by a comma loses both, in either order"
        )
        check(
            V.boundaryPathToken(from: "`\(path)`.") == path,
            "and followed by a full stop"
        )
        check(
            V.boundaryPathToken(from: "(`\(path)`);") == path,
            "and wrapped in brackets with a semicolon after it"
        )
        check(
            V.boundaryPathToken(from: "\"\(path)\",") == path,
            "quotes are prose punctuation too"
        )
        check(
            V.boundaryPathToken(from: "see \(path) for the detail") == path,
            "the path is picked out of a sentence rather than the sentence being taken"
        )
        check(
            V.boundaryPathToken(from: "no path on this line at all") == nil,
            "a line with no path yields none rather than a plausible word"
        )
    }

    // MARK: - Scenario: a bee stands in the project, not the repository

    /// The commonest real failure in the release registry was `producedNothing`
    /// - two turns, ten to sixteen tool calls, zero committed files - on tasks
    /// whose file was sitting in the worktree, written correctly, one directory
    /// up from where the committer looked.
    ///
    /// A worktree is a checkout of the *repository*. This project is a
    /// directory inside it: the repository root is `BrowserOS`, the project is
    /// `BrowserOS/trios`. The worker was given the worktree root as its working
    /// directory, so the boundary `docs/counter-negative.md` - project-relative,
    /// and correct in the no-worktree case where the working directory IS the
    /// project - resolved to `<worktree>/docs/counter-negative.md`. The
    /// committer stages repository-relative paths, so it asked git for
    /// `trios/docs/counter-negative.md`, matched nothing, and reported that the
    /// worker had changed no files.
    ///
    /// Proven at the time by dry run, which mutates nothing:
    ///   git add --dry-run -- docs/counter-negative.md        -> add \'docs/...\'
    ///   git add --dry-run -- trios/docs/counter-negative.md  -> fatal: pathspec
    static func runABeeStandsInTheProjectNotTheRepository() async {
        print("\n# Scenario: a bee stands in the project, not the repository")

        typealias W = QueenWorktree

        check(
            W.workerDirectory(
                worktreePath: "/r/trios/.worktrees/dev/queen-1153",
                projectRoot: "/r/trios",
                repositoryRoot: "/r"
            ) == "/r/trios/.worktrees/dev/queen-1153/trios",
            "a worker stands in the project inside its worktree, not at the worktree root"
        )
        check(
            W.workerDirectory(
                worktreePath: "/r/.worktrees/x", projectRoot: "/r", repositoryRoot: "/r"
            ) == "/r/.worktrees/x",
            "when the project IS the repository there is no subdirectory to descend into"
        )
        check(
            W.workerDirectory(
                worktreePath: "/r/w", projectRoot: "/elsewhere/trios", repositoryRoot: "/r"
            ) == "/r/w",
            "a project outside the repository cannot be located inside its worktree"
        )
        check(
            W.workerDirectory(
                worktreePath: "/r/w/", projectRoot: "/r/trios/", repositoryRoot: "/r/"
            ) == "/r/w/trios",
            "trailing separators do not produce a doubled one"
        )
        check(
            W.workerDirectory(
                worktreePath: "/r/w", projectRoot: "/r/a/b", repositoryRoot: "/r"
            ) == "/r/w/a/b",
            "a project nested more than one level deep keeps its whole prefix"
        )
    }

    // MARK: - Scenario: unreadable history is not overwritten

    /// Sixteen conversations in the release store cannot be decrypted. The
    /// conversation key was created on 25 July and overwritten on 27 July, so
    /// everything written between those dates is ciphertext nobody holds the
    /// key to - 23KB to 507KB each, real data, not corruption. Both paths that
    /// could overwrite a key have since been closed, so the set will not grow.
    ///
    /// What was still live is what happens next: `load` returned `[]`, which is
    /// what an empty conversation returns, so the app showed sixteen blank
    /// chats and would have saved a short new history over a long unreadable
    /// one at the first message. That is the difference between data that
    /// cannot be read today and data that is destroyed.
    static func runUnreadableHistoryIsNotOverwritten() async {
        print("\n# Scenario: unreadable history is not overwritten")

        let suite = "trios.test.unreadable.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else {
            fail("could not open a scratch defaults suite")
            return
        }
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }

        let id = UUID()
        let key = "trios.conversation." + id.uuidString
        // Bytes that are neither valid ciphertext for the current key nor a
        // marked plaintext record: exactly the shape of the sixteen.
        let ciphertext = Data((0..<512).map { UInt8($0 % 251) })
        defaults.set(ciphertext, forKey: key)

        let persister = ConversationPersister(suiteName: suite)
        let loaded = await persister.load(conversationId: id)
        check(loaded.isEmpty, "an unreadable conversation still loads as no messages")

        let quarantined = defaults.data(forKey: "trios.conversation.unreadable." + id.uuidString)
        check(
            quarantined == ciphertext,
            "but its bytes are copied aside first, so a recovered key still has something to read"
        )

        await persister.save(
            messages: [ChatMessage(role: .user, content: "a new first message")],
            conversationId: id
        )
        check(
            defaults.data(forKey: key) == ciphertext,
            "and saving over it is refused - the original ciphertext is untouched"
        )

        // A conversation that is merely empty must still be writable, or the
        // guard has broken every new chat in the app.
        let fresh = UUID()
        let freshPersister = ConversationPersister(suiteName: suite)
        _ = await freshPersister.load(conversationId: fresh)
        await freshPersister.save(
            messages: [ChatMessage(role: .user, content: "hello")],
            conversationId: fresh
        )
        let written = defaults.data(forKey: "trios.conversation." + fresh.uuidString)
        check(
            written != nil && !(written?.isEmpty ?? true),
            "a genuinely new conversation is still saved normally"
        )
    }

    // MARK: - Scenario: a judged task does not wait for a human

    /// Eight tasks sat in `awaitingReview` in the release registry, the oldest
    /// for fifteen hours. All eight were fully judged. All eight had at least
    /// one unmet criterion. The review was complete and nothing consumed it:
    /// the send-back existed and only a human typing `/review ... reject` had
    /// ever called it.
    ///
    /// Each of them held its file boundary while it waited, which is why the
    /// autonomous tick kept reporting that all 24 candidates looked already
    /// done. The queue was not slow - it had no exit.
    static func runAJudgedTaskDoesNotWaitForAHuman() async {
        print("\n# Scenario: a judged task does not wait for a human")

        typealias R = QueenReviewDecision

        check(
            R.decide(verdicts: [("a", true), ("b", true)], totalCriteria: 2,
                     committedFiles: 3, priorSendBacks: 0) == .accept,
            "everything met with a diff behind it is an accept"
        )

        // "Met" against an empty diff is the failure this whole path exists to
        // catch, so it must not be the same answer as a real pass.
        guard case .escalate(let emptyReason) = R.decide(
            verdicts: [("a", true)], totalCriteria: 1,
            committedFiles: 0, priorSendBacks: 0
        ) else {
            fail("every criterion met with nothing committed cannot be an accept")
            return
        }
        check(
            emptyReason.contains("empty diff"),
            "and it says what is wrong with it: \(emptyReason)"
        )

        check(
            R.decide(verdicts: [("a", true), ("b", false)], totalCriteria: 2,
                     committedFiles: 2, priorSendBacks: 0)
                == .sendBack(unmet: ["b"]),
            "an unmet criterion returns the task, naming exactly which one"
        )
        check(
            R.decide(verdicts: [("a", false)], totalCriteria: 1,
                     committedFiles: 1, priorSendBacks: 1)
                == .sendBack(unmet: ["a"]),
            "a second return is still allowed - the first one is the one that teaches"
        )
        guard case .escalate(let exhausted) = R.decide(
            verdicts: [("a", false)], totalCriteria: 1,
            committedFiles: 1, priorSendBacks: 2
        ) else {
            fail("two returns must be the end of the automatic loop")
            return
        }
        check(
            exhausted.contains("has not moved"),
            "and the third is refused as a conversation that is going nowhere: \(exhausted)"
        )

        // Partial judgement must do nothing at all. Returning work over a
        // question nobody asked is worse than waiting.
        check(
            R.decide(verdicts: [("a", false)], totalCriteria: 3,
                     committedFiles: 1, priorSendBacks: 0)
                == .wait(reason: "1 of 3 criteria judged so far"),
            "one unmet answer out of three questions is not a verdict on the task"
        )
        guard case .escalate(let noContract) = R.decide(
            verdicts: [], totalCriteria: 0, committedFiles: 5, priorSendBacks: 0
        ) else {
            fail("a task with no criteria has no contract and cannot be judged")
            return
        }
        check(
            noContract.contains("nothing to judge it against"),
            "and says so rather than passing it: \(noContract)"
        )

        // The note is the whole value of the return.
        let note = R.sendBackNote(unmet: ["the reviewer is not the author", "tests pass"],
                                  attempt: 1)
        check(
            note.contains("the reviewer is not the author") && note.contains("tests pass"),
            "the returned worker is given the criteria verbatim, not 'it did not pass'"
        )
        check(
            note.contains("second pass"),
            "and told which pass this is"
        )
        check(
            note.contains("say so and say why"),
            "with the one answer that is not more code left open to it"
        )
    }

    // MARK: - Scenario: a bee is not sent at the same wall forever

    /// The dev registry held nineteen tasks and fourteen failures: #1127
    /// attempted seven times, #1129 five, #1128 four. Every attempt was the
    /// same brief against the same issue, because nothing counted them and
    /// nothing told the next worker that anyone had been there.
    ///
    /// Ten of those fourteen had `streamOutcome: open` and no completed turns -
    /// the signature of a process that went away under the worker, not of a
    /// worker that failed. Counting those against the issue would retire issues
    /// for the crime of being open while somebody rebuilt the app.
    static func runABeeIsNotSentAtTheSameWallForever() async {
        print("\n# Scenario: a bee is not sent at the same wall forever")

        typealias P = QueenRetryPolicy

        // Classification reads the measurements, because the label is what was
        // missing in the first place.
        check(
            P.classify(streamOutcome: "open", completedTurns: nil, toolCalls: nil,
                       committedFiles: nil) == .interrupted,
            "an open stream with no completed turn is a process that went away, not a defeat"
        )
        check(
            P.classify(streamOutcome: "terminal", completedTurns: 1, toolCalls: 41,
                       committedFiles: 0) == .producedNothing,
            "forty-one tool calls and nothing committed is a real attempt that produced nothing"
        )
        check(
            P.classify(streamOutcome: "terminal", completedTurns: 1, toolCalls: 12,
                       committedFiles: 3) == .workedButFailed,
            "work that landed on a branch and still failed is the third kind"
        )

        // Interruptions must not consume the issue's budget. This is the whole
        // reason the kinds exist rather than a counter.
        check(
            P.decision(priorAttempts: [.interrupted, .interrupted, .interrupted, .interrupted])
                == .attempt(number: 1),
            "four interruptions leave the issue untouched - it is still a first attempt"
        )
        check(
            P.decision(priorAttempts: [.producedNothing]) == .attempt(number: 2),
            "one real failure earns a second attempt, and it is numbered as such"
        )
        guard case .escalate(let reason) = P.decision(
            priorAttempts: [.producedNothing, .workedButFailed]
        ) else {
            fail("two real failures must stop the loop rather than start a third bee")
            return
        }
        check(
            reason.contains("needs you"),
            "and the reason says whose problem it now is: \(reason)"
        )
        check(
            P.decision(priorAttempts: [.interrupted, .producedNothing, .interrupted])
                == .attempt(number: 2),
            "interruptions interleaved with a real failure still do not count"
        )

        // The briefing is the half that makes a retry a second attempt rather
        // than the first attempt run twice.
        check(
            P.retryBriefing(priorAttempts: []) == nil,
            "a first attempt is told nothing about attempts that never happened"
        )
        check(
            P.retryBriefing(priorAttempts: [.interrupted]) == nil,
            "and an interruption is not history worth burdening a worker with"
        )
        guard let briefing = P.retryBriefing(
            priorAttempts: [.producedNothing, .interrupted]
        ) else {
            fail("a real prior failure must produce a briefing")
            return
        }
        check(
            briefing.contains("attempted 1 time"),
            "the briefing counts only the attempts that were the worker's own"
        )
        check(
            briefing.contains("committed nothing"),
            "and says what the previous one actually did: \(briefing.prefix(60))"
        )
        check(
            briefing.contains("Do not repeat the previous approach"),
            "a retry that repeats the approach is not a retry"
        )

        // And the brief a worker receives carries it, which is the only place
        // any of this reaches an actual bee.
        let task = DelegatedTask(
            issue: IssueReference(owner: "gHashTag", repo: "trios", number: 1127),
            title: "Judge and defendant are one model",
            worker: "queen-swift",
            ownedPaths: ["rings/SR-02/ChatViewModel.swift"],
            acceptanceCriteria: ["the reviewer is not the author"]
        )
        let fresh = QueenBriefing.text(for: task)
        let retry = QueenBriefing.text(for: task, priorAttempts: [.workedButFailed])
        check(
            !fresh.contains("attempted"),
            "a first brief is not cluttered with a history it does not have"
        )
        check(
            retry.contains("attempted 1 time"),
            "a retry brief opens with what happened before"
        )
        check(
            retry.count > fresh.count,
            "and it is the same brief plus that, not a different one"
        )
    }

    static func runNothingMergesPastTheGate() async {
        print("\n# Scenario: nothing merges past the gate (#1090)")

        typealias G = QueenMergeGate

        check(
            G.decision(rollup: .success, mergeable: true, isDraft: false, checksConfigured: true)
                == .merge,
            "green merges"
        )
        check(
            G.decision(rollup: .pending, mergeable: true, isDraft: false, checksConfigured: true)
                == .wait(reason: "checks are still running"),
            "running checks mean wait - not merge, and not wake anybody either"
        )
        guard case .wakeWorker = G.decision(
            rollup: .failure, mergeable: true, isDraft: false, checksConfigured: true
        ) else {
            fail("a failed check must wake the worker")
            return
        }
        guard case .wakeWorker(let errorReason) = G.decision(
            rollup: .error, mergeable: true, isDraft: false, checksConfigured: true
        ) else {
            fail("an errored check must wake the worker too")
            return
        }
        check(
            errorReason.contains("errored"),
            "and an errored run is named as such - it did not complete, which is not the same as failing"
        )

        // The NONE case is the one that cannot be guessed, and both guesses are
        // bad: read it as failure and nothing ever merges in a project without
        // CI; read it as success and the gate is decoration in a project that
        // meant to have checks.
        check(
            G.decision(rollup: .none, mergeable: true, isDraft: false, checksConfigured: false)
                == .merge,
            "no checks and none configured: nothing to wait for"
        )
        guard case .wait = G.decision(
            rollup: .none, mergeable: true, isDraft: false, checksConfigured: true
        ) else {
            fail("checks configured but none reported must wait, not merge past the gate")
            return
        }

        // Refusals that no amount of bee work will change.
        guard case .refuse = G.decision(
            rollup: .success, mergeable: true, isDraft: true, checksConfigured: true
        ) else {
            fail("a draft is refused even when green")
            return
        }
        guard case .refuse = G.decision(
            rollup: .success, mergeable: false, isDraft: false, checksConfigured: true
        ) else {
            fail("a pull request the forge calls unmergeable is refused, not retried")
            return
        }

        // The wake-up has to carry something actionable. A worker told only
        // "it is red" repeats what it did.
        let instruction = G.wakeInstruction(
            prNumber: 71, reason: "a check failed", failingChecks: ["Fast gates", "xctest"]
        )
        check(
            instruction.contains("Fast gates") && instruction.contains("xctest"),
            "the wake-up names the failing checks"
        )
        check(
            instruction.contains("Do not open a new pull request"),
            "and says to push to the same branch - a second pull request for one task is the mess this avoids"
        )
        check(
            G.wakeInstruction(prNumber: 71, reason: "x", failingChecks: [])
                .contains("did not name which check"),
            "when the forge names nothing, the instruction says so rather than inventing a check"
        )
    }
}
