// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening  -  safety-budget enforcement, human-in-the-loop
// confirmation, and repo-agnostic PR creation for Queen-generated proposals.
// Follow-up: seal against .trinity/specs/queen-proposal-applier.md.
// Previous waiver: https://github.com/gHashTag/trios/issues/T27-EPIC-001 (fullscreen chat history).
import Combine
import CryptoKit
import Foundation
import SwiftUI

/// Observable progress state for recovery export/import operations.
@MainActor
final class SessionRecoveryProgress: ObservableObject {
    @Published var isActive = false
    @Published var currentFile: String = ""
    @Published var completedFiles: Int = 0
    @Published var totalFiles: Int = 0
    @Published var fractionCompleted: Double = 0
    @Published var operation: SessionRecoveryOperation = .none

    enum SessionRecoveryOperation: String {
        case none
        case export
        case `import`
    }

    func start(operation: SessionRecoveryOperation, totalFiles: Int) {
        self.operation = operation
        self.isActive = true
        self.totalFiles = totalFiles
        self.completedFiles = 0
        self.fractionCompleted = 0
        self.currentFile = ""
    }

    func advance(file: String) {
        self.currentFile = file
        self.completedFiles += 1
        if totalFiles > 0 {
            self.fractionCompleted = Double(completedFiles) / Double(totalFiles)
        }
    }

    func finish() {
        self.isActive = false
        self.fractionCompleted = 1
        self.currentFile = ""
    }

    func reset() {
        self.operation = .none
        self.isActive = false
        self.currentFile = ""
        self.completedFiles = 0
        self.totalFiles = 0
        self.fractionCompleted = 0
    }
}

private struct PendingAgentMemoryTurn {
    let conversationId: UUID
    let sourceMessageId: UUID
    let goal: String
    let streamGeneration: UInt64
    let memoryWriteRevision: UInt64
    var shouldRemember: Bool
    var assistantMessageId: UUID?
}

private struct ActiveAgentMemoryWrite {
    let conversationId: UUID
    let sourceMessageId: UUID
    let task: Task<AgentMemoryRecord?, Never>
}

private struct ConversationHistorySnapshot {
    let conversationId: UUID
    let messages: [ChatMessage]
    let writeRevision: UInt64
}

@MainActor
final class ChatViewModel: ObservableObject {
    private static let unterminatedStreamError =
        "Response stream ended before a terminal event"

    @Published var messages: [ChatMessage] = .init()
    @Published var state: ConversationState = .idle
    @Published var inputText: String = ""
    @Published var isServerReachable: Bool = false
    @Published var isA2ARegistered: Bool = false
    @Published var conversations: [ChatConversation] = .init()
    @Published var showHistory = false
    @Published var messageHistory: [String] = .init()  // Hotkey history ((up/down) navigation)
    @Published private(set) var tokenUsage = TokenUsageLedger()
    @Published private(set) var recalledMemories: [AgentMemoryMatch] = []
    @Published private(set) var memoryControlRevision: UInt64 = 0
    @Published var recoveryProgress = SessionRecoveryProgress()
    @Published var contextUtilizationPercent: Double?
    @Published var contextRoutingLabel: String?
    @Published var requestError: String?
    @Published var streamingContextDecision: StreamingContextDecision?
    @Published var isStreamPausedForContext: Bool = false
    @Published var streamingContextWarning: String?
    @Published var streamingContextPauseLabel: String?
    @Published var canContinueOnLargerModel: Bool = false
    @Published var canSummarizeStreamSoFar: Bool = false
    @Published var streamingBudgetStatus: StreamingBudgetStatus?

    /// Raw reviewer responses keyed by task ID, preserved so a verdict can be
    /// re-examined. The parsed verdicts are recorded in the delegation
    /// registry, but the text the reviewer actually wrote is the evidence
    /// behind them — without it, re-checking a verdict means re-running the
    /// review. Posted to the Queen's chat as well, so the response is visible
    /// in the transcript after the fact.
    @Published private(set) var reviewerResponses: [UUID: String] = [:]

    /// Criteria the reviewer was asked about but gave no answer for, keyed by
    /// task ID. An empty answer is not the same as a question nobody asked:
    /// the former means the request went out and silence came back —
    /// whether the whole response was empty or the reviewer answered some
    /// criteria but not this one — the latter means the criterion never
    /// reached a reviewer at all. Keeping
    /// them separate lets the log and the block reason say "reviewer gave no
    /// answer" instead of "never checked" — they are different problems with
    /// different fixes (#1117).
    @Published private(set) var askedButUnanswered: [UUID: Set<String>] = [:]

    /// Criteria the reviewer was asked about but declined to judge because
    /// the diff was empty — the third state (#1165). Not "never checked"
    /// (a question was never posed) and not "asked but no answer" (the
    /// reviewer would answer "there is nothing to review"): here the
    /// reviewer had no subject to evaluate. Keeping this separate lets the
    /// block reason say "there was no diff" instead of conflating it with
    /// a missing question or a missing answer.
    @Published private(set) var declinedNoDiff: [UUID: Set<String>] = [:]

    /// How many times `sendOneShotReviewerRequest` was called per task.
    /// Populated in `requestReviewerVerdicts`, checked by the assertion
    /// that proves the retry was actually performed when the reviewer
    /// returns empty (#1144 criterion 5: removing the retry breaks the
    /// guard because the count stays at 1 instead of 2).
    private var reviewerRequestCounts: [UUID: Int] = [:]

    let queenStatusVM = QueenStatusViewModel()
    let modelStore: ModelConfigurationStore
    let todoPlanner: TODOPlanner
    /// Injected rather than reached for, so a test can hand over a store built
    /// on a temporary directory. Five call sites used SkillStore.shared, which
    /// reads the real .claude/skills and writes the real disabled-skill state:
    /// covering the Queen saying "that skill is switched off" meant switching a
    /// real one off on whoever ran the suite. Defaulting to .shared keeps every
    /// existing caller unchanged.
    let skillStore: SkillStore
    /// Injected for the same reason as the skill store above: eighteen call
    /// sites reached for the singleton, which reads and writes the real
    /// .trinity/state/queen_delegation.json. Every command that makes the
    /// Queen do something - delegate, accept, review, cancel - goes through it,
    /// so none of them could be tested without leaving tasks behind on whoever
    /// ran the suite. Views and main.swift keep observing .shared; it is only
    /// this view model's own use that is now handed in.
    let delegationRegistry: QueenDelegationRegistry
    /// How the Queen reads the contract an issue already states.
    ///
    /// Injected because reaching straight into GitHubAPIClient made delegation
    /// a network call, and the harness delegates - so the suite started going
    /// to github.com and stopped finishing. Every other dependency here is
    /// handed in; this one had no business being the exception.
    let fetchIssueBody: @Sendable (IssueReference) async -> String?

    private let transport: ChatTransportProtocol
    private let healthCheck: ChatHealthCheckProtocol
    private let parser: ChatParserProtocol
    private(set) var persister: ChatPersisterProtocol
    private let stateMachine: ConversationStateMachine
    private let memoryService: AgentMemoryService
    let a2aClient: A2ARegistryClient?

    @Published private(set) var conversationId: UUID = UUID()
    /// Per-conversation overrides for output budget and context-window margin.
    /// `nil` values fall back to the global defaults in `ModelConfigurationStore`.
    @Published private(set) var conversationSettings: [UUID: ConversationSettings] = [:]
    private var messageCache: [UUID: Int] = [:]
    private var healthCheckTask: Task<Void, Never>?
    private var initializationTask: Task<Void, Never>?
    private(set) var queenBackgroundService: QueenBackgroundService?
    private var lastSendTime: Date = .distantPast
    private var pendingEstimatedInputTokens = 0
    private var pendingEstimatedOutput = ""
    private var pendingUsageActive = false
    private var receivedProviderUsage = false
    private var contextWatchdog = StreamingContextWatchdog.shared
    private var activeStreamTask: Task<Void, Never>?
    private var pendingMemoryTurn: PendingAgentMemoryTurn?
    private var activeMemoryWrites: [UUID: ActiveAgentMemoryWrite] = [:]
    private var memoryClearCounts: [UUID: Int] = [:]
    private var streamGeneration: UInt64 = 0
    private var memoryWriteRevisions: [UUID: UInt64] = [:]
    private var historyWriteRevisions: [UUID: UInt64] = [:]
    private var historyDeletionCounts: [UUID: Int] = [:]
    // MARK: - Dev-only inbox poller (#1150)
    /// Background task that polls the dev-only Queen inbox JSONL file and
    /// delegates each new line. Only started in the dev variant.
    private var queenInboxPollTask: Task<Void, Never>?
    /// The autonomy loop, so a rebuild or a settings change can stop it.
    var queenAutonomyTask: Task<Void, Never>?

    /// Tasks already announced as needing a person, so the sweep says it once.
    ///
    /// In memory rather than persisted: one notice per app run is the right
    /// amount of nagging, and a restart is a reasonable moment to be reminded
    /// that several things are waiting on you.
    var escalatedReviewTaskIDs: Set<UUID> = []
    /// Criteria whose fossil "unmet" verdict this run has already re-asked,
    /// keyed by task UUID and criterion text. In memory, like
    /// `escalatedReviewTaskIDs`: one re-ask per app run is enough, and the
    /// reviewer's answer — either way — is what stops the asking.
    private var reAskedPhantomVerdicts: Set<String> = []
    /// Byte offset into `queen_inbox.jsonl` — remembered so a restart does
    /// not re-process lines already delegated. Persisted in UserDefaults so
    /// it survives app relaunches.
    private var queenInboxOffset: UInt64 = 0
    /// UserDefaults key, prefixed with the variant so dev and prod never
    /// share an offset.
    private static var queenInboxOffsetKey: String {
        "queen.inbox.offset.\(ProjectPaths.variant.rawValue)"
    }
    /// #1274: Fingerprints of inbox lines already executed — the inbox's own
    /// idempotency, independent of the delegation registry. The byte offset
    /// above is the fast path; these fingerprints are the safety net for when
    /// the offset resets (a cleared default, a truncated file, a restart from
    /// zero) and lines already handed over would otherwise be read again.
    ///
    /// The registry refuses a repeat only while the task sits in a
    /// non-terminal state; a task that reached `accepted` or `archived` is
    /// hidden from `task(forIssue:)` by design, and its line would execute a
    /// second time. The fingerprint store does not consult the registry at
    /// all: a well-formed line runs once per lifetime of this store. To
    /// deliberately re-run a delegation, change the line (a new title is
    /// enough) — the skip is named, never silent, so the operator sees why.
    private var queenInboxExecuted: Set<String> = []
    /// UserDefaults key for the persisted fingerprint set, variant-scoped for
    /// the same reason as the offset key: dev and prod never share a net.
    private static var queenInboxExecutedKey: String {
        "queen.inbox.executed.\(ProjectPaths.variant.rawValue)"
    }

    private var isConversationTransitioning = false
    /// #1224: Guards the provider-key warm-up so it starts once per session,
    /// not on every precheck refusal. The first start fills the
    /// ModelCredentialStore cache; every later call is a no-op.
    private var providerKeyWarmupStarted = false

    /// #1225: Once-per-session guards so the Queen says "key unavailable"
    /// exactly once when the warm-up gives up, and "key available" exactly
    /// once when a later warm-up finds it — not once per refusal.
    private var providerKeyUnavailableNoticePosted = false
    private var providerKeyAvailableNoticePosted = false
    private var stagedProposalIds: Set<UUID> = []
    private var stagedProposalBranches: [UUID: String] = [:]
    /// Runs delegated workers off to one side of the UI. Optional so tests and
    /// the e2e harness can construct a view model without a live transport.
    private(set) var workerRunner: QueenWorkerRunner?
    private var workerObservation: AnyCancellable?
    private var workerLivenessObservation: AnyCancellable?
    /// Working-tree snapshot taken when each worker started, so its edits can be
    /// told apart from everything else happening in the shared checkout.
    private var workerBaselineTrees: [UUID: String] = [:]
    /// Task IDs whose last failure was a connectivity issue, not a
    /// genuine worker failure. Left in .running so reapStalledWorkers
    /// retries them without spending a resume attempt (#1219).
    private var connectivityFailedTasks: Set<UUID> = []

    /// The boundary-scoped fingerprint of the task's own files at the moment
    /// verdicts were recorded, keyed by task ID. Snapshotted when the Queen
    /// or a reviewer records a verdict, so acceptance can compare the
    /// boundary the verdicts were carved against with the boundary's current
    /// state (#1131).
    ///
    /// Only the task's `ownedPaths` are hashed, so the Queen's state writes
    /// (`.trinity/state/*`) cannot age a verdict — they are outside the lane
    /// and invisible to the boundary fingerprint.
    ///
    /// This mirrors `DelegatedTask.treeStateFingerprint` but is set from the
    /// view model because the registry's `recordVerdict` does not take a
    /// fingerprint argument. At acceptance time, this takes precedence over
    /// the task's own field — if neither is set, `isStale` returns false and
    /// the verdicts stand, which is what "missing ≠ stale" means (#1131).
    ///
    /// Written only through `sealVerdictsWithBoundaryState`, which clears any
    /// earlier binding first and asserts the write landed — removing that
    /// write fires `queen.assertion.fingerprint_not_recorded` in the journal
    /// (#1131 criterion 4).
    private var verdictTreeStates: [UUID: String] = [:]
    /// Observer concerns already reported, keyed by task, so a warning fires
    /// once rather than on every streamed delta.
    private var announcedConcerns: [UUID: Set<String>] = [:]

    init(
        transport: ChatTransportProtocol,
        healthCheck: ChatHealthCheckProtocol,
        parser: ChatParserProtocol,
        persister: ChatPersisterProtocol,
        stateMachine: ConversationStateMachine,
        a2aClient: A2ARegistryClient? = nil,
        modelStore: ModelConfigurationStore,
        memoryService: AgentMemoryService,
        todoPlanner: TODOPlanner,
        workerRunner: QueenWorkerRunner? = nil,
        // Optional rather than defaulting to .shared directly: a default
        // argument is evaluated outside the actor, and SkillStore.shared is
        // main-actor isolated, which Swift 6 rejects. Resolved inside the
        // initialiser, where the isolation already holds.
        skillStore: SkillStore? = nil,
        delegationRegistry: QueenDelegationRegistry? = nil,
        fetchIssueBody: (@Sendable (IssueReference) async -> String?)? = nil
    ) {
        self.skillStore = skillStore ?? .shared
        self.delegationRegistry = delegationRegistry ?? .shared
        self.fetchIssueBody = fetchIssueBody ?? { issue in
            // Primary path: GitHub API (requires Keychain token).
            // The primary failure used to be swallowed by `try?`, so every
            // fallback said "API empty" whatever had actually gone wrong -
            // missing token, 404, rate limit. The reason is the diagnostic.
            var primaryFailure: String?
            do {
                let fetched = try await GitHubAPIClient().fetchIssue(
                    repo: "\(issue.owner)/\(issue.repo)", number: issue.number
                ).body ?? ""
                if fetched.isEmpty {
                    primaryFailure = "the API returned an empty body"
                } else {
                    TriosLogBus.shared.info(
                        .queen, "queen.fetchIssueBody",
                        "Issue contract read via API",
                        [
                            "issue": "\(issue.owner)/\(issue.repo)#\(issue.number)",
                            "source": "api",
                        ]
                    )
                    return fetched
                }
            } catch {
                primaryFailure = error.localizedDescription
            }
            if let primaryFailure {
                TriosLogBus.shared.warn(
                    .queen, "queen.fetchIssueBody.primary_failed",
                    "API path failed before the fallback: \(primaryFailure)",
                    ["issue": "\(issue.owner)/\(issue.repo)#\(issue.number)"]
                )
            }

            // Fallback: HTTPS GET. Replaces the gh CLI subprocess that
            // added ~38 s to scoring and broke Finder launches.
            // Fallback, authenticated. The comment here used to say the
            // repository is public so no token is required; GitHub answered 403
            // and the Queen delegated with no contract at all - no acceptance
            // criteria, nothing for the reviewer to judge against. Whether the
            // repository is public or not, an unauthenticated caller gets sixty
            // requests an hour, and a supervisor polling issues exhausts that
            // before the operator wakes up.
            var req = URLRequest(
                url: URL(string: "https://api.github.com/repos/\(issue.owner)/\(issue.repo)/issues/\(issue.number)")!
            )
            req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            if let token = ChatViewModel.githubToken() {
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }

            let (data, response): (Data, URLResponse)
            do {
                (data, response) = try await URLSession.shared.data(for: req)
            } catch {
                TriosLogBus.shared.warn(
                    .queen, "queen.fetchIssueBody",
                    "Could not read issue contract: API empty, HTTPS GET failed: \(error.localizedDescription)",
                    ["issue": "\(issue.owner)/\(issue.repo)#\(issue.number)", "source": "none"]
                )
                return nil
            }

            let httpCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            guard (200...299).contains(httpCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let body = json["body"] as? String,
                  !body.isEmpty else {
                TriosLogBus.shared.warn(
                    .queen, "queen.fetchIssueBody",
                    "Could not read issue contract from HTTPS GET (HTTP \(httpCode))",
                    ["issue": "\(issue.owner)/\(issue.repo)#\(issue.number)", "source": "none", "httpStatus": String(httpCode)]
                )
                return nil
            }

            TriosLogBus.shared.info(
                .queen, "queen.fetchIssueBody",
                "Issue contract read via HTTPS GET",
                ["issue": "\(issue.owner)/\(issue.repo)#\(issue.number)", "source": "https"]
            )
            return body
        }
        NSLog("ChatViewModel.init starting")
        self.transport = transport
        self.healthCheck = healthCheck
        self.parser = parser
        self.persister = persister
        self.stateMachine = stateMachine

        // Ensure an A2A registry client exists. In the normal app launch path no
        // caller injects one, so create the embedded trios-agent client here with
        // the BrowserOS loopback endpoint and local-auth provider.
        // AGENT-V-WAIVER: QueenBackgroundService startup wiring (Agent V conditional waiver, 2026-07-27).
        let effectiveA2AClient: A2ARegistryClient
        if let client = a2aClient {
            effectiveA2AClient = client
        } else {
            let serverURL = URL(string: ProjectPaths.mcpBaseURL) ?? URL(fileURLWithPath: "/dev/null")
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
            let card = AgentCard(
                id: AgentId("trios-agent"),
                name: "trios",
                description: "Trinity A2A agent embedded in the trios macOS chat app",
                capabilities: [.browserControl, .chat, .fileSystem, .shell, .git, .orchestrator],
                version: version,
                endpoint: nil
            )
            let authProvider = LocalAuthProvider(baseURL: serverURL)
            effectiveA2AClient = A2ARegistryClient(
                serverURL: serverURL,
                agentCard: card,
                localAuthProvider: authProvider
            )
        }
        self.a2aClient = effectiveA2AClient
        self.modelStore = modelStore
        self.memoryService = memoryService
        self.todoPlanner = todoPlanner
        self.queenBackgroundService = QueenBackgroundService.shared
        self.queenBackgroundService?.delegate = self
        self.queenBackgroundService?.configure(
            memoryService: memoryService,
            persister: persister,
            a2aClient: effectiveA2AClient
        )
        NSLog("ChatViewModel.init properties set")
        self.workerRunner = workerRunner
        configureWorkerRunner()

        initializationTask = Task { [weak self] in
            guard let self else { return }
            NSLog("ChatViewModel.init Task started")
            await setupConversationId()
            await loadHistory()
            await todoPlanner.load(conversationId: conversationId)
            await loadConversations()
            // The list pass above almost certainly ran inside the key-outage
            // window; schedule the one that will not.
            startHealSweepAfterKeyReturns()
            // E2E testing instrument: when TRIOS_E2E_DUMP_QUEEN_CHAT=1, write
            // the Queen conversation to a plaintext file inside the app's data
            // directory so a test harness can verify what the Queen said without
            // decrypting UserDefaults. WARNING: conversation content lands in
            // plain text here — this is only acceptable because the environment
            // variable explicitly opts in, and it must never be enabled in
            // production.
            if ProcessInfo.processInfo.environment["TRIOS_E2E_DUMP_QUEEN_CHAT"] == "1" {
                let queenMessages = await persister.load(
                    conversationId: ChatConversation.trinityQueenId
                )
                let dumpDir = FileManager.default
                    .urls(for: .applicationSupportDirectory, in: .userDomainMask)
                    .first!
                    .appendingPathComponent("trios", isDirectory: true)
                try? FileManager.default.createDirectory(
                    at: dumpDir, withIntermediateDirectories: true
                )
                let dumpFile = dumpDir.appendingPathComponent(
                    "e2e-queen-chat-dump.txt"
                )
                let lines = queenMessages.map { "\($0.role.rawValue): \($0.content)" }
                try? lines.joined(separator: "\n")
                    .write(to: dumpFile, atomically: true, encoding: .utf8)
            }
            // #1132 criterion 4, driven: when TRIOS_E2E_DRILL_1132=1, run
            // the empty-branch deletion drill once at startup. A guard that
            // has never fired is a claim, not a check — the assertion inside
            // diffForReview sat behind the empty-branch early return and had
            // never once been evaluated against a real diff. The drill
            // restores exactly the comparison the old code made — a base
            // taken after someone else's work against an empty branch — on
            // real repository history, expects the phantom deletions to
            // appear, expects the check to fire on them, and expects the
            // shipped path to refuse the empty branch anyway. Its verdict
            // lands in the journal (queen.drill.empty_branch_deletion.*),
            // so the proof is a run, not a comment. Env-gated so it costs
            // nothing unless asked for.
            if ProcessInfo.processInfo.environment["TRIOS_E2E_DRILL_1132"] == "1" {
                await runEmptyBranchDeletionDrill()
            }
            await checkHealth()
            let skipA2AStartup = ProcessInfo.processInfo.environment[
                "TRIOS_SKIP_A2A_STARTUP"
            ] == "1"
            if let service = self.queenBackgroundService, !service.isRunning, !skipA2AStartup {
                await service.start()
                NSLog("ChatViewModel A2A background service started")
            } else if skipA2AStartup {
                NSLog("ChatViewModel A2A startup skipped (TRIOS_SKIP_A2A_STARTUP=1)")
            }
            NSLog("ChatViewModel.init Task done")
            initializationTask = nil
        }
        healthCheckTask = Task {
            while !Task.isCancelled {
                await checkHealth()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }

        // #1150: Dev-only inbox poller. Reads `.trinity-dev/state/queen_inbox.jsonl`,
        // remembers its byte offset, and approves + delegates each new line.
        // Runs only in the dev variant so a release app never picks up a
        // dev inbox.
        if ProjectPaths.hasSupervisorInbox {
            queenInboxOffset = UInt64(
                UserDefaults.standard.double(forKey: Self.queenInboxOffsetKey)
            )
            queenInboxExecuted = Self.loadInboxExecuted()
            queenInboxPollTask = Task { [weak self] in
                guard let self else { return }
                while !Task.isCancelled {
                    await self.pollQueenInbox()
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                }
            }
        }

        NSLog("ChatViewModel.init finished")
    }

    deinit {
        initializationTask?.cancel()
        healthCheckTask?.cancel()
        queenInboxPollTask?.cancel()
    }

    // MARK: - Dev-only inbox poller (#1150)

    /// One line of `queen_inbox.jsonl`. Every field except `issue` is optional;
    /// missing values fall back to the same defaults the `/delegate` command uses.
    ///
    /// Line format — one JSON object per line, UTF-8:
    /// ```
    /// {"issue":"gHashTag/trios#123","worker":"queen-swift","title":"Fix X","paths":["src/Foo.swift"],"skill":null,"criteria":["it compiles"]}
    /// ```
    ///
    /// - `issue` (required): GitHub reference parseable by `IssueReference.parse`,
    ///   e.g. `"gHashTag/trios#1150"`.
    /// - `worker` (optional): worker identifier; defaults to `"queen-swift"`.
    /// - `title` (optional): task title shown in the sidebar;
    ///   defaults to `"Work on <slug>"`.
    /// - `paths` (optional): boundary paths the worker may edit; defaults to `[]`.
    /// - `skill` (optional): skill name passed to the worker; defaults to `nil`.
    /// - `criteria` (optional): acceptance criteria; defaults to `[]`
    ///   (the issue body is read instead).
    private struct QueenInboxEntry: Codable {
        let issue: String
        let worker: String?
        let title: String?
        let paths: [String]?
        let skill: String?
        let criteria: [String]?
    }

    /// The absolute path to the dev-only inbox file. Uses `ProjectPaths.trinity`
    /// which resolves to `.trinity-dev` under the dev variant.
    private static var queenInboxPath: String {
        "\(ProjectPaths.trinity)/state/queen_inbox.jsonl"
    }

    /// #1260: A cursor is a cache. The saved byte offset can point past the
    /// end of a file that was truncated or rotated — the offset is stale, the
    /// same way a cached value is stale when its source changes. This pure
    /// function decides whether the offset is still valid and what to use
    /// instead, so the decision is testable without the full poll loop.
    ///
    /// Returns the offset to seek to and whether a restart was needed. An
    /// offset past EOF returns zero and `didRestart: true`; anything within
    /// or at the boundary returns the offset unchanged and `didRestart: false`.
    internal static func resolveInboxOffset(
        currentOffset: UInt64,
        fileSize: UInt64
    ) -> (offset: UInt64, didRestart: Bool) {
        if currentOffset > fileSize {
            return (0, true)
        }
        return (currentOffset, false)
    }

    /// #1274: Stable fingerprint of one raw inbox line — SHA-256 hex of its
    /// UTF-8 bytes. Identical delegations collide; any edit (a new title, one
    /// more path) does not. Deliberately not `Hasher`, whose per-process seed
    /// would make fingerprints incomparable across launches. Nonisolated
    /// because it is pure — passed as a function value in the seed pass and
    /// callable from tests.
    nonisolated internal static func inboxLineFingerprint(_ line: String) -> String {
        SHA256.hash(data: Data(line.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// #1274: Can this line become a delegation? One decode plus one issue
    /// parse — the same two steps the poll loop below warns about
    /// individually. Used by the seeding pass, which must not adopt garbage
    /// as "executed" (a malformed line was never handed over, so a later
    /// re-read should still say so rather than claim a skip). Nonisolated:
    /// pure, and passed as a function value.
    nonisolated internal static func isExecutableInboxLine(_ line: String) -> Bool {
        guard let data = line.data(using: .utf8),
              let entry = try? JSONDecoder().decode(QueenInboxEntry.self, from: data)
        else { return false }
        return IssueReference.parse(entry.issue) != nil
    }

    /// #1274: The poll loop's skip decision as a pure function, so the
    /// exactly-once contract is testable without a live poller. Walks a batch
    /// of raw lines and returns the ones still to execute, the ones to skip
    /// as already executed (with fingerprints, so the caller can *name* the
    /// skip rather than fall silent), and the grown set — a line seen twice
    /// inside one batch is skipped the second time.
    ///
    /// `isExecutable` decides which fresh lines are recorded: the poll loop
    /// records only lines it actually hands over, so a malformed line is
    /// warned about every time it is read, never "skipped as executed".
    /// Nonisolated: pure, and driven directly from tests.
    nonisolated internal static func filterInboxLines(
        _ lines: [String],
        executed: Set<String>,
        isExecutable: (String) -> Bool = { _ in true }
    ) -> (execute: [String],
          skipped: [(line: String, fingerprint: String)],
          executedAfter: Set<String>) {
        var grown = executed
        var toExecute: [String] = []
        var skipped: [(line: String, fingerprint: String)] = []
        for line in lines {
            let fingerprint = inboxLineFingerprint(line)
            if grown.contains(fingerprint) {
                skipped.append((line, fingerprint))
                continue
            }
            if isExecutable(line) {
                grown.insert(fingerprint)
                toExecute.append(line)
            }
        }
        return (toExecute, skipped, grown)
    }

    /// #1274: Reads the persisted fingerprint set. Stored beside the offset,
    /// in UserDefaults, so both survive a relaunch and reset together if a
    /// human clears the domain.
    private static func loadInboxExecuted() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: queenInboxExecutedKey) ?? [])
    }

    /// #1274: Persists the whole set, sorted for stable diffs. Called only
    /// when the set grew; cheap at dev-inbox scale.
    private func persistInboxExecuted() {
        UserDefaults.standard.set(
            queenInboxExecuted.sorted(), forKey: Self.queenInboxExecutedKey
        )
    }

    /// Reads any new lines appended since the last poll and delegates each one.
    /// The byte offset is persisted to UserDefaults after each read, so a
    /// restart resumes from where it stopped without re-delegating.
    private func pollQueenInbox() async {
        // The guard at the startup site stops the background loop from ever
        // being created in a release build. This one guards the read itself,
        // so no other caller - `enqueueQueenInboxEntry` included - can reach a
        // dev inbox out of a release app (#1090).
        guard ProjectPaths.hasSupervisorInbox else { return }
        let path = Self.queenInboxPath
        guard FileManager.default.fileExists(atPath: path),
              let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        else { return }
        defer { try? handle.close() }

        // #1260: A cursor is a cache — check the size before the seek. If the
        // file was truncated or rotated, the saved offset points past EOF and
        // readToEnd() silently returns nothing, losing every line appended
        // since the shrink. Resolve the offset first; restart from zero and
        // announce it if the cursor is stale.
        guard let fileSize = try? handle.seekToEnd() else { return }
        let (resolvedOffset, didRestart) = Self.resolveInboxOffset(
            currentOffset: queenInboxOffset, fileSize: fileSize
        )
        if didRestart {
            TriosLogBus.shared.info(
                .queen, "queen.inbox.restarted",
                "Inbox cursor (\(queenInboxOffset) B) was past EOF (\(fileSize) B) — restarting from zero",
                ["oldOffset": "\(queenInboxOffset)", "fileSize": "\(fileSize)"]
            )
            queenInboxOffset = 0
            UserDefaults.standard.set(
                Double(queenInboxOffset), forKey: Self.queenInboxOffsetKey
            )
        }

        // #1274: Converge with fingerprints persisted since the last tick —
        // a second poller (a second window, the delegate probe) may have
        // executed lines this one never saw. The union never shrinks.
        queenInboxExecuted.formUnion(Self.loadInboxExecuted())

        // #1274: Cold start of the fingerprint store. The offset says these
        // bytes were consumed before the store existed, so the well-formed
        // lines among them are adopted as already executed — the safety net
        // then covers the file's whole past, not just its future. Never done
        // after a restart-from-zero: an offset past EOF proves nothing about
        // the bytes now sitting in the file, and adopting them could skip
        // lines nobody ever executed.
        if queenInboxExecuted.isEmpty, resolvedOffset > 0, !didRestart {
            try? handle.seek(toOffset: 0)
            if let head = try? handle.read(upToCount: Int(resolvedOffset)),
               let headText = String(data: head, encoding: .utf8) {
                let seeds = headText
                    .split(separator: "\n", omittingEmptySubsequences: true)
                    .map(String.init)
                    .filter(Self.isExecutableInboxLine)
                    .map(Self.inboxLineFingerprint)
                if !seeds.isEmpty {
                    queenInboxExecuted.formUnion(seeds)
                    persistInboxExecuted()
                    TriosLogBus.shared.info(
                        .queen, "queen.inbox.seeded",
                        "Adopted \(seeds.count) already-read lines as executed — the fingerprint store starts empty",
                        ["seeded": String(seeds.count), "offset": String(resolvedOffset)]
                    )
                }
            }
        }

        try? handle.seek(toOffset: resolvedOffset)
        guard let data = try? handle.readToEnd(), !data.isEmpty else { return }

        // Advance the offset before processing so a crash mid-delegation
        // does not re-process the same lines.
        queenInboxOffset += UInt64(data.count)
        UserDefaults.standard.set(
            Double(queenInboxOffset), forKey: Self.queenInboxOffsetKey
        )

        guard let text = String(data: data, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)

        // Parse every line before dispatching, so malformed lines are logged
        // and skipped without blocking the valid ones. The entries are then
        // dispatched concurrently rather than one waiting for the next (#1150).
        var parsed: [(issue: IssueReference, entry: QueenInboxEntry)] = []
        let executedBefore = queenInboxExecuted.count
        for line in lines {
            // #1274: the inbox's own idempotency, not the registry's. A line
            // whose fingerprint was already executed is skipped with a named
            // event. Until now the repeat was caught by the delegation
            // registry — and only while the task sat in a non-terminal
            // state; one that had reached `accepted` or `archived` is
            // invisible to `task(forIssue:)`, so its line ran twice. The
            // check fires before the decode, so a skipped line costs one
            // hash and one log line, and covers duplicates within this same
            // batch as well as repeats after an offset reset.
            let fingerprint = Self.inboxLineFingerprint(line)
            if queenInboxExecuted.contains(fingerprint) {
                TriosLogBus.shared.info(
                    .queen, "queen.inbox.skipped",
                    "Skipped — line already executed",
                    ["fingerprint": fingerprint, "line": String(line.prefix(200))]
                )
                continue
            }

            guard let lineData = line.data(using: .utf8),
                  let entry = try? JSONDecoder().decode(
                      QueenInboxEntry.self, from: lineData
                  )
            else {
                TriosLogBus.shared.warn(
                    .queen, "queen.inbox",
                    "Could not parse inbox line: \(line.prefix(200))",
                    ["line": String(line.prefix(200))]
                )
                continue
            }

            guard let issue = IssueReference.parse(entry.issue) else {
                TriosLogBus.shared.warn(
                    .queen, "queen.inbox",
                    "Could not parse issue reference: \(entry.issue)",
                    ["raw": entry.issue]
                )
                continue
            }

            // #1274: Record the fingerprint with the hand-over, on the same
            // crash-safety principle as the offset advance above — a crash
            // mid-delegation must not hand the same line over twice. Only a
            // line that parses gets here, so a malformed line is never
            // claimed as "already executed" by a later re-read.
            queenInboxExecuted.insert(fingerprint)

            TriosLogBus.shared.info(
                .queen, "queen.inbox",
                "Inbox entry read: \(issue.slug)",
                ["issue": issue.slug, "worker": entry.worker ?? "queen-swift"]
            )

            parsed.append((issue, entry))
        }
        if queenInboxExecuted.count != executedBefore {
            persistInboxExecuted()
        }

        // Dispatch all valid entries concurrently, so one entry's network
        // calls (fetchIssueBody, createVirtualBranch) do not block the next
        // (#1150).  The slot limit is enforced inside delegateIssueToWorker
        // and re-checked before the transition to .running.
        await dispatchInboxEntries(parsed.map { issue, entry in
            (issue: issue,
             worker: entry.worker ?? "queen-swift",
             title: entry.title ?? "Work on \(issue.slug)",
             paths: entry.paths ?? [],
             skill: entry.skill,
             criteria: entry.criteria ?? [])
        })
    }

    /// The one entrance for a delegation that arrives from outside the chat UI
    /// (#1090).
    ///
    /// There used to be two. The launch-environment probe
    /// (`TRIOS_E2E_DELEGATE`, read in main.swift) carried its own approve +
    /// delegate implementation while this file's poller called
    /// `approveDelegation` and `delegateIssueToWorker` directly, and the two
    /// already disagreed about what a spec meant. Callers now append the spec
    /// here and the poller does the work: one file format, one consumer, one
    /// set of bugs.
    ///
    /// The line is consumed synchronously rather than left for the next 5 s
    /// tick. The background loop's latency was measured at 0.6-3.9 s per
    /// entry, which a launch probe would pay on every run.
    ///
    /// Returns false when the entry could not be queued. A release build has
    /// no inbox to write to, which is the whole point of the dev-variant
    /// guard - the caller is told rather than left believing it delegated.
    @discardableResult
    internal func enqueueQueenInboxEntry(
        issue: String,
        worker: String?,
        title: String?,
        paths: [String]?,
        skill: String?,
        criteria: [String]?
    ) async -> Bool {
        guard ProjectPaths.hasSupervisorInbox else {
            TriosLogBus.shared.warn(
                .queen, "queen.inbox",
                "No inbox in a release build - the delegation was not queued",
                ["issue": issue]
            )
            return false
        }

        let entry = QueenInboxEntry(
            issue: issue,
            worker: worker,
            title: title,
            paths: paths,
            skill: skill,
            criteria: criteria
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard var data = try? encoder.encode(entry) else {
            TriosLogBus.shared.warn(
                .queen, "queen.inbox",
                "Could not encode the delegation as an inbox line",
                ["issue": issue]
            )
            return false
        }
        data.append(0x0A)

        let path = Self.queenInboxPath
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        // O_APPEND, not seekToEnd: the Makefile's running-app branch appends
        // with the shell's `>>`, and an atomic append is the only thing that
        // keeps a human running both at once from interleaving a partial line.
        let descriptor = Darwin.open(path, O_WRONLY | O_APPEND)
        guard descriptor >= 0 else {
            TriosLogBus.shared.warn(
                .queen, "queen.inbox",
                "Could not open the inbox for appending: \(path)",
                ["issue": issue, "path": path]
            )
            return false
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: data)
        } catch {
            try? handle.close()
            TriosLogBus.shared.warn(
                .queen, "queen.inbox",
                "Could not append the delegation to the inbox: \(error.localizedDescription)",
                ["issue": issue, "path": path]
            )
            return false
        }
        try? handle.close()

        await pollQueenInbox()
        return true
    }

    /// Dispatches a batch of inbox entries concurrently, so one entry's
    /// network calls do not block the next (#1150).  Each entry is approved
    /// and delegated in its own child task; the worker slot limit is enforced
    /// inside `delegateIssueToWorker` (pre-check) and re-checked atomically
    /// before the transition to `.running`.
    ///
    /// Internal so the test suite can verify concurrency and slot-limit
    /// enforcement without writing to the inbox file.
    internal func dispatchInboxEntries(
        _ entries: [(issue: IssueReference, worker: String, title: String,
                     paths: [String], skill: String?, criteria: [String])]
    ) async {
        await withTaskGroup(of: Void.self) { group in
            for e in entries {
                group.addTask { [weak self] in
                    guard let self else { return }
                    await self.approveDelegation(issue: e.issue)
                    TriosLogBus.shared.info(
                        .queen, "queen.inbox",
                        "Approved: \(e.issue.slug)",
                        ["issue": e.issue.slug]
                    )
                    await self.delegateIssueToWorker(
                        issue: e.issue,
                        worker: e.worker,
                        title: e.title,
                        paths: e.paths,
                        skill: e.skill,
                        criteria: e.criteria
                    )
                    // "Dispatched", not "Delegated": delegateIssueToWorker
                    // refuses on a boundary conflict or a full slot table and
                    // says so in its own `queen.delegate` record. This line
                    // only witnesses that the entry was handed over, and
                    // claiming more made a refusal read as a success (#1090).
                    TriosLogBus.shared.info(
                        .queen, "queen.inbox",
                        "Dispatched: \(e.issue.slug)",
                        ["issue": e.issue.slug, "worker": e.worker]
                    )
                }
            }
        }
    }

    func setupConversationId() async {
        conversationId = await persister.currentConversationId()
    }

    /// The output-token budget for the current conversation, falling back to the
    /// global store default when no per-conversation override exists.
    var effectiveConversationOutputTokens: Int? {
        conversationSettings[conversationId]?.requestedOutputTokens ?? modelStore.requestedOutputTokens
    }

    /// The context-window margin for the current conversation, falling back to the
    /// global store default when no per-conversation override exists.
    var effectiveConversationContextMargin: Double {
        conversationSettings[conversationId]?.contextWindowMargin ?? modelStore.contextWindowMargin
    }

    /// True when the current conversation has a per-conversation output-budget override.
    var hasConversationOutputTokensOverride: Bool {
        conversationSettings[conversationId]?.requestedOutputTokens != nil
    }

    /// True when the current conversation has a per-conversation model/provider override.
    var hasConversationModelOverride: Bool {
        let settings = conversationSettings[conversationId] ?? .default
        return settings.provider != nil || settings.model != nil || settings.baseURL != nil
    }

    /// The provider selected for this conversation, falling back to the global default.
    var effectiveConversationProvider: ModelProvider {
        conversationSettings[conversationId]?.provider ?? modelStore.selectedProvider
    }

    /// The model selected for this conversation, falling back to the global default.
    var effectiveConversationModel: String {
        conversationSettings[conversationId]?.model ?? modelStore.selectedModel
    }

    /// The base URL selected for this conversation, falling back to the global default.
    var effectiveConversationBaseURL: String {
        conversationSettings[conversationId]?.baseURL ?? modelStore.baseURL
    }

    /// A conversation-scoped model constraint when the current conversation has
    /// pinned a specific (provider, baseURL, model) tuple. `nil` means routing,
    /// warmup, and failover may consider all eligible candidates.
    var conversationModelConstraint: ConversationModelConstraint? {
        let settings = conversationSettings[conversationId] ?? .default
        guard let provider = settings.provider,
              let baseURL = settings.baseURL,
              let model = settings.model else { return nil }

        // Heal a stale host. A pin exists to keep a conversation on one provider
        // and model; the base URL is infrastructure, not intent. When the user
        // changes the provider's endpoint in settings, a conversation pinned to
        // the old host keeps calling it forever - which showed up as Z.AI code
        // 1113 on a perfectly good key long after the endpoint was corrected.
        if provider == modelStore.selectedProvider, baseURL != modelStore.baseURL {
            TriosLogBus.shared.warn(
                .models,
                "chat.pin.endpoint_healed",
                "Pinned conversation was still using the previous endpoint",
                ["from": baseURL, "to": modelStore.baseURL, "model": model]
            )
            return ConversationModelConstraint(
                provider: provider,
                baseURL: modelStore.baseURL,
                model: model
            )
        }
        return ConversationModelConstraint(provider: provider, baseURL: baseURL, model: model)
    }

    /// Sets (or clears) the per-conversation output-token budget and persists it.
    func setConversationRequestedOutputTokens(_ tokens: Int?) async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.requestedOutputTokens = tokens.map { max(0, $0) }
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Sets the per-conversation context-window margin and persists it.
    func setConversationContextWindowMargin(_ margin: Double) async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.contextWindowMargin = max(0.5, min(0.95, margin))
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Pins a provider/model/baseURL to the current conversation and persists it.
    func setConversationModelOverride(provider: ModelProvider, baseURL: String, model: String) async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.provider = provider
        settings.baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Clears the per-conversation model/provider override for the current conversation.
    func clearConversationModelOverride() async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.provider = nil
        settings.baseURL = nil
        settings.model = nil
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Clears the per-conversation output-token budget override for the current conversation.
    func clearConversationOutputTokensOverride() async {
        var settings = conversationSettings[conversationId] ?? .default
        settings.requestedOutputTokens = nil
        conversationSettings[conversationId] = settings
        await persister.saveSettings(settings, conversationId: conversationId)
    }

    /// Loads persisted per-conversation settings when switching conversations.
    private func loadConversationSettings() async {
        let settings = await persister.loadSettings(conversationId: conversationId)
        conversationSettings[conversationId] = settings
    }

    /// Pre-send context status for the current draft, computed synchronously from
    /// the advertised model profile and the effective conversation margin.
    var draftContextStatus: DraftContextStatus? {
        guard !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let profile = ModelContextService.shared.advertisedProfile(
            for: effectiveConversationModel,
            provider: effectiveConversationProvider
        )
        let systemPrompt = memoryService.promptContext(for: recalledMemories)
        return ChatRequestSizer.draftContextUtilization(
            draft: inputText,
            history: messages,
            systemPrompt: systemPrompt,
            modelProfile: profile,
            margin: effectiveConversationContextMargin
        )
    }

    /// Shorthand for the composer utilization badge.
    var draftContextUtilizationPercent: Double? {
        draftContextStatus?.utilizationPercent
    }

    /// True when the draft alone exceeds the usable context window and sending
    /// would result in `.tooLargeEvenEmpty`.
    var isDraftContextLimitExceeded: Bool {
        draftContextStatus?.isTooLarge ?? false
    }

    /// The advertised profile of the model pinned to this conversation, if any.
    /// Used for cause-specific send-button guardrails.
    private var pinnedModelAdvertisedProfile: ModelContextProfile? {
        guard let constraint = conversationModelConstraint else { return nil }
        return ModelContextService.shared.advertisedProfile(
            for: constraint.candidate.model,
            provider: constraint.candidate.provider
        )
    }

    /// A description of why the pinned model cannot send the current draft, if any.
    /// Returns `nil` when there is no pin or the draft fits within both context and
    /// output-budget limits.
    var pinnedSendLimitReason: String? {
        guard let constraint = conversationModelConstraint,
              let profile = pinnedModelAdvertisedProfile else { return nil }
        let margin = effectiveConversationContextMargin
        let usableWindow = Int(Double(profile.maxContextTokens) * margin)
        let draftTokens = TokenEstimator.estimate(inputText)
        let contextExceeded = usableWindow > 0 && draftTokens > usableWindow

        // effectiveConversationOutputTokens already falls back to the store, so
        // the second `?? modelStore.requestedOutputTokens` here was the same
        // fallback written twice. Harmless today because the store value is
        // always nil, which is its own problem, but two statements of one rule
        // is how this file has produced most of its defects.
        let requestedOutput = effectiveConversationOutputTokens ?? 0
        let outputExceeded = requestedOutput > 0 && requestedOutput > profile.maxOutputTokens

        if contextExceeded && outputExceeded {
            return "Pinned to \(constraint.candidate.provider.displayName) / \(constraint.candidate.model): draft exceeds \(formatCompact(usableWindow)) context window and requested \(requestedOutput) output tokens exceeds \(profile.maxOutputTokens) ceiling."
        }
        if contextExceeded {
            return "Pinned to \(constraint.candidate.provider.displayName) / \(constraint.candidate.model): draft exceeds \(formatCompact(usableWindow)) context window."
        }
        if outputExceeded {
            return "Pinned to \(constraint.candidate.provider.displayName) / \(constraint.candidate.model): requested \(requestedOutput) output tokens exceeds \(profile.maxOutputTokens) ceiling."
        }
        return nil
    }

    /// True when the pinned model cannot fit the draft or honor the requested
    /// output budget. When false, the global default would be used or the
    /// conversation is not pinned.
    var isPinnedModelSendBlocked: Bool {
        pinnedSendLimitReason != nil
    }

    private func formatCompact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
        return "\(value)"
    }

    func loadHistory() async {
        // A worker chat opened mid-run must show what the bee has produced so
        // far. The persisted copy is only written at the start and end of a
        // worker turn, so the runner's live transcript wins while it is active.
        if let runner = workerRunner,
           runner.isRunning(conversationId: conversationId),
           let live = runner.transcripts[conversationId] {
            messages = live
            rebuildCache()
            return
        }
        let history = await persister.load(conversationId: conversationId)
        history.forEach { $0.isStreaming = false }
        messages = history
        rebuildCache()
    }

    func loadConversations() async {
        var loaded = await persister.listAllConversations()
        if !loaded.contains(where: { $0.id == ChatConversation.trinityQueenId }) {
            loaded.insert(.trinityQueen, at: 0)
            // Persist an empty reserved conversation so it survives restarts.
            await persister.save(messages: [], conversationId: ChatConversation.trinityQueenId)
        }
        // Ensure the reserved conversation is always pinned and has the canonical icon/title.
        if let index = loaded.firstIndex(where: { $0.id == ChatConversation.trinityQueenId }) {
            loaded[index].isPinned = true
            loaded[index].icon = "crown.fill"
            loaded[index].title = "Trinity Queen"
        }
        conversations = loaded
    }

    func sessionRecoveryConversations() async -> SessionRecoverySanitized<[SessionRecoveryConversation]> {
        let activeID = conversationId
        let activeMessages = messages
        let activeTitle = conversations.first(where: { $0.id == activeID })?.title
            ?? activeMessages.first(where: { $0.role == .user })?.content
            ?? "New task"
        let activeUpdatedAt = activeMessages.last?.timestamp ?? Date()
        let activeRaw = SessionRecoverySnapshotFactory.conversation(
            id: activeID,
            title: activeTitle,
            updatedAt: activeUpdatedAt,
            messages: activeMessages
        )
        let active = SessionRecoverySanitizer.sanitize(activeRaw)

        let summaries = await persister.listAllConversations()
        var persisted: [SessionRecoveryConversation] = []
        var redactionCount = active.redactionCount
        for summary in summaries where summary.id != activeID {
            let storedMessages = await persister.load(conversationId: summary.id)
            let raw = SessionRecoverySnapshotFactory.conversation(
                id: summary.id,
                title: summary.title,
                updatedAt: summary.updatedAt,
                messages: storedMessages
            )
            let sanitized = SessionRecoverySanitizer.sanitize(raw)
            redactionCount += sanitized.redactionCount
            persisted.append(sanitized.value)
        }

        return SessionRecoverySanitized(
            value: SessionRecoveryConversationMerger.merge(
                persisted: persisted,
                active: active.value
            ),
            redactionCount: redactionCount
        )
    }

    /// Export with progress reporting. Progress is published to
    /// `recoveryProgress` on the main actor.
    func exportRecoveryPackage(
        request: SessionRecoveryPackageRequest,
        to destinationURL: URL
    ) async throws -> SessionRecoveryExportResult {
        recoveryProgress.start(operation: .export, totalFiles: request.conversations.count + 1)
        defer { recoveryProgress.finish() }

        return try await Task.detached(priority: .userInitiated) {
            try SessionRecoveryPackageWriter().write(
                request: request,
                to: destinationURL
            )
        }.value
    }

    /// Imports a Trinity recovery ZIP into the local encrypted conversation store.
    /// The active conversation is switched to the recovered active conversation.
    /// Duplicate handling defaults to `.skip` when no resolver is supplied.
    func importRecoveryPackage(
        from url: URL,
        resolvingDuplicates resolver: ((UUID, String) async -> SessionRecoveryDuplicateResolution)? = nil
    ) async throws -> SessionRecoveryImportSummary {
        await awaitInitialization()

        recoveryProgress.start(operation: .import, totalFiles: 1)
        defer { recoveryProgress.finish() }

        let result = try await Task.detached(priority: .userInitiated) {
            try SessionRecoveryPackageReader.read(from: url)
        }.value

        let existing = await persister.listAllConversations()
        let existingByID = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })

        var importedMessages = 0
        var successCount = 0
        var savedIDs: [UUID] = []

        for recoveryConversation in result.conversations {
            let id = recoveryConversation.id
            let messages = SessionRecoverySnapshotFactory.chatMessage(from: recoveryConversation)
            importedMessages += messages.count

            let resolution: SessionRecoveryDuplicateResolution
            if existingByID[id] != nil {
                resolution = await resolver?(id, recoveryConversation.title) ?? .skip
            } else {
                resolution = .replace
            }

            let messagesToSave: [ChatMessage]
            switch resolution {
            case .replace:
                messagesToSave = messages
            case .merge:
                let existingMessages = await persister.load(conversationId: id)
                let existingIDs = Set(existingMessages.map { $0.id })
                let newMessages = messages.filter { !existingIDs.contains($0.id) }
                messagesToSave = existingMessages + newMessages
            case .skip:
                messagesToSave = []
            }

            guard !messagesToSave.isEmpty || resolution == .replace else {
                continue
            }

            await persister.save(messages: messagesToSave, conversationId: id)
            await persister.renameConversation(
                id: id,
                title: ConversationTitlePolicy.normalized(recoveryConversation.title)
            )
            savedIDs.append(id)
            successCount += 1
        }

        let activeID = result.activeConversationID
        if result.conversations.contains(where: { $0.id == activeID && savedIDs.contains($0.id) }) {
            conversationId = activeID
            await persister.setCurrentConversationId(activeID)
            await loadHistory()
            await todoPlanner.load(conversationId: activeID)
        }
        await loadConversations()

        return SessionRecoveryImportSummary(
            conversationCount: result.conversations.count,
            successCount: successCount,
            failureCount: result.conversations.count - successCount,
            messageCount: importedMessages,
            activeConversationID: activeID,
            failedConversationIDs: []
        )
    }

    func switchConversation(id: UUID) async {
        await awaitInitialization()
        guard beginConversationTransition() else { return }
        defer { endConversationTransition() }
        invalidateActiveStream()
        await performConversationSwitch(id: id)
    }

    private func performConversationSwitch(id: UUID) async {
        // A turn in flight is about to be cancelled. Save what it produced to
        // the conversation it belongs to first: clicking another chat used to
        // destroy a nearly-finished answer with nothing left behind, which is
        // how the Queen appeared to simply stop.
        await preserveInterruptedTurn(reason: "you opened another chat")
        // Cancel any in-flight stream before loading a different conversation;
        // otherwise late SSE events could corrupt the newly loaded messages.
        await cancelPendingTurn()
        await transport.cancel()
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        recalledMemories = []
        memoryControlRevision &+= 1
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        conversationId = id
        await persister.setCurrentConversationId(id)
        await loadHistory()
        await todoPlanner.load(conversationId: id)
        await loadConversationSettings()
        applyConversationModelOverrideIfNeeded()
        await loadConversations()
        tokenUsage.reset()
        showHistory = false
    }

    /// Applies a per-conversation provider/model/baseURL override without mutating
    /// the global defaults, so switching back restores the previous selection.
    private func applyConversationModelOverrideIfNeeded() {
        let settings = conversationSettings[conversationId] ?? .default
        guard let provider = settings.provider,
              let model = settings.model,
              let baseURL = settings.baseURL else { return }
        modelStore.applySelection(provider: provider, baseURL: baseURL, model: model)
    }

    /// Execute a Queen slash command locally, switching to the Queen conversation
    /// if necessary so the result is visible in the chat timeline.
    func runQueenCommand(_ text: String) async {
        await awaitInitialization()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.hasPrefix("/") else { return }
        if conversationId != ChatConversation.trinityQueenId {
            await switchConversation(id: ChatConversation.trinityQueenId)
        }
        let command = QueenCommandParser.parse(trimmed)
        await executeQueenCommand(command, originalText: trimmed)
    }

    func sendMessage(
        text customText: String? = nil,
        appendUser: Bool = true,
        imageAttachments: [ChatComposerAttachment] = [],
        onAccepted: (() -> Void)? = nil
    ) async {
        await awaitInitialization()
        let text = (customText ?? inputText).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isConversationTransitioning else { return }

        let now = Date()
        guard now.timeIntervalSince(lastSendTime) >= 0.5 else {
            NSLog("[TriosChat] debounce blocked")
            return
        }
        lastSendTime = now
        contextUtilizationPercent = nil
        contextRoutingLabel = nil
        requestError = nil
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false

        // Trinity Queen conversation intercepts slash commands locally.
        if conversationId == ChatConversation.trinityQueenId, text.hasPrefix("/") {
            let command = QueenCommandParser.parse(text)
            inputText = ""
            await executeQueenCommand(command, originalText: text)
            return
        }

        // Log only text-derived facts here. Reading modelStore from this point in
        // the send path perturbs the streaming turn, so provider and model are
        // recorded by the routing and transport events instead.
        TriosLogBus.shared.info(
            .chat,
            "chat.send.start",
            "Sending a message",
            ["chars": String(text.count)]
        )

        // Save to message history for (up/down) hotkey navigation
        messageHistory.append(text)
        if messageHistory.count > 50 {  // Limit history to 50 messages
            messageHistory.removeFirst()
        }

        let memoryGoal = memorySafeGoal(from: text)
        let shouldRemember = isEligibleForLongTermMemory(text)
            && !isMemoryClearInProgress(conversationId)
        let sourceMessageId: UUID
        if appendUser {
            let userMessage = ChatMessage(role: .user, content: text)
            sourceMessageId = userMessage.id
            messages.append(userMessage)
            rebuildCache()
        } else if let existingUser = messages.last(where: { $0.role == .user }) {
            sourceMessageId = existingUser.id
        } else {
            sourceMessageId = UUID()
        }
        inputText = ""

        let ok = await stateMachine.tryTransition(to: .streaming(messageId: UUID()))
        guard ok else {
            NSLog("[TriosChat] stateMachine blocked transition, aborting")
            if appendUser {
                messages.removeLast()
                rebuildCache()
            }
            inputText = text
            return
        }
        state = await stateMachine.currentState()
        NSLog("[TriosChat] state transitioned to streaming")
        onAccepted?()

        streamGeneration &+= 1
        let generation = streamGeneration
        pendingMemoryTurn = PendingAgentMemoryTurn(
            conversationId: conversationId,
            sourceMessageId: sourceMessageId,
            goal: memoryGoal,
            streamGeneration: generation,
            memoryWriteRevision: memoryWriteRevision(
                for: conversationId
            ),
            shouldRemember: shouldRemember,
            assistantMessageId: nil
        )

        await todoPlanner.startPlan(
            conversationId: conversationId,
            goal: memoryGoal
        )
        guard isCurrentStream(generation) else { return }

        let recallRevision = memoryControlRevision
        let recalled = await memoryService.recall(
            for: memoryGoal,
            limit: 3
        )
        guard isCurrentStream(generation) else { return }
        recalledMemories = recallRevision == memoryControlRevision ? recalled : []

        // Exclude only the current user message from previousConversation: the server
        // receives it separately via the `message` field, and duplicating it
        // confuses the model and the UI. When continuing from a paused stream,
        // the current user message is not the last message, so a simple dropLast()
        // would incorrectly drop the partial assistant response (INV-9).
        var historyForRequest = messages.filter { $0.id != sourceMessageId }
        beginUsageEstimate(message: text, history: historyForRequest)

        let requestAttachments: [ChatRequestAttachment]
        do {
            requestAttachments = try imageAttachments.compactMap { attachment in
                guard attachment.kind == .image,
                      let mediaType = attachment.mediaType,
                      !mediaType.isEmpty else {
                    return nil
                }
                let decrypted = try attachment.loadDecryptedData()
                let base64 = decrypted.base64EncodedString()
                return ChatRequestAttachment(
                    kind: "image",
                    mediaType: mediaType,
                    dataURL: "data:\(mediaType);base64,\(base64)"
                )
            }
        } catch {
            NSLog("[TriosChat] failed to decrypt image attachments: \(error.localizedDescription)")
            await failPendingTurn(message: "Failed to read image attachment")
            guard isGenerationCurrent(generation) else { return }
            _ = await stateMachine.transition(to: .error("Failed to read image attachment"))
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            clearPendingUsage()
            return
        }

        var didFailover = false

        // Capture the initial selection before any automatic switching. This is
        // what we restore to if a failover fails.
        let initialProvider = modelStore.selectedProvider
        let initialBaseURL = modelStore.baseURL
        let initialModel = modelStore.selectedModel

        // When a conversation model pin is active, warmup, routing, and all forms
        // of automatic failover must stay inside the pinned boundary.
        let constraint = conversationModelConstraint

        // Preflight health check: if the selected model is known unhealthy, switch
        // to the first healthy fallback before burning a real request. When a pin
        // is active we skip this step so we do not silently switch models.
        let preflightModel = await runPreflightHealthCheck(generation: generation)
        // This comparison was computed but never consumed. Routing decisions are
        // exactly what the LOGS tab needs in order to explain a surprising send.
        if preflightModel != modelStore.selectedModel {
            TriosLogBus.shared.info(
                .health,
                "chat.route.preflight_switch",
                "Preflight health check switched the model before sending",
                ["from": modelStore.selectedModel, "to": preflightModel]
            )
        }

        // Predictive warmup cache: if a fresh (or recently-stale) background
        // winner is available, apply it immediately without paying probe latency
        // on the send path. A stale winner triggers a coalesced background
        // refresh for future sends.
        var warmupSwitched = false
        var warmupCandidate: CrossProviderModelCandidate?
        if modelStore.isAdaptiveProviderWarmupEnabled,
           modelStore.isPredictiveWarmupEnabled,
           constraint == nil,
           let selection = await modelStore.cachedOrStaleWarmupWinner(
               tier: modelStore.preferredCostTier,
               strictQuotaGating: modelStore.isStrictQuotaGatingEnabled,
               maxStaleness: modelStore.predictiveWarmupMaxStaleness
           ) {
            let current = CrossProviderModelCandidate(
                provider: modelStore.selectedProvider,
                baseURL: modelStore.baseURL,
                model: modelStore.selectedModel
            )
            if selection.winner.selected != current {
                warmupCandidate = selection.winner.selected
                TriosLogBus.shared.info(
                    .models,
                    "chat.route.warmup_switch",
                    "Predictive warmup switched the routing target",
                    [
                        "served_stale": String(selection.isStale),
                        "to_provider": selection.winner.selected.provider.rawValue,
                        "to_model": selection.winner.selected.model,
                        "reason": selection.winner.reason
                    ]
                )
                modelStore.applySelection(
                    provider: selection.winner.selected.provider,
                    baseURL: selection.winner.selected.baseURL,
                    model: selection.winner.selected.model
                )
                warmupSwitched = true
                let prefix = selection.isStale ? "[↻ stale]" : "[↻]"
                let banner = ChatMessage(role: .system, content: "\(prefix) \(selection.winner.reason)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
            }
            if selection.isStale {
                modelStore.refreshWarmupCacheInBackground()
            }
        }

        // Adaptive provider warmup: race lightweight probes across eligible
        // providers and switch to the best live candidate before the real send.
        // A conversation pin narrows the candidate set to the pinned tuple.
        if !warmupSwitched && modelStore.isAdaptiveProviderWarmupEnabled {
            let warmupResult = await modelStore.runAdaptiveWarmup(constrainedTo: constraint)
            warmupSwitched = warmupResult.didSwitch
            if warmupSwitched {
                let banner = ChatMessage(role: .system, content: "[↻] \(warmupResult.reason)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
            }
        }

        var activeProvider = modelStore.selectedProvider
        var activeBaseURL = modelStore.baseURL
        var activeModel = modelStore.selectedModel

        let systemPrompt = memoryService.promptContext(for: recalledMemories)
        let currentMessage = ChatMessage(role: .user, content: text)
        let routingDecision = await modelStore.resolveContextRoutingDecision(
            conversationId: conversationId,
            messages: historyForRequest,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            requestedOutputTokens: effectiveConversationOutputTokens,
            candidates: modelStore.warmupCandidates(constrainedTo: constraint),
            margin: effectiveConversationContextMargin,
            constrainedTo: constraint
        )

        // Re-estimate input tokens after any routing/trimming so the stream
        // watchdog and the utilization badge see the actual request, not the
        // pre-routing estimate (Cycle 31 learned-limit sync).
        let resolvedHistory: [ChatMessage]
        switch routingDecision {
        case .trimHistory(let policy):
            resolvedHistory = await ChatRequestSizer.shared.trimmedMessages(
                from: historyForRequest,
                policy: policy
            )
        default:
            resolvedHistory = historyForRequest
        }
        let resolvedInputEstimate = TokenEstimator.estimate(
            messages: resolvedHistory,
            systemPrompt: systemPrompt
        ) + TokenEstimator.estimate(currentMessage.content)
        pendingEstimatedInputTokens = resolvedInputEstimate

        switch routingDecision {
        case .useCurrent:
            contextRoutingLabel = nil
        case .routeTo(let candidate):
            let reason = modelStore.lastContextRoutingReason ?? "routed to \(candidate.model)"
            modelStore.applyContextRoutedSelection(
                candidate: candidate,
                reason: reason
            )
            activeProvider = candidate.provider
            activeBaseURL = candidate.baseURL
            activeModel = candidate.model
            contextRoutingLabel = reason
        case .trimHistory(let policy):
            historyForRequest = await ChatRequestSizer.shared.trimmedMessages(
                from: historyForRequest,
                policy: policy
            )
            contextRoutingLabel = "trimmed \(policy.droppedMessageCount) turns"
        case .tooLargeEvenEmpty:
            let errorMessage = "This message is too long for every available model's context window."
            requestError = errorMessage
            contextRoutingLabel = "too large to send"
            contextUtilizationPercent = await modelStore.contextWindowUtilizationPercent(
                for: activeModel,
                provider: activeProvider,
                baseURL: activeBaseURL
            )
            _ = await stateMachine.transition(to: .error(errorMessage))
            state = await stateMachine.currentState()
            await saveHistory(expectedGeneration: generation)
            return
        }

        contextUtilizationPercent = await modelStore.contextWindowUtilizationPercent(
            for: activeModel,
            provider: activeProvider,
            baseURL: activeBaseURL
        )

        let streamStart = Date()
        do {
            let latency = try await executeStream(
                generation: generation,
                text: text,
                memoryGoal: memoryGoal,
                historyForRequest: historyForRequest,
                requestAttachments: requestAttachments,
                activeProvider: activeProvider,
                activeBaseURL: activeBaseURL,
                activeModel: activeModel
            )
            let didPause = latency.didPauseForContext
            await modelStore.recordSendOutcome(
                model: activeModel,
                provider: activeProvider,
                baseURL: activeBaseURL,
                success: !didPause,
                reason: didPause ? "context limit" : nil,
                latencyMs: latency.totalMs,
                timeToFirstTokenMs: latency.timeToFirstTokenMs,
                observedOutputTokens: latency.observedOutputTokens,
                observedTotalTokens: latency.observedTotalTokens,
                finishReason: latency.finishReason
            )
            await modelStore.recordCircuitBreakerSuccess(provider: activeProvider, baseURL: activeBaseURL)
            if let warmupCandidate, !didPause {
                await modelStore.recordCachedWinnerOutcome(success: true, candidate: warmupCandidate)
            }
        } catch {
            guard isCurrentStream(generation) else { return }
            let isCancellation = (error as? URLError)?.code == .cancelled
            if let warmupCandidate, !isCancellation {
                let failureKind = (error as? TransportError)?.circuitBreakerFailureKind
                await modelStore.recordCachedWinnerOutcome(
                    success: false,
                    candidate: warmupCandidate,
                    kind: failureKind
                )
            }
            let failureMs = Int(max(0, Date().timeIntervalSince(streamStart) * 1000))
            // One automatic model failover for provider-side model failures.
            // Mark the (provider, baseURL, model) tuple that failed as unhealthy so
            // the same model on another provider is not wrongly skipped.
            modelStore.markUnhealthy(provider: activeProvider, baseURL: activeBaseURL, model: activeModel)

            if let transportError = error as? TransportError,
               transportError.isEligibleForCrossProviderFailover {
                await modelStore.recordCircuitBreakerFailure(
                    provider: activeProvider,
                    baseURL: activeBaseURL,
                    model: activeModel,
                    transportError: transportError
                )
            }

            // Same-provider model failover is disabled when a conversation pin
            // is active because switching models would violate the pinned boundary.
            if !didFailover,
               constraint == nil,
               let transportError = error as? TransportError,
               (transportError.isModelUnavailableError || transportError.isInvalidModelError),
               let nextModel = await modelStore.selectNextModel() {
                didFailover = true
                finalizeAssistantStreamingState()
                clearPendingUsage()
                await modelStore.recordSendOutcome(
                    model: activeModel,
                    provider: activeProvider,
                    baseURL: activeBaseURL,
                    success: false,
                    reason: transportError.localizedDescription,
                    latencyMs: failureMs,
                    observedOutputTokens: nil,
                    observedTotalTokens: nil,
                    finishReason: nil
                )
                let failoverMsg = "Model `\(activeModel)` failed; retrying with `\(nextModel)`…"
                let banner = ChatMessage(role: .system, content: "[↻] \(failoverMsg)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
                let failoverStreamStart = Date()
                do {
                    let latency = try await executeStream(
                        generation: generation,
                        text: text,
                        memoryGoal: memoryGoal,
                        historyForRequest: historyForRequest,
                        requestAttachments: requestAttachments,
                        activeProvider: activeProvider,
                        activeBaseURL: activeBaseURL,
                        activeModel: nextModel
                    )
                    await modelStore.recordSendOutcome(
                        model: nextModel,
                        provider: activeProvider,
                        baseURL: activeBaseURL,
                        success: true,
                        reason: nil,
                        latencyMs: latency.totalMs,
                        timeToFirstTokenMs: latency.timeToFirstTokenMs,
                        observedOutputTokens: latency.observedOutputTokens,
                        observedTotalTokens: latency.observedTotalTokens,
                        finishReason: latency.finishReason
                    )
                    await modelStore.recordCircuitBreakerSuccess(provider: activeProvider, baseURL: activeBaseURL)
                    return
                } catch {
                    let failoverFailureMs = Int(max(0, Date().timeIntervalSince(failoverStreamStart) * 1000))
                    await modelStore.recordSendOutcome(
                        model: nextModel,
                        provider: activeProvider,
                        baseURL: activeBaseURL,
                        success: false,
                        reason: (error as? TransportError)?.localizedDescription,
                        latencyMs: failoverFailureMs,
                        observedOutputTokens: nil,
                        observedTotalTokens: nil,
                        finishReason: nil
                    )
                    // Restore the original selection so the next turn does not
                    // silently inherit a failed fallback.
                    modelStore.restoreSelection(provider: initialProvider, baseURL: initialBaseURL, model: initialModel)
                }
            }

            // Cross-provider failover: if the same-provider fallback failed (or was
            // not possible), try one other eligible provider before giving up.
            if modelStore.isCrossProviderFailoverEnabled,
               let transportError = error as? TransportError,
               transportError.isEligibleForCrossProviderFailover,
               let candidate = await modelStore.selectFirstHealthyCrossProviderModel(constrainedTo: constraint) {
                let crossStreamStart = Date()
                let failoverMsg = "Provider `\(activeProvider.displayName)` failed; switching to `\(candidate.provider.displayName)/\(candidate.model)`…"
                let banner = ChatMessage(role: .system, content: "[↻] \(failoverMsg)")
                messages.append(banner)
                rebuildCache()
                let historySnapshot = captureHistorySnapshot()
                await persistHistorySnapshot(historySnapshot)
                do {
                    let latency = try await executeStream(
                        generation: generation,
                        text: text,
                        memoryGoal: memoryGoal,
                        historyForRequest: historyForRequest,
                        requestAttachments: requestAttachments,
                        activeProvider: candidate.provider,
                        activeBaseURL: candidate.baseURL,
                        activeModel: candidate.model
                    )
                    await modelStore.recordSendOutcome(
                        model: candidate.model,
                        provider: candidate.provider,
                        baseURL: candidate.baseURL,
                        success: true,
                        reason: nil,
                        latencyMs: latency.totalMs,
                        timeToFirstTokenMs: latency.timeToFirstTokenMs,
                        observedOutputTokens: latency.observedOutputTokens,
                        observedTotalTokens: latency.observedTotalTokens,
                        finishReason: latency.finishReason
                    )
                    await modelStore.recordCircuitBreakerSuccess(provider: candidate.provider, baseURL: candidate.baseURL)
                    return
                } catch {
                    let crossFailureMs = Int(max(0, Date().timeIntervalSince(crossStreamStart) * 1000))
                    await modelStore.recordSendOutcome(
                        model: candidate.model,
                        provider: candidate.provider,
                        baseURL: candidate.baseURL,
                        success: false,
                        reason: (error as? TransportError)?.localizedDescription,
                        latencyMs: crossFailureMs,
                        observedOutputTokens: nil,
                        observedTotalTokens: nil,
                        finishReason: nil
                    )
                    if let transportError = error as? TransportError,
                       transportError.isEligibleForCrossProviderFailover {
                        await modelStore.recordCircuitBreakerFailure(
                            provider: candidate.provider,
                            baseURL: candidate.baseURL,
                            model: candidate.model,
                            transportError: transportError
                        )
                    }
                    // Revert to the original provider so the next turn does not
                    // silently stay on a failed cross-provider candidate.
                    modelStore.restoreSelection(provider: initialProvider, baseURL: initialBaseURL, model: initialModel)
                }
            }

            if !didFailover {
                await modelStore.recordSendOutcome(
                    model: activeModel,
                    provider: activeProvider,
                    baseURL: activeBaseURL,
                    success: false,
                    reason: (error as? TransportError)?.localizedDescription,
                    latencyMs: failureMs,
                    observedOutputTokens: nil,
                    observedTotalTokens: nil,
                    finishReason: nil
                )
            }

            guard isCurrentStream(generation) else { return }
            finalizeAssistantStreamingState()
            // Manual cancellation is not a user-visible error.
            if let urlError = error as? URLError, urlError.code == .cancelled {
                let historySnapshot = captureHistorySnapshot()
                NSLog("[TriosChat] stream cancelled by user")
                await cancelPendingTurn()
                await persistHistorySnapshot(historySnapshot)
                guard isGenerationCurrent(generation) else { return }
                _ = await stateMachine.transition(to: .idle)
                guard isGenerationCurrent(generation) else { return }
                let currentState = await stateMachine.currentState()
                guard isGenerationCurrent(generation) else { return }
                state = currentState
                await saveHistory(expectedGeneration: generation)
                return
            }

            let errorDetail = formatRequestError(error)
            TriosLogBus.shared.error(
                .chat,
                "chat.transport.error",
                errorDetail,
                ["raw_error": String(describing: error).prefix(500).description]
            )
            clearPendingUsage()
            let errorMsg = ChatMessage(role: .system, content: "[!] \(errorDetail)")
            messages.append(errorMsg)
            rebuildCache()
            let historySnapshot = captureHistorySnapshot()
            await failPendingTurn(message: errorDetail)
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(generation) else { return }
            _ = await stateMachine.transition(to: .error(errorDetail))
            guard isGenerationCurrent(generation) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(generation) else { return }
            state = currentState
            await saveHistory(expectedGeneration: generation)
        }
    }

    /// Latency measurements for a completed stream.
    private struct StreamLatency {
        let totalMs: Int
        let timeToFirstTokenMs: Int?
        /// True when the stream paused because it hit the context/output limit;
        /// the caller must record this as a non-success outcome.
        let didPauseForContext: Bool
        /// Observed output tokens if a usage event arrived; used for limit learning.
        let observedOutputTokens: Int?
        /// Observed total tokens if a usage event arrived; used for limit learning.
        let observedTotalTokens: Int?
        /// Provider `finish_reason` from the terminal SSE event.
        let finishReason: String?
    }

    /// Attempts a single streaming request. On success it finalizes the turn and
    /// persists history and returns request latency measurements. On failure it
    /// throws the underlying error so the caller can decide whether to failover
    /// or surface the error to the user.
    private func executeStream(
        generation: UInt64,
        text: String,
        memoryGoal: String,
        historyForRequest: [ChatMessage],
        requestAttachments: [ChatRequestAttachment],
        activeProvider: ModelProvider,
        activeBaseURL: String,
        activeModel: String
    ) async throws -> StreamLatency {
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: 0, timeToFirstTokenMs: nil, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        var runtimeConfiguration = await modelStore.runtimeConfiguration
        // A keyless request to a provider that needs one is a 500 already sent.
        //
        // The delegation path has had this guard for a while - its comment even
        // names this exact error, "the request is doomed to a 500 'z.ai
        // provider requires apiKey' before it is sent" - and the chat path
        // never got it. The window is real and narrow: the keychain launch gate
        // lowers, the first key read still comes back empty, and the warm-up
        // needs several attempts. A message typed inside that window was built
        // with `has_key: no`, sent anyway, and came back as an opaque provider
        // error that blames z.ai for the app's timing.
        //
        // So: wait briefly for the warm-up rather than refuse outright, because
        // this resolves on its own within seconds, and only then say something
        // true if it has not.
        // Real transport only. The test harness injects a stubbed transport
        // that needs no credential, and gating it here made nine tests refuse
        // to send - the delegation path's equivalent guard has carried exactly
        // this exemption from the start (`type(of: transport) is
        // SSETransport.Type`) and I failed to carry it across with the rest.
        let usesLiveTransport = type(of: transport) is SSETransport.Type
        if usesLiveTransport,
           runtimeConfiguration.provider.requiresAPIKey,
           (runtimeConfiguration.apiKey ?? "").isEmpty {
            warmupProviderKey()
            for _ in 0..<10 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                runtimeConfiguration = await modelStore.runtimeConfiguration
                if !(runtimeConfiguration.apiKey ?? "").isEmpty { break }
            }
        }
        if usesLiveTransport,
           runtimeConfiguration.provider.requiresAPIKey,
           (runtimeConfiguration.apiKey ?? "").isEmpty {
            TriosLogBus.shared.error(
                .chat, "chat.send.no_key",
                "Refusing to send to \(runtimeConfiguration.provider.rawValue) without a key: "
                    + "the keychain has not answered yet.",
                ["provider": runtimeConfiguration.provider.rawValue]
            )
            throw ChatViewModelError.providerKeyUnavailable(
                provider: runtimeConfiguration.provider.displayName
            )
        }
        guard let requestBody = try? ChatRequestBuilder(
            conversationId: conversationId,
            message: text,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: composedSystemPrompt(),
            previousConversation: historyForRequest,
            browserContext: nil,
            modelConfiguration: runtimeConfiguration,
            attachments: requestAttachments
        ).build() else {
            NSLog("[TriosChat] ChatRequestBuilder failed")
            throw ChatViewModelError.requestBuildFailed
        }
        // Log the target that is actually about to be called. Reading it from
        // the built configuration - not from settings - is the point: a pinned
        // conversation, a warmup switch, or a stale override can all send a
        // request somewhere other than what the Models tab displays, and
        // without this the only symptom is an opaque provider error.
        TriosLogBus.shared.info(
            .chat,
            "chat.request.target",
            "Request target resolved",
            [
                "provider": runtimeConfiguration.provider.rawValue,
                "model": runtimeConfiguration.model,
                "base_url": runtimeConfiguration.baseURL,
                "has_key": runtimeConfiguration.apiKey == nil ? "no" : "yes",
                "bytes": String(requestBody.count)
            ]
        )
        // Log what the payload ACTUALLY carries, not what we intended to send.
        // The previous line reported the resolved configuration, which is why a
        // request that reached the server without provider/model/apiKey still
        // looked correct in the log.
        if let sent = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any] {
            TriosLogBus.shared.info(
                .chat,
                "chat.request.payload",
                "Payload fields",
                [
                    "provider": (sent["provider"] as? String) ?? "ABSENT",
                    "model": (sent["model"] as? String) ?? "ABSENT",
                    "base_url": (sent["baseUrl"] as? String) ?? "ABSENT",
                    "api_key": sent["apiKey"] == nil ? "ABSENT" : "present",
                    "keys": sent.keys.sorted().joined(separator: ","),
                    // Proving the Queen can see her own skills needs evidence
                    // from the wire, not from the code that builds it. This is
                    // the same class of check as logging the resolved target:
                    // the layer above can look correct while the payload is not.
                    "system_chars": String(systemPromptCharacterCount(in: sent)),
                    "system_skills": String(systemPromptSkillCount(in: sent))
                ]
            )
        }
        NSLog("[TriosChat] request body built, size: \(requestBody.count), attachments: \(requestAttachments.count)")

        await parser.reset()

        let isWatchdogEnabled = modelStore.isStreamingContextWatchdogEnabled
        if isWatchdogEnabled {
            let profile = await ModelContextService.shared.profile(
                for: activeModel,
                provider: activeProvider,
                baseURL: activeBaseURL
            )
            await contextWatchdog.beginStream(
                modelProfile: profile,
                estimatedInputTokens: pendingEstimatedInputTokens,
                margin: effectiveConversationContextMargin
            )
        }

        let streamStart = Date()
        let stream = try await transport.sendMessage(body: requestBody)
        var timeToFirstTokenMs: Int? = nil
        guard isCurrentStream(generation) else {
            if isWatchdogEnabled { await contextWatchdog.endStream() }
            return StreamLatency(
                totalMs: Int(max(0, Date().timeIntervalSince(streamStart) * 1000)),
                timeToFirstTokenMs: nil,
                didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil
            )
        }
        // The answer itself is a step. Naming it means a turn with no tool calls
        // still shows "Understand request -> Compose answer" rather than a
        // single stalled row.
        await todoPlanner.beginStep(
            title: TODOPlanDeriver.title(for: .composing),
            detail: "Response stream opened"
        )
        NSLog("[TriosChat] transport stream opened")
        var receivedTerminalEvent = false
        var streamFinishReason: String? = nil
        var observedOutputTokens: Int? = nil
        var observedTotalTokens: Int? = nil
        for await event in stream {
            guard isCurrentStream(generation) else { break }
            if timeToFirstTokenMs == nil, event.isFirstToken {
                timeToFirstTokenMs = Int(max(0, Date().timeIntervalSince(streamStart) * 1000))
            }
            switch event {
            case .finish(_, let reason):
                receivedTerminalEvent = true
                streamFinishReason = reason
            case .abort, .error:
                receivedTerminalEvent = true
            case .usage(let inputTokens, let outputTokens, let totalTokens):
                if outputTokens > 0 {
                    observedOutputTokens = outputTokens
                }
                let resolvedTotal = totalTokens > 0
                    ? totalTokens
                    : (inputTokens + outputTokens > 0 ? inputTokens + outputTokens : 0)
                if resolvedTotal > 0 {
                    observedTotalTokens = resolvedTotal
                }
            default:
                break
            }
            NSLog("[TriosChat] SSE event: \(event)")
            // Apply the delta to messages BEFORE checking the watchdog so the
            // final delta that triggers the limit is preserved in the partial
            // response (INV-2, INV-9).
            await handleEvent(
                event,
                expectedGeneration: generation
            )
            let decision = await feedWatchdog(event: event)
            switch decision {
            case .ok:
                break
            case .approachingLimit(let remaining, let kind):
                showApproachingContextLimitWarning(remaining: remaining, kind: kind)
            case .limitReached(let partialText, let suggestedAction):
                await pauseStreamForContextLimit(
                    generation: generation,
                    partialText: partialText,
                    suggestedAction: suggestedAction
                )
                await contextWatchdog.endStream()
                let tokens = await contextWatchdog.estimatedTokens()
                return StreamLatency(
                    totalMs: Int(max(0, Date().timeIntervalSince(streamStart) * 1000)),
                    timeToFirstTokenMs: timeToFirstTokenMs,
                    didPauseForContext: true,
                    observedOutputTokens: tokens.output,
                    observedTotalTokens: tokens.input + tokens.output,
                    finishReason: streamFinishReason
                )
            }
        }
        let totalMs = Int(max(0, Date().timeIntervalSince(streamStart) * 1000))
        guard isCurrentStream(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        guard receivedTerminalEvent else {
            finalizeAssistantStreamingState()
            NSLog(
                "[TriosChat] unterminated stream: %@",
                Self.unterminatedStreamError
            )
            await applyAction(
                .streamError(Self.unterminatedStreamError),
                expectedGeneration: generation
            )
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        await completePendingTurnIfNeeded()
        if isWatchdogEnabled { await contextWatchdog.endStream() }
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        finalizeEstimatedUsageIfNeeded()
        NSLog("[TriosChat] stream ended normally")
        _ = await stateMachine.transition(to: .idle)
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        let currentState = await stateMachine.currentState()
        guard isGenerationCurrent(generation) else {
            return StreamLatency(totalMs: totalMs, timeToFirstTokenMs: timeToFirstTokenMs, didPauseForContext: false,
                observedOutputTokens: nil,
                observedTotalTokens: nil,
                finishReason: nil)
        }
        state = currentState
        await saveHistory(expectedGeneration: generation)
        return StreamLatency(
            totalMs: totalMs,
            timeToFirstTokenMs: timeToFirstTokenMs,
            didPauseForContext: false,
            observedOutputTokens: observedOutputTokens,
            observedTotalTokens: observedTotalTokens,
            finishReason: streamFinishReason
        )
    }

    private func runPreflightHealthCheck(generation: UInt64) async -> String {
        guard isCurrentStream(generation) else { return modelStore.selectedModel }
        // End-to-end tests exercise the chat plumbing, not the machine's model
        // inventory. Without this guard the preflight probed whatever Ollama
        // happened to have installed and, when the selected model was missing,
        // appended a "[/] Model ... unavailable; switching" banner - a third
        // message that broke "messages contains exactly user + assistant" about
        // one run in three, depending on the probe cache.
        guard ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_WARMUP"] != "1" else {
            return modelStore.selectedModel
        }
        // A pinned conversation model must not be silently replaced by a healthy
        // same-provider fallback during preflight.
        guard conversationModelConstraint == nil else { return modelStore.selectedModel }
        let result = await modelStore.healthStatus(for: modelStore.selectedModel)
        guard case .unavailable = result.health else { return modelStore.selectedModel }

        let currentModel = modelStore.selectedModel
        guard let healthyModel = await modelStore.selectFirstHealthyModel() else {
            return currentModel
        }

        let banner = ChatMessage(
            role: .system,
            content: "[↻] Model `\(currentModel)` is unavailable; switching to `\(healthyModel)`…"
        )
        messages.append(banner)
        rebuildCache()
        let historySnapshot = captureHistorySnapshot()
        await persistHistorySnapshot(historySnapshot)
        return healthyModel
    }

    /// Length of the system message actually present in the built payload.
    private func systemPromptCharacterCount(in body: [String: Any]) -> Int {
        systemMessageText(in: body).count
    }

    /// How many `/skill` names survived into the payload.
    private func systemPromptSkillCount(in body: [String: Any]) -> Int {
        let text = systemMessageText(in: body)
        guard !text.isEmpty else { return 0 }
        return text
            .components(separatedBy: .newlines)
            .filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("/") }
            .count
    }

    private func systemMessageText(in body: [String: Any]) -> String {
        guard let messages = body["messages"] as? [[String: Any]] else { return "" }
        return messages
            .filter { ($0["role"] as? String) == "system" }
            .compactMap { $0["content"] as? String }
            .joined(separator: "\n")
    }

    private enum ChatViewModelError: Error, LocalizedError {
        case requestBuildFailed
        /// The provider needs a key and the keychain has not produced one yet.
        ///
        /// Its own case rather than a generic failure, because the user-visible
        /// difference matters: "z.ai provider requires apiKey" coming back as a
        /// 500 reads as a broken provider or a missing key, and the truth is
        /// that the key exists and the keychain was still waking up.
        case providerKeyUnavailable(provider: String)

        var errorDescription: String? {
            switch self {
            case .requestBuildFailed:
                return "The request could not be built."
            case .providerKeyUnavailable(let provider):
                return "The \(provider) key is stored but the keychain has not "
                    + "released it yet. Nothing was sent. Try again in a moment - "
                    + "this clears itself once the first read succeeds."
            }
        }
    }

    func cancelStreaming() {
        finalizeAssistantStreamingState()
        let historySnapshot = captureHistorySnapshot()
        invalidateActiveStream()
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        Task {
            await awaitInitialization()
            await persistHistorySnapshot(historySnapshot)
            await cancelPendingTurn()
            clearPendingUsage()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
        }
    }

    func regenerateLastResponse() async {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role == .user }),
              lastUserIndex < messages.count - 1 else {
            NSLog("[TriosChat] regenerate: no user message or no assistant response to regenerate")
            return
        }
        let userText = messages[lastUserIndex].content
        messages.removeSubrange((lastUserIndex + 1)...)
        rebuildCache()
        inputText = userText
        // Re-send the existing user message without appending a duplicate.
        await sendMessage(text: userText, appendUser: false)
    }

    func sendFeedback(messageId: UUID, isPositive: Bool) async {
        NSLog("[TriosChat] feedback for \(messageId): \(isPositive ? "thumbs-up" : "thumbs-down")")

        guard let url = URL(
            string: "\(ProjectPaths.mcpBaseURL)/chat/\(conversationId.uuidString)/messages/\(messageId.uuidString)/feedback"
        ) else {
            NSLog("[TriosChat] feedback aborted: invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        let body: [String: Bool] = ["isPositive": isPositive]
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            NSLog("[TriosChat] feedback body encoding failed: \(error.localizedDescription)")
            return
        }

        let retrier = NetworkRetrier(policy: NetworkRetryPolicy.default)
        let feedbackRequest = request
        do {
            let (_, response) = try await retrier.execute(
                url: url,
                description: "feedback POST \(url.absoluteString)"
            ) {
                try await URLSession.shared.data(for: feedbackRequest)
            }
            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                NSLog("[TriosChat] feedback server returned \(status)")
                return
            }
            NSLog("[TriosChat] feedback stored on server")
        } catch {
            NSLog("[TriosChat] feedback request failed: \(formatRequestError(error))")
        }
    }

    func checkHealth() async {
        let reachable = await healthCheck.check()
        isServerReachable = reachable
    }

    private func formatRequestError(_ error: Error) -> String {
        if let transportError = error as? TransportError {
            let providerMsg = transportError.providerErrorMessage
            let fallback = modelStore.fallbackSuggestion
            switch transportError {
            case _ where transportError.isBalanceError:
                return [
                    "Insufficient balance or no resource package.",
                    providerMsg,
                    fallback,
                    "Pick a different model (`/doctor --model <model>`) or recharge your provider account."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isAuthError:
                return [
                    "Authentication failed for \(modelStore.selectedProvider.displayName).",
                    providerMsg,
                    "Check the API key in TriOS model settings or macOS Keychain."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isContextLengthError:
                return [
                    "The conversation is too long for \(modelStore.selectedModel).",
                    providerMsg,
                    "Start a new chat or reduce context via `/doctor --context`."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isInvalidModelError:
                return [
                    "Model '\(modelStore.selectedModel)' is unavailable or invalid.",
                    providerMsg,
                    fallback,
                    "Switch models or run `/doctor --model <model>`."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isRateLimitError:
                return [
                    "Rate limit hit on \(modelStore.selectedProvider.displayName).",
                    providerMsg,
                    fallback,
                    "Retrying briefly; switch to a cheaper model if it persists."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            case _ where transportError.isModelUnavailableError:
                return [
                    "Model provider temporarily unavailable.",
                    providerMsg,
                    fallback,
                    "Retrying; use `/doctor --model <model>` to force a fallback."
                ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            default:
                return transportError.localizedDescription
            }
        }
        if let retryError = error as? RetryError {
            return retryError.localizedDescription
        }
        if let a2aError = error as? A2AError {
            return a2aError.localizedDescription
        }
        if let urlError = error as? URLError {
            var parts: [String] = []
            parts.append("URLError code \(urlError.code.rawValue): \(urlError.localizedDescription)")
            if let failingURL = urlError.failingURL {
                parts.append("URL: \(failingURL.absoluteString)")
            }
            return parts.joined(separator: " | ")
        }
        return error.localizedDescription
    }

    func newConversation() {
        guard beginConversationTransition() else { return }
        let newConversationId = UUID()
        invalidateActiveStream()
        streamingContextWarning = nil
        streamingContextPauseLabel = nil
        streamingContextDecision = nil
        streamingBudgetStatus = nil
        isStreamPausedForContext = false
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        Task {
            await awaitInitialization()
            await preserveInterruptedTurn(reason: "you started a new chat")
            await cancelPendingTurn()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            conversationId = newConversationId
            messages = []
            messageCache = [:]
            tokenUsage.reset()
            clearPendingUsage()
            recalledMemories = []
            memoryControlRevision &+= 1
            await todoPlanner.load(conversationId: newConversationId)
            await persister.setCurrentConversationId(newConversationId)
            // Persist it empty, the way the Queen's reserved conversation is.
            // Without this the chat exists only as a UUID in memory: the user
            // presses New Chat, lands somewhere that works, and sees nothing
            // added to the sidebar, because listAllConversations only returns
            // what has been saved. It appeared after the first message, which
            // reads as "creating chats is broken" rather than "creating chats
            // is deferred". It matters more now the Queen opens one per issue -
            // a chat she cannot see is a bee she cannot supervise.
            await persister.save(messages: [], conversationId: newConversationId)
            await loadConversations()
            endConversationTransition()
        }
    }

    func deleteConversation(id: UUID) async {
        await awaitInitialization()
        guard beginConversationTransition() else { return }
        defer { endConversationTransition() }
        let retainedHistorySnapshot: ConversationHistorySnapshot?
        if id == conversationId {
            finalizeAssistantStreamingState()
            retainedHistorySnapshot = captureHistorySnapshot()
            invalidateActiveStream()
        } else {
            retainedHistorySnapshot = nil
        }
        await performConversationDeletion(
            id: id,
            retainedHistorySnapshot: retainedHistorySnapshot
        )
    }

    private func performConversationDeletion(
        id: UUID,
        retainedHistorySnapshot: ConversationHistorySnapshot?
    ) async {
        if id == conversationId {
            await cancelPendingTurn()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            await waitForMemoryWrite(conversationId: id)
            do {
                try await todoPlanner.deleteConversationData(
                    conversationId: id
                )
            } catch {
                let message = "Conversation was not deleted because private data cleanup failed."
                let receipt = ChatMessage(
                    role: .system,
                    content: "[!] \(message)"
                )
                messages.append(receipt)
                rebuildCache()
                let failureSnapshot: ConversationHistorySnapshot
                if let retainedHistorySnapshot {
                    failureSnapshot = ConversationHistorySnapshot(
                        conversationId:
                            retainedHistorySnapshot.conversationId,
                        messages:
                            retainedHistorySnapshot.messages + [receipt],
                        writeRevision:
                            retainedHistorySnapshot.writeRevision
                    )
                } else {
                    finalizeAssistantStreamingState()
                    failureSnapshot = captureHistorySnapshot()
                }
                await persistHistorySnapshot(failureSnapshot)
                _ = await stateMachine.transition(to: .error(message))
                state = await stateMachine.currentState()
                return
            }
            await clearPersistedConversationHistory(conversationId: id)
            conversationId = UUID()
            await persister.setCurrentConversationId(conversationId)
            messages = []
            tokenUsage.reset()
            clearPendingUsage()
            pendingMemoryTurn = nil
            recalledMemories = []
            memoryControlRevision &+= 1
            advanceMemoryWriteRevision(for: id)
            await todoPlanner.load(conversationId: conversationId)
            rebuildCache()
        } else {
            do {
                await waitForMemoryWrite(conversationId: id)
                try await todoPlanner.deleteConversationData(
                    conversationId: id
                )
                await clearPersistedConversationHistory(conversationId: id)
            } catch {
                NSLog(
                    "[TriosChat] conversation deletion blocked: %@",
                    error.localizedDescription
                )
                return
            }
        }
        await loadConversations()
    }

    // MARK: - A2A Actions

    func updateTaskState(id: UUID, state: AgentTaskState) async {
        guard let client = a2aClient else { return }
        do {
            try await client.updateTaskState(id: id, state: state)
            if let index = messages.firstIndex(where: { $0.task?.id == id }) {
                if var task = messages[index].task {
                    task.state = state
                    messages[index].task = task
                    objectWillChange.send()
                }
            }
        } catch {
            // Silent
        }
    }

    func sendA2AMessage(type: A2AMessageType, to recipient: AgentId? = nil, payload: Data) async {
        guard let client = a2aClient else { return }
        let message = A2AMessage(
            sender: AgentId("trios-agent"),
            recipient: recipient,
            type: type,
            payload: payload
        )
        do {
            try await client.sendMessage(message)
        } catch {
            // Silent failure  -  A2A is best-effort until server routes are live
        }
    }

    private func handleEvent(
        _ event: SSEEvent,
        expectedGeneration: UInt64
    ) async {
        guard isCurrentStream(expectedGeneration) else { return }
        guard let action = await parser.parse(event) else { return }
        guard isCurrentStream(expectedGeneration) else { return }
        await applyAction(
            action,
            expectedGeneration: expectedGeneration
        )
    }

    private func applyAction(
        _ action: ParserAction,
        expectedGeneration: UInt64
    ) async {
        guard isCurrentStream(expectedGeneration) else { return }

        switch action {
        case .appendMessage(let message):
            messages.append(message)
            rebuildCache()
            if message.role == .assistant,
               var pending = pendingMemoryTurn,
               pending.streamGeneration == streamGeneration {
                pending.assistantMessageId = message.id
                pendingMemoryTurn = pending
            }
            _ = await stateMachine.transition(to: .streaming(messageId: message.id))
            guard isCurrentStream(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isCurrentStream(expectedGeneration) else { return }
            state = currentState

        case .appendText(let messageId, let delta):
            guard let index = messageCache[messageId] else { return }
            messages[index].content += delta
            if let lastIndex = messages[index].segments.indices.last,
               case .text(let existing) = messages[index].segments[lastIndex] {
                messages[index].segments[lastIndex] = .text(existing + delta)
            } else {
                messages[index].segments.append(.text(delta))
            }
            messages[index].isStreaming = true
            if pendingUsageActive {
                pendingEstimatedOutput += delta
            }
            objectWillChange.send()

        case .finishMessage(let messageId):
            guard let _ = messageCache[messageId] else { return }
            // Do NOT clear isStreaming here  -  text may be finished but tool calls
            // or reasoning may still be in progress. isStreaming is cleared on
            // streamComplete / streamAborted so the reaction bar only appears
            // after the *entire* assistant turn is done.
            objectWillChange.send()

        case .startSegment(let messageId, let segment):
            guard let index = messageCache[messageId] else { return }
            messages[index].segments.append(segment)
            objectWillChange.send()

        case .appendToSegment(let messageId, let kind, let delta):
            guard let index = messageCache[messageId] else { return }
            if let lastIndex = messages[index].segments.indices.last {
                switch (kind, messages[index].segments[lastIndex]) {
                case (.text, .text(let existing)):
                    messages[index].segments[lastIndex] = .text(existing + delta)
                case (.reasoning, .reasoning(let existing)):
                    messages[index].segments[lastIndex] = .reasoning(existing + delta)
                default:
                    break
                }
            }
            if pendingUsageActive {
                pendingEstimatedOutput += delta
            }
            objectWillChange.send()

        case .addToolCall(let messageId, let toolCall):
            guard let index = messageCache[messageId] else { return }
            messages[index].toolCalls.append(toolCall)
            messages[index].segments.append(.toolCall(id: toolCall.id))
            // The Queen is told by name which tools she must not call, and
            // nothing can stop her: the client sends no tool list and the agent
            // server takes no filter, so refusing one is a change to that
            // server's API rather than something available here. What is
            // available is noticing. An unenforceable rule that is at least
            // observed is a different thing from one nobody would ever know was
            // broken - and if this line never fires, that is evidence about the
            // instruction the next person can act on.
            if QueenDelegationPolicy.isForbiddenQueenToolCall(
                conversationId: conversationId,
                queenConversationId: ChatConversation.trinityQueenId,
                tool: toolCall.name
            ) {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.tool.forbidden",
                    "The Queen called a tool she is told not to call",
                    ["tool": toolCall.name]
                )
                // And say it where she can read it, which is what a bee gets.
                //
                // The worker model is not "log the violation": `observeWorker`
                // sends a correction INTO the worker's chat the moment it
                // writes outside its boundary, and the worker changes course on
                // the next turn. Until now the Queen's equivalent rule produced
                // a log line nobody in the conversation could see - the model
                // was carried across as a detector and not as the correction it
                // exists to deliver.
                //
                // Still not enforcement: the call has already been made and
                // this cannot unmake it. It is the same instrument a bee gets,
                // pointed at the supervisor, and it is honest about being that.
                let correction = QueenObserver.correctionText(concerns: [
                    "You called `\(toolCall.name)`, which is on the list of tools "
                        + "you do not call. That call is the signal to delegate: open "
                        + "a worker for the issue and let it make the change on its "
                        + "own branch. Do not repeat the call."
                ])
                Task { [weak self] in
                    await self?.postQueenNotice(
                        SystemNoticeClassifier.warningMarker + correction
                    )
                }
            }
            await todoPlanner.markToolActivity(name: toolCall.name)
            guard isCurrentStream(expectedGeneration) else { return }
            objectWillChange.send()

        case .appendToolInput(let messageId, let toolCallId, let delta):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].arguments += delta
            }
            objectWillChange.send()

        case .finalizeToolInput(let messageId, let toolCallId, let arguments):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].arguments = arguments
                // Arguments are complete now, so the step can name its target.
                await todoPlanner.refineStepTitle(
                    toolName: messages[index].toolCalls[toolIndex].name,
                    arguments: arguments
                )
            }
            objectWillChange.send()

        case .setToolOutput(let messageId, let toolCallId, let output):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].output = output
                messages[index].toolCalls[toolIndex].isComplete = true
            }
            objectWillChange.send()

        case .setToolError(let messageId, let toolCallId, let error):
            guard let index = messageCache[messageId] else { return }
            if let toolIndex = messages[index].toolCalls.firstIndex(where: { $0.id == toolCallId }) {
                messages[index].toolCalls[toolIndex].output = "Error: \(error)"
                messages[index].toolCalls[toolIndex].isComplete = true
            }
            objectWillChange.send()

        case .recordUsage(let inputTokens, let outputTokens, let totalTokens):
            guard !receivedProviderUsage else { return }
            let resolvedOutput = inputTokens + outputTokens > 0 ? outputTokens : totalTokens
            tokenUsage.record(
                inputTokens: inputTokens,
                outputTokens: resolvedOutput,
                source: .provider
            )
            receivedProviderUsage = true

        case .streamComplete:
            finalizeAssistantStreamingState()
            finalizeEstimatedUsageIfNeeded()
            let historySnapshot = captureHistorySnapshot()
            await completePendingTurnIfNeeded()
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(expectedGeneration) else { return }
            _ = await stateMachine.transition(to: .idle)
            guard isGenerationCurrent(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(expectedGeneration) else { return }
            state = currentState
            await saveHistory(expectedGeneration: expectedGeneration)

        case .streamAborted:
            finalizeAssistantStreamingState()
            clearPendingUsage()
            let historySnapshot = captureHistorySnapshot()
            await cancelPendingTurn()
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(expectedGeneration) else { return }
            _ = await stateMachine.transition(to: .idle)
            guard isGenerationCurrent(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(expectedGeneration) else { return }
            state = currentState
            await saveHistory(expectedGeneration: expectedGeneration)

        case .streamError(let message):
            finalizeAssistantStreamingState()
            clearPendingUsage()
            let errorMsg = ChatMessage(role: .system, content: "[!] \(message)")
            messages.append(errorMsg)
            rebuildCache()
            let historySnapshot = captureHistorySnapshot()
            await failPendingTurn(message: message)
            await persistHistorySnapshot(historySnapshot)
            guard isGenerationCurrent(expectedGeneration) else { return }
            _ = await stateMachine.transition(to: .error(message))
            guard isGenerationCurrent(expectedGeneration) else { return }
            let currentState = await stateMachine.currentState()
            guard isGenerationCurrent(expectedGeneration) else { return }
            state = currentState
            await saveHistory(expectedGeneration: expectedGeneration)
        }
    }

    /// Feeds text/reasoning deltas to the context watchdog and returns its
    /// decision. Non-content events leave the watchdog unchanged. Also publishes
    /// a live `streamingBudgetStatus` so the UI can render a progress bar.
    private func feedWatchdog(event: SSEEvent) async -> StreamingContextDecision {
        let decision: StreamingContextDecision
        switch event {
        case .textDelta(_, let delta),
             .reasoningDelta(_, let delta):
            decision = await contextWatchdog.append(deltaText: delta)
        default:
            decision = .ok
        }
        await refreshStreamingBudgetStatus()
        return decision
    }

    /// Recomputes the published streaming-budget status from the watchdog.
    private func refreshStreamingBudgetStatus() async {
        guard let ratios = await contextWatchdog.budgetRatios() else {
            streamingBudgetStatus = nil
            return
        }
        let dominantRatio = max(ratios.outputRatio, ratios.totalRatio)
        let limitKind: StreamingContextLimitKind = ratios.totalRatio >= ratios.outputRatio
            ? .totalContext
            : .outputTokens
        let kind: StreamingBudgetStatus.Kind
        if dominantRatio >= 0.95 {
            kind = .critical
        } else if dominantRatio >= 0.80 {
            kind = .warning
        } else {
            kind = .safe
        }
        streamingBudgetStatus = StreamingBudgetStatus(
            outputUsed: ratios.outputUsed,
            outputCeiling: ratios.outputCeiling,
            totalUsed: ratios.totalUsed,
            totalCeiling: ratios.totalCeiling,
            outputRatio: ratios.outputRatio,
            totalRatio: ratios.totalRatio,
            kind: kind,
            limitKind: limitKind
        )
    }

    /// Shows a transient warning when the response approaches a limit.
    /// The warning is not persisted as a history message (INV-10).
    private func showApproachingContextLimitWarning(
        remaining: Int,
        kind: StreamingContextLimitKind
    ) {
        let kindText = kind == .outputTokens ? "output" : "context"
        streamingContextWarning = "Response is approaching the \(kindText) limit (~\(remaining) tokens remaining)."
        streamingContextDecision = .approachingLimit(remainingTokens: remaining, kind: kind)
    }

    /// Pauses the current stream and transitions to a state where the user must
    /// choose how to continue after a context limit is reached.
    private func pauseStreamForContextLimit(
        generation: UInt64,
        partialText: String,
        suggestedAction: StreamingContextSuggestedAction
    ) async {
        // The caller already verified this generation is current. Do NOT re-check
        // after invalidating the stream, because invalidateActiveStream bumps
        // streamGeneration and would make the guard fail (INV-8).
        invalidateActiveStream()
        finalizeAssistantStreamingState()
        await transport.cancel()
        await completePendingTurnIfNeeded()

        let messageId = latestAssistantMessageId() ?? UUID()
        _ = await stateMachine.transition(to: .awaitingContextDecision(
            messageId: messageId,
            partialText: partialText
        ))
        let currentState = await stateMachine.currentState()
        state = currentState
        isStreamPausedForContext = true
        streamingContextDecision = .limitReached(
            partialText: partialText,
            suggestedAction: suggestedAction
        )
        streamingContextPauseLabel = contextLimitPauseLabel(for: suggestedAction)
        updateContextActionAvailability(suggestedAction: suggestedAction, partialText: partialText)
        // Save the paused state directly; do not use saveHistory(expectedGeneration:)
        // because invalidateActiveStream has bumped streamGeneration.
        let snapshot = captureHistorySnapshot()
        await persistHistorySnapshot(snapshot)
    }

    /// Returns a user-facing label describing which limit was hit.
    private func contextLimitPauseLabel(
        for suggestedAction: StreamingContextSuggestedAction
    ) -> String {
        switch suggestedAction {
        case .continueOnLargerModel:
            return "Response reached the output limit. Continue on a larger model?"
        case .summarizeSoFar:
            return "Response reached the context limit. Summarize and continue?"
        case .stopHere:
            return "Response reached the context limit."
        }
    }

    /// Updates the availability flags for the context-limit action bar based on
    /// the suggested action and the current partial text.
    private func updateContextActionAvailability(
        suggestedAction: StreamingContextSuggestedAction,
        partialText: String
    ) {
        let trimmedPartial = partialText.trimmingCharacters(in: .whitespacesAndNewlines)
        canSummarizeStreamSoFar = !trimmedPartial.isEmpty && trimmedPartial.count >= 32
        switch suggestedAction {
        case .continueOnLargerModel:
            canContinueOnLargerModel = true
        default:
            canContinueOnLargerModel = false
        }
    }

    /// Returns the UUID of the most recent assistant message, if any.
    private func latestAssistantMessageId() -> UUID? {
        guard let last = messages.last(where: { $0.role == .assistant }) else { return nil }
        return last.id
    }

    /// User chose to continue the partial response on a larger model.
    func continueStreamOnLargerModel(_ candidate: CrossProviderModelCandidate? = nil) async {
        guard case .awaitingContextDecision = await stateMachine.currentState() else { return }
        let constraint = conversationModelConstraint
        let chosenCandidate: CrossProviderModelCandidate
        if let candidate = candidate {
            // A manually supplied candidate must still respect the conversation pin.
            if let constraint, candidate != constraint.candidate { return }
            chosenCandidate = candidate
        } else {
            let continuationOutputTokens = await modelStore.effectiveRequestedOutputTokens(
                for: modelStore.selectedModel,
                provider: modelStore.selectedProvider,
                baseURL: modelStore.baseURL
            ) ?? effectiveConversationOutputTokens ?? 1024
            guard let largerCandidate = await modelStore.selectLargerModelCandidate(
                estimatedInput: pendingEstimatedInputTokens,
                outputTokens: continuationOutputTokens,
                constrainedTo: constraint
            ) else { return }
            chosenCandidate = largerCandidate
        }
        modelStore.applyContextRoutedSelection(
            candidate: chosenCandidate,
            reason: "continued on larger model \(chosenCandidate.model)"
        )
        contextRoutingLabel = "continued on \(chosenCandidate.model)"
        isStreamPausedForContext = false
        streamingContextDecision = nil
        streamingContextWarning = nil
        streamingBudgetStatus = nil
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        guard let lastUserMessage = messages.last(where: { $0.role == .user })?.content else { return }
        await sendMessage(text: lastUserMessage, appendUser: false)
    }

    /// User chose to summarize the partial response so far.
    func summarizeStreamSoFar() async {
        guard case .awaitingContextDecision(let messageId, _) = await stateMachine.currentState() else { return }
        guard let index = messageCache[messageId] else { return }
        let partial = messages[index].content
        let summaryPrompt = "Summarize the following assistant response so far in 2-3 sentences, preserving key facts:\n\n\"\"\"\n\(partial)\n\"\"\""

        isStreamPausedForContext = false
        streamingContextDecision = nil
        streamingContextWarning = nil
        streamingBudgetStatus = nil
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()

        await sendMessage(text: summaryPrompt, appendUser: true)
    }

    /// User chose to keep the partial response and stop.
    func stopStreamAndKeepPartial() async {
        guard case .awaitingContextDecision(let messageId, _) = await stateMachine.currentState() else { return }
        guard let index = messageCache[messageId] else { return }
        messages[index].isStreaming = false
        messages[index].content += "\n\n[Response truncated by context limit]"
        rebuildCache()

        isStreamPausedForContext = false
        streamingContextDecision = nil
        streamingContextWarning = nil
        streamingBudgetStatus = nil
        canContinueOnLargerModel = false
        canSummarizeStreamSoFar = false
        _ = await stateMachine.transition(to: .idle)
        state = await stateMachine.currentState()
        let historySnapshot = captureHistorySnapshot()
        await persistHistorySnapshot(historySnapshot)
        await saveHistory(expectedGeneration: streamGeneration)
    }

    func searchMemories(_ query: String) async -> [AgentMemoryMatch] {
        let revision = memoryControlRevision
        let matches = await memoryService.recall(for: query, limit: 20)
        return revision == memoryControlRevision ? matches : []
    }

    func recentMemories(limit: Int = 20) async throws -> [AgentMemoryMatch] {
        let revision = memoryControlRevision
        let matches = try await memoryService.recentMemories(limit: limit)
        return revision == memoryControlRevision ? matches : []
    }

    func forgetMemory(id: UUID) async throws -> Bool {
        let deleted = try await memoryService.forgetMemory(id: id)
        memoryControlRevision &+= 1
        recalledMemories.removeAll { $0.record.id == id }
        return deleted
    }

    func clearCurrentConversationMemories() async throws -> Int {
        try await clearConversationMemories(
            conversationId: conversationId
        )
    }

    func clearConversationMemories(
        conversationId targetConversationId: UUID
    ) async throws -> Int {
        beginMemoryClear(conversationId: targetConversationId)
        defer {
            endMemoryClear(conversationId: targetConversationId)
        }
        memoryControlRevision &+= 1
        advanceMemoryWriteRevision(for: targetConversationId)
        if var pending = pendingMemoryTurn,
           pending.conversationId == targetConversationId {
            pending.shouldRemember = false
            pendingMemoryTurn = pending
        }

        await waitForMemoryWrite(conversationId: targetConversationId)
        let deleted = try await memoryService.clearConversationMemories(
            conversationId: targetConversationId
        )
        memoryControlRevision &+= 1
        recalledMemories.removeAll {
            $0.record.conversationId == targetConversationId
        }
        return deleted
    }

    private func completePendingTurnIfNeeded() async {
        guard let initialPending = pendingMemoryTurn else { return }
        await todoPlanner.completePlan()

        guard let pending = pendingMemoryTurn,
              isSamePendingTurn(pending, initialPending) else {
            return
        }
        guard pending.streamGeneration == streamGeneration,
              pending.memoryWriteRevision == memoryWriteRevision(
                  for: pending.conversationId
              ),
              !isMemoryClearInProgress(pending.conversationId),
              pending.shouldRemember,
              let assistantMessageId = pending.assistantMessageId,
              let assistant = messages.first(where: {
                  $0.id == assistantMessageId && $0.role == .assistant
              }) else {
            clearPendingTurnIfMatching(pending)
            return
        }
        let directContent = assistant.content
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let segmentContent = assistant.segments.compactMap { segment -> String? in
            guard case .text(let text) = segment else { return nil }
            return text
        }
        .joined()
        .trimmingCharacters(in: .whitespacesAndNewlines)
        let result = directContent.isEmpty ? segmentContent : directContent
        guard !result.isEmpty else {
            clearPendingTurnIfMatching(pending)
            return
        }

        let writeTask = Task { [memoryService] in
            await memoryService.rememberCompletedTurn(
                conversationId: pending.conversationId,
                sourceMessageId: pending.sourceMessageId,
                goal: pending.goal,
                assistantResult: result
            )
        }
        activeMemoryWrites[pending.sourceMessageId] = ActiveAgentMemoryWrite(
            conversationId: pending.conversationId,
            sourceMessageId: pending.sourceMessageId,
            task: writeTask
        )
        let stored = await writeTask.value
        clearActiveMemoryWriteIfMatching(
            conversationId: pending.conversationId,
            sourceMessageId: pending.sourceMessageId
        )
        let stillAllowed =
            pending.memoryWriteRevision == memoryWriteRevision(
                for: pending.conversationId
            )
            && !isMemoryClearInProgress(pending.conversationId)
        clearPendingTurnIfMatching(pending)

        if !stillAllowed, let stored {
            do {
                _ = try await memoryService.forgetMemory(id: stored.id)
            } catch {
                NSLog(
                    "[AgentMemory] post-clear cleanup failed: %@",
                    error.localizedDescription
                )
            }
        }
    }

    /// Keeps a partial answer when its turn is about to be cancelled.
    ///
    /// The stream itself cannot outlive the switch: the planner, the memory
    /// turn, the usage ledger and the state machine are all single-slot and
    /// conversation-scoped, so two live turns would corrupt each other. What
    /// can be saved is the work already streamed, and a line saying why it
    /// stopped - a silent void reads as a crash.
    private func preserveInterruptedTurn(reason: String) async {
        guard case .streaming = state else { return }
        guard messages.contains(where: { $0.role == .assistant && $0.isStreaming }) else { return }

        finalizeAssistantStreamingState()
        messages.append(ChatMessage(
            role: .system,
            content: "[interrupted] This answer stopped because \(reason). "
                + "Everything above was kept; send again to continue."
        ))
        rebuildCache()
        let snapshot = captureHistorySnapshot()
        await persistHistorySnapshot(snapshot)
        TriosLogBus.shared.warn(
            .chat,
            "chat.turn.interrupted",
            "A streaming turn was cut short",
            ["conversation": conversationId.uuidString, "reason": reason]
        )
    }

    private func cancelPendingTurn() async {
        guard pendingMemoryTurn != nil else { return }
        pendingMemoryTurn = nil
        await todoPlanner.cancelPlan()
    }

    private func failPendingTurn(message: String) async {
        guard pendingMemoryTurn != nil else { return }
        pendingMemoryTurn = nil
        await todoPlanner.failPlan(message: message)
    }

    private func invalidateActiveStream() {
        streamGeneration &+= 1
    }

    private func isCurrentStream(_ generation: UInt64) -> Bool {
        isGenerationCurrent(generation)
            && pendingMemoryTurn?.streamGeneration == generation
    }

    private func isGenerationCurrent(_ generation: UInt64) -> Bool {
        generation == streamGeneration
    }

    private func memoryWriteRevision(for conversationId: UUID) -> UInt64 {
        memoryWriteRevisions[conversationId] ?? 0
    }

    private func advanceMemoryWriteRevision(for conversationId: UUID) {
        memoryWriteRevisions[conversationId] =
            memoryWriteRevision(for: conversationId) &+ 1
    }

    private func historyWriteRevision(for conversationId: UUID) -> UInt64 {
        historyWriteRevisions[conversationId] ?? 0
    }

    private func advanceHistoryWriteRevision(for conversationId: UUID) {
        historyWriteRevisions[conversationId] =
            historyWriteRevision(for: conversationId) &+ 1
    }

    private func isHistoryDeletionInProgress(
        _ conversationId: UUID
    ) -> Bool {
        (historyDeletionCounts[conversationId] ?? 0) > 0
    }

    private func beginHistoryDeletion(conversationId: UUID) {
        historyDeletionCounts[conversationId, default: 0] += 1
        advanceHistoryWriteRevision(for: conversationId)
    }

    private func endHistoryDeletion(conversationId: UUID) {
        let remaining = (historyDeletionCounts[conversationId] ?? 1) - 1
        if remaining > 0 {
            historyDeletionCounts[conversationId] = remaining
        } else {
            historyDeletionCounts.removeValue(forKey: conversationId)
        }
    }

    private func isMemoryClearInProgress(_ conversationId: UUID) -> Bool {
        (memoryClearCounts[conversationId] ?? 0) > 0
    }

    private func beginMemoryClear(conversationId: UUID) {
        memoryClearCounts[conversationId, default: 0] += 1
    }

    private func endMemoryClear(conversationId: UUID) {
        let remaining = (memoryClearCounts[conversationId] ?? 1) - 1
        if remaining > 0 {
            memoryClearCounts[conversationId] = remaining
        } else {
            memoryClearCounts.removeValue(forKey: conversationId)
        }
    }

    private func waitForMemoryWrite(conversationId: UUID) async {
        let writes = activeMemoryWrites.values.filter {
            $0.conversationId == conversationId
        }
        for write in writes {
            _ = await write.task.value
            clearActiveMemoryWriteIfMatching(
                conversationId: write.conversationId,
                sourceMessageId: write.sourceMessageId
            )
        }
    }

    private func clearActiveMemoryWriteIfMatching(
        conversationId: UUID,
        sourceMessageId: UUID
    ) {
        guard let activeMemoryWrite = activeMemoryWrites[sourceMessageId],
              activeMemoryWrite.conversationId == conversationId,
              activeMemoryWrite.sourceMessageId == sourceMessageId else {
            return
        }
        activeMemoryWrites.removeValue(forKey: sourceMessageId)
    }

    private func isSamePendingTurn(
        _ lhs: PendingAgentMemoryTurn,
        _ rhs: PendingAgentMemoryTurn
    ) -> Bool {
        lhs.streamGeneration == rhs.streamGeneration
            && lhs.sourceMessageId == rhs.sourceMessageId
    }

    private func clearPendingTurnIfMatching(
        _ pending: PendingAgentMemoryTurn
    ) {
        guard let current = pendingMemoryTurn,
              isSamePendingTurn(current, pending) else {
            return
        }
        pendingMemoryTurn = nil
    }

    private func finalizeAssistantStreamingState() {
        for index in messages.indices
        where messages[index].role == .assistant
            && messages[index].isStreaming {
            messages[index].isStreaming = false
        }
    }

    private func beginConversationTransition() -> Bool {
        guard !isConversationTransitioning else { return false }
        isConversationTransitioning = true
        return true
    }

    private func endConversationTransition() {
        isConversationTransitioning = false
    }

    private func awaitInitialization() async {
        if let initializationTask {
            await initializationTask.value
        }
    }

    private func memorySafeGoal(from text: String) -> String {
        let marker = "<local_attachments>"
        let userText = text.components(separatedBy: marker).first ?? text
        let normalized = userText
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return normalized.isEmpty ? "Inspect attached files" : normalized
    }

    private func isEligibleForLongTermMemory(_ text: String) -> Bool {
        let lowercased = text.lowercased()
        let excludedMarkers = [
            "<local_attachments>",
            "<browser_context>",
            "```",
            "diff --git ",
            "-----begin file-----",
            "-----end file-----"
        ]
        return !excludedMarkers.contains(where: lowercased.contains)
    }

    private func beginUsageEstimate(message: String, history: [ChatMessage]) {
        let context = history.map(\.content).joined(separator: "\n") + "\n" + message
        pendingEstimatedInputTokens = TokenEstimator.estimate(context)
        pendingEstimatedOutput = ""
        pendingUsageActive = true
        receivedProviderUsage = false
    }

    private func finalizeEstimatedUsageIfNeeded() {
        guard pendingUsageActive else { return }
        if !receivedProviderUsage {
            tokenUsage.record(
                inputTokens: pendingEstimatedInputTokens,
                outputTokens: TokenEstimator.estimate(pendingEstimatedOutput),
                source: .estimate
            )
        }
        clearPendingUsage()
    }

    private func clearPendingUsage() {
        pendingEstimatedInputTokens = 0
        pendingEstimatedOutput = ""
        pendingUsageActive = false
        receivedProviderUsage = false
    }

    func rebuildCache() {
        // Stable sort: timestamp is primary, original index is tie-breaker.
        // Without a tie-breaker, Array.sort is unstable and messages created in
        // the same millisecond can appear out of order.
        let indexed = messages.enumerated().map { (index: $0, message: $1) }
        let sorted = indexed.sorted { a, b in
            if a.message.timestamp != b.message.timestamp {
                return a.message.timestamp < b.message.timestamp
            }
            return a.index < b.index
        }
        messages = sorted.map { $0.message }

        deduplicateMessages()

        messageCache = [:]
        for (index, message) in messages.enumerated() {
            messageCache[message.id] = index
        }
    }

    func deduplicateMessages() {
        var seenIds = Set<UUID>()
        messages = messages.filter { msg in
            guard !seenIds.contains(msg.id) else { return false }
            seenIds.insert(msg.id)
            return true
        }
    }

    private func saveHistory(expectedGeneration: UInt64) async {
        guard isGenerationCurrent(expectedGeneration) else { return }
        let targetConversationId = conversationId
        let snapshot = messages
        await persister.save(
            messages: snapshot,
            conversationId: targetConversationId
        )
        guard isGenerationCurrent(expectedGeneration),
              conversationId == targetConversationId else {
            return
        }
        await loadConversations()
    }

    private func captureHistorySnapshot() -> ConversationHistorySnapshot {
        ConversationHistorySnapshot(
            conversationId: conversationId,
            messages: messages,
            writeRevision: historyWriteRevision(for: conversationId)
        )
    }

    private func persistHistorySnapshot(
        _ snapshot: ConversationHistorySnapshot
    ) async {
        guard snapshot.writeRevision == historyWriteRevision(
                  for: snapshot.conversationId
              ),
              !isHistoryDeletionInProgress(snapshot.conversationId) else {
            return
        }

        await persister.save(
            messages: snapshot.messages,
            conversationId: snapshot.conversationId
        )

        guard snapshot.writeRevision == historyWriteRevision(
                  for: snapshot.conversationId
              ),
              !isHistoryDeletionInProgress(snapshot.conversationId) else {
            await persister.clear(conversationId: snapshot.conversationId)
            return
        }

        if conversationId == snapshot.conversationId {
            await loadConversations()
        }
    }

    private func clearPersistedConversationHistory(
        conversationId: UUID
    ) async {
        beginHistoryDeletion(conversationId: conversationId)
        defer {
            endHistoryDeletion(conversationId: conversationId)
        }
        await persister.clear(conversationId: conversationId)
    }
    
    // MARK: - Conversation Management

    func renameConversation(_ id: UUID, to newName: String) async {
        let title = ConversationTitlePolicy.normalized(newName)
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].title = title
        }
        await persister.renameConversation(id: id, title: title)
        await loadConversations()
    }

    func togglePin(_ id: UUID) {
        guard id != ChatConversation.trinityQueenId else {
            NSLog("[TriosChat] togglePin ignored for reserved Trinity Queen conversation")
            return
        }
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].isPinned.toggle()
            objectWillChange.send()
        }
    }

    func createNewConversation() {
        guard beginConversationTransition() else { return }
        let newConv = ChatConversation(
            id: UUID(),
            title: "New Chat",
            isPinned: false,
            icon: "message.fill",
            updatedAt: Date(),
            unreadCount: 0
        )
        invalidateActiveStream()
        Task {
            await awaitInitialization()
            await preserveInterruptedTurn(reason: "you started a new chat")
            await cancelPendingTurn()
            await transport.cancel()
            _ = await stateMachine.transition(to: .idle)
            state = await stateMachine.currentState()
            conversations.insert(newConv, at: 0)
            conversationId = newConv.id
            messages = []
            messageCache = [:]
            tokenUsage.reset()
            clearPendingUsage()
            recalledMemories = []
            memoryControlRevision &+= 1
            objectWillChange.send()
            await todoPlanner.load(conversationId: newConv.id)
            await persister.setCurrentConversationId(newConv.id)
            await loadConversations()
            endConversationTransition()
        }
    }

    func selectConversation(_ id: UUID) {
        guard beginConversationTransition() else { return }
        invalidateActiveStream()
        Task {
            await awaitInitialization()
            await performConversationSwitch(id: id)
            endConversationTransition()
        }
    }

    func deleteConversation(_ id: UUID) {
        guard id != ChatConversation.trinityQueenId else {
            NSLog("[TriosChat] deleteConversation ignored for reserved Trinity Queen conversation")
            Task {
                await appendSystemMessageToQueenChat(
                    "This conversation is the Trinity Queen direct line and cannot be deleted."
                )
            }
            return
        }
        guard beginConversationTransition() else { return }
        let retainedHistorySnapshot: ConversationHistorySnapshot?
        if id == conversationId {
            finalizeAssistantStreamingState()
            retainedHistorySnapshot = captureHistorySnapshot()
            invalidateActiveStream()
        } else {
            retainedHistorySnapshot = nil
        }
        Task {
            await awaitInitialization()
            await performConversationDeletion(
                id: id,
                retainedHistorySnapshot: retainedHistorySnapshot
            )
            endConversationTransition()
        }
    }

    /// Whether this repository runs checks the gate must wait for.
    ///
    /// Stated rather than inferred. A repository with no CI reports NONE, and
    /// guessing from that is a coin toss with two bad sides: read it as failure
    /// and nothing ever merges; read it as success and the gate is a
    /// decoration in a project that meant to have checks. `.github/workflows`
    /// existing is the fact, and it is cheap to ask.
    static var repositoryHasChecks: Bool {
        let root = (ProjectPaths.root as NSString).deletingLastPathComponent
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(
            atPath: "\(root)/.github/workflows", isDirectory: &isDirectory
        )
        return exists && isDirectory.boolValue
    }

    /// Puts a correction where the worker will read it.
    ///
    /// Written straight through the persister rather than into `messages`,
    /// because the worker's conversation is usually not the one on screen and
    /// touching the visible transcript for a different chat is how two
    /// conversations end up sharing a history.
    private func appendCorrectionToWorkerChat(task: DelegatedTask, text: String) async {
        let note = ChatMessage(
            role: .system,
            content: QueenObserver.correctionText(concerns: [text])
        )
        var history = await persister.load(conversationId: task.conversationId)
        history.append(note)
        await persister.save(messages: history, conversationId: task.conversationId)
    }

    /// The Queen's chat as last known, when the user is looking somewhere else.
    ///
    /// Kept because the obvious version loses messages. Load, append, save has
    /// two suspension points, and bees do not report politely one at a time -
    /// six finishing together each loaded the same history, appended their own
    /// line and saved, so five were overwritten. Six notices arrived and she
    /// heard two. A supervisor silently missing four bees is worse than one
    /// reporting late.
    ///
    /// Appending to an array held here is synchronous on the main actor, so no
    /// two callers can interleave between reading and writing it. Only the save
    /// suspends, and by then every caller's line is already in the array.
    private var queenChatWhileAway: [ChatMessage]?
    /// The tail of the queue of writes to her chat, so two reports arriving at
    /// once cannot land out of order and lose one.
    private var queenChatSaveChain: Task<Void, Never>?

    func appendSystemMessageToQueenChat(_ content: String) async {
        let message = ChatMessage(role: .system, content: content)
        if conversationId == ChatConversation.trinityQueenId {
            // Her chat is open, so `messages` is the live copy and the cache
            // would only go stale behind it.
            queenChatWhileAway = nil
            messages.append(message)
            rebuildCache()
            await saveHistory(expectedGeneration: streamGeneration)
            await loadConversations()
            return
        }

        if queenChatWhileAway == nil {
            let loaded = await persister.load(conversationId: ChatConversation.trinityQueenId)
            // Re-check: a second caller may have filled it while this one was
            // suspended, and overwriting would drop whatever it had appended.
            if queenChatWhileAway == nil { queenChatWhileAway = loaded }
        }
        queenChatWhileAway?.append(message)
        await persistQueenChatWhileAway(fallback: message)
        await loadConversations()
    }

    /// Serialises the writes to the Queen's chat, and takes the snapshot at the
    /// moment each one runs rather than when it was queued.
    ///
    /// The buffer above already stopped concurrent reports from overwriting each
    /// other in memory - every bee appends to the same array on the main actor,
    /// so the array is always complete. What was still lost was the file: each
    /// caller passed its own whole-array snapshot to `save`, the saves raced,
    /// and the winner was whichever finished last, not whichever held the most.
    /// Six bees reporting at once persisted three, and the Queen was missing
    /// half her fleet with nothing anywhere saying so.
    ///
    /// Found by running six reports concurrently under a parallel build - it
    /// survived every idle run, which is why a fixed sleep had been enough to
    /// hide it.
    private func persistQueenChatWhileAway(fallback: ChatMessage) async {
        let previous = queenChatSaveChain
        let save = Task { @MainActor [weak self] in
            await previous?.value
            guard let self else { return }
            let snapshot = self.queenChatWhileAway ?? [fallback]
            await self.persister.save(
                messages: snapshot,
                conversationId: ChatConversation.trinityQueenId
            )
        }
        queenChatSaveChain = save
        await save.value
        if queenChatSaveChain == save { queenChatSaveChain = nil }
    }

    // MARK: - Queen Slash Commands

    private func executeQueenCommand(_ command: QueenCommand, originalText: String) async {
        switch command {
        case .reconcile(let apply):
            await handleReconcileCommand(apply: apply)
        case .help:
            await appendSystemMessageToQueenChat(QueenCommandParser.helpText)
        case .status:
            let a2aStatus = queenBackgroundService?.isA2ARegistered ?? false
            await appendSystemMessageToQueenChat(
                "Server: \(isServerReachable ? "online" : "offline"). " +
                "A2A: \(a2aStatus ? "registered" : "unregistered"). " +
                "Conversations: \(conversations.count)."
            )
        case .agents:
            await listQueenAgents()
        case .chats:
            await listQueenChats()
        case .switchChat(let id):
            await switchConversation(id: id)
            await appendSystemMessageToQueenChat("Switched to conversation \(id.uuidString.prefix(8))")
        case .newChat(let title):
            if let id = await queenBackgroundService?.createChat(title: title) {
                await switchConversation(id: id)
                await appendSystemMessageToQueenChat("Created and switched to conversation \(id.uuidString.prefix(8))")
            } else {
                newConversation()
                if let title, !title.isEmpty {
                    await renameConversation(conversationId, to: title)
                }
                await appendSystemMessageToQueenChat("Created new conversation")
            }
        case .deleteChat(let id):
            deleteConversation(id)
            await appendSystemMessageToQueenChat("Deleted conversation \(id.uuidString.prefix(8))")
        case .delegate(let agent, let task):
            await delegateTaskToAgent(agentIdString: agent, taskDescription: task)
        case .delegateIssue(let issue, let worker, let title, let paths, let skill, let criteria):
            await delegateIssueToWorker(
                issue: issue,
                worker: worker,
                title: title,
                paths: paths,
                skill: skill,
                criteria: criteria
            )
        case .cancelTask(let issue, let reason):
            await cancelDelegatedTask(issue: issue, reason: reason)
        case .dismissTask(let issue, let reason):
            await dismissFailedTask(issue: issue, reason: reason)
        case .verifyCriterion(let issue, let criterion, let verdict):
            await recordCriterionVerdict(issue: issue, criterion: criterion, verdict: verdict)
        case .approveDelegation(let issue):
            await approveDelegation(issue: issue)
        case .openPullRequest(let issue):
            await openPullRequestForTask(issue: issue)
        case .swarm:
            await reportSwarm()
        case .review(let issue, let decision, let note):
            await reviewDelegatedTask(issue: issue, decision: decision, note: note)
        case .broadcast(let message):
            await broadcastToAgents(message)
        case .audit:
            await runQueenEvolution()
        case .memory:
            await recallQueenMemory()
        case .evolve:
            await runQueenEvolution()
        case .proposals:
            await listQueenProposals()
        case .evolveApply(let id, let confirmed):
            if confirmed {
                guard stagedProposalIds.contains(id) else {
                    await appendSystemMessageToQueenChat(
                        "Proposal \(id.uuidString.prefix(8)) has not been staged. Run `/apply \(id.uuidString)` first."
                    )
                    return
                }
                await applyQueenProposal(id: id, confirmed: true)
            } else {
                await applyQueenProposal(id: id, confirmed: false)
            }
        case .evolveReject(let id):
            await rejectQueenProposal(id: id)
        case .doctor(let model):
            let output: String
            if let model = model, !model.isEmpty {
                // Persist the requested model so the next chat turn also uses it.
                modelStore.selectModel(model)
                output = await queenStatusVM.runSkillReturningOutput(
                    name: "/doctor",
                    arguments: ["--model", model]
                )
            } else {
                output = await queenStatusVM.runSkillReturningOutput(name: "/doctor")
            }
            await appendSystemMessageToQueenChat("`/doctor` result:\n\(output)")
        case .tri:
            let output = await queenStatusVM.runSkillReturningOutput(name: "/tri")
            await appendSystemMessageToQueenChat("`/tri` result:\n\(output)")
        case .godMode:
            let output = await queenStatusVM.runSkillReturningOutput(name: "/god-mode")
            await appendSystemMessageToQueenChat("`/god-mode` result:\n\(output)")
        case .bridge:
            let output = await queenStatusVM.runSkillReturningOutput(name: "/bridge")
            await appendSystemMessageToQueenChat("`/bridge` result:\n\(output)")
        case .skills:
            await reportSkills()
        case .selfAudit:
            await runSelfAudit()
        case .salience:
            await reportSalience()
        case .choose:
            let wantStart = originalText.range(of: "--start") != nil
            await chooseNextOpenIssue(startAfterChoosing: wantStart)
        case .brief(let issue):
            // Preview only — this is not a security boundary. It builds the
            // brief the same way /delegate does (reads the contract from the
            // issue, parses Границы, applies QueenLocalisation narrowing) but
            // prints it to the Queen chat instead of opening a worker. No task
            // is created, no chat is opened, no branch is taken: nothing here
            // enters the registry.
            guard let body = await fetchIssueBody(issue) else {
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Cannot read \(issue.slug) to preview the brief."
                )
                return
            }
            let criteria = QueenTaskSpec.criteriaFromIssue(body: body)
            let paths = ChatViewModel.boundaryPaths(from: body) ?? []
            let task = DelegatedTask(
                issue: issue,
                title: "Brief preview for \(issue.slug)",
                worker: "(preview)",
                ownedPaths: paths,
                acceptanceCriteria: criteria
            )
            // Narrow large files exactly as delegation does — the shared
            // function guarantees identical hints and identical logging.
            let narrowedHints = ChatViewModel.narrowedHints(
                for: paths, from: body, issueSlug: issue.slug
            )
            let brief = QueenBriefing.text(for: task)
                + (narrowedHints.isEmpty ? "" : "\n" + narrowedHints.joined(separator: "\n"))
            await appendSystemMessageToQueenChat(brief)
            TriosLogBus.shared.info(
                .queen, "queen.brief.preview",
                "Brief preview for \(issue.slug) (\(brief.count) chars)",
                ["issue": issue.slug, "length": String(brief.count)]
            )
        case .runSkill(let command, let arguments):
            await runQueenSkill(command: command, arguments: arguments)
        case .unknown:
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "I do not know `\(originalText)`.\n\(QueenCommandParser.helpText)"
            )
        }
    }

    /// Narrows each boundary path to the region the issue mentions, returning
    /// one hint string per narrowed file. Shared by the `/brief` preview and
    /// real delegation so both produce identical hints and emit
    /// `queen.brief.narrowed` for every file that gets narrowed.
    private static func narrowedHints(
        for paths: [String],
        from issueBody: String,
        issueSlug: String
    ) -> [String] {
        var hints: [String] = []
        let identifiers = ChatViewModel.identifiers(from: issueBody)
        for path in paths {
            // The token may still carry a trailing backtick when the
            // comma sits outside the closing backtick (`path`,);
            // strip both before treating it as a path.
            let path = path.trimmingCharacters(
                in: CharacterSet(charactersIn: "`),;:!?")
            )
            let fullPath = "\(ProjectPaths.root)/\(path)"
            guard FileManager.default.fileExists(atPath: fullPath),
                  let source = try? String(contentsOfFile: fullPath, encoding: .utf8)
            else { continue }
            // Count actual lines: components(separatedBy:) over-counts by one
            // when the file ends with a newline, so a 300-line file reports
            // 301 and gets narrowed when the contract says "longer than 300".
            let lineCount = source.components(separatedBy: "\n").count
                - (source.hasSuffix("\n") ? 1 : 0)
            guard lineCount > QueenLocalisation.maxRegionWidth else { continue }
            // Before asking QueenLocalisation to narrow, record what we are
            // about to search for and where. Without this log, silence from
            // region(in:mentioning:) is indistinguishable from "never tried"
            // (#1177 criterion 2).
            TriosLogBus.shared.info(
                .queen, "queen.brief.localising",
                "Localising in \(path) (\(lineCount) lines) with \(identifiers.count) identifier(s)",
                [
                    "issue": issueSlug,
                    "file": path,
                    "lines": String(lineCount),
                    "identifiers": identifiers.joined(separator: " | "),
                ]
            )
            if let range = QueenLocalisation.region(in: source, mentioning: identifiers) {
                hints.append(
                    "В \(path) читай только строки \(range.lowerBound)-\(range.upperBound)."
                )
                // Which identifier actually caused the hit? region() returns
                // only the line range; scan the narrowed slice to name the
                // identifier that matched (#1177 criterion 3).
                let sourceLines = source.components(separatedBy: "\n")
                let regionStart = max(0, range.lowerBound - 1)
                let regionEnd = min(sourceLines.count, range.upperBound)
                let matched = identifiers.first { id in
                    sourceLines[regionStart..<regionEnd].contains { $0.contains(id) }
                }
                TriosLogBus.shared.info(
                    .queen, "queen.brief.narrowed",
                    "Narrowed \(path) to lines \(range.lowerBound)-\(range.upperBound)",
                    [
                        "issue": issueSlug,
                        "file": path,
                        "range": "\(range.lowerBound)-\(range.upperBound)",
                        "matched": matched ?? "unknown",
                    ]
                )
            } else {
                // nil from region(): the identifiers were tried against this
                // file but none landed. Recording them here keeps "tried and
                // failed" separate from "never tried" (#1177 criterion 2).
                TriosLogBus.shared.warn(
                    .queen, "queen.brief.notNarrowed",
                    "Could not narrow \(path) (\(lineCount) lines); tried \(identifiers.count) identifier(s)",
                    [
                        "issue": issueSlug,
                        "file": path,
                        "lines": String(lineCount),
                        "identifiers": identifiers.joined(separator: " | "),
                    ]
                )
            }
        }
        return hints
    }

    private func listQueenAgents() async {
        let agents = await queenBackgroundService?.listAgents() ?? []
        let lines = agents.map { "* \($0.id.rawValue): \($0.name)" }
        let text = lines.isEmpty ? "No online agents discovered." : lines.joined(separator: "\n")
        await appendSystemMessageToQueenChat("Online agents:\n\(text)")
    }

    private func listQueenChats() async {
        let chats = await queenBackgroundService?.listChats() ?? conversations
        let lines = chats.map { conv in
            let pin = conv.isReserved ? "[QUEEN]" : (conv.isPinned ? "[PIN]" : "  ")
            return "\(pin) \(conv.id.uuidString.prefix(8))  -  \(conv.title)"
        }
        await appendSystemMessageToQueenChat("Conversations:\n\(lines.joined(separator: "\n"))")
    }

    /// Opens a worker chat for a GitHub issue and isolates it on its own
    /// GitButler virtual branch.
    ///
    /// This is the Queen's one act of creation: she does not write code, she
    /// opens a conversation, gives it a boundary, and reviews what comes back.
    private func delegateIssueToWorker(
        issue: IssueReference,
        worker: String,
        title: String,
        paths: [String] = [],
        skill: String? = nil,
        criteria: [String] = []
    ) async {
        let registry = delegationRegistry

        if let existing = registry.task(forIssue: issue) {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "\(issue.slug) is already delegated to \(existing.worker). "
                    + "Open that chat rather than starting a second one."
            )
            TriosLogBus.shared.warn(
                .queen,
                "queen.delegate",
                "Refused — \(issue.slug) already delegated to \(existing.worker)",
                [
                    "issue": issue.slug,
                    "reason": "already delegated",
                    "worker": existing.worker,
                ]
            )
            return
        }
        // The Queen proposes, the person decides. Checked before every other
        // refusal so the answer is about consent rather than capacity - being
        // told "three workers are busy" when the real problem is that nobody
        // agreed to this work would send the user to fix the wrong thing.
        if let reason = QueenDelegationPolicy.approvalBlockReason(
            issue: issue, approved: registry.approvedIssues
        ) {
            await postQueenNotice(SystemNoticeClassifier.warningMarker + reason)
            TriosLogBus.shared.warn(
                .queen,
                "queen.delegate",
                "Refused — \(issue.slug) not approved: \(reason)",
                [
                    "issue": issue.slug,
                    "reason": reason,
                ]
            )
            return
        }
        if let reason = registry.delegationBlockReason(paths: paths) {
            await postQueenNotice(SystemNoticeClassifier.warningMarker + "Cannot delegate: \(reason)")
            TriosLogBus.shared.warn(
                .queen,
                "queen.delegate",
                "Refused — \(issue.slug) boundary conflict: \(reason)",
                [
                    "issue": issue.slug,
                    "reason": reason,
                ]
            )
            return
        }
        // Refuse to *start* work past the ceiling. Stopping a bee already
        // running would leave the repository half-edited; declining to open a
        // new one is a decision that can be taken safely at any moment.
        let spent = registry.spentToday()
        if case .exhausted(let overBy) = SwarmBudget.default.verdict(spentToday: spent) {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "I am not opening new work today. The swarm has spent about "
                    + "\(ModelPricing.format(spent)), which is \(ModelPricing.format(overBy)) past "
                    + "the daily ceiling. Anything already running continues."
            )
            TriosLogBus.shared.warn(
                .queen,
                "queen.delegate",
                "Refused — \(issue.slug) budget exhausted (spent \(ModelPricing.format(spent)), "
                    + "\(ModelPricing.format(overBy)) past ceiling)",
                [
                    "issue": issue.slug,
                    "reason": "budget exhausted",
                    "spent": ModelPricing.format(spent),
                    "overBy": ModelPricing.format(overBy),
                ]
            )
            return
        }

        // No contract on the command line? Read the one the issue already
        // states. Requiring it to be retyped is why every delegation in this
        // project's history went out with nothing to judge it by - the flag
        // existed, and in practice nobody used it.
        var criteria = criteria
        if criteria.isEmpty {
            if let body = await fetchIssueBody(issue) {
                criteria = QueenTaskSpec.criteriaFromIssue(body: body)
                if !criteria.isEmpty {
                    TriosLogBus.shared.info(
                        .queen, "queen.spec.fromIssue", "Read the contract from the issue",
                        ["issue": issue.slug, "criteria": String(criteria.count)]
                    )
                }
            } else {
                // Not fatal. A task with no criteria is still delegated, and the
                // specification says plainly that nothing here can be judged
                // finished - the honest state, not a silent one.
                TriosLogBus.shared.warn(
                    .queen, "queen.spec.issueUnreadable",
                    "Could not read the issue, so there is no contract",
                    ["issue": issue.slug]
                )
            }
        }

        // Create the worker's own conversation. The persister materialises a
        // conversation the moment messages are saved against a fresh id.
        let conversationId = UUID()

        guard let task = registry.delegate(
            issue: issue,
            title: title,
            worker: worker,
            conversationId: conversationId,
            ownedPaths: paths,
            acceptanceCriteria: criteria
        ) else {
            await postQueenNotice(SystemNoticeClassifier.failureMarker + (registry.lastError ?? "Delegation was refused."))
            return
        }

        // A private checkout is what keeps two bees off each other's files -
        // and off the build's. The branch alone never did: it recorded WHOSE a
        // change was, while every bee still wrote into the one working tree the
        // user, the gate and each other were reading (#1277).
        //
        // `git worktree add -B` cuts the branch as it makes the checkout, so
        // `createVirtualBranch` is only reached when a worktree could not be
        // made. That fallback is the pre-worktree behaviour, kept deliberately:
        // a bee that cannot get its own directory should still work, just
        // without the isolation.
        if let branch = task.virtualBranch {
            if let prepared = await prepareWorktree(for: task, branch: branch) {
                registry.setWorktreePath(taskID: task.id, path: prepared.path)
                // The branch too, and this is the load-bearing half. Everything
                // downstream - the committer, the combined build, the pull
                // request - reads `virtualBranch`, and it named a branch the
                // bee was not on.
                if prepared.branch != branch {
                    registry.setVirtualBranch(taskID: task.id, branch: prepared.branch)
                }
            } else if let reason = await createVirtualBranch(named: branch) {
                registry.transition(taskID: task.id, to: .cancelled)
                await postQueenNotice(
                    SystemNoticeClassifier.failureMarker
                        + "Could not create the virtual branch `\(branch)`, so the delegation "
                        + "was rolled back. git said: \(reason)"
                )
                return
            }
        }

        // Brief the worker in its own chat. Deliberately a subset of context:
        // the issue, the branch, the boundary - never the Queen's history.
        // A named skill is handed over whole. Refused rather than silently
        // ignored: a worker briefed without the procedure it was promised looks
        // like it disobeyed.
        // When nobody named a skill, choose one from the boundary.
        //
        // Not one delegation in this project's history has carried a skill: the
        // slot has existed since the briefing was written, `--skill` has always
        // been accepted, and the field was always nil - so every bee improvised
        // beside twenty-six written procedures. An explicit name still wins;
        // this only fills a silence.
        //
        // Conservative by construction: `QueenSkillMatch` returns nil unless
        // every path in the boundary agrees on one skill, because a worker
        // briefed with the wrong rehearsal is worse off than one briefed with
        // none - it will follow it.
        let skill = skill ?? QueenSkillMatch.skill(
            forBoundary: paths,
            available: Set(skillStore.enabled.map(\.id))
        )
        if skill != nil {
            TriosLogBus.shared.info(
                .queen, "queen.brief.skill",
                "Briefing \(worker) with the `\(skill ?? "-")` procedure",
                ["issue": issue.slug, "skill": skill ?? "-"]
            )
        }
        var skillBody: String?
        if let skill {
            guard let descriptor = skillStore.skill(named: skill),
                  skillStore.isEnabled(descriptor),
                  let body = try? String(contentsOfFile: descriptor.path, encoding: .utf8) else {
                registry.transition(taskID: task.id, to: .cancelled)
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "I did not open this one. You asked for `\(skill)` and I either do not "
                        + "have it or it is switched off, and briefing a worker without the "
                        + "procedure you named would look like it ignored you."
                )
                return
            }
            skillBody = body
        }
        // Narrow each boundary path to the region the issue talks about
        // before the brief goes out. Shared with the `/brief` preview so
        // both produce identical hints and emit `queen.brief.narrowed`.
        var narrowedHints: [String] = []
        if let issueBody = await fetchIssueBody(issue) {
            narrowedHints = ChatViewModel.narrowedHints(
                for: task.ownedPaths, from: issueBody, issueSlug: issue.slug
            )
        }
        // What the bees before this one hit. Gathered from the registry rather
        // than passed along, so a retry started from any path carries it.
        let priorAttempts = registry.priorFailures(forIssue: issue.number)
        if !priorAttempts.filter(\.countsAgainstTheIssue).isEmpty {
            TriosLogBus.shared.info(
                .queen, "queen.brief.retry",
                "Briefing \(worker) with what \(priorAttempts.filter(\.countsAgainstTheIssue).count) "
                    + "earlier attempt(s) on \(issue.slug) ran into",
                ["issue": issue.slug]
            )
        }
        let brief = QueenBriefing.text(
            for: task, skillBody: skillBody, priorAttempts: priorAttempts
        ) + (narrowedHints.isEmpty ? "" : "\n" + narrowedHints.joined(separator: "\n"))
        // Materialise the chat before naming it. renameConversation renames a
        // record that exists; the comment above claimed the persister creates
        // one "the moment messages are saved against a fresh id", which is true
        // and is the problem - nothing was saved yet, so the rename landed on
        // nothing and the chat stayed out of the sidebar until the bee spoke.
        //
        // A delegated chat nobody can see is a bee nobody can supervise, which
        // is the whole point of the Queen having chats at all.
        await persister.save(messages: [], conversationId: conversationId)
        await persister.renameConversation(
            id: conversationId,
            title: "\(issue.slug) \(title)"
        )
        await loadConversations()

        // Take the baseline BEFORE the transition to .running, so no await
        // separates the transition from runner.start. Two delegations arriving
        // seconds apart interleave at every await on the main actor; without
        // this ordering, the first task transitions to .running, yields at the
        // snapshot, and the second delegation starts and completes while the
        // first sits in .running with no worker (#1139).
        let baseline = await QueenBranchCommitter.snapshotWorkingTree()

        // Actually start the bee. Saving the briefing and stopping there left a
        // chat that looked delegated and did nothing, which is worse than
        // refusing to delegate at all.
        guard let runner = workerRunner else {
            // .cancelled, not .failed: the task is still in .queued (the
            // transition to .running happens below, after this guard), and
            // the state machine allows .queued → .cancelled but not
            // .queued → .failed. Using .failed here was silently rejected,
            // leaving the task orphaned in .queued — visible to every
            // subsequent delegation as a live task holding its paths (#1139).
            registry.transition(taskID: task.id, to: .cancelled)
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Delegation aborted: no worker runner is configured, so \(worker) could not be started."
            )
            await loadConversations()
            return
        }

        // #1223: The API key lives only in the Keychain, which answers
        // intermittently. When resolvedAPIKey comes back empty the request
        // is doomed to a 500 "z.ai provider requires apiKey" before it is
        // sent, so dispatching is pointless. Check before transitioning to
        // .running: leave the task in .queued — the same idea as a
        // connectivity failure leaving a task in .running — so no resume
        // attempt is spent and the task is not the worker's fault.
        //
        // Gate on the real network transport only: the test harness injects
        // a stubbed transport with no API key, and the precheck would block
        // every delegation in the suite.
        if type(of: transport) is SSETransport.Type {
            let resolvedKey = modelStore.resolvedAPIKey(for: modelStore.selectedProvider)
            guard !resolvedKey.isEmpty else {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.worker.api_key_unavailable",
                    "API key for \(modelStore.selectedProvider.rawValue) resolved "
                        + "empty. \(worker) is not dispatched for \(issue.slug); "
                        + "the task stays where it is, no resume attempt counted. "
                        + modelStore.credentialDiagnosis(for: modelStore.selectedProvider),
                    [
                        "issue": issue.slug,
                        "worker": worker,
                        "provider": modelStore.selectedProvider.rawValue,
                        "diagnosis": modelStore.credentialDiagnosis(
                            for: modelStore.selectedProvider
                        ),
                    ]
                )
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "I did not dispatch \(worker) to \(issue.slug) — the API "
                        + "key is unavailable (the Keychain did not respond). The "
                        + "task is left where it is and no resume attempt is "
                        + "counted. Try again when the key is reachable."
                )
                await loadConversations()
                // #1224: A refusal is a chance to warm the key — the next
                // dispatch attempt may find it in the cache. Idempotent: if
                // the bootstrap already started the warm-up this is a no-op.
                warmupProviderKey()
                return
            }
        }

        // #1150: Concurrent inbox dispatch means multiple tasks can pass the
        // slot pre-check (delegationBlockReason) while still in .queued, then
        // all reach this point and transition to .running at once — exceeding
        // the limit.  This re-check runs in the synchronous section after the
        // last await (snapshotWorkingTree), so on the main actor it is atomic
        // with the transition below: no other child task can interleave
        // between the check and the transition.
        if !QueenDelegationPolicy.canStartAnother(running: registry.running.count) {
            registry.transition(taskID: task.id, to: .cancelled)
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "All \(QueenDelegationPolicy.maximumConcurrentWorkers) worker "
                    + "slots are full, so \(issue.slug) is not started yet. "
                    + "It will be retried on the next inbox poll."
            )
            await loadConversations()
            return
        }
        // Transition and start are now synchronous-adjacent: no yield between
        // them, so a second delegation arriving while this one runs cannot
        // interleave between marking .running and launching the worker.
        registry.transition(taskID: task.id, to: .running)
        workerBaselineTrees[conversationId] = baseline
        registry.setBaselineTree(taskID: task.id, baselineTree: baseline)
        // Re-read rather than trusting the copy taken before the worktree was
        // prepared. `task` is a value, captured above `prepareWorktree`, so the
        // struct handed to the runner still says `worktreePath: nil` while the
        // registry knows better.
        //
        // Two things read that field and both were wrong on this path.
        // `workerWorkingDirectory` sends the bee to `ProjectPaths.root`, so the
        // whole worktree isolation was inert and an empty checkout sat unused;
        // and `commitWorkerOutput` routed to the shared-tree committer, which
        // manufactures a commit out of whatever is dirty and leaves the dirt
        // behind. #1282 went out this way and its file is still untracked in
        // the shared tree.
        //
        // #1280 took the key-warmup path instead, which iterates the registry
        // and therefore had the worktree - same code, two paths, two outcomes.
        // `reapStalledWorkers` already states this discipline in as many words;
        // this applies the rule the file already keeps.
        let dispatched = registry.tasks.first(where: { $0.id == task.id }) ?? task
        runner.start(task: dispatched, brief: brief)
        TriosLogBus.shared.info(
            .queen,
            "queen.worker.dispatched",
            "Dispatched worker for \(issue.slug)",
            ["issue": issue.slug, "conversation": conversationId.uuidString.prefix(8).description]
        )

        await postQueenNotice(
            SystemNoticeClassifier.successMarker
                + "\(worker) is on \(issue.slug) now. It has its own chat and its own "
                + "branch `\(task.virtualBranch ?? "-")`, so whatever it edits grows apart "
                + "from your working tree until you decide otherwise. "
                + "That puts \(registry.running.count) of "
                + "\(QueenDelegationPolicy.maximumConcurrentWorkers) slots in use."
        )
        await loadConversations()
    }

    /// Creates the branch that isolates a task's edits.
    ///
    /// Deliberately `git branch` and not `git checkout -b`: creating the ref
    /// must not move HEAD. The checkout is shared by the user, the build, and
    /// every other worker, so switching it on delegation silently dragged the
    /// whole repository onto one bee's branch - the exact conflict the branch
    /// was supposed to prevent.
    /// Returns nil when the branch exists afterwards, or git's own complaint
    /// when it does not.
    ///
    /// It used to return Bool and throw away what git said, so a failed
    /// delegation told the user only that the branch could not be created -
    /// never that the name was already taken, or that HEAD was unborn, or
    /// whichever of those it actually was. The compiler had been reporting the
    /// discarded result on every build; the value it named was the answer to
    /// the question the failure message could not answer.
    private func createVirtualBranch(named name: String) async -> String? {
        await Task.detached(priority: .utility) {
            let existing = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["branch", "--list", name],
                workDir: ProjectPaths.root,
                timeout: 10
            )
            // Reconnecting to an existing task must not be treated as an error.
            if existing.contains(name) { return nil }
            let attempt = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["branch", name, "HEAD"],
                workDir: ProjectPaths.root,
                timeout: 20
            )
            let created = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["branch", "--list", name],
                workDir: ProjectPaths.root,
                timeout: 10
            )
            if created.contains(name) { return nil }
            // git is usually loud about why, but a timeout or a killed process
            // leaves nothing to quote, and "" would read as success upstream.
            let reason = attempt.trimmingCharacters(in: .whitespacesAndNewlines)
            return reason.isEmpty ? "git branch produced no output and no branch" : reason
        }.value
    }

    /// Gives a task its own checkout, and reports where.
    ///
    /// Returns the worktree path, or nil with the reason logged. Nil is not
    /// fatal: the caller falls back to the shared tree, which is what every bee
    /// did before this existed. Degrading to the old behaviour beats refusing
    /// to work because a directory could not be made.
    ///
    /// The branch is cut here rather than by `createVirtualBranch`, because
    /// `git worktree add -B` does both in one step and cannot leave a branch
    /// pointing somewhere no checkout exists.
    /// The checkout and the branch it was actually cut on.
    ///
    /// Both, because they can differ: when the wanted branch is a leftover cut
    /// before HEAD, a fresh suffixed name is used instead. Returning only the
    /// path left the registry holding the ORIGINAL name while the bee worked on
    /// the new one - so the committer wrote to `queen/1127-r5` and the combined
    /// build read `queen/1127`, a branch 140 commits stale. The build could not
    /// compile, acceptance refused with "the combined state does not build
    /// together", and every finished task parked.
    struct PreparedWorktree {
        let path: String
        let branch: String
    }

    private func prepareWorktree(for task: DelegatedTask, branch: String) async -> PreparedWorktree? {
        let root = ProjectPaths.root
        let path = QueenWorktree.path(
            forIssue: task.issue.number,
            projectRoot: root,
            variant: ProjectPaths.variant.rawValue
        )
        return await Task.detached(priority: .utility) { () -> PreparedWorktree? in
            func git(_ args: [String], timeout: TimeInterval = 25) -> String {
                QueenStatusViewModel.runProcess(
                    "/usr/bin/git", arguments: args, workDir: root, timeout: timeout
                ).trimmingCharacters(in: .whitespacesAndNewlines)
            }

            // A worktree left behind by a killed run is reusable only if it is
            // still registered; `git worktree list` is the register, not the
            // presence of a directory.
            if git(["worktree", "list", "--porcelain"]).contains("worktree \(path)") {
                TriosLogBus.shared.info(
                    .queen, "queen.worktree.reused",
                    "Reusing the existing checkout for \(task.issue.slug)",
                    ["path": path]
                )
                let head = git(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
                return PreparedWorktree(path: path, branch: head.isEmpty ? branch : head)
            }

            // A branch left over from an older run is adopted silently by
            // `createVirtualBranch`. Here that adoption is refused when the
            // branch predates HEAD - see QueenWorktree.staleBranchReason. The
            // old branch is never deleted; a fresh name is used instead.
            let head = git(["rev-parse", "HEAD"])
            var name = branch
            var attempt = 0
            while attempt < 8 {
                let exists = !git(["branch", "--list", name]).isEmpty
                let mergeBase = exists ? git(["merge-base", name, "HEAD"]) : nil
                guard let reason = QueenWorktree.staleBranchReason(
                    branchExists: exists, mergeBase: mergeBase, head: head
                ) else { break }
                attempt += 1
                let next = QueenWorktree.freshBranchName(base: branch, attempt: attempt)
                TriosLogBus.shared.warn(
                    .queen, "queen.worktree.stale_branch",
                    "Not reusing \(name): \(reason). Cutting \(next) from HEAD instead; "
                        + "the old branch is left alone.",
                    ["branch": name, "next": next, "reason": reason]
                )
                name = next
            }

            let output = git(
                ["worktree", "add", "--quiet", "-B", name, path, "HEAD"], timeout: 90
            )
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                TriosLogBus.shared.error(
                    .queen, "queen.worktree.failed",
                    "Could not create a checkout for \(task.issue.slug); working in the "
                        + "shared tree instead. git said: "
                        + (output.isEmpty ? "(nothing)" : output),
                    ["issue": task.issue.slug, "path": path]
                )
                return nil
            }
            TriosLogBus.shared.info(
                .queen, "queen.worktree.created",
                "\(task.issue.slug) works in its own checkout on \(name)",
                ["path": path, "branch": name]
            )
            return PreparedWorktree(path: path, branch: name)
        }.value
    }

    /// Removes a finished task's checkout. The branch stays.
    ///
    /// Guarded by `isOwnedWorktree`, because this hands a path to
    /// `git worktree remove` and the shape of that mistake is deleting the
    /// checkout somebody is working in. `--force` covers the ordinary case of a
    /// bee that left uncommitted scratch behind; anything it wanted kept is on
    /// its branch, which is the whole contract.
    func releaseWorktree(for task: DelegatedTask) async {
        guard let path = task.worktreePath else { return }
        let root = ProjectPaths.root
        // Nothing there means nothing to remove, and the recorded path is
        // simply out of date - a task written before the paths were scoped by
        // variant carries the old shape. Without this the ownership guard below
        // refuses it, forever, on every sweep, and says so each time.
        guard FileManager.default.fileExists(atPath: path) else {
            delegationRegistry.clearWorktreePath(taskID: task.id)
            return
        }
        guard QueenWorktree.isOwnedWorktree(
            path: path, projectRoot: root, variant: ProjectPaths.variant.rawValue
        ) else {
            TriosLogBus.shared.error(
                .queen, "queen.worktree.refused_removal",
                "Refusing to remove \(path): it is not a checkout this code created",
                ["path": path]
            )
            return
        }
        await Task.detached(priority: .utility) {
            _ = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["worktree", "remove", "--force", path],
                workDir: root,
                timeout: 60
            )
            _ = QueenStatusViewModel.runProcess(
                "/usr/bin/git", arguments: ["worktree", "prune"], workDir: root, timeout: 30
            )
        }.value
        TriosLogBus.shared.info(
            .queen, "queen.worktree.released",
            "Released the checkout for \(task.issue.slug)", ["path": path]
        )
    }

    // MARK: - Worker Runner

    /// #1224: Reads the selected provider's API key once in the background so
    /// the ModelCredentialStore cache is filled without any request triggering
    /// it. The Keychain answers intermittently at launch, so the read is
    /// retried after a short delay with a sensible cap on attempts. A
    /// successful read populates the in-process cache for the whole session;
    /// only the first read is the problem, and this is the fix for it.
    ///
    /// One background attempt per minute to reach the conversation key, and a
    /// single healing pass over every conversation the moment it answers.
    ///
    /// Healing is read-triggered: `ConversationPersister.load` re-encrypts a
    /// plaintext-fallback slot and folds quarantined generations back - but
    /// only when something reads. Measured across three launches on
    /// 2026-08-21: every startup list pass lands INSIDE the key-outage
    /// window (the launch gate plus one stall cooldown), and the passes stop
    /// the moment loads start succeeding - so twelve resting-plaintext
    /// conversations waited hours for a human to open the sidebar. This task
    /// closes that gap: wait for the key, run one list pass (listing loads
    /// every conversation), report, exit.
    private var healSweepStarted = false

    func startHealSweepAfterKeyReturns() {
        guard !healSweepStarted else { return }
        healSweepStarted = true
        let persister = self.persister
        Task.detached(priority: .utility) {
            let deadline = Date().addingTimeInterval(30 * 60)
            while Date() < deadline {
                if Task.isCancelled { return }
                if ConversationEncryption.shared.keyAnswers() {
                    let summaries = await persister.listAllConversations()
                    TriosLogBus.shared.info(
                        .chat,
                        "conversation.persist.heal_sweep",
                        "The conversation key answers; one healing pass read "
                            + "\(summaries.count) conversation(s), re-encrypting and "
                            + "recovering whatever the reads found",
                        ["conversations": String(summaries.count)]
                    )
                    return
                }
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
            TriosLogBus.shared.warn(
                .chat,
                "conversation.persist.heal_sweep_gave_up",
                "The conversation key did not answer within 30 minutes of launch; "
                    + "healing will happen at the next successful read instead",
                [:]
            )
        }
    }

    /// Idempotent — `providerKeyWarmupStarted` ensures only one background
    /// task ever runs. Called from the bootstrap at launch (after the keychain
    /// gate lowers) and from the dispatch precheck (when it refuses because
    /// the key is empty), so a refusal brings the next success closer.
    /// Logs only whether the warm-up succeeded, never the key itself.
    private func warmupProviderKey() {
        guard !providerKeyWarmupStarted else { return }
        providerKeyWarmupStarted = true

        let maxAttempts = 10
        // #1240: 65 s — longer than the 60-second global cooldown in
        // KeychainSecrets.  When a read times out, the cooldown refuses every
        // subsequent read for 60 s; at 500 ms spacing all ten attempts were
        // swallowed at once.  65 s guarantees the refusal has expired before
        // the next attempt.
        let retryDelayNanos: UInt64 = 65_000_000_000  // 65s
        let provider = modelStore.selectedProvider

        Task { [weak self, modelStore] in
            guard let self else { return }

            // Wait for the keychain launch gate to lower before the first
            // read. From the bootstrap the gate may still be up; from the
            // precheck it is already down — either way the poll is short.
            // #1240: While the gate is up every keychain operation — including
            // the entry listing that resolvedAPIKey relies on — returns empty,
            // so retries before the gate lowers are wasted.  Log the wait so
            // it is visible in the journal.
            if KeychainSecrets.isLaunching {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.key.warmup",
                    "Provider key warm-up waiting for the keychain launch gate "
                        + "to lower before first attempt — key reads return "
                        + "empty while the gate is up (#1240).",
                    ["provider": provider.rawValue]
                )
            }
            let gateDeadline = Date().addingTimeInterval(10)
            while KeychainSecrets.isLaunching, Date() < gateDeadline {
                try? await Task.sleep(nanoseconds: 200_000_000)
            }

            for attempt in 1...maxAttempts {
                let key = modelStore.resolvedAPIKey(for: provider)
                if !key.isEmpty {
                    TriosLogBus.shared.info(
                        .queen,
                        "queen.key.warmup",
                        "Provider key warm-up succeeded "
                            + "(attempt \(attempt) of \(maxAttempts)).",
                        ["provider": provider.rawValue, "attempt": "\(attempt)"]
                    )
                    // #1225: If the Queen already told the chat the key was
                    // missing, close the loop with one line — silence after a
                    // complaint reads as still broken.
                    if self.providerKeyUnavailableNoticePosted,
                       !self.providerKeyAvailableNoticePosted {
                        self.providerKeyAvailableNoticePosted = true
                        await self.postQueenNotice(
                            SystemNoticeClassifier.successMarker
                                + "The \(provider.rawValue) API key is now "
                                + "available — I can start dispatching tasks again."
                        )
                    }
                    // #1241: A task stays in .queued only when the api-key
                    // precheck in delegateIssueToWorker refused — every other
                    // failure cancels the task and success runs it. Now that the
                    // key is warm, send each held task through the same dispatch
                    // tail the normal path uses: baseline snapshot before the
                    // transition, then transition and runner.start with no await
                    // between them (#1139).
                    let heldTasks = self.delegationRegistry.tasks.filter {
                        $0.state == .queued
                    }
                    for task in heldTasks {
                        guard let runner = self.workerRunner else { break }
                        let baseline = await QueenBranchCommitter
                            .snapshotWorkingTree()
                        let brief = QueenBriefing.text(for: task)
                        guard self.delegationRegistry.transition(
                            taskID: task.id, to: .running
                        ) else { continue }
                        self.workerBaselineTrees[task.conversationId] = baseline
                        self.delegationRegistry.setBaselineTree(
                            taskID: task.id, baselineTree: baseline
                        )
                        runner.start(task: task, brief: brief)
                        TriosLogBus.shared.info(
                            .queen,
                            "queen.worker.dispatched",
                            "Re-dispatched worker for \(task.issue.slug) "
                                + "after key warm-up succeeded",
                            [
                                "issue": task.issue.slug,
                                "worker": task.worker,
                            ]
                        )
                    }
                    if !heldTasks.isEmpty {
                        await self.loadConversations()
                    }
                    return
                }
                if attempt < maxAttempts {
                    // #1240: Log the inter-attempt wait so the journal shows
                    // why the warm-up is pausing — the 60-second keychain
                    // cooldown needs to expire before the next read can reach
                    // the key.
                    TriosLogBus.shared.info(
                        .queen,
                        "queen.key.warmup",
                        "Provider key warm-up attempt \(attempt) of "
                            + "\(maxAttempts) found no key; waiting 65 s "
                            + "before retry so the keychain cooldown can "
                            + "expire (#1240).",
                        ["provider": provider.rawValue, "attempt": "\(attempt)"]
                    )
                    try? await Task.sleep(nanoseconds: retryDelayNanos)
                }
            }

            TriosLogBus.shared.warn(
                .queen,
                "queen.key.warmup",
                "Provider key warm-up failed after \(maxAttempts) attempts; "
                    + "the cache is still empty.",
                ["provider": provider.rawValue]
            )
            // #1225: Post once per session — the journal entry is invisible to
            // someone watching the Queen chat who sees tasks chosen and nothing
            // happening, with no reason given.
            if !self.providerKeyUnavailableNoticePosted {
                self.providerKeyUnavailableNoticePosted = true
                await self.postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "I cannot dispatch tasks: the \(provider.rawValue) "
                        + "API key is missing (the Keychain did not respond "
                        + "after \(maxAttempts) attempts). Add the key in "
                        + "Settings → Models for \(provider.rawValue) and the "
                        + "next task dispatch will proceed normally."
                )
            }
            // Reset so the next precheck refusal can start a fresh warm-up.
            // A success leaves the flag set forever — no extra reads once the
            // key is cached.
            self.providerKeyWarmupStarted = false
        }
    }

    private func configureWorkerRunner() {
        guard let runner = workerRunner else { return }

        // A worker chat opened while its turn is in flight must show the live
        // stream, not the snapshot that happened to be persisted last.
        // The status pills read `runningConversationIds` through this view model,
        // and a worker finishing changes that set without touching anything the
        // views observe. It is @Published, but publishing to nobody: the runner
        // is held as a plain property here and no view subscribes to it. So a
        // bee that stopped kept its green "Working" pill until some unrelated
        // change forced a redraw - the supervisor surface confidently reporting
        // a worker that was not there.
        workerLivenessObservation = runner.$runningConversationIds
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }

        workerObservation = runner.$transcripts
            .receive(on: RunLoop.main)
            .sink { [weak self] transcripts in
                guard let self else { return }
                guard let live = transcripts[self.conversationId] else { return }
                // Never fight the main send path for the same conversation.
                guard self.workerRunner?.isRunning(conversationId: self.conversationId) == true else { return }
                self.messages = live
                self.rebuildCache()
            }

        runner.onModelResolved = { [delegationRegistry] task, provider, model in
            delegationRegistry.recordModel(
                taskID: task.id,
                provider: provider,
                model: model
            )
        }

        // The runner states what it knows as it happens - a turn was opened, a
        // byte arrived, the stream ended this way - and the reaper reads those
        // facts. It used to ask "is a stream running for this conversation
        // right now", and that answer cannot tell a worker that finished a
        // millisecond ago from one that died an hour ago (#1247, #1248).
        runner.onStreamFact = { [delegationRegistry] task, outcome, lastByteAt in
            delegationRegistry.recordStreamFact(
                taskID: task.id,
                outcome: outcome,
                lastByteAt: lastByteAt
            )
        }

        // The observer reads the stream while it is still moving. The review
        // loop is post-mortem by construction; this is the only place a bee can
        // be stopped before it wastes the whole turn.
        runner.onProgress = { [weak self] task, transcript in
            self?.observeWorker(task: task, transcript: transcript)
        }

        runner.onFinish = { [weak self] task, failure, usage in
            guard let self else { return }
            // #1248: Record the completed turn synchronously, before the
            // deferred Task, so the count is visible to reapStalledWorkers
            // and the resume log line immediately.
            delegationRegistry.recordCompletedTurn(taskID: task.id)
            Task { await self.handleWorkerFinished(task: task, failure: failure, usage: usage) }
        }

        // The Queen reports to herself on a timer. Wired here rather than in the
        // composition root so the scheduler never outlives the chat it posts to.
        // The policy asks for weights; the learner supplies them. Installed once
        // here so `QueenDelegationPolicy` stays pure and testable without it.
        QueenDelegationPolicy.learnedWeight = { feature in
            MainActor.assumeIsolated { SalienceLearner.shared.weight(for: feature) }
        }

        let scheduler = QueenReviewScheduler.shared
        scheduler.tasks = { [delegationRegistry] in delegationRegistry.tasks }
        scheduler.report = { [weak self] digest in
            await self?.appendSystemMessageToQueenChat(digest)
        }
        // The wake is also when housekeeping happens: a supervisor that only
        // reports, and never acts on what it sees, is a nicer log.
        scheduler.spentToday = { [delegationRegistry] in delegationRegistry.spentToday() }
        scheduler.beforeReport = { [weak self, delegationRegistry] in
            await self?.reapStalledWorkers()
            await self?.pollPullRequests()
            delegationRegistry.pruneArchive()
        }
        scheduler.start()

        // Orphans from a previous session died with the process, but their
        // edits live on in the shared working tree with no branch to carry
        // them. The registry gathered these at load; settle each one so the
        // work is attributed rather than lost. The registry hands the list
        // over and empties its own copy, so even if a second ChatViewModel
        // is built against the same shared registry the orphans settle once.
        let launchOrphans = delegationRegistry.drainOrphansReconciledAtLaunch()
        if !launchOrphans.isEmpty {
            Task { [weak self] in
                guard let self else { return }
                var remaining = launchOrphans
                var filesSettled = 0
                let taskCount = remaining.count
                while let task = remaining.popLast() {
                    let (_, rescued, _) = await self.settleFailedWorkerEdits(
                        task: task,
                        reason: "did not survive a restart"
                    )
                    filesSettled += rescued
                }
                TriosLogBus.shared.info(
                    .queen,
                    "queen.launch.orphans.settled",
                    "Settled \(taskCount) orphaned task(s) from restart; \(filesSettled) file(s) attributed",
                    ["tasks": "\(taskCount)", "files": "\(filesSettled)"]
                )
            }
        }

        // If nothing is queued or running at launch, the Queen picks the
        // next open sub-issue of #1090 and starts it, so a plain `open
        // trios.app` opens a chat without a human typing /choose (#1197).
        let hasActiveWork = delegationRegistry.tasks.contains {
            $0.state == .queued || $0.state == .running
        }
        if !hasActiveWork {
            Task { [weak self] in
                guard let self else { return }
                // Wait for the keychain launch gate (KeychainSecrets.isLaunching)
                // to lower before reading the timeline and the contract. Firing
                // immediately means the token read comes back empty, the requests
                // hit the 60/hour ceiling, and the task is delegated with no
                // criteria (#1218). Poll the gate directly instead of sleeping a
                // fixed five seconds — the same magic number in two files breaks
                // silently the day one changes.
                let gateDeadline = Date().addingTimeInterval(30)
                while KeychainSecrets.isLaunching, Date() < gateDeadline {
                    try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                }
                TriosLogBus.shared.info(
                    .queen,
                    "queen.launch.bootstrap",
                    "No active tasks at launch — choosing next open issue to start",
                    [:]
                )
                await self.chooseNextOpenIssue(startAfterChoosing: false, isLaunchBootstrap: true)
            }
        }

        // Outside the "no active tasks" branch on purpose. I first put it
        // inside, which skipped the scan exactly when the swarm was busy - and
        // a busy swarm is when work goes missing. The scan is cheap and reads
        // only git, so it runs every launch regardless of what is in flight.
        Task { [weak self] in
            guard let self else { return }
            let gateDeadline = Date().addingTimeInterval(30)
            while KeychainSecrets.isLaunching, Date() < gateDeadline {
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            await self.reconcileRecordAgainstRepository()
        }

        // #1224: Warm the provider key in the background after the keychain
        // gate lowers, so the ModelCredentialStore cache is filled at launch
        // without any request triggering it. Runs regardless of active work.
        warmupProviderKey()

        startQueenAutonomyLoop()

        // Hourly background refresh of the sub-issue store (#1215).  The store
        // is written at launch and on every /choose, but a long-lived app that
        // never chooses grows stale.  This detached repeating task re-reads
        // the #1090 timeline and rewrites the store on success, logging the
        // count or the error.  It does not choose, propose, or delegate — it
        // only refreshes the list.
        Task.detached { [weak self] in
            // Short-lived first run so the effect is observable without
            // waiting an hour, then hourly thereafter.
            var delay: UInt64 = 30_000_000_000
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled, let self else { break }
                delay = 3_600_000_000_000
                let (subIssues, networkOK, failureMessage) =
                    await self.fetchAndStoreSubIssues()
                if networkOK {
                    TriosLogBus.shared.info(
                        .queen,
                        "queen.subissue.refresh",
                        "Background refresh updated store: \(subIssues.count) sub-issue\(subIssues.count == 1 ? "" : "s")",
                        ["epic": QueenEpics.describedList, "count": String(subIssues.count)]
                    )
                } else {
                    TriosLogBus.shared.warn(
                        .queen,
                        "queen.subissue.refresh",
                        "Background refresh failed (\(failureMessage)); store left untouched",
                        ["epic": QueenEpics.describedList, "error": failureMessage]
                    )
                }
            }
        }
    }

    /// Settles a dead worker's edits so the shared tree is not left with
    /// changes nobody owns.
    ///
    /// When a worker fails or is cancelled, its edits are still in the shared
    /// working tree. Without this method they sit there unattributed: the next
    /// worker, the user, or the build inherits them without knowing whose they
    /// are. The method commits what changed to the worker's own branch with an
    /// incompleteness marker, logging each file by name. If the commit cannot
    /// happen (no branch, no baseline), the failure is logged as an error so it
    /// is never silent.
    ///
    /// Returns a human-readable summary for the Queen's notice.
    /// Returns the commit as well, because the failure path always measured it
    /// and always threw it away.
    ///
    /// A bee that commits real work and then dies was recorded as having
    /// produced nothing - #1282 committed 288 lines that way and its record
    /// says `committedFiles: None`. The measurement was right here the whole
    /// time, in `outcome`, discarded by callers that took only the summary.
    private func settleFailedWorkerEdits(
        task: DelegatedTask,
        reason: String
    ) async -> (summary: String, filesRescued: Int, commit: String?) {
        let baselineTree = workerBaselineTrees[task.conversationId] ?? task.baselineTree
        let measured = await QueenBranchCommitter.changedPaths(since: baselineTree, ownedPaths: task.ownedPaths)
        let measuredRelative = measured.map { QueenBranchCommitter.projectRelative($0) }

        // Nothing the worker touched — the tree is clean, nothing to settle.
        if measuredRelative.isEmpty {
            TriosLogBus.shared.info(
                .queen,
                "queen.worker.died.clean",
                "\(task.worker) died but changed no files; the tree is clean",
                ["issue": task.issue.slug, "worker": task.worker, "reason": reason]
            )
            return ("\(task.worker) changed no files before it stopped.", 0, nil)
        }

        guard let branch = task.virtualBranch else {
            // Changes exist but there is nowhere to put them. This is the exact
            // "silent" state the issue forbids: the tree is dirty, no branch
            // carries the edits, and nobody has taken ownership. Log it loudly
            // so the user knows the tree needs manual attention.
            TriosLogBus.shared.error(
                .queen,
                "queen.worker.died.orphaned",
                "\(task.worker) died with edits but no branch to carry them",
                [
                    "issue": task.issue.slug,
                    "worker": task.worker,
                    "reason": reason,
                    "files": measuredRelative.joined(separator: ", ")
                ]
            )
            return ("\(task.worker) left \(measuredRelative.count) file(s) changed "
                + "but has no branch to attribute them to — the tree needs "
                + "manual attention: \(measuredRelative.joined(separator: ", ")).",
                measuredRelative.count, nil)
        }

        // Commit the changes with an incompleteness marker so the partial work
        // is preserved on the branch, clearly marked as unfinished.
        let outcome = await commitWorkerOutput(
            task: task,
            branch: branch,
            baselineTree: baselineTree,
            message: Self.conventionalCommitMessage(task: task, note: "[INCOMPLETE: \(reason)]")
        )

        // Per-file log so the journal says by name what happened to each file.
        TriosLogBus.shared.warn(
            .queen,
            outcome.committed ? "queen.worker.died.attributed" : "queen.worker.died.unsettled",
            "\(task.worker) died; \(outcome.summary)",
            [
                "issue": task.issue.slug,
                "worker": task.worker,
                "reason": reason,
                "files": measuredRelative.joined(separator: ", "),
                "committed": outcome.committed ? "true" : "false"
            ]
        )

        // The count of what LANDED, not of what was measured before the
        // commit: `outcome.fileCount` is the branch's answer and
        // `measuredRelative.count` is the working tree's guess. They differ
        // whenever the boundary dropped something.
        return (
            outcome.summary,
            outcome.committed ? outcome.fileCount : measuredRelative.count,
            outcome.commit
        )
    }

    /// #1219: recognises failure messages that describe connectivity
    /// problems — the worker could not reach the network, not that it
    /// did the work wrong. The wording comes from URLSession /
    /// URLError localised descriptions on macOS: "Could not connect to
    /// the server", "A server with the specified hostname could not be
    /// found."
    private static func isConnectivityFailure(_ message: String) -> Bool {
        let lowercased = message.lowercased()
        return lowercased.contains("could not connect")
            || lowercased.contains("cannot connect")
            || lowercased.contains("unable to connect")
            || lowercased.contains("could not be found")
    }

    private func handleWorkerFinished(
        task: DelegatedTask,
        failure: String?,
        usage: QueenWorkerRunner.WorkerUsage
    ) async {
        let registry = delegationRegistry
        registry.recordUsage(
            taskID: task.id,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            toolCalls: usage.toolCalls
        )

        // #1219: A connectivity failure is outside the worker's control.
        // The task stays in .running so reapStalledWorkers retries it
        // without counting a resume attempt. A genuine failure proceeds
        // through the normal path below — nothing changes for it.
        if let failure, Self.isConnectivityFailure(failure) {
            connectivityFailedTasks.insert(task.id)
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.connectivity_failed",
                "\(task.worker) could not reach the network on \(task.issue.slug); the task stays in place for retry",
                ["issue": task.issue.slug, "worker": task.worker, "failure": failure]
            )
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "\(task.worker) could not reach the network on \(task.issue.slug). "
                    + "The task is left where it is and will be retried when the "
                    + "connection is back — no resume attempt is counted."
            )
            return
        }

        var notice: String
        if let failure {
            notice = "\(task.worker) failed on \(task.issue.slug): \(failure)"
        } else {
            notice = "\(task.worker) finished \(task.issue.slug) and is awaiting your review."
        }

        // Tracks whether the reviewer was asked and how many verdicts it
        // returned, so the transition below can give a silent reviewer an
        // explicit outcome instead of parking the task forever (#1144).
        var reviewerVerdictsRecorded = 0
        var askedReviewer = false
        var askedCriteriaCount = 0

        // ── #1152: snapshot-after-finish guard ──────────────────────────
        //
        // The branch snapshot and commit must not run until the worker's
        // turn has *actually* finished. `onFinish` — which reaches this
        // handler — is called from the runner's `finish()` after it logs
        // `queen.worker.finish` and removes the conversation from its
        // active set. But that ordering is an implementation detail of the
        // runner, not a contract this function enforces. Polling
        // `isRunning` here makes the dependency explicit and load-bearing:
        // the git diff cannot proceed until the runner has confirmed the
        // turn is done and the conversation is no longer active.
        //
        // Without this guard, the snapshot races the worker's last file
        // writes — the git diff fires before the writes are visible on
        // disk, the branch reads empty, and the work is lost (#1152).
        // Removing the guard breaks criterion 4: the branch goes back to
        // reporting empty for files the bee wrote, because nothing waits
        // for the worker's turn to settle.
        //
        // The runner's `finish()` currently removes the conversation from
        // `runningConversationIds` before calling `onFinish`, so the poll
        // is satisfied immediately in practice. The guard exists for the
        // day that ordering changes — and for the test that proves the
        // invariant by keeping the worker "running" until the file write
        // is observable.
        while workerRunner?.isRunning(conversationId: task.conversationId) == true {
            try? await Task.sleep(nanoseconds: 50_000_000)  // 50ms
        }

        // Attribute whatever the worker changed to its own branch. Until this
        // runs, the branch is an empty ref and the edits sit loose in the shared
        // working tree with nothing tying them to the issue.
        if failure == nil, let branch = task.virtualBranch {
            // Ask git what changed before committing, and judge the boundary on
            // that rather than on the names of the tools the worker called.
            // Names cannot see a shell write - filesystem_bash is neither
            // write-named nor path-argumented - so until now a worker could
            // `echo >` its way outside its lane and the only sign was the file
            // quietly not appearing on the branch, because the committer drops
            // what it may not carry. Dropped without a word looks like the work
            // was never done.
            //
            // Here rather than in observeWorker: that runs on every SSE delta,
            // and one git invocation per token costs more than the warning is
            // worth. This is once, when the turn ends.
            let measured = await QueenBranchCommitter.changedPaths(
                since: workerBaselineTrees[task.conversationId],
                ownedPaths: task.ownedPaths
            )
            // An empty transcript on purpose. Anything the tool names could see
            // has already been announced during the turn by observeWorker, and
            // saying it twice at the end reads as two separate problems. What
            // is added here is only what names could not see.
            let strays = QueenObserver.outOfBoundsPaths(
                in: QueenWorkerTranscript(),
                ownedPaths: task.ownedPaths,
                observedWrites: measured.map {
                    QueenBranchCommitter.projectRelative($0)
                }
            )
            if !strays.isEmpty {
                notice += "\n\(task.worker) wrote outside its boundary, so those files "
                    + "will not be on the branch: " + strays.joined(separator: ", ")
                TriosLogBus.shared.error(
                    .queen,
                    "queen.observer.outOfBounds",
                    "A worker wrote outside its boundary",
                    ["issue": task.issue.slug, "paths": strays.joined(separator: ",")]
                )
            }

            // What she can settle on evidence, she settles now. A criterion
            // naming a file is answered by whether that file changed; one
            // naming none is left unchecked, so the gate still stops on the
            // questions a person has to answer and no longer stops on the ones
            // nobody needed to be asked.
            //
            // An empty measurement is silence, not absence (#1132). A repeat
            // run whose file a previous run already wrote changes nothing
            // between the two snapshots, and a bee working in its own
            // worktree never moves the shared tree at all — in both cases
            // `measured` is empty while the criterion's file sits on disk
            // exactly as the task asks. Recording "unmet" from that emptiness
            // is the same false "no" the phantom deletion diff made: a
            // comparison against a base taken after someone else's work,
            // read as this run's failure. It kept #1130 parked on one "unmet"
            // criterion through two worker returns while the file existed the
            // whole time. With nothing measured, the path-naming criteria are
            // left for the reviewer, which reads the files as they are — a
            // missing file still comes back "unmet", from the file itself
            // rather than from an empty diff (#1132 criterion 3).
            let evidenceVerdicts: [String: QueenCriterionVerdict] = measured.isEmpty
                ? [:]
                : QueenAcceptancePolicy.mechanicalVerdicts(
                    criteria: task.acceptanceCriteria,
                    changedPaths: measured.map {
                        QueenBranchCommitter.projectRelative($0)
                    }
                )
            for (criterion, verdict) in evidenceVerdicts {
                registry.recordVerdict(taskID: task.id, criterion: criterion, verdict: verdict)
            }

            // Character-count criteria are settled by counting, not by
            // asking the model (#1151). A criterion whose threshold the
            // code can recognise — "at least three hundred characters" —
            // gets a measured verdict from the file on disk. The count
            // overrides a path-existence verdict because a file with
            // enough characters obviously exists. A criterion whose shape
            // is not recognised stays as it was and still goes to the
            // reviewer.
            let charResults = ChatViewModel.characterCountVerdicts(
                criteria: task.acceptanceCriteria,
                ownedPaths: task.ownedPaths
            )
            for (criterion, result) in charResults {
                registry.recordVerdict(
                    taskID: task.id,
                    criterion: criterion,
                    verdict: result.verdict
                )
                TriosLogBus.shared.info(
                    .queen,
                    "queen.review.characterCount",
                    "Character-count criterion judged by counting (#1151)",
                    [
                        "issue": task.issue.slug,
                        "measured": String(result.measured),
                        "threshold": String(result.threshold)
                    ]
                )
            }

            // Record the boundary-scoped fingerprint at the moment the
            // evidence verdicts are carved (#1131). Only the task's own
            // files are hashed, so the Queen's state writes cannot age a
            // verdict. The fingerprint is written here — at verdict
            // recording time — not at acceptance, because what matters is
            // the state the verdicts were derived against, not the state
            // the decision is made in.
            if !evidenceVerdicts.isEmpty || !charResults.isEmpty {
                await sealVerdictsWithBoundaryState(task)
            }
            if !evidenceVerdicts.isEmpty || !charResults.isEmpty {
                TriosLogBus.shared.info(
                    .queen, "queen.review.evidence", "Judged what the files show",
                    [
                        "issue": task.issue.slug,
                        "judged": String(evidenceVerdicts.count + charResults.count),
                        "of": String(task.acceptanceCriteria.count)
                    ]
                )
            }

            let outcome = await commitWorkerOutput(
                task: task,
                branch: branch,
                baselineTree: workerBaselineTrees[task.conversationId],
                message: Self.conventionalCommitMessage(task: task)
            )
            notice += "\n" + outcome.summary
            registry.recordCommittedFiles(
                taskID: task.id, count: outcome.fileCount, commit: outcome.commit
            )
            TriosLogBus.shared.info(
                .queen,
                outcome.committed ? "queen.branch.committed" : "queen.branch.empty",
                outcome.summary,
                ["issue": task.issue.slug, "branch": branch]
            )

            // Ask a reviewer agent for verdicts on criteria the files alone
            // could not settle. A path check answers "does the file exist";
            // it cannot answer "does the change do what the criterion asks".
            // Without a reviewer those criteria stayed "never checked", which
            // blocked acceptance on the right question but left the user with
            // no answer to it. The reviewer fills the gap; the parser is
            // conservative, so a garbled response still leaves the criterion
            // unchecked rather than guessing it passed.
            let current = registry.task(forIssue: task.issue) ?? task
            let unanswered = current.acceptanceCriteria.filter {
                current.criterionVerdicts[$0] == nil
            }
            if !unanswered.isEmpty {
                askedReviewer = true
                askedCriteriaCount = unanswered.count
                let diffText = await diffForReview(
                    baselineTree: workerBaselineTrees[task.conversationId],
                    branch: branch,
                    ownedPaths: task.ownedPaths
                )
                let touchedFiles = await fileContentsForReview(
                    baselineTree: workerBaselineTrees[task.conversationId],
                    ownedPaths: task.ownedPaths,
                    criteria: unanswered,
                    branch: branch
                )
                reviewerVerdictsRecorded = await requestReviewerVerdicts(
                    for: task,
                    criteria: unanswered,
                    diff: diffText,
                    fileContents: touchedFiles
                )
            }
        } else if failure != nil {
            // A dead worker's edits are still in the shared tree. Settle them
            // so they are attributed to its branch with an incompleteness
            // marker, or reported loudly if they cannot be.
            let (settlement, landed, commit) = await settleFailedWorkerEdits(
                task: task, reason: failure!
            )
            // Recorded on the failure side too. Safe: `qualifiesForAutoAccept`
            // gates on `state == .awaitingReview`, so a failed task cannot be
            // accepted by having a count - it can only stop being described as
            // having produced nothing when it did not.
            if landed > 0 {
                registry.recordCommittedFiles(taskID: task.id, count: landed, commit: commit)
            }
            notice += "\n" + settlement
        }
        workerBaselineTrees[task.conversationId] = nil
        // Transition only after the branch is tallied. Announcing
        // `awaitingReview` first meant the wake could describe a task whose
        // commit had not run yet and report it as having changed nothing.
        //
        // When the worker succeeded but the reviewer returned zero verdicts
        // after retry, the task cannot be verified by an automated gate.
        // The criteria are recorded as "asked but unanswered" in
        // `askedButUnanswered` (#1117), which makes the block reason — and
        // the Queen's chat notice — say "the reviewer gave no answer" rather
        // than "never checked." That distinction is the explicit outcome: the
        // task is in `awaitingReview` not because it is finished and waiting
        // for a rubber stamp, but because every automated avenue has been
        // exhausted and a human decision is the only one left (#1144
        // criterion 2). The task never looks "working" — `.running` is gone,
        // `.awaitingReview` is visible, and the notice names the silence.
        if failure == nil, askedReviewer, reviewerVerdictsRecorded == 0 {
            // Distinguish "no diff" (#1165) from "silent reviewer" (#1144):
            // when the diff was empty, the reviewer had nothing to evaluate,
            // not nothing to say. The notice and log should reflect the actual
            // cause so a reader does not chase a retry that never happened.
            let declinedSet = declinedNoDiff[task.id]
            if let declinedSet, !declinedSet.isEmpty {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.review.no_diff",
                    "Reviewer declined — diff was empty; task left in "
                        + "awaitingReview with criteria marked declined-no-diff",
                    [
                        "issue": task.issue.slug,
                        "asked": String(askedCriteriaCount)
                    ]
                )
                notice += "\n" + SystemNoticeClassifier.warningMarker
                    + "I could not verify \(task.issue.slug): the diff was "
                    + "empty, so the reviewer had nothing to evaluate. The "
                    + "task is awaiting your decision — there was no code "
                    + "change to review."
            } else {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.review.silent_after_retry",
                    "Reviewer returned zero verdicts after retry; task left in "
                        + "awaitingReview with all criteria marked asked-but-unanswered",
                    [
                        "issue": task.issue.slug,
                        "asked": String(askedCriteriaCount)
                    ]
                )
                notice += "\n" + SystemNoticeClassifier.warningMarker
                    + "I could not verify \(task.issue.slug): the reviewer was "
                    + "asked about \(askedCriteriaCount) criterion(s) but returned "
                    + "no answer after a retry. The task is awaiting your decision "
                    + "— every automated check has run its course. The branch and "
                    + "chat survive, but this work is not verified and should not "
                    + "be mistaken for done."
            }
        }
        // A worker can finish AFTER its task was cancelled - measured four
        // times on 2026-08-21, each an operator cancel racing the dying
        // worker's finish handler, which then asked for cancelled -> failed
        // and the registry refused with a "Cannot move" line plus an
        // "Auto-accept skipped: state is cancelled" echo. The refusals were
        // correct; asking was the defect. Measure the state first: a settled
        // task takes no verdict from a worker that outlived it, and the
        // housekeeping below still runs.
        // By conversation, not by issue: an issue can hold several records
        // (a cancelled one and the fresh delegation that replaced it), and
        // task(forIssue:) would answer for the newest. The conversation is
        // one-to-one with THIS record.
        if registry.task(forConversation: task.conversationId)?.state == .cancelled {
            TriosLogBus.shared.info(
                .queen,
                "queen.worker.finished_after_cancel",
                "Worker for \(task.issue.slug) finished after its task was "
                    + "cancelled; nothing is recorded from this turn",
                ["issue": task.issue.slug]
            )
            await sweepAwaitingReview(excluding: task.id, trigger: task.issue.slug)
            await reapStalledWorkers()
            await loadConversations()
            return
        }
        let moved = registry.transition(
            taskID: task.id, to: failure == nil ? .awaitingReview : .failed
        )
        // Classify immediately after the move, while the measurements this
        // task was judged on are still the ones in the store. Deferring it to
        // read time would classify against whatever the record looked like
        // later, which is a different question.
        //
        // Only when the move actually happened. A cancelled task refuses the
        // transition to `failed` - correctly - and writing a failure kind onto
        // it anyway would make a task nobody failed at look like one that did,
        // to the very policy that counts failures. Seen in the suite:
        // "Cannot move #4243 from cancelled to failed" immediately followed by
        // "#4243 failed as producedNothing".
        if failure != nil, moved {
            registry.recordFailureKind(taskID: task.id)
        }
        // The notice belongs in the Queen's chat even when she is not the open
        // conversation, otherwise a result reported while the user is reading a
        // worker chat is lost.
        await appendSystemMessageToQueenChat(notice)
        await autoAcceptIfUnambiguous(taskID: task.id)
        await actOnCompletedReview(taskID: task.id)

        await sweepAwaitingReview(excluding: task.id, trigger: task.issue.slug)

        // When a worker finishes, immediately check for orphans left behind by
        // a concurrent delegation that was transitioned to .running but never
        // dispatched. Without this, the orphan waits up to 30 minutes for the
        // scheduler's next sweep (#1139).
        await reapStalledWorkers()
        await loadConversations()
    }

    // MARK: - Reviewer Agent

    /// The diff of what the worker changed, limited to its owned paths.
    ///
    /// Compares the baseline tree against the **branch tip**, not the shared
    /// working tree. The working tree is edited by every worker in the swarm,
    /// so `git diff <baselineTree>` (tree against working tree) picks up changes
    /// nobody on this branch made — and when those changes include files the
    /// baseline captured after another worker's work, the diff shows them as
    /// deletions, presenting a file the worker created as one it removed (#1132).
    ///
    /// The branch tip carries only this worker's committed changes, so the diff
    /// is exactly what landed on the branch. The direction `git diff A B` reads
    /// A→B: a file the worker added appears as a new file, never as a deleted
    /// one (#1132 criterion 2).
    ///
    /// An empty branch is not diffed at all. "Empty" means the branch tip is
    /// its own merge-base with HEAD — no commits of its own, the same test
    /// `QueenBranchCommitter.branchPoint` applies to refuse a pull request.
    /// The baseline is a snapshot of the whole working tree taken when the
    /// worker started, and it can contain work that is not on this branch: a
    /// repeat run of an issue whose file a previous run already wrote has that
    /// file in the baseline but not at the fork point, and diffing the two
    /// reads it as deleted — a deletion nobody performed (#1130's repeat
    /// answered "unmet" twice on exactly that phantom). The empty branch
    /// returns a parenthetical "nothing to compare" instead, and the reviewer
    /// judges the criteria from the file contents the brief already carries
    /// (#1132 criterion 1).
    ///
    /// Returns a parenthetical "nothing to compare" message when the baseline
    /// was never captured, the branch cannot be resolved, or the branch has
    /// no commits of its own, so the reviewer is never handed a blank diff
    /// with no explanation — and never a deletion phantom (#1132).
    private func diffForReview(
        baselineTree: String?,
        branch: String?,
        ownedPaths: [String]
    ) async -> String {
        // No baseline means the snapshot was never taken, so there is nothing
        // to diff against. Returning "" left the reviewer with a blank brief
        // and no reason — indistinguishable from "the diff was lost" (#1132).
        guard let baselineTree else {
            return "(No baseline snapshot — nothing to compare.)"
        }
        // The branch carries the worker's committed work. Without it there is
        // no committed state to compare the baseline against.
        guard let branch else {
            return "(No branch to review — nothing to compare.)"
        }
        return await Task.detached(priority: .utility) {
            // Resolve the branch tip's tree object. `git diff A B` compares
            // two snapshots; using the branch tip instead of the working tree
            // means the diff reflects only what this worker committed — never
            // what another bee wrote or cleaned in the shared tree (#1132).
            let branchRef = "refs/heads/\(branch)"
            let branchTree = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["rev-parse", "\(branchRef)^{tree}"],
                workDir: ProjectPaths.root,
                timeout: 10
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !branchTree.isEmpty,
                  !branchTree.hasPrefix("fatal") else {
                return "(Branch \(branch) could not be resolved — nothing to compare.)"
            }
            // Is the branch empty — no commits of its own? The tip is compared
            // with its merge-base against HEAD, the same test branchPoint
            // applies to decide there is nothing to open a pull request for.
            // Both git answers must resolve; a merge-base that fails falls
            // through to the diff rather than guessing emptiness.
            let tip = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["rev-parse", "--verify", branchRef],
                workDir: ProjectPaths.root,
                timeout: 10
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            let fork = QueenStatusViewModel.runProcess(
                "/usr/bin/git",
                arguments: ["merge-base", branchRef, "HEAD"],
                workDir: ProjectPaths.root,
                timeout: 10
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            let branchCarriesNoCommits =
                !tip.isEmpty && !tip.hasPrefix("fatal")
                && !fork.isEmpty && !fork.hasPrefix("fatal")
                && tip == fork
            // An empty branch is not diffed at all (#1132 criterion 1). The
            // baseline is a snapshot of the whole working tree taken when the
            // worker started, so it can hold files a previous run wrote that
            // the fork point never saw; diffing the two reads those files as
            // deletions nobody performed — the phantom that made a repeat
            // review of #1130 answer "unmet" on a file that exists. Said
            // plainly, twice: to the journal here, and to the reviewer in the
            // returned string, which points the verdicts at the file
            // contents the brief already carries.
            if branchCarriesNoCommits {
                // The check, run live on every empty branch rather than held
                // in reserve (#1132 criterion 4). The comparison the old code
                // made — the post-work baseline against this empty branch,
                // scoped to the owned paths exactly as the reviewer's diff
                // would have been — is produced here so the guard's condition
                // is evaluated against a real diff, not only in the world
                // where someone deletes the early return below. When the
                // baseline holds a boundary file the fork point never saw,
                // that diff shows the file as deleted: the phantom that made
                // a repeat review of #1130 answer "unmet" on a file that
                // exists. The check fires — named, in the journal — and the
                // phantom is still withheld: firing is the point, handing it
                // to the reviewer never is. Restoring the old comparison as
                // the reviewer's diff breaks exactly here, loudly.
                let withheld = Self.reviewDiff(
                    baselineTree: baselineTree,
                    branchTree: branchTree,
                    ownedPaths: ownedPaths
                )
                if withheld.contains("deleted file mode") {
                    let header = withheld.components(separatedBy: "\n")
                        .first { $0.contains("deleted file mode") } ?? ""
                    TriosLogBus.shared.warn(
                        .queen,
                        "queen.assertion.empty_branch_deletions",
                        "The comparison the old code made — the post-work "
                            + "baseline against the empty branch \(branch) — "
                            + "shows deletions nobody made: \(header). The "
                            + "check fires; the reviewer still gets nothing "
                            + "to compare (#1132)",
                        ["branch": branch, "deleted_header": header]
                    )
                }
                TriosLogBus.shared.info(
                    .queen,
                    "queen.diff.unavailable",
                    "Branch \(branch) has no commits of its own; there is "
                        + "nothing to compare",
                    ["branch": branch]
                )
                return "(Branch \(branch) has no commits of its own — nothing "
                    + "to compare. This run changed nothing on the branch; "
                    + "judge the criteria from the files as they are now.)"
            }
            // Direction: baseline → branch tip. Files the worker added appear
            // as new (all +), files removed as deleted (all -). Reversing the
            // arguments would invert the reading: a created file would read
            // as deleted (#1132 criterion 2). The order itself lives in
            // `reviewDiff` — one definition — and the #1132 drill drives it
            // from both sides on real history, so the direction is a checked
            // fact rather than a comment.
            let diff = Self.reviewDiff(
                baselineTree: baselineTree,
                branchTree: branchTree,
                ownedPaths: ownedPaths
            )
            // Regression guard (#1132 criterion 4): an empty branch must never
            // be handed a diff, because the only diff an empty branch can
            // produce against a baseline captured after someone else's work
            // is deletions nobody made. This fires if the early return above
            // is removed — that is the sense in which the check breaks when
            // the comparison with a post-work base is restored. It cannot
            // fire on a genuine deletion: a branch that really removed a file
            // carries commits, so branchCarriesNoCommits is false here.
            //
            // The check does not stop at observing. A guard that logs the
            // phantom and then hands it over anyway fired at runtime on
            // 2026-08-19 (queen/9932) "without a single consequence": the
            // reviewer still received the deletions and answered from them.
            // So here the phantom is withheld — the reviewer gets the same
            // honest message the early return gives, and removing the early
            // return breaks this check loudly AND fails safe.
            if branchCarriesNoCommits && diff.contains("deleted file mode") {
                let header = diff.components(separatedBy: "\n")
                    .first { $0.contains("deleted file mode") } ?? ""
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.assertion.empty_branch_deletions",
                    "An empty branch was diffed against its baseline and the "
                        + "result carries deletions nobody made: \(header). "
                        + "The baseline was captured after another worker's "
                        + "work, so the comparison reads that work as removed "
                        + "(#1132)",
                    ["branch": branch, "deleted_header": header]
                )
                return "(Branch \(branch) has no commits of its own — nothing "
                    + "to compare. This run changed nothing on the branch; "
                    + "judge the criteria from the files as they are now.)"
            }
            // What the reviewer was handed, in the journal rather than only
            // in the reviewer's paraphrase of it (#1132 criterion 2): the
            // file headers of the diff, which say "new file mode" for a file
            // the worker created and "deleted file mode" for one removed.
            // The direction of the comparison is visible here first-hand.
            let headers = diff.components(separatedBy: "\n")
                .filter {
                    $0.hasPrefix("diff --git")
                        || $0.hasPrefix("new file mode")
                        || $0.hasPrefix("deleted file mode")
                        || $0.hasPrefix("rename ")
                }
                .joined(separator: " | ")
            if !headers.isEmpty {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.review.diff_summary",
                    "Reviewer diff for \(branch): \(headers)",
                    ["branch": branch, "headers": headers]
                )
            }
            return diff
        }.value
    }

    /// The reviewer's comparison, as one definition consumed by every caller
    /// (#1132).
    ///
    /// `diffForReview` builds the reviewer's diff with it, the empty-branch
    /// probe builds the withheld comparison with it, and the #1132 drill
    /// drives it from both directions on real repository history. The
    /// argument order lives here and nowhere else: **baseline first, branch
    /// tip second**, so a file the worker added reads `new file mode` —
    /// reversing the two reads the same creation as a deletion. Before this
    /// the order was written twice and proved only by a comment; the drill's
    /// direction arm makes it a checked fact
    /// (`queen.drill.review_diff_direction.*` in the journal).
    nonisolated private static func reviewDiff(
        baselineTree: String,
        branchTree: String,
        ownedPaths: [String]
    ) -> String {
        var args = ["diff", baselineTree, branchTree]
        if !ownedPaths.isEmpty {
            args.append("--")
            args.append(contentsOf: ownedPaths.map {
                QueenDelegationPolicy.normalizePath($0)
            })
        }
        return QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: args,
            workDir: ProjectPaths.root,
            timeout: 30
        )
    }

    // MARK: - #1132 drill

    /// Drives the #1132 check from the failing side (#1132 criterion 4).
    ///
    /// The defect: a repeat run's branch is empty — no commits of its own —
    /// while the baseline, snapshotted when the worker started, already
    /// holds a file a previous run wrote. Diffing the two reads that file as
    /// deleted, and the reviewer answered "unmet" twice on a file that
    /// exists (#1130's repeat). The fix refuses to diff an empty branch at
    /// all. A guard proving that refusal had never fired once, and an
    /// unproven guard is a claim — so this drill restores the comparison on
    /// real repository history, where every ingredient is genuine:
    ///
    /// 1. **The phantom reproduces.** It takes the most recent commit that
    ///    added a source file, stands "an empty branch" on the state before
    ///    that commit, and uses HEAD's tree as the base *taken after
    ///    someone else's work* — exactly what a dispatch-time snapshot is
    ///    when earlier runs have landed since the fork. The old comparison,
    ///    `git diff <post-work base> <empty branch tree>` scoped to that
    ///    file, must show `deleted file mode`. If it does not, the drill is
    ///    broken and says so; it does not pass by failing quietly.
    ///
    /// 2. **The check fires.** The same condition the live probe inside
    ///    `diffForReview` evaluates — an empty branch whose old comparison
    ///    carries deletions — fires `queen.assertion.empty_branch_deletions`
    ///    here, on the record, with the phantom's header named.
    ///
    /// 3. **The shipped path holds.** A real empty branch among `queen/*`
    ///    (tip equal to its merge-base with HEAD — the same test
    ///    `diffForReview` applies) is handed to `diffForReview` with the
    ///    post-work base. It must answer "no commits of its own — nothing to
    ///    compare" and must not contain a deletions diff. The live probe
    ///    inside fires too when that branch's fork predates the file's
    ///    arrival; the verdict records whether it did.
    ///
    /// 4. **Direction: a creation reads as a creation.** The commit the
    ///    phantom arm stands on is a real creation, so standing on its
    ///    parent as the base and the commit as the branch is exactly a
    ///    worker's creation. `reviewDiff` in the shipped order must read
    ///    `new file mode`; the same call with the arguments reversed must
    ///    read `deleted file mode`. Both facts land in one journal event
    ///    (`queen.drill.review_diff_direction.passed`), so the direction is
    ///    observed on real history, not asserted by comment (#1132
    ///    criterion 2). Swapping the two arguments inside `reviewDiff`
    ///    makes this arm fail — see the Run record.
    ///
    /// Everything the drill does to git is read-only: rev-parse, merge-base,
    /// diff, for-each-ref. No branch is created, moved, or deleted. Gated
    /// behind `TRIOS_E2E_DRILL_1132` (see the init task) so a normal launch
    /// never pays for it.
    ///
    /// **Run record** — test variant, journal
    /// `.trinity-test/logs/trios-app.jsonl`, each mutation physically
    /// applied to the source, rebuilt, run, reverted, and the revert
    /// checksum-verified before the next step (#1132 criteria 2 and 4):
    ///
    /// - 2026-08-19T22:33:26Z `empty_branch_deletion.passed` (live probe
    ///   fired) — first green of the empty-branch arms.
    /// - 2026-08-19T22:36:57Z live review, not the drill: the repeat review
    ///   of #1130 on an empty branch answered **met × 3** from the file
    ///   contents, and the reviewer's own text cites the "nothing to
    ///   compare" message — the empty branch produced no deletions diff for
    ///   a real reviewer to misread.
    /// - 2026-08-19T22:40:24Z `empty_branch_deletion.failed` **by design**:
    ///   the old comparison (a base taken after someone else's work) was
    ///   physically restored by forcing `branchCarriesNoCommits` false;
    ///   rebuilt and run, the drill went red naming the phantom
    ///   (`refused=false, carries deletions=true — deleted file mode 100644`)
    ///   — the check breaks when the comparison is restored (criterion 4).
    /// - 2026-08-19T22:41:50Z `empty_branch_deletion.passed` again on the
    ///   restored, checksum-verified tree.
    /// - 2026-08-19T23:01:27Z `review_diff_direction.passed` and
    ///   `empty_branch_deletion.passed` in one run — the direction arm's
    ///   first green: a real creation reads `new file mode` shipped and
    ///   `deleted file mode` reversed (criterion 2).
    /// - 2026-08-19T23:05:27Z `empty_branch_deletion.failed` **by design**:
    ///   the base-restoration mutation re-applied on the tree that carries
    ///   the direction arm; red again, `refused=false`, the phantom handed
    ///   over — while the direction arm still passed, so each mutation
    ///   isolates its own arm.
    /// - 2026-08-19T23:07:53Z `review_diff_direction.failed` **by design**:
    ///   the two arguments inside `reviewDiff` were physically swapped,
    ///   rebuilt, run — a real creation then read `deleted file mode` and the
    ///   arm failed by name (`shipped reads creation = false`). The check
    ///   breaks when the direction is inverted (criterion 2's breaking side,
    ///   and the companion of criterion 4's).
    /// - 2026-08-19T23:09:27Z final green on the restored,
    ///   checksum-verified tree: `review_diff_direction.passed` and
    ///   `empty_branch_deletion.passed` in one run, with this Run record in
    ///   place.
    /// - 2026-08-19T23:16:46Z green again on the same tree, re-run for the
    ///   third pass: `review_diff_direction.passed` then
    ///   `empty_branch_deletion.passed`. The literal outputs the direction
    ///   arm compared, quoted verbatim so the claim can be checked against
    ///   git without the journal (trees: parent `d4dffa17…` of commit
    ///   `7e3e7c09`, commit tree `881586fa…`):
    ///   shipped order (`git diff d4dffa17 881586fa -- <file>`):
    ///   `new file mode 100644`, `index 000000000..cdc114fda` — a creation
    ///   reads as created.
    ///   reversed order (`git diff 881586fa d4dffa17 -- <file>`):
    ///   `deleted file mode 100644`, `index cdc114fda..000000000` — the same
    ///   creation reads as deleted. The shipped `reviewDiff` is the first of
    ///   these two, and only the first.
    /// - After each mutation the file was restored to the byte-identical
    ///   pre-mutation state (SHA-256 compared against the pre-run backup);
    ///   the final green run above is on the checksum-verified tree.
    private func runEmptyBranchDeletionDrill() async {
        // The scenario, resolved against the real repository. A tuple of
        // Sendable values so it can cross out of the detached task.
        typealias Scenario = (
            file: String,               // a file someone else's work added
            addedBy: String,            // the commit that added it
            postWorkBase: String,       // HEAD's tree: the base taken after
            emptyBranch: String,        // a real queen/* branch, tip == fork
            phantomHeader: String,      // the phantom's own header line
            liveProbeFires: Bool        // would the in-function probe fire?
        )
        let scenario: Scenario? = await Task.detached(priority: .utility) { () -> Scenario? in
            // The drill's git runs from the REPOSITORY root, unlike
            // diffForReview's project root: the paths `git log --name-only`
            // yields are repository-relative, and a pathspec is interpreted
            // relative to the working directory — `trios/docs/x.md` from
            // inside `trios/` matches nothing, and the phantom quietly
            // fails to reproduce. The frame a path arrives in and the frame
            // it is spent in must agree (#1132).
            let repoRoot = QueenBranchCommitter.repositoryRoot()
            func git(_ args: [String], timeout: TimeInterval = 15) -> String {
                QueenStatusViewModel.runProcess(
                    "/usr/bin/git", arguments: args, workDir: repoRoot, timeout: timeout
                ).trimmingCharacters(in: .whitespacesAndNewlines)
            }

            // ── 1. The phantom reproduces ────────────────────────────────
            //
            // The newest commit that added a file which still exists at
            // HEAD. Dot-paths (.trinity*, .worktrees, state churn) and tmp/
            // are not work; the drill stands on a real source file so the
            // "deletion" it is about to show is undeniable.
            let logOutput = git(
                ["log", "--diff-filter=A", "-n", "40", "--format=%H", "--name-only", "HEAD"],
                timeout: 30
            )
            var currentSHA = ""
            var candidate: (sha: String, file: String)?
            outer: for rawLine in logOutput.components(separatedBy: "\n") {
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                if line.isEmpty { continue }
                if line.count == 40, line.allSatisfy({ $0.isHexDigit }) {
                    currentSHA = line
                    continue
                }
                guard !currentSHA.isEmpty else { continue }
                guard !line.hasPrefix("."), !line.hasPrefix("tmp/") else { continue }
                // The file must still exist at HEAD: if the comparison is
                // to show it "deleted", the deletion can only come from the
                // comparison, not from a file that is genuinely gone.
                let exists = git(["rev-parse", "HEAD:\(line)"])
                guard !exists.isEmpty, !exists.hasPrefix("fatal") else { continue }
                // An empty branch needs somewhere to stand: the commit's
                // parent. A root commit has none; keep looking.
                let parent = git(["rev-parse", "\(currentSHA)^"])
                guard !parent.isEmpty, !parent.hasPrefix("fatal") else { continue }
                candidate = (currentSHA, line)
                break outer
            }
            guard let found = candidate else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.drill.empty_branch_deletion.failed",
                    "Could not find a recent commit that added a surviving "
                        + "source file — the drill has nothing to stand on "
                        + "and refuses to pass (#1132)",
                    ["log_head": String(logOutput.prefix(120))]
                )
                return nil
            }
            // The tree an empty branch cut BEFORE that work would carry:
            // the parent's tree, not the commit's own (which already holds
            // the file — diffing HEAD against it shows nothing, and the
            // first drill run failed on exactly that mistake, loudly, as
            // designed).
            let parent = git(["rev-parse", "\(found.sha)^"])
            let parentTree = git(["rev-parse", "\(parent)^{tree}"])
            let postWorkBase = git(["rev-parse", "HEAD^{tree}"])
            guard !parentTree.isEmpty, !parentTree.hasPrefix("fatal"),
                  !postWorkBase.isEmpty, !postWorkBase.hasPrefix("fatal") else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.drill.empty_branch_deletion.failed",
                    "Could not resolve the trees the drill compares "
                        + "(parent \(parentTree.prefix(12)), base \(postWorkBase.prefix(12))) (#1132)",
                    ["file": found.file]
                )
                return nil
            }
            // The old comparison itself: post-work base → empty branch,
            // scoped to the owned file, exactly as the reviewer's diff was.
            let oldComparison = git(
                ["diff", "--no-color", postWorkBase, parentTree, "--", found.file],
                timeout: 30
            )
            guard let phantomHeader = oldComparison.components(separatedBy: "\n")
                .first(where: { $0.contains("deleted file mode") }) else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.drill.empty_branch_deletion.failed",
                    "The restored comparison did not show the phantom: "
                        + "\(found.file) at HEAD vs an empty branch before "
                        + "its arrival produced no 'deleted file mode'. The "
                        + "drill is broken, not green (#1132)",
                    ["file": found.file, "diff_head": String(oldComparison.prefix(160))]
                )
                return nil
            }
            TriosLogBus.shared.info(
                .queen,
                "queen.drill.empty_branch_deletion.started",
                "Standing on \(found.file), added by \(found.sha.prefix(8)) "
                    + "— an empty branch at its parent against HEAD's tree, "
                    + "a base taken after someone else's work (#1132)",
                ["file": found.file, "added_by": String(found.sha.prefix(8))]
            )

            // ── Direction: a creation must read as a creation ────────────
            //
            // The same repository supplies a real one: found.sha added
            // found.file, so standing on its parent as the base and the
            // commit itself as the branch is exactly a worker's creation.
            // The shipped order (`reviewDiff`: baseline first, tip second)
            // must read `new file mode` and no `deleted file mode`; the
            // reversed order must read `deleted file mode`. Both results go
            // into one journal event with both facts, so the direction is
            // observed on a real creation rather than asserted by comment
            // (#1132 criterion 2). Physically swapping the two arguments
            // inside `reviewDiff` makes this arm fail — that run is cited in
            // the drill's doc comment (Run record).
            let commitTree = git(["rev-parse", "\(found.sha)^{tree}"])
            let directionFile = QueenBranchCommitter.projectRelative(found.file)
            let shippedOrder = Self.reviewDiff(
                baselineTree: parentTree,
                branchTree: commitTree,
                ownedPaths: [directionFile]
            )
            let reversedOrder = Self.reviewDiff(
                baselineTree: commitTree,
                branchTree: parentTree,
                ownedPaths: [directionFile]
            )
            let shippedReadsCreation = shippedOrder.contains("new file mode")
                && !shippedOrder.contains("deleted file mode")
            let reversedReadsDeletion = reversedOrder.contains("deleted file mode")
            guard shippedReadsCreation, reversedReadsDeletion else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.drill.review_diff_direction.failed",
                    "The shipped comparison order does not read a creation "
                        + "as a creation: shipped reads creation = "
                        + "\(shippedReadsCreation), reversed reads deletion = "
                        + "\(reversedReadsDeletion). Shipped diff head: "
                        + "\(shippedOrder.prefix(120)) (#1132 criterion 2)",
                    [
                        "file": found.file,
                        "shipped_reads_creation": shippedReadsCreation ? "true" : "false",
                        "reversed_reads_deletion": reversedReadsDeletion ? "true" : "false",
                    ]
                )
                return nil
            }
            TriosLogBus.shared.info(
                .queen,
                "queen.drill.review_diff_direction.passed",
                "A real creation (\(found.file), added by "
                    + "\(found.sha.prefix(8))) reads as a creation in the "
                    + "shipped order — `new file mode` — and as a deletion "
                    + "only when the order is reversed (#1132 criterion 2)",
                [
                    "file": found.file,
                    "shipped": "new file mode",
                    "reversed": "deleted file mode",
                ]
            )

            // ── 2. The check fires ───────────────────────────────────────
            //
            // The same condition the live probe evaluates, driven here on
            // the restored comparison so the event exists on the record
            // even before any real empty-branch review meets a phantom.
            TriosLogBus.shared.warn(
                .queen,
                "queen.assertion.empty_branch_deletions",
                "drill: the comparison with a post-work base restored — "
                    + "an empty branch diffed against work that landed after "
                    + "its fork — shows deletions nobody made: "
                    + "\(phantomHeader) (#1132)",
                [
                    "drill": "1132",
                    "file": found.file,
                    "deleted_header": phantomHeader
                ]
            )

            // ── 3. A real empty branch for the shipped path ──────────────
            //
            // Prefer one whose fork predates the file's arrival, so the
            // live probe inside diffForReview fires on this very call; take
            // any empty branch if none qualifies. fork predates the add
            // exactly when merge-base(fork, add) == fork.
            let refs = git(["for-each-ref", "refs/heads/queen", "--format=%(refname:short)"])
                .components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            var emptyBranch = ""
            var liveProbeFires = false
            for ref in refs {
                let tip = git(["rev-parse", "--verify", ref])
                guard !tip.isEmpty, !tip.hasPrefix("fatal") else { continue }
                let fork = git(["merge-base", ref, "HEAD"])
                guard !fork.isEmpty, !fork.hasPrefix("fatal"), tip == fork else { continue }
                let qualifies = git(["merge-base", fork, found.sha]) == fork
                let tipTree = git(["rev-parse", "\(ref)^{tree}"])
                let wouldFire = git(
                    ["diff", "--no-color", postWorkBase, tipTree, "--", found.file],
                    timeout: 30
                ).contains("deleted file mode")
                if wouldFire && qualifies {
                    emptyBranch = ref
                    liveProbeFires = true
                    break
                }
                if emptyBranch.isEmpty {
                    emptyBranch = ref
                    liveProbeFires = wouldFire
                }
            }
            guard !emptyBranch.isEmpty else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.drill.empty_branch_deletion.failed",
                    "No empty queen/* branch exists to exercise the shipped "
                        + "path with — the drill refuses to pass without one "
                        + "(#1132)",
                    [:]
                )
                return nil
            }
            return (found.file, found.sha, postWorkBase, emptyBranch, phantomHeader, liveProbeFires)
        }.value
        guard let scenario else { return }

        // The shipped path, on the same kind of pair: a base taken after
        // someone else's work, a branch with no commits of its own, the
        // drill's file as the owned path — in the project-relative frame
        // diffForReview expects for owned paths.
        let shipped = await diffForReview(
            baselineTree: scenario.postWorkBase,
            branch: scenario.emptyBranch,
            ownedPaths: [QueenBranchCommitter.projectRelative(scenario.file)]
        )
        let refused = shipped.contains("no commits of its own")
        let clean = !shipped.contains("deleted file mode")
        if refused && clean {
            TriosLogBus.shared.info(
                .queen,
                "queen.drill.empty_branch_deletion.passed",
                "The check fired on the restored comparison and the shipped "
                    + "path refused the empty branch \(scenario.emptyBranch): "
                    + "\(shipped.prefix(120)) (#1132)",
                [
                    "file": scenario.file,
                    "branch": scenario.emptyBranch,
                    "live_probe_fired": scenario.liveProbeFires ? "true" : "false",
                    "deleted_header": scenario.phantomHeader
                ]
            )
        } else {
            TriosLogBus.shared.error(
                .queen,
                "queen.drill.empty_branch_deletion.failed",
                "The shipped path did not refuse the empty branch "
                    + "\(scenario.emptyBranch): refused=\(refused), "
                    + "carries deletions=\(!clean) — \(shipped.prefix(160)) (#1132)",
                ["file": scenario.file, "branch": scenario.emptyBranch]
            )
        }
    }

    /// The full contents of files the reviewer needs, read from the working
    /// tree after the commit.
    ///
    /// Two sets of files are carried into the brief:
    ///
    /// 1. **Boundary files** (`ownedPaths`) — the files the worker was allowed
    ///    to edit. The diff answers "what changed"; the file contents answer
    ///    "what the file looks like now". A criterion may ask about code that
    ///    the change did not touch but that lives in a file the task owns.
    ///
    /// 2. **Criterion-mentioned files** — paths extracted from the acceptance
    ///    criteria text by `QueenAcceptancePolicy.pathsMentioned`. Criteria
    ///    often name files outside the boundary: the boundary says where the
    ///    worker may edit, not where the reviewer needs to look. A criterion
    ///    that asks "BR-OUTPUT/Foo.swift has property X" is unanswerable when
    ///    the brief carries only the boundary files.
    ///
    /// A file named in a criterion that does not exist on the working tree is
    /// included with an explicit "(file not found)" marker rather than silently
    /// dropped. The reviewer needs to know the file was expected and is absent,
    /// not wonder whether the path was overlooked.
    ///
    /// Volume is bounded: instead of sending the first N lines of a large
    /// file, each file is narrowed to the regions around names the criteria
    /// mention — declarations and usages of those names with a margin of
    /// context above and below (`regionExtractedContent`). When no criteria
    /// names appear in a file, the excerpt says so explicitly rather than
    /// substituting the file's opening lines, so the reviewer sees the gap
    /// instead of a plausible-looking excerpt (#1124). A total file-count
    /// cap (`maxFiles`) prevents a criterion that names many paths from
    /// drowning the diff and the criteria under code. The region selection
    /// header names how many lines were chosen from how many and which
    /// names drove the selection.
    ///
    /// **Which copy of a file** the reviewer gets: when `branch` carries
    /// commits of its own, owned-path contents are read from the branch tip —
    /// the tree the diff describes, the tree a pull request would carry. The
    /// shared working tree can lag the branch by whole runs, and a brief
    /// whose diff says one thing while its "full contents" show another is
    /// unanswerable — the reviewer must refuse, and did (#1130's repeat,
    /// 2026-08-19: "could not check", sources contradict). An empty branch
    /// carries nothing of its own, so there the working tree remains the
    /// source, matching the "judge the files as they are now" the empty-
    /// branch diff message says. A file the branch *removed* (it is in the
    /// baseline, not on the branch) is said to be deleted rather than shown
    /// from the working tree — the disagreement runs both directions
    /// (#1132 criteria 2 and 3).
    private func fileContentsForReview(
        baselineTree: String?,
        ownedPaths: [String],
        criteria: [String] = [],
        branch: String? = nil
    ) async -> [String: String] {
        return await Task.detached(priority: .utility) {
            // Criterion and boundary paths are project-relative (`rings/SR-02/…`,
            // `BR-OUTPUT/…`), but `repositoryRoot()` returns the git toplevel,
            // which for this project is the BrowserOS checkout one level up.
            // Resolving from the project root means the files are actually found;
            // resolving from the git root left every criterion-named file missing
            // and the reviewer with nothing to read.
            let projectRoot = ProjectPaths.root
            var result: [String: String] = [:]
            let maxFiles = 20

            // Whose copy of the file is the reviewer to read? (#1132
            // criterion 3). When the branch carries the worker's commits, the
            // work under review IS the branch — the pull request would carry
            // it, and the diff above describes it. The shared working tree is
            // moved by every worker in the swarm and can lag the branch by
            // whole runs: #1130's repeat review was handed a diff that rewrote
            // the note alongside "full contents" of the note's *previous*
            // version, and the reviewer rightly refused to pick between two
            // sources that disagreed — "could not check", 0 verdicts of 1
            // (2026-08-19 17:28Z, glm-5.2). The contents must come from the
            // same tree the diff reads. An empty branch carries nothing of
            // its own, so there the working tree stays the world — "the files
            // as they are now" — which is what the empty-branch message in
            // `diffForReview` already promises.
            var branchTipSHA: String?
            if let branch {
                let tip = QueenStatusViewModel.runProcess(
                    "/usr/bin/git",
                    arguments: ["rev-parse", "--verify", "refs/heads/\(branch)"],
                    workDir: ProjectPaths.root,
                    timeout: 10
                ).trimmingCharacters(in: .whitespacesAndNewlines)
                let fork = QueenStatusViewModel.runProcess(
                    "/usr/bin/git",
                    arguments: ["merge-base", "refs/heads/\(branch)", "HEAD"],
                    workDir: ProjectPaths.root,
                    timeout: 10
                ).trimmingCharacters(in: .whitespacesAndNewlines)
                let carriesWork =
                    !tip.isEmpty && !tip.hasPrefix("fatal")
                    && !fork.isEmpty && !fork.hasPrefix("fatal")
                    && tip != fork
                branchTipSHA = carriesWork ? tip : nil
            }
            var servedFromBranch: [String] = []

            // --- Boundary files (owned paths) ---
            // A worker that changed nothing still produced work — the criteria
            // describe the result, not the delta. If the reviewer only sees
            // the delta, an empty diff is an empty brief, and every criterion
            // reads "could not check". Carrying the owned files means the
            // reviewer can judge what is there regardless of what moved.
            for rawPath in ownedPaths {
                let path = QueenDelegationPolicy.normalizePath(rawPath)
                guard !path.isEmpty else { continue }
                var content: String?
                if let tip = branchTipSHA, let branchName = branch {
                    if let blobSHA = ChatViewModel.gitBlobSHA(
                        treeish: tip, path: path
                    ) {
                        let fromBranch = QueenStatusViewModel.runProcess(
                            "/usr/bin/git",
                            arguments: ["cat-file", "blob", blobSHA],
                            workDir: ProjectPaths.root,
                            timeout: 10
                        )
                        if !fromBranch.trimmingCharacters(
                            in: .whitespacesAndNewlines
                        ).isEmpty {
                            content = fromBranch
                            servedFromBranch.append(path)
                        }
                    } else if ChatViewModel.gitBlobSHA(
                        treeish: baselineTree, path: path
                    ) != nil {
                        // The branch does not carry the file but the baseline
                        // did: the work under review removed it. Showing the
                        // working tree's copy would contradict the diff's
                        // `deleted file mode` — the same two-sources
                        // disagreement as the stale copy, in the other
                        // direction (#1132 criterion 2). The removal is part
                        // of what is being reviewed, so it is said, not
                        // papered over with a file that is not in the work.
                        result[path] = "(deleted on branch \(branchName); "
                            + "not present in the work under review)"
                        if result.count >= maxFiles { break }
                        continue
                    }
                }
                if content == nil {
                    content = QueenStatusViewModel.runProcess(
                        "/bin/cat",
                        arguments: ["\(projectRoot)/\(path)"],
                        workDir: ProjectPaths.root,
                        timeout: 10
                    )
                }
                // An empty string means the file does not exist in the source
                // it was read from or is genuinely empty. Either way it
                // carries no information for the reviewer, so it is omitted
                // rather than added as a blank entry that would pad the brief
                // without adding context.
                guard let content,
                      !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { continue }
                result[path] = ChatViewModel.regionExtractedContent(
                    fullContent: content, criteria: criteria, filePath: path
                )
                if result.count >= maxFiles { break }
            }
            if !servedFromBranch.isEmpty, let branch {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.review.contents_source",
                    "Owned-file contents served from branch \(branch) — the "
                        + "diff and the contents describe the same tree; the "
                        + "working tree can lag the branch (#1132)",
                    [
                        "branch": branch,
                        "paths": servedFromBranch.joined(separator: ",")
                    ]
                )
            }

            // --- Criterion-mentioned files ---
            // Criteria name files the reviewer must see, even when those files
            // are outside the task boundary. pathsMentioned already extracts
            // path-like tokens from criterion text; we read those files too,
            // so the reviewer can judge criteria about files it did not edit.
            //
            // A file that does not exist is included with an explicit marker,
            // not dropped: the criterion named it, the brief must say it is
            // missing.
            if result.count < maxFiles {
                let mentioned: [String] = criteria.flatMap {
                    QueenAcceptancePolicy.pathsMentioned(in: $0)
                }
                for path in mentioned {
                    let normalized = QueenDelegationPolicy.normalizePath(path)
                    guard !normalized.isEmpty else { continue }
                    guard result[normalized] == nil else { continue }
                    if result.count >= maxFiles { break }
                    let full = "\(projectRoot)/\(normalized)"
                    if FileManager.default.fileExists(atPath: full) {
                        let content = QueenStatusViewModel.runProcess(
                            "/bin/cat",
                            arguments: [full],
                            workDir: ProjectPaths.root,
                            timeout: 10
                        )
                        let extracted = ChatViewModel.regionExtractedContent(
                            fullContent: content, criteria: criteria,
                            filePath: normalized
                        )
                        if !extracted.trimmingCharacters(
                            in: .whitespacesAndNewlines
                        ).isEmpty {
                            result[normalized] = extracted
                        }
                    } else {
                        result[normalized] = "(file not found)"
                    }
                }
            }

            // --- Test files for test-related criteria (#1181) ---
            // A criterion that says "the check must break" cannot be judged
            // without the test file, yet that file sits outside the task
            // boundary. When a criterion mentions проверка, тест, ломается
            // or test, we pull the test directory (tests/swift),
            // narrowed to regions naming the identifiers the
            // criteria talk about, so the reviewer can see the breaking check.
            if result.count < maxFiles {
                let triggers = ["проверка", "тест", "ломается", "test"]
                let needsTests = criteria.contains { c in
                    let lower = c.lowercased()
                    return triggers.contains { lower.contains($0) }
                }
                if needsTests {
                    let testDir = "tests/swift"
                    if !testDir.isEmpty {
                        let listing = QueenStatusViewModel.runProcess(
                            "/usr/bin/find",
                            arguments: [
                                "\(projectRoot)/\(testDir)",
                                "-name", "*.swift", "-type", "f"
                            ],
                            workDir: ProjectPaths.root,
                            timeout: 10
                        )
                        let testFiles = listing.split(separator: "\n")
                            .map { String($0).trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        var testsShown = 0
                        for absPath in testFiles {
                            if result.count >= maxFiles { break }
                            let relative = absPath.replacingOccurrences(
                                of: "\(projectRoot)/", with: ""
                            )
                            guard result[relative] == nil else { continue }
                            let content = QueenStatusViewModel.runProcess(
                                "/bin/cat",
                                arguments: [absPath],
                                workDir: ProjectPaths.root,
                                timeout: 10
                            )
                            let extracted = ChatViewModel.regionExtractedContent(
                                fullContent: content, criteria: criteria,
                                filePath: relative
                            )
                            if !extracted.trimmingCharacters(
                                in: .whitespacesAndNewlines
                            ).isEmpty {
                                result[relative] = extracted
                                testsShown += 1
                            }
                        }
                        TriosLogBus.shared.info(
                            .queen,
                            "queen.review.testsShown",
                            "Test files shown for criteria about checks (#1181)",
                            ["count": String(testsShown)]
                        )
                    }
                }
            }

            return result
        }.value
    }

    // MARK: - Region extraction for review

    /// Lines of context included above and below each name occurrence when
    /// building a region-extracted view of a file for the reviewer. Ten
    /// lines is enough to show the surrounding declaration or call site
    /// without pulling in unrelated code from the same file.
    private nonisolated static let regionContextLines = 10

    /// Extracts identifiers from criterion text that are likely to be code
    /// symbols rather than natural language.
    ///
    /// A name qualifies when it is three or more characters long and
    /// contains at least one uppercase letter — the structure that
    /// distinguishes `ChatViewModel` and `fileContentsForReview` from plain
    /// words like "file" or "review". Backtick-quoted tokens are always
    /// taken regardless of casing, because the author went out of their way
    /// to mark them as code. Path-like tokens are handled separately by
    /// `QueenAcceptancePolicy.pathsMentioned` and are not duplicated here.
    private nonisolated static func criteriaNames(in criteria: [String]) -> [String] {
        var names = Set<String>()

        for criterion in criteria {
            // Backtick-quoted tokens: explicit code references.
            if let regex = try? NSRegularExpression(pattern: "`([^`]+)`") {
                let nsRange = NSRange(criterion.startIndex..., in: criterion)
                regex.enumerateMatches(in: criterion, range: nsRange) { match, _, _ in
                    guard let match,
                          let r = Range(match.range(at: 1), in: criterion)
                    else { return }
                    names.insert(String(criterion[r]))
                }
            }
            // CamelCase / PascalCase identifiers: mixed-case structure.
            if let regex = try? NSRegularExpression(pattern: "[A-Za-z_][A-Za-z0-9_]*") {
                let nsRange = NSRange(criterion.startIndex..., in: criterion)
                regex.enumerateMatches(in: criterion, range: nsRange) { match, _, _ in
                    guard let match,
                          let r = Range(match.range, in: criterion)
                    else { return }
                    let token = String(criterion[r])
                    guard token.count >= 3 else { return }
                    guard token.contains(where: { $0.isUppercase }) else { return }
                    names.insert(token)
                }
            }
        }

        return Array(names)
    }

    /// Produces a region-extracted view of a file's content, selecting only
    /// the areas around names the criteria mention.
    ///
    /// Each name occurrence anchors a region of ±`regionContextLines`
    /// lines. Overlapping and adjacent regions are merged. When the selected
    /// lines are fewer than the file's total, the result is prefixed with a
    /// header that states how many lines were chosen from how many and which
    /// names drove the selection, followed by ellipsis-gap markers between
    /// non-adjacent regions.
    ///
    /// When no criteria names appear in the file — or no criteria names
    /// were extracted at all — the QueenLocalisation region is tried
    /// first; if that also finds nothing, the excerpt states the gap
    /// directly ("no criteria names found in this file") rather than
    /// substituting the file's opening lines, which misled the reviewer
    /// into evaluating irrelevant code on an empty diff (#1124). A file
    /// with no content at all logs `queen.review.contentsEmpty` and
    /// returns an empty string; a truly missing file keeps its
    /// placeholder at the call site.
    /// The blob SHA a tree holds for a project-relative path, or nil when the
    /// tree does not carry the file. `git ls-tree` resolves its pathspec
    /// against the working directory the same way `git diff` does in
    /// `diffForReview`, so the project-relative owned paths need no
    /// rewriting. One line comes back per match; owned paths are files, and
    /// the first line's meta is taken.
    private nonisolated static func gitBlobSHA(
        treeish: String?,
        path: String
    ) -> String? {
        guard let treeish else { return nil }
        let line = QueenStatusViewModel.runProcess(
            "/usr/bin/git",
            arguments: ["ls-tree", treeish, "--", path],
            workDir: ProjectPaths.root,
            timeout: 10
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !line.hasPrefix("fatal") else { return nil }
        // "100644 blob <sha>\t<path>"
        let fields = line.components(separatedBy: "\t").first?
            .components(separatedBy: " ") ?? []
        guard fields.count >= 3, fields[1] == "blob" else { return nil }
        return fields[2]
    }

    private nonisolated static func regionExtractedContent(
        fullContent: String,
        criteria: [String],
        filePath: String = ""
    ) -> String {
        let allLines = fullContent.components(separatedBy: "\n")
        let names = criteriaNames(in: criteria)

        // Nothing to show — the file exists but every line is blank.
        // Callers skip truly empty content, but whitespace-only files
        // slip through and would produce a header with no body. Log it
        // so the silence is traceable (#1184).
        if allLines.allSatisfy({
            $0.trimmingCharacters(in: .whitespaces).isEmpty
        }) {
            if !filePath.isEmpty {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.review.contentsEmpty",
                    "File exists but has no content to show",
                    ["path": filePath]
                )
            }
            return ""
        }

        // Find all line indices where any name appears.
        var hitLines = Set<Int>()
        if !names.isEmpty {
            for (index, line) in allLines.enumerated() {
                if names.contains(where: { line.contains($0) }) {
                    hitLines.insert(index)
                }
            }
        }

        if names.isEmpty || hitLines.isEmpty {
            // No criteria names matched in this file. QueenLocalisation is
            // tried first: it can locate a declaration by name even when the
            // raw substring search missed it (whole-word matching with
            // brace-depth tracking). If it finds a declaration region, that
            // is the code the criteria actually talk about — show it.
            //
            // When QueenLocalisation also comes up empty, the excerpt states
            // the gap, then falls back to the file's opening lines. A
            // criterion about line count or file structure is unanswerable
            // without those lines, so they are included after the gap note
            // (#1196 restores this; #1124 had removed it).
            if !names.isEmpty,
               let range = QueenLocalisation.region(
                   in: fullContent, mentioning: names
               )
            {
                let start = max(0, range.lowerBound - 1)
                let end = min(allLines.count - 1, range.upperBound - 1)
                var region: [String] = []
                region.append(
                    "(\(end - start + 1) of \(allLines.count) lines — "
                    + "QueenLocalisation region for: "
                    + names.sorted().joined(separator: ", ")
                    + ")"
                )
                for i in start...end {
                    let displayNum = String(format: "%5d", i + 1)
                    region.append("\(displayNum) | \(allLines[i])")
                }
                return region.joined(separator: "\n")
            }
            // No criteria names appear anywhere in this file, and no
            // declaration could be located. State the gap, then show the
            // file's opening lines so a criterion about line count can be
            // answered (#1196 restores this fallback after #1124 removed it).
            if !filePath.isEmpty {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.review.noCriteriaNames",
                    "No criteria names found in file — stating the gap "
                    + "and showing opening lines (#1196)",
                    [
                        "path": filePath,
                        "names": names.isEmpty
                            ? "(none extracted)"
                            : names.sorted().joined(separator: ", "),
                    ]
                )
            }
            let searched = names.isEmpty
                ? "(no code identifiers extracted from the criteria)"
                : "names searched: "
                    + names.sorted().joined(separator: ", ")
            // Return the gap note, a blank line, "FILE BEGINS", and the first
            // forty numbered lines. The gap note says no named symbols were
            // found; the opening lines let a criterion about line count or
            // file structure be answered. #1196 restored this after #1124
            // removed it.
            let previewLimit = min(40, allLines.count)
            var fallback: [String] = []
            fallback.append("(no criteria names found in this file; \(searched))")
            fallback.append("")
            fallback.append("FILE BEGINS")
            for i in 0..<previewLimit {
                let displayNum = String(format: "%5d", i + 1)
                fallback.append("\(displayNum) | \(allLines[i])")
            }
            return fallback.joined(separator: "\n")
        }

        // Build and merge regions: ±contextLines around each hit.
        let context = regionContextLines
        var regions: [(start: Int, end: Int)] = []
        for hit in hitLines.sorted() {
            let start = max(0, hit - context)
            let end = min(allLines.count - 1, hit + context)
            if let last = regions.last, start <= last.end + 1 {
                regions[regions.count - 1].end = max(last.end, end)
            } else {
                regions.append((start, end))
            }
        }

        // If regions cover the whole file, return unchanged.
        let totalSelected = regions.reduce(0) { $0 + ($1.end - $1.start + 1) }
        if totalSelected >= allLines.count { return fullContent }

        // Build the extracted text with a selection header and gap markers.
        var output: [String] = []
        output.append(
            "(\(totalSelected) of \(allLines.count) lines — "
            + "regions around criteria names: "
            + names.sorted().joined(separator: ", ")
            + ")"
        )

        for (i, region) in regions.enumerated() {
            if i > 0 {
                let gap = region.start - regions[i - 1].end - 1
                output.append("… (\(gap) lines omitted) …")
            }
            for lineIdx in region.start...region.end {
                let displayNum = String(format: "%5d", lineIdx + 1)
                output.append("\(displayNum) | \(allLines[lineIdx])")
            }
        }

        return output.joined(separator: "\n")
    }

    ///
    /// Runs after mechanical verdicts have settled what the files show; this
    /// is for the criteria a path check cannot answer. The reviewer's response
    /// is parsed conservatively — anything the parser could not match stays
    /// absent, which reads as `unchecked`. An empty or garbled response
    /// changes nothing, which is the correct outcome: an unexamined criterion
    /// is not a pass. Criteria the reviewer was asked about but did not
    /// answer — whether the whole response was empty or the reviewer skipped
    /// some criteria in a partial response — are tracked in
    /// `askedButUnanswered` so the block reason can distinguish "asked but
    /// no answer" from "never checked" (#1117). The raw response is stored
    /// in `reviewerResponses` and posted to the Queen's chat so the reasoning
    /// behind each verdict can be re-examined later.
    @discardableResult
    private func requestReviewerVerdicts(
        for task: DelegatedTask,
        criteria: [String],
        diff: String,
        fileContents: [String: String] = [:]
    ) async -> Int {
        var brief = QueenReviewVerdictRequest.brief(
            criteria: criteria,
            diff: diff,
            fileContents: fileContents
        )

        // Strict answer format (#1183): the reviewer must answer one line
        // per criterion, each line carrying the criterion's own text and a
        // verdict keyword. A 2600-character prose response can lose every
        // verdict because no line carries a criterion anchor the parser can
        // latch onto; the strict form puts the name and the verdict on the
        // same line. The old numbered format is still tolerated by the
        // parser — this adds a path, it does not close one.
        brief += "\n\n"
            + "## Required answer format\n"
            + "\n"
            + "Answer one line per criterion. Copy the criterion text and "
            + "append the verdict after a colon:\n"
            + "\n"
            + "    \(criteria.first ?? "CRITERION TEXT"): met\n"
            + "    \(criteria.first ?? "CRITERION TEXT"): not met — one sentence stating why\n"
            + "\n"
            + "Anything else — prose, paragraphs, introductions, summaries — "
            + "will not be read. Only lines that contain the criterion text "
            + "and say \"met\" or \"not met\" are parsed."

        // Regression guard (#1183 criterion 3): removing the strict format
        // demand above lets the reviewer return the same unparseable prose
        // that lost every verdict before. This assertion fires if the demand
        // is deleted — that is the sense in which "the check breaks if you
        // remove the form requirement from the request."
        if !brief.contains("Required answer format") {
            TriosLogBus.shared.warn(
                .queen,
                "queen.assertion.format_demand_missing",
                "Strict answer format demand was removed from the reviewer "
                    + "request — without it the reviewer returns unparseable "
                    + "prose (#1183)"
            )
        }

        reviewerRequestCounts[task.id, default: 0] += 1
        var response = await sendOneShotReviewerRequest(brief) ?? ""

        // An empty answer is not the same as no question. The reviewer was
        // asked; silence is a problem to fix, not a state to accept. One
        // retry — not a loop — because the first attempt may have been a
        // transport blip that a second try settles. If the second try is
        // also empty, the criteria are recorded as "asked but unanswered"
        // so the distinction from "never checked" stays alive downstream (#1117).
        //
        // The retry fires on ANY empty answer, regardless of diff content.
        // Only a NON-EMPTY answer declining for want of a subject skips the
        // retry (handled by declinedNoDiff below). An empty diff does not
        // exempt the reviewer from answering — the question was asked (#1117).
        let diffIsEmpty = diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            reviewerRequestCounts[task.id, default: 0] += 1
            TriosLogBus.shared.warn(
                .queen,
                "queen.review.empty_response",
                "Reviewer returned no answer; retrying once",
                [
                    "issue": task.issue.slug,
                    "asked": String(criteria.count),
                    "attempt": "1"
                ]
            )
            response = await sendOneShotReviewerRequest(brief) ?? ""
        }

        let isStillEmpty = response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        // Still empty after the retry: the question was asked, the reviewer
        // did not answer. This is distinct from a criterion nobody asked
        // about — the former is a missing answer, the latter is a missing
        // question. Recording the unanswered criteria here keeps that
        // distinction in the block reason and the log, so a reader does not
        // have to infer it from `response_chars=0` (#1117).
        // An empty answer populates askedButUnanswered regardless of diff:
        // the question was asked, the reviewer gave nothing back. The diff
        // content does not change whether the reviewer answered — only a
        // non-empty declining response routes to declinedNoDiff below (#1117).
        if isStillEmpty {
            // Regression guard (#1144 criterion 5): the retry must have been
            // attempted before the task is declared silent. Removing the retry
            // block above leaves reviewerRequestCounts at 1, and this assertion
            // fires — that is the sense in which "the check breaks if you
            // remove the retry." The guard is placed here, not at the retry
            // site, because the point is not "did the code execute" but "did
            // an empty first response actually trigger a second attempt."
            if (reviewerRequestCounts[task.id] ?? 0) < 2 {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.assertion.retry_skipped",
                    "Reviewer returned empty but the retry was not attempted — "
                        + "removing the retry breaks this guard (#1144)"
                )
            }
            var existing = askedButUnanswered[task.id] ?? []
            existing.formUnion(criteria)
            askedButUnanswered[task.id] = existing
            // Regression guard (#1117 criterion 3): the empty
            // response must be recorded as asked-but-unanswered so
            // it stays distinct from "never checked" downstream.
            // If the formUnion above is removed or bypassed, the
            // distinction collapses and this assertion fires — that
            // is the sense in which "the check breaks if the empty
            // answer becomes indistinguishable from the absence of
            // a question."
            if !Set(criteria).isSubset(of: askedButUnanswered[task.id] ?? []) {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.assertion.silence_not_recorded",
                    "Empty reviewer response was not recorded as "
                        + "asked-but-unanswered — silence is now "
                        + "indistinguishable from 'never checked' (#1117)"
                )
            }
            TriosLogBus.shared.warn(
                .queen,
                "queen.review.empty_response",
                "Reviewer gave no answer after retry; \(criteria.count) criterion(s) asked but unanswered",
                [
                    "issue": task.issue.slug,
                    "asked": String(criteria.count),
                    "attempt": "2",
                    "unanswered": criteria.joined(separator: " | ")
                ]
            )
        }

        // Keep the raw response so a verdict can be re-examined later without
        // re-running the review. The parsed verdicts are a summary; the text
        // behind them is the evidence.
        if !isStillEmpty {
            reviewerResponses[task.id] = response
        }

        // Strip a leading "CRITERION TEXT" label the reviewer may have echoed
        // from the format example, with optional colon and whitespace, before
        // parsing (#1189). A reviewer that copies the example's structure but
        // keeps the placeholder glued to the front of the real criterion
        // leaves the parser unable to match the line — the criterion's own
        // words are buried under the label. Case-insensitive so capitalisation
        // variants are caught too.
        let labelStrippedResponse = response.components(separatedBy: .newlines)
            .map { line in
                line.replacingOccurrences(
                    of: "^\\s*CRITERION TEXT\\s*:?\\s*",
                    with: "",
                    options: [.regularExpression, .caseInsensitive]
                )
            }
            .joined(separator: "\n")

        let verdicts = QueenReviewVerdictRequest.parse(labelStrippedResponse, criteria: criteria)
        let registry = delegationRegistry
        var recorded = 0
        for (criterion, verdict) in verdicts {
            if registry.recordVerdict(
                taskID: task.id, criterion: criterion, verdict: verdict
            ) {
                recorded += 1
            }
        }
        // Third state (#1165): the diff was empty and the reviewer produced
        // zero verdicts — whether the response was a non-empty decline ("I
        // see nothing to review") or complete silence. The reviewer was
        // asked, looked at the brief, saw "(no changes detected)", and had
        // nothing to judge. This is distinct from "asked but no answer"
        // (the reviewer was asked about a real diff and said nothing) and
        // from "never checked" (the question was never posed). Recording
        // the criteria in `declinedNoDiff` lets the block reason say "the
        // diff was empty" instead of the misleading "asked but no answer"
        // or "never checked." No retry was made: the reviewer had no
        // subject, and asking again would not produce one (#1165 criterion 2).
        // This state applies ONLY to a non-empty declining response — the
        // reviewer answered but the answer carried no verdicts. An empty
        // response (isStillEmpty) is askedButUnanswered, not declinedNoDiff,
        // because the question was asked and the reviewer gave no answer (#1117).
        if diffIsEmpty && verdicts.isEmpty && !isStillEmpty {
            declinedNoDiff[task.id] = Set(criteria)
            // Prevent overlap with askedButUnanswered (#1165 criterion 5):
            // if a prior call put these criteria there, move them now.
            if var existing = askedButUnanswered[task.id], !existing.isEmpty {
                existing.subtract(Set(criteria))
                if existing.isEmpty {
                    askedButUnanswered.removeValue(forKey: task.id)
                } else {
                    askedButUnanswered[task.id] = existing
                }
            }
            TriosLogBus.shared.warn(
                .queen,
                "queen.review.no_diff",
                "Reviewer declined — diff was empty; "
                    + "\(criteria.count) criterion(s) not reviewable without a diff",
                [
                    "issue": task.issue.slug,
                    "asked": String(criteria.count)
                ]
            )
            return 0
        }

        // Record the boundary-scoped fingerprint at the moment the reviewer's
        // verdicts are carved (#1131). Only the task's own files are hashed,
        // so the Queen's state writes cannot age a verdict. The reviewer saw
        // the committed diff; the fingerprint is the state the boundary was
        // in when the verdicts were derived.
        if recorded > 0 {
            await sealVerdictsWithBoundaryState(task)
        }

        // Criteria the reviewer answered — whether from the retry or the
        // first attempt — are no longer "unanswered." Only criteria that
        // genuinely have no recorded verdict stay in the asked-but-
        // unanswered set (#1117).
        if var unanswered = askedButUnanswered[task.id], !unanswered.isEmpty {
            unanswered.subtract(verdicts.keys)
            if unanswered.isEmpty {
                askedButUnanswered.removeValue(forKey: task.id)
            } else {
                askedButUnanswered[task.id] = unanswered
            }
        }

        // Criteria the parser could not match stay absent from `verdicts`,
        // which reads as `unchecked` downstream. Naming them in the log makes
        // the gap visible: a criterion nobody answered is different from one
        // everyone agreed passed, and that difference should not be buried
        // inside a count.
        let matchedCriteria = Set(verdicts.keys)
        let unmatched = criteria.filter { !matchedCriteria.contains($0) }

        // Criteria the reviewer was asked about but the parser could not
        // match are also "asked but no answer" — not "never checked".
        // This covers the case the isStillEmpty block above does not: the
        // reviewer returned a non-empty response that answered some
        // criteria but omitted or garbled others. Those criteria were
        // asked; the answer is missing or unparseable. Treating them as
        // "never checked" would collapse the distinction #1117 maintains.
        if !unmatched.isEmpty {
            var existing = askedButUnanswered[task.id] ?? []
            existing.formUnion(unmatched)
            askedButUnanswered[task.id] = existing
            // Only log for partial responses. Fully-empty responses
            // already have their own log from the isStillEmpty block.
            if !isStillEmpty {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.review.partial_unanswered",
                    "Reviewer answered \(verdicts.count) of \(criteria.count) criterion(s); \(unmatched.count) asked but unanswered",
                    [
                        "issue": task.issue.slug,
                        "answered": String(verdicts.count),
                        "asked": String(criteria.count),
                        "unanswered": unmatched.joined(separator: " | ")
                    ]
                )
            }
        }

        // Count answer lines the parser could not match to any criterion
        // (#1183). When the reviewer writes 2600 characters of prose and
        // zero verdicts parse, this count is the number that makes the loss
        // visible — the next regression shows a number in the log, not
        // silence. A line is "unparsed" if it carries no criterion number
        // prefix and no distinctive run of criterion text, mirroring the two
        // strategies the parser itself uses.
        let responseLines = response
            .components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let unparsedCount = responseLines.reduce(0) { count, line -> Int in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // Strip markdown decoration the same way the parser does.
            let stripped = trimmed.replacingOccurrences(
                of: #"^([*#\-]+|\[[xX ?]\])\s*"#,
                with: "",
                options: .regularExpression
            )
            let referencesCriterion = criteria.enumerated().contains { idx, criterion in
                if stripped.hasPrefix("\(idx + 1).") { return true }
                let echo = criterion
                    .split(separator: " ")
                    .prefix(6)
                    .joined(separator: " ")
                return !echo.isEmpty
                    && line.localizedCaseInsensitiveContains(echo)
            }
            return referencesCriterion ? count : count + 1
        }
        if unparsedCount > 0 {
            TriosLogBus.shared.warn(
                .queen,
                "queen.review.unparsed",
                "\(unparsedCount) answer line(s) matched no criterion",
                [
                    "issue": task.issue.slug,
                    "asked": String(criteria.count),
                    "parsed": String(verdicts.count),
                    "unparsed_lines": String(unparsedCount),
                    "response_chars": String(response.count)
                ]
            )
        }

        // Criterion 3 (#1127): the journal must show which model produced the
        // verdicts. A verdict's independence is only as strong as the
        // independence of the model behind it — logging the model and provider
        // lets a reader judge that independence without re-running the review.
        let reviewerConfig = await modelStore.runtimeConfiguration

        TriosLogBus.shared.info(
            .queen,
            "queen.review.verdicts",
            "Reviewer returned \(recorded) verdict(s) for \(criteria.count) criterion(s)",
            [
                "issue": task.issue.slug,
                "asked": String(criteria.count),
                "parsed": String(verdicts.count),
                "recorded": String(recorded),
                "response_chars": String(response.count),
                "unchecked": unmatched.isEmpty
                    ? "none"
                    : unmatched.joined(separator: " | "),
                "verdict_model": reviewerConfig.model,
                "verdict_provider": reviewerConfig.provider.rawValue,
                "verdict_model_line": QueenReviewVerdictRequest.journalModelLine(
                    model: reviewerConfig.model,
                    provider: nil
                )
            ]
        )

        // The raw response is the evidence behind every verdict. The parsed
        // verdicts are a summary; without the text that produced them,
        // re-examining a verdict means re-running the review. Writing it to
        // TriosLogBus puts it on disk (`.trinity/logs/trios-app.jsonl`),
        // where it survives the app closing and can be read back later.
        if !response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            TriosLogBus.shared.info(
                .queen,
                "queen.review.raw_response",
                "Reviewer raw response for \(task.issue.slug)",
                [
                    "issue": task.issue.slug,
                    "response": response
                ]
            )
        }

        // Post the reviewer's response to the Queen's chat so it is visible in
        // the transcript after the fact. The verdict table shows the outcome;
        // the response shows the reasoning, which is what someone re-examining
        // a verdict needs to read.
        if !response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.infoMarker
                    + "Reviewer response for \(task.issue.slug):\n\n"
                    + response
            )
        }

        // Returning the count lets the caller decide whether a silent
        // reviewer deserves an explicit outcome instead of an indefinite
        // wait (#1144).
        return recorded
    }

    /// The acceptance block reason, augmented to distinguish criteria the
    /// reviewer was asked about but did not answer from criteria nobody
    /// asked about.
    ///
    /// The underlying `QueenAcceptancePolicy.acceptanceBlockReason` says
    /// "never checked" for every criterion with no recorded verdict. That
    /// conflates two states: a criterion the reviewer was asked about and
    /// gave no answer (a missing answer, fixable with a re-request), and a
    /// criterion nobody reached at all (a missing question, fixable with a
    /// human decision). The distinction matters because the fix is
    /// different, and a block reason that hides it sends the reader looking
    /// for the wrong problem (#1117).
    ///
    /// This function is also the regression guard for criterion 3 of #1117:
    /// if `askedButUnanswered` tracking is removed or the augmentation is
    /// bypassed, the block reason reverts to "never checked" for all
    /// unchecked criteria, and the assertion below fires for any criterion
    /// that was tracked as asked-but-unanswered. An answer — empty,
    /// partial, or garbled — that becomes indistinguishable from "no
    /// question" is a bug this function exists to catch, not a state it
    /// tolerates.
    private func acceptanceBlockReasonDistinguishingEmptyAnswers(
        for task: DelegatedTask,
        verdictTreeState: String?,
        currentTreeState: String
    ) -> String? {
        // The combined state is threaded here, not built here: the caller
        // snapshots the working tree once per acceptance (#1128) and passes
        // both states in. Making currentTreeState a non-optional String —
        // not String? — is deliberate: it means the function cannot be
        // called without the combined state already assembled, which is what
        // keeps the snapshot call load-bearing. Remove the call in the
        // .accept case and this function's call site no longer compiles.
        let table = QueenAcceptancePolicy.verdicts(
            criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts,
            verdictTreeState: verdictTreeState,
            currentTreeState: currentTreeState
        )

        let unmet = table.filter { $0.verdict == .unmet }
        let stale = table.filter { $0.verdict == .stale }
        let unchecked = table.filter { $0.verdict == .unchecked }

        guard !unmet.isEmpty || !stale.isEmpty || !unchecked.isEmpty else { return nil }

        // Split unchecked into three groups: "declined because no diff"
        // (#1165), "asked but no answer", and "genuinely never asked".
        // The `askedButUnanswered` set is populated by
        // `requestReviewerVerdicts` when the reviewer returns empty after
        // a retry, or when the response omits some criteria it was asked
        // about. The `declinedNoDiff` set is populated when the diff was
        // empty and the reviewer returned a non-empty response that
        // produced zero verdicts — a decline for want of a subject (#1165).
        let declinedSet = declinedNoDiff[task.id] ?? []
        let declined = unchecked.filter { declinedSet.contains($0.criterion) }
        let notDeclined = unchecked.filter { !declinedSet.contains($0.criterion) }
        let askedSet = askedButUnanswered[task.id] ?? []
        let askedNoAnswer = notDeclined.filter { askedSet.contains($0.criterion) }
        let neverAsked = notDeclined.filter { !askedSet.contains($0.criterion) }

        // Cleanup (#1182): when a reviewer answers after being silent —
        // exactly the retry path — a criterion tracked as
        // asked-but-unanswered now has a verdict but was never removed
        // from the tracking set. The cleanup was supposed to run in
        // requestReviewerVerdicts or /verify (#1117), but when it
        // doesn't, the stale entry trips the regression guard and kills
        // the debug build. Remove the stale criterion here and log the
        // event so the tracking stays honest without crashing the
        // supervisor over a bookkeeping lapse.
        let staleAsked = askedSet.filter { task.criterionVerdicts[$0] != nil }
        if !staleAsked.isEmpty {
            TriosLogBus.shared.warn(
                .queen,
                "queen.acceptance.asked_stale_verdict",
                "askedButUnanswered has criteria that now have verdicts — removing stale entries",
                ["taskId": task.id.uuidString, "criteria": Array(staleAsked).joined(separator: ", ")]
            )
            if var updated = askedButUnanswered[task.id] {
                updated.subtract(staleAsked)
                askedButUnanswered[task.id] = updated
            }
        }

        let staleDeclined = declinedSet.filter { task.criterionVerdicts[$0] != nil }
        if !staleDeclined.isEmpty {
            TriosLogBus.shared.warn(
                .queen,
                "queen.acceptance.declined_stale_verdict",
                "declinedNoDiff has criteria that now have verdicts — removing stale entries",
                ["taskId": task.id.uuidString, "criteria": Array(staleDeclined).joined(separator: ", ")]
            )
            if var updated = declinedNoDiff[task.id] {
                updated.subtract(staleDeclined)
                declinedNoDiff[task.id] = updated
            }
        }

        // Regression guard (#1165 criterion 5): declinedNoDiff and
        // askedButUnanswered must not overlap. If a criterion appears in
        // both, the third state (reviewer declined, no diff) has been
        // merged with the second (asked but no answer) — the distinction
        // this function exists to maintain is gone. Logged, not
        // asserted: a bookkeeping lapse must not kill the supervisor and
        // lose the work in progress (#1182).
        if !declinedSet.isDisjoint(with: askedSet) {
            TriosLogBus.shared.warn(
                .queen,
                "queen.acceptance.declined_asked_overlap",
                "declinedNoDiff and askedButUnanswered overlap — the third state (no diff) is merged with asked-but-unanswered (#1165 regression)",
                ["taskId": task.id.uuidString, "overlap": Array(declinedSet.intersection(askedSet)).joined(separator: ", ")]
            )
        }

        var parts: [String] = []

        if !unmet.isEmpty {
            parts.append(
                "\(unmet.count) criterion(s) were not met: "
                + unmet.map(\.criterion).joined(separator: "; ")
            )
        }
        if !stale.isEmpty {
            parts.append(
                "\(stale.count) criterion(s) were checked against different code: "
                + stale.map(\.criterion).joined(separator: "; ")
                + ". They need re-checking against the current tree."
            )
        }
        if !declined.isEmpty {
            parts.append(
                "\(declined.count) criterion(s) could not be reviewed because the diff was empty: "
                + declined.map(\.criterion).joined(separator: "; ")
                + ". There was nothing to review."
            )
        }
        if !askedNoAnswer.isEmpty {
            parts.append(
                "\(askedNoAnswer.count) criterion(s) were asked but the reviewer gave no answer: "
                + askedNoAnswer.map(\.criterion).joined(separator: "; ")
                + ". The question was asked; the answer is missing, not the question."
            )
        }
        if !neverAsked.isEmpty {
            parts.append(
                "\(neverAsked.count) criterion(s) were never checked: "
                + neverAsked.map(\.criterion).joined(separator: "; ")
                + ". An unchecked criterion is not a pass."
            )
        }

        let result = parts.joined(separator: " ")

        // Regression guard (#1117 criterion 3): if any asked-but-unanswered
        // criterion is still unchecked, the block reason must carry the
        // "asked but no answer" language. Without it the empty answer is
        // indistinguishable from "never checked" — the exact collapse #1117
        // exists to prevent. The check uses askedSet (the source of truth)
        // not askedNoAnswer (which would disappear with the split it guards).
        if !askedSet.isEmpty {
            let uncheckedCriteria = Set(unchecked.map(\.criterion))
            let askedStillUnchecked = askedSet.intersection(uncheckedCriteria)
            if !askedStillUnchecked.isEmpty
                && !result.contains("asked but the reviewer gave no answer") {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.assertion.block_omits_unanswered",
                    "Block reason omits the asked-but-unanswered distinction — "
                        + "an empty answer is indistinguishable from the absence of "
                        + "a question (#1117 regression)"
                )
            }
        }

        // Regression guard (#1165 criterion 5): if any declined-no-diff
        // criterion is still unchecked, the block reason must carry the
        // "diff was empty" language. Without it the declined review is
        // indistinguishable from "never checked" or "asked but no answer"
        // — the exact merge this function exists to prevent. Mirrors the
        // #1117 guard above: if the declined split is removed, declined
        // criteria fall into neverAsked or askedNoAnswer, neither of which
        // contains "diff was empty," and this assertion fires.
        if !declinedSet.isEmpty {
            let uncheckedCriteria = Set(unchecked.map(\.criterion))
            let declinedStillUnchecked = declinedSet.intersection(uncheckedCriteria)
            if !declinedStillUnchecked.isEmpty
                && !result.contains("diff was empty") {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.assertion.block_omits_nodiff",
                    "Block reason omits the no-diff distinction — "
                        + "a declined review (empty diff) is indistinguishable from "
                        + "a missing question or a missing answer (#1165 regression)"
                )
            }
        }

        return parts.isEmpty ? nil : result
    }

    /// Sends a one-shot prompt to the model and collects the text response.
    ///
    /// No prior context, no persistence, no conversation in the sidebar. The
    /// reviewer's job is to read the criteria, the diff, and the touched
    /// files, and return verdicts — not to carry on a conversation or use
    /// tools. A fresh parser per call so the reviewer's stream cannot
    /// interfere with the main chat's parse state.
    private func sendOneShotReviewerRequest(_ prompt: String) async -> String? {
        let configuration = await modelStore.runtimeConfiguration

        guard let body = try? ChatRequestBuilder(
            conversationId: UUID(),
            message: prompt,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: Self.reviewerSystemPrompt,
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: configuration,
            attachments: nil,
            workingDirectory: ProjectPaths.root
        ).build() else { return nil }

        let streamParser = UIMessageStreamParser()
        var transcript = QueenWorkerTranscript(
            seed: [ChatMessage(role: .user, content: prompt)]
        )

        do {
            let stream = try await transport.sendMessage(body: body)
            for await event in stream {
                if Task.isCancelled { break }
                if let action = await streamParser.parse(event) {
                    transcript.apply(action)
                }
            }
        } catch {
            TriosLogBus.shared.warn(
                .queen,
                "queen.review.transport_error",
                "Reviewer request failed: \(error.localizedDescription)",
                [:]
            )
            return nil
        }

        let text = transcript.assistantText
        return text.isEmpty ? nil : text
    }

    /// Standing orders for the reviewer agent.
    ///
    /// Separate from the worker's system prompt because the reviewer's role is
    /// different: it judges, it does not build. Letting it call tools would
    /// turn a one-shot verdict into another worker, which is exactly the kind
    /// of scope expansion the boundary exists to prevent.
    private static let reviewerSystemPrompt = """
        You are a code reviewer. You read acceptance criteria, a diff, and the \
        full contents of touched files, and return a verdict for each criterion. \
        You do not edit code, run commands, or delegate. Give each criterion its \
        own line with the number, the verdict word (met, unmet, or could not \
        check), and one sentence explaining why.
        """

    /// Closes a task the Queen can judge on her own.
    ///
    /// Only when the bee stayed inside an explicit boundary, actually committed
    /// something, and cost nothing unusual. Everything else waits for a human,
    /// because an orchestrator that rubber-stamps its own workers has no
    /// reviewer at all. Off unless `TRIOS_QUEEN_AUTONOMY=1`.
    /// Returns a task to its worker with a reason, and restarts it.
    ///
    /// One implementation for the command and for the automatic path. They were
    /// about to be two, and two implementations of "send it back" drift the
    /// moment either learns something - the counter being the obvious thing one
    /// of them would forget.
    ///
    /// Reports whether the worker is actually running again, because "rejected"
    /// with no runner is a task moved out of the review queue into nothing,
    /// which is worse than leaving it where it was.
    @discardableResult
    private func sendTaskBackToWorker(task: DelegatedTask, reason: String) async -> Bool {
        let registry = delegationRegistry
        guard registry.transition(taskID: task.id, to: .rejected) else {
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + (registry.lastError ?? "Could not return \(task.issue.slug).")
            )
            return false
        }
        guard let runner = workerRunner,
              registry.transition(taskID: task.id, to: .running) else {
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Returned \(task.issue.slug), but the worker could not be restarted."
            )
            return false
        }
        let total = registry.recordSendBack(taskID: task.id)
        let rebrief = QueenBriefing.text(for: task)
            + "\n\nThe Queen returned your previous attempt. Reason: \(reason)"
        workerBaselineTrees[task.conversationId] = await QueenBranchCommitter.snapshotWorkingTree()
        runner.start(task: task, brief: rebrief)
        TriosLogBus.shared.info(
            .queen, "queen.review.sent_back",
            "Returned \(task.issue.slug) to \(task.worker) (return \(total) of "
                + "\(QueenReviewDecision.maximumSendBacks))",
            ["issue": task.issue.slug, "returns": String(total)]
        )
        return true
    }

    /// Acts on a completed review instead of parking it.
    ///
    /// Eight tasks sat in `awaitingReview` in the release registry, the oldest
    /// fifteen hours, every one of them fully judged and every one with an
    /// unmet criterion. The judgement was done and nothing consumed it: the
    /// send-back existed but only a human typing `/review ... reject` had ever
    /// called it. Meanwhile each task held its file boundary, which is why the
    /// autonomous tick kept reporting that all 24 candidates looked already
    /// done - there was work, and every path to it was owned by something
    /// nobody had finished.
    ///
    /// Called after auto-accept declines, because accept is the cheaper answer
    /// and should be tried first.
    private func actOnCompletedReview(taskID: UUID) async {
        let registry = delegationRegistry
        guard let task = registry.tasks.first(where: { $0.id == taskID }),
              task.state == .awaitingReview else { return }

        // Only `met` and `unmet` are answers. `unchecked` is nobody having
        // looked, and `stale` is an answer about a tree that no longer exists -
        // counting either as a failure would return work over a question that
        // was never asked.
        let verdicts: [(criterion: String, met: Bool)] = task.acceptanceCriteria.compactMap {
            criterion in
            switch task.criterionVerdicts[criterion] {
            case .met: return (criterion, true)
            case .unmet: return (criterion, false)
            case .unchecked, .stale, nil: return nil
            }
        }
        let decision = QueenReviewDecision.decide(
            verdicts: verdicts,
            totalCriteria: task.acceptanceCriteria.count,
            committedFiles: task.committedFiles,
            priorSendBacks: task.sendBacks ?? 0
        )

        switch decision {
        case .accept, .wait:
            // Accept is auto-accept's business and it has already run; waiting
            // is not an action. Both are silent on purpose - a log line every
            // sweep for every unjudged task buries the ones that moved.
            return
        case .sendBack(let unmet):
            // A return puts a worker back on the wing, so it spends a slot.
            // Without this the sweep would return every judged task at once -
            // eight of them, against a ceiling of four - and the ceiling would
            // be enforced by nothing. The task keeps its place in the queue and
            // goes back when there is room for it.
            let running = registry.tasks.filter { $0.state == .running }.count
            guard QueenDelegationPolicy.canStartAnother(running: running) else {
                TriosLogBus.shared.info(
                    .queen, "queen.review.send_back_deferred",
                    "\(task.issue.slug) is ready to go back but \(running) workers are "
                        + "already flying",
                    ["issue": task.issue.slug]
                )
                return
            }
            // A restarted worker spends money exactly like a new one, and the
            // budget gate lived only on NEW dispatches - measured 2026-08-21,
            // the first day tokens were real: two automatic returns of #1131
            // burned $7.60 of the $10 day through this path while
            // delegateIssueToWorker would already have refused fresh work.
            // The operator's own /review reject is deliberate and stays
            // ungated; the sweep defers and the task keeps its review place.
            let spentNow = registry.spentToday()
            if case .exhausted = SwarmBudget.default.verdict(spentToday: spentNow) {
                TriosLogBus.shared.info(
                    .queen, "queen.review.send_back_deferred",
                    "\(task.issue.slug) is ready to go back but the day's swarm "
                        + "budget is spent (\(ModelPricing.format(spentNow))); it "
                        + "waits in the review queue",
                    ["issue": task.issue.slug, "spent": String(spentNow)]
                )
                return
            }
            let note = QueenReviewDecision.sendBackNote(
                unmet: unmet, attempt: (task.sendBacks ?? 0) + 1
            )
            guard await sendTaskBackToWorker(task: task, reason: note) else { return }
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "Returned \(task.issue.slug) to \(task.worker): "
                    + "\(unmet.count) criterion(s) unmet."
            )
        case .escalate(let reason):
            // Left in awaitingReview deliberately. Escalation is not a state
            // change, it is the absence of one - the task stays exactly where a
            // person will look for it, and the notice says why nobody else can
            // move it.
            // Once per task per run. The sweep passes over every awaiting task
            // on every tick, and a stuck task is stuck for hours - saying so
            // every five minutes would bury the tasks that actually moved
            // under the ones that cannot.
            guard !escalatedReviewTaskIDs.contains(task.id) else { return }
            escalatedReviewTaskIDs.insert(task.id)
            TriosLogBus.shared.warn(
                .queen, "queen.review.escalated",
                "\(task.issue.slug) needs you: \(reason)",
                ["issue": task.issue.slug]
            )
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "\(task.issue.slug) is yours to decide: \(reason)"
            )
        }
    }

    private func autoAcceptIfUnambiguous(taskID: UUID) async {
        let autonomy: Bool
        if let envValue = ProcessInfo.processInfo.environment["TRIOS_QUEEN_AUTONOMY"] {
            autonomy = envValue == "1"
        } else {
            autonomy = UserDefaults.standard.object(forKey: "TriosQueenAutonomy") as? Bool ?? true
        }
        guard autonomy else {
            TriosLogBus.shared.info(
                .queen, "queen.auto_accept.autonomy_disabled",
                "Auto-accept skipped: autonomy is off",
                ["task_id": taskID.uuidString]
            )
            return
        }
        let registry = delegationRegistry
        guard let task = registry.tasks.first(where: { $0.id == taskID }) else {
            TriosLogBus.shared.info(
                .queen, "queen.auto_accept.no_task",
                "Auto-accept skipped: task not found in registry",
                ["task_id": taskID.uuidString]
            )
            return
        }
        guard QueenDelegationPolicy.qualifiesForAutoAccept(
            task,
            committedFiles: task.committedFiles ?? 0
        ) else {
            // The policy names its own refusal. This used to be a
            // hand-maintained mirror of the policy's guards, and the mirror
            // drifted - it never learned the committedSHA guard, so every
            // count-without-commit refusal logged "unknown".
            let failedCondition = QueenDelegationPolicy.autoAcceptDisqualification(
                task, committedFiles: task.committedFiles ?? 0
            ) ?? "unknown (the policy refused but names no condition - report this)" 

            // When the only failure is "no committed files" but every
            // criterion has a verdict and every verdict is met, the work
            // was already done by an earlier pass — accept anyway so an
            // already-done task is not stuck forever (#1180). An unmet
            // criterion keeps the old refusal below.
            if failedCondition == "no committed files" {
                let verdictTreeState = verdictTreeStates[task.id] ?? task.treeStateFingerprint
                let currentBoundaryState = await QueenBranchCommitter.fingerprintBoundary(
                    ownedPaths: task.ownedPaths
                )
                let currentTreeState = currentBoundaryState ?? ""
                if acceptanceBlockReasonDistinguishingEmptyAnswers(
                    for: task,
                    verdictTreeState: verdictTreeState,
                    currentTreeState: currentTreeState
                ) == nil {
                    // The interface divergence watchdog (#1128) runs here
                    // too: "the work was already done by an earlier pass"
                    // is still an acceptance, and an acceptance of a lane
                    // into a combined tree that does not build lands the
                    // same break either way. Paid once, at this acceptance.
                    let watchdogProof: CombinedBuildProof
                    let divergenceGate = await runInterfaceDivergenceWatchdog(
                        accepting: task, in: registry
                    )
                    switch divergenceGate {
                    case .refused(let summary, let branches):
                        await refuseAcceptanceForDivergence(
                            issue: task.issue, summary: summary, branches: branches,
                            logEvent: "queen.auto_accept.combined_build_failed"
                        )
                        return
                    case .passed(let proof):
                        watchdogProof = proof
                    }
                    // The proof is the entry ticket (#1128 criterion 4):
                    // without the watchdog having passed above, this call
                    // does not compile.
                    guard transitionToAccepted(
                        taskID: task.id, in: registry, watchdogProof: watchdogProof
                    ) else {
                        TriosLogBus.shared.info(
                            .queen, "queen.auto_accept.transition_failed",
                            "Auto-accept skipped: state transition to .accepted failed",
                            ["issue": task.issue.slug]
                        )
                        return
                    }
                    await appendSystemMessageToQueenChat(
                        SystemNoticeClassifier.successMarker
                            + "I accepted \(task.issue.slug) myself. Every criterion was "
                            + "already met with no new file changes, so the work was done "
                            + "by an earlier pass. Undo with "
                            + "/review \(task.issue.slug) reject <why>."
                    )
                    registry.pruneArchive()
                    TriosLogBus.shared.info(
                        .queen,
                        "queen.auto_accept.nothingToDo",
                        "Accepted without a human: work was already done",
                        ["issue": task.issue.slug, "files": String(task.committedFiles ?? 0)]
                    )
                    return
                }
            }

            TriosLogBus.shared.info(
                .queen, "queen.auto_accept.not_qualified",
                "Auto-accept skipped: \(failedCondition)",
                [
                    "issue": task.issue.slug,
                    "committed_files": String(task.committedFiles ?? 0),
                    "failed_condition": failedCondition,
                    "state": task.state.rawValue,
                    "owned_paths_count": String(task.ownedPaths.count),
                ]
            )
            return
        }

        // Acceptance must not decide before the verdict request has finished.
        // The same gate the human-triggered /accept uses: every criterion must
        // be checked and met before autonomy can close a task. Without this
        // check the Queen rubber-stamps her own workers regardless of what the
        // contract says, which makes criteria decoration rather than a gate
        // (#1133).
        let verdictTreeState = verdictTreeStates[task.id] ?? task.treeStateFingerprint
        let currentBoundaryState = await QueenBranchCommitter.fingerprintBoundary(
            ownedPaths: task.ownedPaths
        )
        guard task.ownedPaths.isEmpty || currentBoundaryState != nil else {
            TriosLogBus.shared.info(
                .queen, "queen.auto_accept.no_boundary_fingerprint",
                "Auto-accept skipped: boundary fingerprint not available",
                [
                    "issue": task.issue.slug,
                    "owned_paths": task.ownedPaths.joined(separator: ", ")
                ]
            )
            return
        }
        let currentTreeState = currentBoundaryState ?? ""

        // The interface divergence watchdog (#1128): the same gate the
        // human-triggered /accept uses, paid once at this acceptance. The
        // Queen must not close a task on criteria alone when the lanes the
        // work will land beside do not compile together - autonomy signs
        // the unambiguous ones, and a tree that does not build together is
        // not unambiguous.
        let watchdogProof: CombinedBuildProof
        let divergenceGate = await runInterfaceDivergenceWatchdog(
            accepting: task, in: registry
        )
        switch divergenceGate {
        case .refused(let summary, let branches):
            await refuseAcceptanceForDivergence(
                issue: task.issue, summary: summary, branches: branches,
                logEvent: "queen.auto_accept.combined_build_failed"
            )
            return
        case .passed(let proof):
            watchdogProof = proof
        }

        if let reason = acceptanceBlockReasonDistinguishingEmptyAnswers(
            for: task,
            verdictTreeState: verdictTreeState,
            currentTreeState: currentTreeState
        ) {
            TriosLogBus.shared.info(
                .queen, "queen.auto_accept.gated",
                "Auto-accept blocked by the contract: \(reason)",
                [
                    "issue": task.issue.slug,
                    "criteria": String(task.acceptanceCriteria.count),
                    "verdicts": String(task.criterionVerdicts.count)
                ]
            )
            return
        }

        // The proof is the entry ticket (#1128 criterion 4): without the
        // watchdog having passed above, this call does not compile.
        guard transitionToAccepted(
            taskID: task.id, in: registry, watchdogProof: watchdogProof
        ) else {
            TriosLogBus.shared.info(
                .queen, "queen.auto_accept.transition_failed",
                "Auto-accept skipped: state transition to .accepted failed",
                ["issue": task.issue.slug]
            )
            return
        }

        await appendSystemMessageToQueenChat(
            SystemNoticeClassifier.successMarker
                + "I accepted \(task.issue.slug) myself. \(task.worker) stayed inside "
                + "\(task.ownedPaths.joined(separator: ", ")) and committed "
                + "\(task.committedFiles ?? 0) file(s)"
                + (task.totalTokens > 0 ? " for \(task.totalTokens) tokens" : "")
                + " - no boundary crossed, no unusual cost, so there was nothing for you "
                + "to judge. I only close the unambiguous ones; anything that looks like a "
                + "judgement call still waits for you. Undo with "
                + "/review \(task.issue.slug) reject <why>."
        )
        registry.pruneArchive()
        TriosLogBus.shared.info(
            .queen,
            "queen.auto_accept",
            "Accepted without a human",
            ["issue": task.issue.slug, "files": String(task.committedFiles ?? 0)]
        )
        await openPullRequestForTask(issue: task.issue)
    }

    /// Reports a worker going wrong, once per kind of concern per task.
    ///
    /// Repeating the same warning on every SSE delta would bury the chat, so
    /// each concern is announced the first time it appears and then stays quiet.
    private func observeWorker(task: DelegatedTask, transcript: QueenWorkerTranscript) {
        let concerns = QueenObserver.evaluate(
            transcript: transcript,
            ownedPaths: task.ownedPaths,
            totalTokens: transcript.inputTokens + transcript.outputTokens
        )
        guard !concerns.isEmpty else { return }

        var announced = announcedConcerns[task.id] ?? []
        let fresh = concerns.filter { !announced.contains($0.kind.rawValue) }
        guard !fresh.isEmpty else { return }
        fresh.forEach { announced.insert($0.kind.rawValue) }
        announcedConcerns[task.id] = announced

        let body = fresh.map(\.explanation).joined(separator: "\n")
        Task { [weak self] in
            guard let self else { return }
            // The correction goes to the worker, not only to the report. Telling
            // the user about a bee heading the wrong way and saying nothing to
            // the bee is observation, not supervision - it leaves the only
            // available fix as a decision about wreckage.
            //
            // It cannot interrupt a stream in flight; it lands in the worker's
            // conversation, which is what it reads on its next turn. Steering
            // between deltas would need the transport to support it, and
            // claiming otherwise here would be a comment that lies.
            await self.appendCorrectionToWorkerChat(task: task, text: body)
            delegationRegistry.recordIntervention(taskID: task.id, text: body)

            let count = delegationRegistry.task(forIssue: task.issue)?
                .interventions.count ?? 1
            await self.appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "Watching \(task.worker) on \(task.issue.slug):\n\(body)\n"
                    + "I have said this in its chat - correction \(count) for this task. "
                    + "Nothing is cancelled: while it is still running there is something "
                    + "to steer, and after it finishes the only choice left is whether to "
                    + "keep the wreckage."
            )
        }
        for concern in fresh {
            TriosLogBus.shared.warn(
                .queen,
                "queen.observer.\(concern.kind.rawValue)",
                concern.explanation,
                ["issue": task.issue.slug, "worker": task.worker]
            )
        }
    }

    /// Cancels bees that stopped without saying so, and reports each one.
    ///
    /// A task stuck in `running` forever occupies a worker slot and hides real
    /// capacity, so the swarm quietly shrinks to nothing. This also catches
    /// **orphans** - tasks the registry shows as `.running` for which no turn
    /// was ever opened. A task transitioned to `.running` whose worker was
    /// never dispatched looks "working" to the sidebar, the slot counter, and
    /// the stall timer, while doing nothing at all (#1139).
    ///
    /// Every judgement here is read from facts the runner recorded as they
    /// happened - a turn opened, a byte at this time, the stream ended this
    /// way - rather than from sampling "is a stream running for this
    /// conversation right now". That sample is stale the moment it is taken.
    /// Asks the reviewer about every task parked in awaitingReview.
    ///
    /// Extracted from `handleWorkerFinished` because living there made it
    /// reachable only when a worker finished - and when nothing finishes,
    /// nothing sweeps. Three tasks sat in awaitingReview for fourteen hours
    /// with the sweep never running once: the log had `queen.review.posted`
    /// (a report) and not a single `queen.review.sweep`.
    ///
    /// `excluding` is the task whose worker just finished, handled by the
    /// caller directly. Nil when the sweep runs on a timer, because then
    /// there is no such task and every parked one is fair game.
    /// Commits a worker's changes from wherever that worker actually wrote.
    ///
    /// `commitWorkerChanges` assembles a tree by overlay from the SHARED
    /// checkout - correct while every bee edited that checkout, and wrong the
    /// moment they stopped. With worktrees the bee's edits live in its own
    /// directory, the shared tree is untouched (which is the whole point), and
    /// the overlay therefore committed nothing: `committedFiles: 0`,
    /// auto-accept refused for "no committed files", and the task parked in
    /// awaitingReview with its work stranded uncommitted in the worktree.
    ///
    /// `QueenBranchCommitter.commitInWorktree` already existed for exactly
    /// this, written under #1142 - documented, guarded against the shared
    /// checkout, staging only owned paths - and had no callers at all. It does
    /// now.
    /// A commit message this repository will actually accept.
    ///
    /// Every bee commit was rejected, silently as far as the Queen could see.
    /// The message began `queen(gHashTag/trios#1137):` and lefthook's
    /// `conventional` hook allows only feat|fix|docs|style|refactor|perf|test|
    /// chore|ci|build|revert - so `git commit` exited non-zero, the files
    /// stayed staged, `committedFiles` stayed 0, auto-accept refused for "no
    /// committed files", and no delegated task has ever reached a pull request.
    /// For the whole life of the swarm. The supervisor's own commit convention
    /// violated the repository's.
    ///
    /// The type is derived from what the bee was allowed to touch, which is the
    /// only evidence available without reading the diff: docs for prose, test
    /// for tests, fix otherwise. `Closes #N` in the body is L1 TRACEABILITY,
    /// which the old format also failed to satisfy.
    static func conventionalCommitMessage(task: DelegatedTask, note: String? = nil) -> String {
        let paths = task.ownedPaths
        let type: String
        if !paths.isEmpty, paths.allSatisfy({ $0.hasPrefix("docs/") || $0.hasSuffix(".md") }) {
            type = "docs"
        } else if !paths.isEmpty, paths.allSatisfy({ $0.contains("tests/") }) {
            type = "test"
        } else {
            type = "fix"
        }
        let subject = task.title.replacingOccurrences(of: "\n", with: " ")
        let head = note.map { "\(type)(trios): \($0) \(subject)" } ?? "\(type)(trios): \(subject)"
        return head + "\n\nCloses #\(task.issue.number)\n\nDelegated to \(task.worker) by the Trinity Queen."
    }

    private func commitWorkerOutput(
        task: DelegatedTask,
        branch: String,
        baselineTree: String?,
        message: String
    ) async -> QueenBranchCommitter.Outcome {
        if let worktree = task.worktreePath {
            return await QueenBranchCommitter.commitInWorktree(
                worktreePath: worktree,
                message: message,
                ownedPaths: task.ownedPaths
            )
        }
        return await QueenBranchCommitter.commitWorkerChanges(
            branch: branch,
            baselineTree: baselineTree,
            message: message,
            ownedPaths: task.ownedPaths
        )
    }

    func sweepAwaitingReview(excluding excluded: UUID?, trigger: String) async {
        let registry = delegationRegistry
        // ── #1156: every awaitingReview task gets its verdicts ──────────
        //
        // handleWorkerFinished asks the reviewer about the task whose worker
        // just finished. A second parallel task already in awaitingReview is
        // not re-examined: its criteria may be unanswered, auto-accept stays
        // gated, and nobody comes back to ask the reviewer. The task parks
        // in awaitingReview forever. This sweep closes that gap: every
        // awaitingReview task with unanswered criteria gets its verdicts
        // requested, then gets an auto-accept attempt — not just the one the
        // human named.
        //
        // The filter matches the primary flow above: nil verdicts only,
        // without the askedButUnanswered exclusion the original sweep had.
        // That exclusion made the sweep inert — a task whose first reviewer
        // request came back empty was permanently filtered out, so the sweep
        // never retried it and the task was stuck in awaitingReview with no
        // path to acceptance.
        let otherAwaiting = registry.tasks.filter {
            $0.state == .awaitingReview && $0.id != excluded
        }
        TriosLogBus.shared.info(
            .queen,
            "queen.review.sweep",
            "Sweeping \(otherAwaiting.count) other task(s) in awaitingReview",
            ["trigger": trigger]
        )
        var verdictsRequested = 0
        for other in otherAwaiting {
            let current = registry.task(forIssue: other.issue) ?? other
            var unanswered = current.acceptanceCriteria.filter {
                current.criterionVerdicts[$0] == nil
            }
            // Which fossils this pass re-asked, with the verdict each carried
            // in — so the reviewer's answer can be compared against it below.
            // A re-ask whose result nobody observes is a question with no
            // answer: the sweep would log that it asked, and the replacement
            // of the fossil would be indistinguishable from its survival
            // (#1132 criterion 3 — the run must SHOW the met, not hope for it).
            var reAskedFossils: [(criterion: String, was: QueenCriterionVerdict)] = []
            // A fossil verdict, re-asked (#1132 criterion 3). The sweep
            // treats any recorded verdict as settled, so an "unmet" carved
            // from the phantom-deletion diff — or recorded by the old empty
            // measurement that read absence into silence — stands forever:
            // send-backs run out, nothing re-asks the reviewer, and the task
            // parks on "1 criterion still unmet" while the very file the
            // criterion names sits on disk. #1130 sat through three runs on
            // exactly that fossil. Its signature is checkable: the verdict
            // says unmet, the criterion names a path, and the path exists.
            // A criterion whose file is genuinely absent keeps its verdict
            // untouched — that "unmet" is about the world, not about a
            // comparison someone made badly. Re-asked once per app run; the
            // reviewer's answer replaces the fossil and ends the asking.
            for criterion in current.acceptanceCriteria
            where !unanswered.contains(criterion) {
                guard current.criterionVerdicts[criterion] == .unmet else { continue }
                let mentioned = QueenAcceptancePolicy.pathsMentioned(in: criterion)
                guard !mentioned.isEmpty else { continue }
                let onDisk = mentioned.contains { path in
                    FileManager.default.fileExists(
                        atPath: ProjectPaths.root + "/"
                            + QueenDelegationPolicy.normalizePath(path)
                    )
                }
                guard onDisk else { continue }
                let key = current.id.uuidString + " ‖ " + criterion
                guard !reAskedPhantomVerdicts.contains(key) else { continue }
                reAskedPhantomVerdicts.insert(key)
                TriosLogBus.shared.info(
                    .queen,
                    "queen.review.reask_fossil",
                    "Re-asking an unmet verdict whose named file exists — the "
                        + "verdict may be a fossil of the phantom-deletion diff "
                        + "(#1132)",
                    [
                        "issue": current.issue.slug,
                        "criterion": String(criterion.prefix(80))
                    ]
                )
                unanswered.append(criterion)
                reAskedFossils.append((criterion, .unmet))
            }
            guard !unanswered.isEmpty else {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.review.sweep.skip",
                    "All criteria already have verdicts",
                    [
                        "issue": current.issue.slug,
                        "criteria": String(current.acceptanceCriteria.count)
                    ]
                )
                // All criteria have verdicts but the task is still in
                // awaitingReview — give it the same acceptance attempt
                // the primary task gets (line ~3770). Without this the
                // skip leaves the task parked forever (#1156).
                await autoAcceptIfUnambiguous(taskID: current.id)
                await actOnCompletedReview(taskID: current.id)
                continue
            }
            guard let branch = current.virtualBranch else {
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.review.sweep.skip",
                    "No virtual branch — cannot request verdicts",
                    [
                        "issue": current.issue.slug,
                        "unanswered": String(unanswered.count)
                    ]
                )
                continue
            }
            // The task may have been dispatched — and its baseline captured —
            // in an earlier process; after a restart the in-memory dictionary
            // is empty and the registry's persisted copy is the only one
            // left. Without this fallback the sweep handed the reviewer
            // "(No baseline snapshot — nothing to compare.)" for a task whose
            // baseline exists on disk, and a repeat review could not see what
            // the worker actually started from (#1132 criterion 3).
            let baseline = workerBaselineTrees[current.conversationId]
                ?? current.baselineTree
            let diffText = await diffForReview(
                baselineTree: baseline,
                branch: branch,
                ownedPaths: current.ownedPaths
            )
            let touchedFiles = await fileContentsForReview(
                baselineTree: baseline,
                ownedPaths: current.ownedPaths,
                criteria: unanswered,
                branch: branch
            )
            let returned = await requestReviewerVerdicts(
                for: current,
                criteria: unanswered,
                diff: diffText,
                fileContents: touchedFiles
            )
            verdictsRequested += 1
            // The fossil's fate, read back from the registry rather than
            // assumed from the request (#1132 criterion 3). The reviewer was
            // asked; the answer is whatever the task now carries. A replaced
            // fossil and a surviving one get different, named events, so a
            // re-ask that changed nothing cannot read as one that worked —
            // and the verdict that ended #1130's parking is on the record
            // with its before and after, not only in the reviewer's prose.
            if !reAskedFossils.isEmpty,
               let after = registry.task(forIssue: current.issue) {
                for fossil in reAskedFossils {
                    let now = after.criterionVerdicts[fossil.criterion]
                    if now == nil || now == fossil.was {
                        TriosLogBus.shared.info(
                            .queen,
                            "queen.review.fossil_stood",
                            "Re-asked \(current.issue.slug); the reviewer left "
                                + "the verdict as it was (\(fossil.was.rawValue))",
                            [
                                "issue": current.issue.slug,
                                "criterion": String(fossil.criterion.prefix(80)),
                                "verdict": fossil.was.rawValue
                            ]
                        )
                    } else {
                        TriosLogBus.shared.info(
                            .queen,
                            "queen.review.fossil_replaced",
                            "Re-asked \(current.issue.slug); verdict replaced: "
                                + "\(fossil.was.rawValue) → \(now?.rawValue ?? "?")",
                            [
                                "issue": current.issue.slug,
                                "criterion": String(fossil.criterion.prefix(80)),
                                "was": fossil.was.rawValue,
                                "now": now?.rawValue ?? "?"
                            ]
                        )
                    }
                }
            }
            TriosLogBus.shared.info(
                .queen,
                "queen.review.sweep.requested",
                "Requested verdicts for \(unanswered.count) criterion(s); reviewer returned \(returned)",
                [
                    "issue": current.issue.slug,
                    "asked": String(unanswered.count),
                    "returned": String(returned)
                ]
            )
            await autoAcceptIfUnambiguous(taskID: current.id)
            await actOnCompletedReview(taskID: current.id)
        }
        TriosLogBus.shared.info(
            .queen,
            "queen.review.sweep.done",
            "Sweep complete: \(otherAwaiting.count) considered, \(verdictsRequested) got verdicts",
            ["trigger": trigger]
        )
    }

    func reapStalledWorkers(now: Date = Date()) async {
        let registry = delegationRegistry

        // Orphans: the registry says .running but no turn was ever opened for
        // it. Caught immediately rather than waiting the stall threshold,
        // because a task that was never dispatched looks "working" to every
        // other part of the system while doing nothing.
        //
        // Read off the runner's record of the task, not off "is a stream
        // running right now". That question answers no both for a task nobody
        // ever started and for a worker that streamed for an hour and stopped
        // a moment ago, and treating the second as the first is how a finished
        // worker got reaped 0.7s after it finished (#1247, #1248).
        let orphaned = registry.running.filter(QueenDelegationPolicy.wasNeverStarted)
        let stalled = registry.stalled(now: now)
        // Deduplicate: a task can be both orphaned and stalled, but it only
        // needs to be processed once.
        var seen = Set<UUID>()
        let toProcess = (orphaned + stalled).filter { seen.insert($0.id).inserted }
        guard !toProcess.isEmpty else { return }

        for task in toProcess {
            // Only reap what has genuinely stopped. A long stream is not a
            // stall - and the runner says whether this one is still in flight,
            // so nothing here has to guess from the absence of a stream object.
            // Re-read it rather than trusting the copy taken before the loop:
            // this function awaits on every iteration, so by the time a later
            // task is reached its turn may have been restarted - by the resume
            // branch below, or by a sweep that interleaved with this one.
            let current = registry.task(forConversation: task.conversationId) ?? task
            // `isStreamAlive`, not `isStreamOpen`: a stream that opened and
            // never delivered a byte is open and dead at the same time, and
            // asking only whether it is open let one hold a slot indefinitely
            // (#1275). A stream that has spoken is still protected in full.
            guard !QueenDelegationPolicy.isStreamAlive(current, now: now) else { continue }

            // #1219: A connectivity failure is not the worker's fault. Retry
            // without counting a resume attempt — the stall was outside its
            // control. The task was left in .running by handleWorkerFinished
            // specifically so this path would pick it up.
            if connectivityFailedTasks.contains(task.id), let runner = workerRunner {
                connectivityFailedTasks.remove(task.id)
                let brief = QueenBriefing.text(for: task)
                    + "\n\nYour previous attempt could not reach the network. "
                    + "Continue from where you left off in this same chat and on "
                    + "the same branch."
                runner.start(task: task, brief: brief)
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.infoMarker
                        + "\(task.worker) is being retried on \(task.issue.slug) after "
                        + "a connectivity failure — no resume attempt counted."
                )
                TriosLogBus.shared.info(
                    .queen,
                    "queen.worker.connectivity_retry",
                    "Retrying a worker that failed on connectivity",
                    ["issue": task.issue.slug, "worker": task.worker]
                )
                continue
            }

            // Try to finish the work before writing it off. A silent worker is
            // a chat left mid-sentence, and closing it converts "unfinished"
            // into "abandoned" while learning nothing about why it stopped.
            let alreadyTried = task.resumeAttempts ?? 0
            if alreadyTried < QueenDelegationPolicy.maxResumeAttempts, let runner = workerRunner {
                let attempt = registry.recordResumeAttempt(taskID: task.id)
                let brief = QueenBriefing.text(for: task)
                    + "\n\nYour stream stopped without a result. Continue from where you "
                    + "left off in this same chat and on the same branch - do not start "
                    + "over. If you cannot finish, say plainly what blocked you."
                // Keep the baseline from the first turn's start (set at
                // delegation, line ~3294). A fresh snapshot here would swallow
                // everything the first turn already wrote — those files would
                // vanish from the diff at commit time because the baseline now
                // includes them (#1155).
                runner.start(task: task, brief: brief)
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.infoMarker
                        + "\(task.worker) went quiet on \(task.issue.slug), so I restarted it "
                        + "in the same chat - attempt \(attempt) of "
                        + "\(QueenDelegationPolicy.maxResumeAttempts). Same branch, so it "
                        + "continues rather than competing with its own earlier work."
                )
                TriosLogBus.shared.info(
                    .queen,
                    "queen.worker.resumed",
                    "Restarted a silent worker",
                    ["issue": task.issue.slug, "worker": task.worker, "attempt": "\(attempt)", "completedTurns": "\(task.completedTurns ?? 0)"]
                )
                continue
            }

            guard registry.transition(taskID: task.id, to: .cancelled) else { continue }
            // A cancelled worker's edits are as unattributed as a failed one's.
            // Settle them the same way before clearing the baseline.
            let (settlement, _, _) = await settleFailedWorkerEdits(
                task: task,
                reason: "cancelled after exhausting restarts"
            )
            workerBaselineTrees[task.conversationId] = nil
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "I closed \(task.issue.slug). \(task.worker) went silent and did not "
                    + "come back after \(alreadyTried) restart"
                    + (alreadyTried == 1 ? "" : "s") + ", so this is not a stall I can "
                    + "clear by asking again. Its branch and chat survive, so nothing is "
                    + "lost - but treat the task as unanswered rather than attempted."
                    + "\n" + settlement
            )
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.reaped",
                "Cancelled a stalled worker after exhausting restarts",
                ["issue": task.issue.slug, "worker": task.worker, "attempts": "\(alreadyTried)"]
            )
        }
        registry.pruneArchive()

        // Drifting: streaming and idle at once. The scan above deliberately
        // skips every stream-alive worker - bytes are evidence of life - but
        // measured 2026-08-22, a bee heartbeated for two and a half hours
        // with its boundary file untouched since the fourth minute, at a
        // cost invisible under an unmetered server. The boundary is the
        // evidence of WORK, so a long turn that has not touched it drifts.
        // The turn stops and the task goes to review, where its committed
        // state is judged like any finished turn - not to failure: the
        // stream WAS delivering, and earlier turns' commits may stand.
        for task in registry.running {
            let current = registry.task(forConversation: task.conversationId) ?? task
            guard current.state == .running else { continue }
            let touched = Self.boundaryLastTouched(task: current)
            guard QueenDelegationPolicy.isDrifting(
                current, boundaryTouchedAt: touched, now: now
            ) else { continue }
            let turnStart = current.streamOpenedAt ?? current.updatedAt
            let streamedMinutes = Int(now.timeIntervalSince(turnStart) / 60)
            workerRunner?.stop(conversationId: current.conversationId)
            guard registry.transition(taskID: current.id, to: .awaitingReview) else { continue }
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.drifting",
                "Stopped \(current.issue.slug): the stream spoke for "
                    + "\(streamedMinutes) minute(s) while the boundary went "
                    + "untouched the whole drift window - streaming is not working",
                ["issue": current.issue.slug, "streamed_minutes": "\(streamedMinutes)"]
            )
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "I stopped \(current.worker) on \(current.issue.slug): "
                    + "\(streamedMinutes) minutes of stream with no change to its "
                    + "boundary files. The turn is in review; whatever earlier "
                    + "turns committed still stands."
            )
        }
    }

    /// When any of the task's owned files in ITS OWN worktree last changed,
    /// or nil when none exists or none can be measured. The caller treats
    /// nil as "no work since the turn began", which is exactly what a
    /// missing worktree or an untouched boundary both mean here.
    nonisolated private static func boundaryLastTouched(task: DelegatedTask) -> Date? {
        let worktree = QueenWorktree.path(
            forIssue: task.issue.number,
            projectRoot: ProjectPaths.root,
            variant: ProjectPaths.variant.rawValue
        )
        let fm = FileManager.default
        var newest: Date?
        for owned in task.ownedPaths {
            let path = worktree + "/trios/" + QueenDelegationPolicy.normalizePath(owned)
            if let attrs = try? fm.attributesOfItem(atPath: path),
               let mtime = attrs[.modificationDate] as? Date {
                if newest == nil || mtime > newest! { newest = mtime }
            }
        }
        return newest
    }

    /// A word from the Queen, which belongs in the Queen's chat.
    ///
    /// This used to append to `messages` - whatever conversation happens to be
    /// open. Every caller reached through /delegate is fine, because
    /// runQueenCommand switches to her chat first. The callers that are not are
    /// the ones that matter: a worker finishing, the observer noticing a stray
    /// write, the review scheduler waking. Those fire while the user is
    /// watching a bee, and her words landed in that bee's chat - the supervisor
    /// talking into the wrong room, and her own chat silent about work she was
    /// supervising.
    ///
    /// Not private, so a test can call it with some other conversation open.
    /// The routing is the whole behaviour and there is no other way in: every
    /// caller that reaches it through a command has already switched away from
    /// the case worth proving.
    func postQueenNotice(_ text: String) async {
        await appendSystemMessageToQueenChat(text)
    }

    // MARK: - gh binary resolution

    nonisolated(unsafe) private static var _cachedGhPath: String?
    nonisolated(unsafe) private static var _ghPathResolved = false
    nonisolated private static let _ghLock = NSLock()

    /// Resolves the `gh` binary path without relying on the process PATH.
    ///
    /// Apps launched via `open` (Finder) inherit a minimal PATH that omits
    /// `/opt/homebrew/bin`, so `command -v gh` returns empty and the Queen
    /// goes silent forever.  This helper checks three well-known locations
    /// first, falls back to the shell probe only when none exist, caches
    /// the result, and logs where `gh` was found — or that it was nowhere.
    nonisolated private static func resolveGhPath() -> String {
        _ghLock.lock()
        defer { _ghLock.unlock() }
        if _ghPathResolved { return _cachedGhPath ?? "" }
        _ghPathResolved = true

        for path in ["/opt/homebrew/bin/gh",
                     "/usr/local/bin/gh",
                     "/usr/bin/gh"]
        {
            if FileManager.default.fileExists(atPath: path) {
                _cachedGhPath = path
                TriosLogBus.shared.info(
                    .queen, "queen.gh",
                    "gh found at \(path)",
                    ["path": path, "source": "FileManager"]
                )
                return path
            }
        }

        // Last resort: the inherited PATH may still find it.
        let probed = QueenStatusViewModel.runProcess(
            "/bin/sh",
            arguments: ["-c", "command -v gh"],
            workDir: ProjectPaths.root,
            timeout: 5
        )
        if !probed.isEmpty {
            _cachedGhPath = probed
            TriosLogBus.shared.info(
                .queen, "queen.gh",
                "gh found at \(probed) via command -v",
                ["path": probed, "source": "PATH"]
            )
            return probed
        }

        TriosLogBus.shared.warn(
            .queen, "queen.gh",
            "gh not found in any known location or on PATH",
            ["source": "nowhere"]
        )
        return ""
    }

    /// Returns a GitHub token for the timeline read, trying each source in
    /// order and stopping at the first that has one:
    ///
    /// 1. The Keychain item `GitHubAPIClient` reads (same service and account).
    /// 2. The value of `TRIOS_GITHUB_TOKEN` in `~/.trios/config.json`, read
    ///    only when that file is readable by its owner alone.
    ///
    /// Returns `nil` when neither source has a token. The token itself is
    /// never logged — only which source supplied it.
    /// One token source for every GitHub read.
    ///
    /// Static because the issue-body fetcher is built in `init`, before `self`
    /// exists, and an instance method is therefore unreachable from it. That is
    /// the whole reason the fallback GET went out unauthenticated for as long
    /// as it did - not a decision, an ordering.
    private nonisolated(unsafe) static var ghTokenCache: String??
    // Same reason as the cache above: `cachedGhToken` is nonisolated, so a
    // main-actor-isolated lock is unreachable from it. Five warnings, and an
    // error in Swift 6.
    private nonisolated static let ghTokenLock = NSLock()

    /// `gh auth token`, at most once per process, with a hard deadline.
    nonisolated static func cachedGhToken() -> String? {
        ghTokenLock.lock()
        if let cached = ghTokenCache {
            ghTokenLock.unlock()
            return cached
        }
        ghTokenLock.unlock()

        var resolved: String?
        for path in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"] {
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = ["auth", "token"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            guard (try? process.run()) != nil else { continue }
            let deadline = Date().addingTimeInterval(3)
            while process.isRunning, Date() < deadline {
                usleep(50_000)
            }
            if process.isRunning {
                process.terminate()
                break
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let token = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !token.isEmpty { resolved = token }
            break
        }

        ghTokenLock.lock()
        ghTokenCache = .some(resolved)
        ghTokenLock.unlock()
        return resolved
    }

    nonisolated static func githubToken() -> String? {
        githubTokenSource()
    }

    nonisolated func githubTokenForTimeline() -> String? {
        Self.githubTokenSource()
    }

    /// Step 2 of ``githubTokenSource()``, extracted so that "no token here" is
    /// `nil` rather than the end of the walk.
    ///
    /// The file is read only when it is readable by its owner alone: no group
    /// read (0o040), no other read (0o004).
    nonisolated private static func tokenFromConfigFile() -> String? {
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".trios/config.json")
        guard FileManager.default.fileExists(atPath: configPath.path) else { return nil }
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: configPath.path)
            guard let permNumber = attrs[.posixPermissions] as? NSNumber else { return nil }
            let perms = UInt16(permNumber.intValue)
            guard perms & 0o044 == 0 else { return nil }
            let data = try Data(contentsOf: configPath)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["TRIOS_GITHUB_TOKEN"] as? String,
                  !token.filter({ !$0.isWhitespace }).isEmpty
            else { return nil }
            return token
        } catch {
            return nil
        }
    }

    nonisolated static func githubTokenSource() -> String? {
        // 1. Keychain — same service/account as GitHubAPIClient.
        if let token = try? KeychainSecrets.read(
            service: "ai.browseros.trios",
            account: "github-token",
            // Never a dialog for this one. `readData`'s own comment says a
            // re-fetchable token is not worth a modal prompt, and the default
            // here was `true`: the read blocked on securityd waiting for an ACL
            // approval nobody could give, hit the two-second deadline, and
            // armed the sixty-second cooldown that made every OTHER keychain
            // read - including the provider key - answer "nothing there".
            //
            // The warm-up retries every 65 seconds, just after the cooldown
            // lapses, and stalls again. That cadence kept the Keychain
            // unusable more or less permanently, and the swarm idle with it.
            allowsInteraction: false
        ), !token.filter({ !$0.isWhitespace }).isEmpty {
            TriosLogBus.shared.info(
                .queen, "queen.choose",
                "Timeline token sourced from Keychain",
                [:]
            )
            return token
        }

        // 2. ~/.trios/config.json — owner-only readable.
        //
        // A MISS HERE MUST FALL THROUGH. Every miss used to `return nil`, which
        // made steps 3 and 4 unreachable - the compiler said "will never be
        // executed" and the warning gate was red when this landed. On this
        // machine that severed the chain at exactly the wrong link: the file
        // exists, it is 0600, and it has no TRIOS_GITHUB_TOKEN, so the walk
        // ended at step 2 and never reached the environment or `gh auth token`
        // - and `gh` is the source that actually answers here. A list of four
        // sources that stops at the second is a list of two.
        if let token = tokenFromConfigFile() {
            TriosLogBus.shared.info(
                .queen, "queen.choose",
                "Timeline token sourced from config file",
                [:]
            )
            return token
        }

        // 3. GITHUB_TOKEN / GH_TOKEN. The standard names, and the ones every
        //    other tool on the machine already honours. She was the only thing
        //    here that did not look at them.
        for name in ["GITHUB_TOKEN", "GH_TOKEN"] {
            if let value = ProcessInfo.processInfo.environment[name],
               !value.filter({ !$0.isWhitespace }).isEmpty {
                return value
            }
        }

        // 4. `gh auth token`, once per process.
        //
        //    `gh` on this machine is authenticated and keeps its token in the
        //    keyring rather than in `~/.config/gh/hosts.yml`, so the file
        //    cannot be read - only the command can answer.
        //
        //    Cached and hard-limited on purpose. A gh subprocess on every
        //    scoring call once added ~38 seconds and broke launches from
        //    Finder; that was an unbounded call per use, not a bounded call
        //    once. Three seconds, one attempt, and the answer is kept whether
        //    it succeeded or not so a failure cannot become a per-call cost.
        return Self.cachedGhToken()

    }

    /// Reads open sub-issues of epic #1090 from the GitHub timeline over HTTPS
    /// and, on success, persists them to the sub-issue store with a fresh
    /// `readAt`.  Returns the parsed sub-issues, whether the network call
    /// succeeded, and a failure message.  Used by both `chooseNextOpenIssue`
    /// and the hourly background refresh in `configureWorkerRunner` (#1215).
    /// Does not choose, propose, or delegate — it only reads and stores.
    private func fetchAndStoreSubIssues() async -> (
        subIssues: [(number: Int, title: String, body: String)],
        networkOK: Bool,
        failureMessage: String
    ) {
        let storePath = "\(ProjectPaths.trinity)/state/queen_subissues.json"
        var seen = Set<Int>()
        var subIssues: [(number: Int, title: String, body: String)] = []

        // Every configured epic, not one. The number used to be written into
        // the URL, which was fine while there was one epic and became a wall
        // the moment there were two: six well-formed sub-issues under #1279
        // were invisible to a Queen that reported "all 24 candidates look
        // already done".
        var networkOK = false
        var failureMessage = ""
        for epic in QueenEpics.configured {
            guard let url = QueenEpics.timelineURL(epic: epic) else { continue }
            var timelineRequest = URLRequest(url: url)
            timelineRequest.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            if let token = githubTokenForTimeline() {
                timelineRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }

            var timelineData = Data()
            var epicOK = false
            do {
                let (data, response) = try await URLSession.shared.data(for: timelineRequest)
                timelineData = data
                if let httpResp = response as? HTTPURLResponse,
                   (200...299).contains(httpResp.statusCode) {
                    epicOK = true
                } else {
                    let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                    // Named, because "HTTP 404" without the epic is a message
                    // that cannot be acted on when there is more than one.
                    failureMessage = "#\(epic): HTTP \(code)"
                }
            } catch {
                failureMessage = "#\(epic): \(error.localizedDescription)"
            }

            // One reachable epic is enough to have read the board. Treating a
            // single unreachable epic as total failure would let a typo in one
            // number stop work that is sitting open in another.
            if epicOK { networkOK = true } else { continue }

            if let events = try? JSONSerialization.jsonObject(with: timelineData) as? [[String: Any]] {
                for event in events {
                    guard event["event"] as? String == "cross-referenced" else { continue }
                    guard let source = event["source"] as? [String: Any],
                          let issue = source["issue"] as? [String: Any] else { continue }
                    guard issue["state"] as? String == "open" else { continue }
                    guard let number = issue["number"] as? Int else { continue }
                    let title = issue["title"] as? String ?? ""
                    let body = issue["body"] as? String ?? ""
                    if seen.insert(number).inserted {
                        subIssues.append((number, title, body))
                    }
                }
            }
        }

        if networkOK {

            let storePayload: [String: Any] = [
                "readAt": ISO8601DateFormatter().string(from: Date()),
                "issues": subIssues.map { iss -> [String: Any] in
                    [
                        "number": iss.number,
                        "title": iss.title,
                        "body": iss.body,
                        "state": "open",
                    ]
                },
            ]
            if let storeJSON = try? JSONSerialization.data(
                withJSONObject: storePayload, options: [.prettyPrinted]
            ) {
                try? FileManager.default.createDirectory(
                    atPath: (storePath as NSString).deletingLastPathComponent,
                    withIntermediateDirectories: true
                )
                try? storeJSON.write(to: URL(fileURLWithPath: storePath))
            }
        }

        return (subIssues, networkOK, failureMessage)
    }

    /// Picks the next open sub-issue to act on and says why.
    ///
    /// Reads the **open sub-issues of epic gHashTag/trios#1090 through `gh`**
    /// (GitHub CLI), not the local delegation registry, so the choice reflects
    /// what is actually open on GitHub — not what the registry happens to know.
    /// Sub-issues already in flight (a running worker is attached) are excluded.
    ///
    /// Says distinctly when `gh` is unavailable (not installed, network error,
    /// auth failure) versus when there is genuinely nothing to choose.
    ///
    /// The choice is logged as a separate event so it can be audited: a
    /// decision that is not recorded might as well not have been made.
    /// How often the Queen looks for work of her own accord.
    ///
    /// Five minutes, not five seconds: every tick that finds capacity opens a
    /// real chat against a real provider, and the point is a supervisor who
    /// keeps the swarm busy, not one who empties the backlog into four chats
    /// the moment the app launches. Every tick that finds no capacity is free.
    nonisolated static let queenAutonomyInterval: UInt64 = 300_000_000_000

    /// Whether the Queen may pick and start work without being asked.
    ///
    /// The gate that used to say no is `approvalBlockReason`, whose comment
    /// reads: *a supervisor that can start work unprompted is not a supervisor,
    /// it is a second author with a budget*. That was the right default while
    /// nobody had asked for the other behaviour. It has now been asked for
    /// explicitly, so the answer is the operator's, not the code's - and it is
    /// a stored preference rather than a constant, because withdrawing consent
    /// must be as easy as giving it.
    ///
    /// Defaults to ON in release and OFF in dev and test - see
    /// `BuildVariant.autonomyDefault` for why exactly one variant may start
    /// work unprompted. The comment here used to claim the opposite ("on in the
    /// supervisor variants, unavailable in release"), which was true before
    /// `hasSupervisorInbox` became true everywhere and was never corrected.
    ///
    /// Instance access forwards to the static below so the two cannot drift.
    /// They already had: this property had a setter and, for as long as it
    /// existed, not one caller. The default was therefore the only value it
    /// ever held, which is why dev - where the default is OFF - could not be
    /// driven at all. A stored preference nobody can store is a constant.
    var queenAutonomyEnabled: Bool {
        get { Self.storedAutonomyPreference }
        set { Self.storedAutonomyPreference = newValue }
    }

    /// The operator's answer, readable and writable from the view layer.
    ///
    /// `nonisolated` because the control that flips it is a SwiftUI toggle in
    /// the supervisor strip, and routing a checkbox through the actor to set a
    /// UserDefaults key would buy nothing.
    nonisolated static var storedAutonomyPreference: Bool {
        get {
            UserDefaults.standard.object(forKey: queenAutonomyKey) as? Bool
                ?? ProjectPaths.autonomyDefault
        }
        set {
            UserDefaults.standard.set(newValue, forKey: queenAutonomyKey)
        }
    }

    nonisolated static var queenAutonomyKey: String {
        "queen.autonomy.enabled.\(ProjectPaths.variant.rawValue)"
    }

    /// Why the Queen will not pick up work on this tick, or nil if she will.
    ///
    /// Pure and separately testable, because the loop around it is a timer and
    /// a timer is the one thing a test cannot wait for honestly. Every reason
    /// is a state the swarm is legitimately in - none of them is an error.
    nonisolated static func autonomyBlockReason(
        enabled: Bool,
        hasInbox: Bool,
        runningWorkers: Int,
        budgetActive: Bool,
        hasProviderKey: Bool = true
    ) -> String? {
        guard hasInbox else { return "this build has no supervisor inbox" }
        guard enabled else { return "autonomy is switched off" }
        guard budgetActive else { return "the safety budget is spent or halted" }
        // Choosing without a key is not work, it is churn. Dispatch refuses at
        // the end of the same tick, the task is left queued, the reaper
        // cancels it ten minutes later, and the next tick chooses it again -
        // cutting a fresh branch each round. #1284 and #1285 cycled that way
        // through r1, r2, r3, r4 while nothing could possibly start.
        //
        // The reaper turned a permanent deadlock into a permanent spin. Both
        // are wrong; this is the condition that makes the whole round
        // pointless, so it belongs before the choosing rather than after it.
        guard hasProviderKey else {
            return "the provider key resolves empty, so nothing could be "
                + "dispatched even if an issue were chosen"
        }
        guard QueenDelegationPolicy.canStartAnother(running: runningWorkers) else {
            return "\(runningWorkers) workers already running "
                + "(limit \(QueenDelegationPolicy.maximumConcurrentWorkers))"
        }
        return nil
    }

    /// The Queen picks her own next issue and opens a chat for it, repeatedly.
    ///
    /// Everything this needs already existed and was never called on its own:
    /// `chooseNextOpenIssue(startAfterChoosing: true)` reads the open
    /// sub-issues of the epic, scores them, and delegates the winner through
    /// the same path `/delegate` takes - approval, capacity, path conflicts,
    /// budget, branch, dispatch. The only two callers were the `/choose`
    /// command and the launch bootstrap, and the bootstrap passed `false`: it
    /// named an issue and asked a human to type the next command.
    ///
    /// So the missing piece was never a mechanism. It was that nobody called
    /// the mechanism.
    ///
    /// Asynchronous by construction rather than by promise: the dispatch path
    /// this reaches runs each entry in its own task, up to three at a time,
    /// under a ceiling of four running workers.
    func startQueenAutonomyLoop() {
        guard ProjectPaths.hasSupervisorInbox else { return }
        queenAutonomyTask?.cancel()
        queenAutonomyTask = Task { [weak self] in
            // A short first delay so the effect is observable without waiting
            // five minutes, and so the launch bootstrap's own choice lands
            // first rather than racing this one for the same issue.
            var delay: UInt64 = 60_000_000_000
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled, let self else { break }
                delay = Self.queenAutonomyInterval
                await self.reapUndispatchedTasks()
                await self.queenAutonomyTick()
            }
        }
    }

    /// Shows what disagrees and, on a word from the operator, fixes one.
    ///
    /// `/reconcile` never changes anything. `/reconcile apply 2` changes
    /// exactly one thing, and `apply all` works through the list. Showing and
    /// doing are separate words rather than a flag, because a typo in a flag
    /// should not be the difference between a report and an edit.
    ///
    /// Why the Queen does not simply repair her own record on a timer: a
    /// registry that is made to agree with the repository by construction
    /// stops being evidence about anything. The disagreement is the finding.
    private func handleReconcileCommand(apply: String?) async {
        let proposals = await gatherReconciliationProposals()
        guard !proposals.isEmpty else {
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.infoMarker
                    + "The record and the repository agree on every task."
            )
            return
        }

        guard let apply else {
            var lines = ["\(proposals.count) proposal(s). Apply with `/reconcile apply <n>` "
                + "or `/reconcile apply all`."]
            for (index, item) in proposals.enumerated() {
                if let line = QueenReconciliation.describeCorrection(
                    index: index + 1, issue: item.task.issue.slug, correction: item.correction
                ) {
                    lines.append(line)
                }
            }
            await appendSystemMessageToQueenChat(lines.joined(separator: "\n"))
            return
        }

        let words = apply.split(separator: " ").map(String.init)
        guard words.first?.lowercased() == "apply" else {
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "I understand `/reconcile` and `/reconcile apply <n>`; "
                    + "`\(apply)` is neither."
            )
            return
        }
        let target = words.count > 1 ? words[1].lowercased() : ""
        let chosen: [Int]
        if target == "all" {
            chosen = Array(proposals.indices)
        } else if let n = Int(target), n >= 1, n <= proposals.count {
            chosen = [n - 1]
        } else {
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "There are \(proposals.count) proposals; `\(target)` is not one of them."
            )
            return
        }

        var done: [String] = []
        for index in chosen {
            let item = proposals[index]
            switch item.correction {
            case .none:
                continue
            case .sendToReview:
                guard delegationRegistry.transition(
                    taskID: item.task.id, to: .awaitingReview
                ) else {
                    done.append("\(item.task.issue.slug): refused - "
                        + (delegationRegistry.lastError ?? "illegal transition"))
                    continue
                }
                done.append("\(item.task.issue.slug): moved into review")
            case .clearUnsupportedCount:
                delegationRegistry.recordCommittedFiles(taskID: item.task.id, count: 0)
                done.append("\(item.task.issue.slug): file count cleared")
            }
            TriosLogBus.shared.info(
                .queen, "queen.reconcile.applied",
                "\(item.task.issue.slug): correction applied on the operator's word",
                ["issue": item.task.issue.slug]
            )
        }
        await appendSystemMessageToQueenChat(
            done.isEmpty ? "Nothing to apply." : done.joined(separator: "\n")
        )
    }

    /// Every task whose record disagrees with the repository, with what to do.
    private func gatherReconciliationProposals() async
        -> [(task: DelegatedTask, correction: QueenReconciliation.Correction)]
    {
        var out: [(DelegatedTask, QueenReconciliation.Correction)] = []
        for task in delegationRegistry.tasks {
            let facts = await QueenBranchCommitter.repositoryFacts(
                branch: task.virtualBranch,
                commitSHA: task.committedSHA,
                baseRef: "HEAD"
            )
            let finding = QueenReconciliation.check(
                state: task.state,
                committedFiles: task.committedFiles,
                committedSHA: task.committedSHA,
                facts: facts
            )
            let correction = QueenReconciliation.correction(for: finding)
            if correction.needsOperator { out.append((task, correction)) }
        }
        return out
    }

    /// Cancels queued tasks whose dispatch never happened.
    ///
    /// A queued task holds its file boundary, so until it is settled its own
    /// issue can never be chosen again - the Queen looks at the issue, finds a
    /// live task owning exactly those paths, and refuses. Four issues were
    /// frozen that way, two of them the start of the T27 migration, while the
    /// log said "all 26 candidates look already done".
    ///
    /// Cancelled rather than failed: nobody failed. The dispatch did not
    /// happen, and `cancelled` is the state that says so without accusing a
    /// worker that never ran.
    func reapUndispatchedTasks() async {
        let registry = delegationRegistry
        for task in registry.tasks {
            guard let reason = QueenDelegationPolicy.staleQueuedReason(
                state: task.state,
                createdAt: task.createdAt,
                streamOutcome: task.streamOutcome,
                completedTurns: task.completedTurns
            ) else { continue }
            guard registry.transition(taskID: task.id, to: .cancelled) else { continue }
            TriosLogBus.shared.warn(
                .queen, "queen.task.undispatched",
                "\(task.issue.slug) cancelled: \(reason)",
                ["issue": task.issue.slug]
            )
            await appendSystemMessageToQueenChat(
                SystemNoticeClassifier.warningMarker
                    + "\(task.issue.slug): \(reason). Its issue is choosable again."
            )
        }
    }

    /// Says out loud where the record and the repository disagree.
    ///
    /// The registry is a claim; the repository is a fact; nothing compared
    /// them. A hand scan of thirty-five tasks found twenty-two branches
    /// carrying the bees' own commits, eleven of them belonging to tasks the
    /// registry called `queued` or `failed` - work that exists and that nobody
    /// is looking at. One task was `accepted` with a branch that is gone.
    ///
    /// Reports; does not correct. Advancing a state from a git scan is a
    /// judgement about work nobody reviewed. Saying the two disagree is not,
    /// and it is the half that was missing.
    func reconcileRecordAgainstRepository() async {
        let tasks = delegationRegistry.tasks
        guard !tasks.isEmpty else { return }
        // HEAD, not a named branch. `dev..branch` counts every commit on the
        // current working branch as well - the first run of this reported "507
        // commits" for a bee that made one, which is the third time I have
        // compared against the wrong base and the second time after writing a
        // warning about it into the helper's own comment.
        //
        // `HEAD..branch` is exactly "commits on that branch that are not
        // already here", which is the bee's own work and nothing else.
        let base = "HEAD"
        var findings: [QueenReconciliation.Finding] = []
        var urgentLines: [String] = []

        for task in tasks {
            var facts = await QueenBranchCommitter.repositoryFacts(
                branch: task.virtualBranch,
                commitSHA: task.committedSHA,
                baseRef: base
            )
            // Git cannot know the registry. Whether a SIBLING record on the
            // same issue or branch expects work is what separates "nobody is
            // looking at it" from "it is in the review queue under another
            // record" - the per-record view without this printed the former
            // about the latter, twice, on 2026-08-21.
            facts.siblingExpectsWork = tasks.contains { other in
                other.id != task.id
                    && QueenReconciliation.statesThatExpectWork.contains(other.state)
                    && (other.issue.slug == task.issue.slug
                        || (other.virtualBranch != nil
                            && other.virtualBranch == task.virtualBranch))
            }
            // An archived record whose branch was cleaned afterwards is
            // lifecycle, not loss - the debris sweep of 2026-08-21 turned
            // twelve old records into urgent disagreements without this bit.
            facts.recordArchived = task.archivedAt != nil
            let finding = QueenReconciliation.check(
                state: task.state,
                committedFiles: task.committedFiles,
                committedSHA: task.committedSHA,
                facts: facts
            )
            findings.append(finding)
            guard finding.isUrgent else { continue }
            let line = QueenReconciliation.describe(
                issue: task.issue.slug, finding: finding
            )
            urgentLines.append(line)
            TriosLogBus.shared.warn(
                .queen, "queen.reconcile.disagrees", line,
                ["issue": task.issue.slug, "state": task.state.rawValue]
            )
        }

        let summary = QueenReconciliation.summary(findings: findings)
        TriosLogBus.shared.info(.queen, "queen.reconcile", summary, [:])

        // Silence when everything agrees. A notice every launch saying nothing
        // is wrong trains the reader to skip the one that says something is.
        guard !urgentLines.isEmpty else { return }
        await postQueenNotice(
            SystemNoticeClassifier.warningMarker
                + summary + "\n" + urgentLines.prefix(8).joined(separator: "\n")
                + (urgentLines.count > 8
                    ? "\n...and \(urgentLines.count - 8) more"
                    : "")
        )
    }

    /// Removes the checkouts of tasks that have finished.
    ///
    /// A sweep rather than a hook on each terminal transition: there are six
    /// places a task can settle, and a cleanup wired to five of them leaves
    /// directories on disk in exactly the case nobody tested. Idempotent, so
    /// running it every tick costs nothing when there is nothing to do.
    func releaseSettledWorktrees() async {
        let settled = delegationRegistry.tasks.filter {
            $0.state.isTerminal && $0.worktreePath != nil
        }
        for task in settled {
            await releaseWorktree(for: task)
            delegationRegistry.clearWorktreePath(taskID: task.id)
        }
    }

    func queenAutonomyTick() async {
        // Before the capacity check, not after: a finished bee's checkout must
        // be released even on the ticks where there is no room to start a new
        // one, which is exactly when the swarm is busiest.
        await releaseSettledWorktrees()
        // And ask the reviewer about anything parked. The sweep used to run
        // only when a worker finished, so when nothing finished nothing swept:
        // three tasks sat in awaitingReview for fourteen hours while the tick
        // beside them kept choosing new work.
        await sweepAwaitingReview(excluding: nil, trigger: "autonomy tick")
        let budget = QueenSelfImprovementService.loadBudget()
        if let reason = Self.autonomyBlockReason(
            enabled: queenAutonomyEnabled,
            hasInbox: ProjectPaths.hasSupervisorInbox,
            runningWorkers: delegationRegistry.running.count,
            budgetActive: budget?.isActive ?? false,
            // Only the live transport cares: the harness injects a stub with
            // no key, and gating on it there would block every delegation in
            // the suite - the same exemption the dispatch precheck makes.
            hasProviderKey: !(type(of: transport) is SSETransport.Type)
                || !modelStore.resolvedAPIKey(for: modelStore.selectedProvider).isEmpty
        ) {
            // Carry the credential diagnosis when the key is the reason.
            //
            // Moving this check to the top of the tick stopped the churn and
            // also stopped the one line that said WHY the key was empty - that
            // was logged at dispatch, which no longer runs. A guard that hides
            // the evidence for the thing it guards against is worse than the
            // churn it replaced.
            let detail = reason.contains("provider key")
                ? " " + modelStore.credentialDiagnosis(for: modelStore.selectedProvider)
                : ""
            TriosLogBus.shared.debug(
                .queen, "queen.autonomy.skipped",
                "Not picking up work: \(reason)\(detail)",
                ["reason": reason]
            )
            return
        }
        TriosLogBus.shared.info(
            .queen, "queen.autonomy.tick",
            "Capacity free — choosing and starting the next open sub-issue",
            ["running": String(delegationRegistry.running.count)]
        )
        await chooseNextOpenIssue(startAfterChoosing: true, autonomous: true)
    }

    /// `autonomous` is the Queen acting on her own rather than on a command.
    /// It is the only caller allowed to grant its own approval; see the branch
    /// at the end of this function.
    private func chooseNextOpenIssue(
        startAfterChoosing: Bool = false,
        isLaunchBootstrap: Bool = false,
        autonomous: Bool = false
    ) async {
        // ── 1. Read open sub-issues of epic #1090 via GitHub REST API ──
        // The timeline read and store persistence are handled by
        // `fetchAndStoreSubIssues`, shared with the hourly background
        // refresh in `configureWorkerRunner` (#1215).  When the request
        // fails, the last list that was read successfully is loaded from
        // the store so a single forge refusal does not wipe out the
        // launch (#1214).
        let storePath = "\(ProjectPaths.trinity)/state/queen_subissues.json"
        /// Non-nil when subIssues came from the store fallback — appended
        /// to the log and the proposal so a choice made on yesterday's
        /// list looks like one (#1214).
        var storeDisclaimer: String? = nil

        let (fetched, networkOK, failureMessage) = await fetchAndStoreSubIssues()
        var subIssues = fetched

        if !networkOK {
            // ── 1b. Network failed — try the store fallback (#1214) ───
            if let loaded = Self.loadSubIssueStore(at: storePath) {
                subIssues = loaded.issues
                storeDisclaimer = loaded.disclaimer
                TriosLogBus.shared.warn(
                    .queen,
                    "queen.choose",
                    "Timeline request failed (\(failureMessage)); using \(subIssues.count) sub-issue\(subIssues.count == 1 ? "" : "s") from store — \(loaded.disclaimer)",
                    [
                        "epic": QueenEpics.describedList,
                        "source": "store",
                        "age": loaded.disclaimer,
                        "count": String(subIssues.count),
                    ]
                )
            } else {
                // No store — refuse as now
                TriosLogBus.shared.error(
                    .queen,
                    "queen.choose",
                    "Timeline request failed: \(failureMessage)",
                    ["epic": QueenEpics.describedList, "chosen": "(none)"]
                )
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Cannot choose: failed to read sub-issues of \(QueenEpics.describedList) "
                        + "(\(failureMessage))."
                )
                return
            }
        }

        if let disclaimer = storeDisclaimer {
            TriosLogBus.shared.info(
                .queen,
                "queen.choose",
                "Using \(subIssues.count) sub-issue\(subIssues.count == 1 ? "" : "s") — \(disclaimer)",
                ["epic": QueenEpics.describedList, "count": String(subIssues.count), "source": "store"]
            )
        } else {
            TriosLogBus.shared.info(
                .queen,
                "queen.choose",
                "Read \(subIssues.count) open sub-issue\(subIssues.count == 1 ? "" : "s") from \(QueenEpics.describedList)",
                ["epic": QueenEpics.describedList, "count": String(subIssues.count)]
            )
        }

        guard !subIssues.isEmpty else {
            TriosLogBus.shared.info(
                .queen,
                "queen.choose",
                "Nothing to choose — no open sub-issues on #1090",
                ["epic": QueenEpics.describedList, "considered": "0", "chosen": "(none)"]
            )
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "No open sub-issues under gHashTag/trios#1090. The hive is empty."
            )
            return
        }

        // ── 4. Exclude in-flight issues ───────────────────────────
        let inFlightNumbers = Set(delegationRegistry.running.map { $0.issue.number })
        let actionable = subIssues.filter { !inFlightNumbers.contains($0.number) }

        guard !actionable.isEmpty else {
            let names = subIssues.map { "#\($0.number)" }.joined(separator: ", ")
            TriosLogBus.shared.info(
                .queen,
                "queen.choose",
                "All \(subIssues.count) open sub-issues are in flight — nothing to choose",
                [
                    "considered": String(subIssues.count),
                    "inFlight": String(inFlightNumbers.count),
                    "chosen": "(none)",
                ]
            )
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "\(subIssues.count) open sub-issue\(subIssues.count == 1 ? "" : "s") "
                    + "under #1090, but \(inFlightNumbers.count) "
                    + "\(inFlightNumbers.count == 1 ? "is" : "are") in flight. "
                    + "Nothing to act on until a worker reports back:\n" + names
            )
            return
        }

        // ── 5. Score by boundary size, then issue number ───────────
        // Issue bodies are fetched via the GitHub REST API (public, no token).
        // Fewest files in Границы wins; ties break by lowest number.
        // A directory path (trailing /) counts as 9999 — it is a
        // region, not a boundary.  No Границы section → Int.max (last).
        struct ScoredIssue {
            let number: Int
            let title: String
            let fileCount: Int
            let paths: [String]?
            let body: String
        }

        var scored: [ScoredIssue] = []
        var extraRequests = 0
        for issue in actionable {
            // Use the body from the timeline entry; fall back to a
            // per-issue HTTPS request only when it is missing.
            var body = issue.body
            if body.isEmpty {
                extraRequests += 1
                body = await Task.detached(priority: .utility) {
                let url = URL(string: "https://api.github.com/repos/gHashTag/trios/issues/\(issue.number)")!
                var request = URLRequest(url: url)
                request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
                do {
                    let (data, response) = try await URLSession.shared.data(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        TriosLogBus.shared.warn(
                            .queen,
                            "queen.choose",
                            "GitHub API returned \(http.statusCode) for issue #\(issue.number)",
                            ["issue": String(issue.number), "status": String(http.statusCode)]
                        )
                        return ""
                    }
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let body = json["body"] as? String {
                        return body
                    }
                    return ""
                } catch {
                    TriosLogBus.shared.warn(
                        .queen,
                        "queen.choose",
                        "Failed to fetch issue #\(issue.number): \(error.localizedDescription)",
                        ["issue": String(issue.number)]
                    )
                    return ""
                }
                }.value
            }

            scored.append(ScoredIssue(
                number: issue.number,
                title: issue.title,
                fileCount: ChatViewModel.countBoundaryFiles(in: body),
                paths: ChatViewModel.boundaryPaths(from: body),
                body: body
            ))
        }

        if extraRequests > 0 {
            TriosLogBus.shared.info(
                .queen,
                "queen.choose",
                "Made \(extraRequests) extra request(s) for issue(s) whose body was missing from the timeline",
                ["extraRequests": String(extraRequests)]
            )
        }

        let sorted = scored.sorted { a, b in
            if a.fileCount != b.fileCount { return a.fileCount < b.fileCount }
            return a.number < b.number
        }

        // ── 5b. Skip candidates that look already done (#1180) ────
        // Before settling on a candidate, check whether its acceptance
        // criteria already hold against the current tree — the cheapest
        // honest signal is that every file named in its boundary exists
        // and the criteria name symbols that are present in them. When
        // they do, skip that candidate, journal why, and take the next.
        // A candidate that is not done is proposed exactly as before.
        // An issue that already has a live task is not a candidate.
        //
        // Without this the autonomous tick spun: every five minutes it chose
        // the same highest-scored issue, `delegateIssueToWorker` refused it
        // with "already delegated", and the tick ended there rather than
        // moving to the next one. Three tasks sat in awaitingReview, one slot
        // of four stayed free, and nothing new was ever started - twenty-three
        // delegations in ten minutes, all of them the same refusal.
        //
        // The refusal itself is right: one chat per issue. What was wrong is
        // treating it as the end of the tick instead of as "try the next one".
        // Anything already SPOKEN FOR, not merely anything running.
        //
        // `open` excludes terminal states, and `accepted` is terminal - so an
        // accepted-but-unmerged task vanished from this filter while its issue
        // stayed open on the forge. She chose it again, delegated it again, and
        // accepted it again: #1127 existed twice in one registry, once accepted
        // and once running, minutes apart. A loop that burns a worker slot and
        // a provider bill to redo settled work.
        //
        // `failed` is deliberately NOT here: a failure nobody has looked at is
        // work still to do, and it should be choosable again.
        let spokenFor: Set<DelegatedTaskState> = [
            .queued, .running, .awaitingReview, .rejected, .accepted, .merged
        ]
        // Keep the STATES, not just the numbers. The filter is right and the
        // comment above defends it at length; what was wrong is the word it
        // used for itself downstream, which said "a worker already has it"
        // about every state in the set. Four of the six have no worker: an
        // accepted task is finished, a merged one is landed, an awaitingReview
        // one is waiting on the operator. Eight such lines in a tick read as
        // eight bees at work while the board was in fact settled and stuck -
        // and "busy" and "stuck" call for opposite actions.
        let liveIssueStates: [Int: [DelegatedTaskState]] = Dictionary(
            grouping: delegationRegistry.tasks.filter { spokenFor.contains($0.state) },
            by: { $0.issue.number }
        ).mapValues { $0.map(\.state) }

        var chosenScored: ScoredIssue!
        // Why each candidate was passed over. The summary at the end used to
        // say "all candidates look already done" whatever the reasons were -
        // the most reassuring sentence in the system, printed while five tasks
        // sat escalated to the operator holding twelve issues' paths.
        var skipReasons: [String: Int] = [:]
        for candidate in sorted {
            // A candidate with no boundary cannot be delegated at all, and
            // that is knowable here: the paths were parsed during scoring.
            // Discovering it after the choice ends the tick with "Refused
            // --start: no Границы section" and a free worker slot - the fourth
            // instance of one shape, after "already delegated", "boundary
            // conflict" and the accepted-task filter. The pattern is always
            // the same: a condition the selection could test is instead left
            // for the refusal to find.
            if (candidate.paths ?? []).isEmpty {
                skipReasons["no boundary", default: 0] += 1
                TriosLogBus.shared.info(
                    .queen, "queen.choose.no_boundary",
                    "Skipping #\(candidate.number): no Границы section, so there is nothing to delegate",
                    ["issue": "gHashTag/trios#\(candidate.number)"]
                )
                continue
            }
            // Boundary conflicts too, and for the same reason. `delegate`
            // refuses a candidate whose files another live task already owns -
            // correctly - and the tick again treated that refusal as the end
            // rather than as "try the next one". Third instance of the same
            // shape today; filtered here with the very policy that would
            // otherwise refuse it, so the two can never disagree.
            if let paths = candidate.paths, !paths.isEmpty {
                let holders = QueenDelegationPolicy.conflictingTasks(
                    for: paths, among: delegationRegistry.tasks
                )
                if !holders.isEmpty {
                    // Name the holder and its state. "Owned by a live task" is
                    // anonymous, and six of these in a row read as a busy swarm
                    // when in fact five tasks were escalated to the operator
                    // hours earlier and are holding their paths while they
                    // wait. A block nobody can attribute is a block nobody
                    // clears.
                    let named = holders.map { holder -> String in
                        let age = Int(Date().timeIntervalSince(holder.updatedAt) / 60)
                        return "\(holder.issue.slug) (\(holder.state.rawValue), "
                            + "\(age)m)"
                    }.joined(separator: ", ")
                    skipReasons["held by another task", default: 0] += 1
                TriosLogBus.shared.info(
                        .queen, "queen.choose.boundary_taken",
                        "Skipping #\(candidate.number): its files are held by \(named)",
                        [
                            "issue": "gHashTag/trios#\(candidate.number)",
                            "held_by": named,
                        ]
                    )
                    continue
                }
            }
            if let states = liveIssueStates[candidate.number] {
                let report = QueenDelegationPolicy.spokenForReport(states: states)
                skipReasons[report.bucket, default: 0] += 1
                TriosLogBus.shared.info(
                    .queen, "queen.choose.already_running",
                    "Skipping #\(candidate.number): \(report.detail)",
                    [
                        "issue": "gHashTag/trios#\(candidate.number)",
                        "states": Set(states.map(\.rawValue)).sorted().joined(separator: ", "),
                    ]
                )
                continue
            }
            // A failure is choosable again - that much the comment above is
            // right about. What it did not say is how many times. #1127 was
            // attempted seven times in one registry, #1129 five, #1128 four,
            // every one of them the same brief against the same issue, because
            // nothing counted. Interruptions are excluded from the count by the
            // policy: a worker that died in a rebuild did not fail at anything.
            let priorFailures = delegationRegistry.priorFailures(forIssue: candidate.number)
            if case .escalate(let reason) = QueenRetryPolicy.decision(
                priorAttempts: priorFailures
            ) {
                skipReasons["attempts exhausted", default: 0] += 1
                TriosLogBus.shared.warn(
                    .queen, "queen.choose.exhausted",
                    "Skipping #\(candidate.number): \(reason)",
                    [
                        "issue": "gHashTag/trios#\(candidate.number)",
                        "attempts": String(priorFailures.filter(\.countsAgainstTheIssue).count),
                    ]
                )
                continue
            }
            if let evidence = Self.looksAlreadyDone(
                body: candidate.body,
                paths: candidate.paths
            ) {
                skipReasons["looks already done", default: 0] += 1
                TriosLogBus.shared.info(
                    .queen, "queen.choose.already_done",
                    "Skipping #\(candidate.number): looks already done — \(evidence)",
                    [
                        "issue": "gHashTag/trios#\(candidate.number)",
                        "evidence": evidence,
                    ]
                )
                continue
            }
            // Do not break: keep checking every remaining candidate so
            // the already-done judgement is logged for all of them, not
            // just those before the chosen one (#1180).
            if chosenScored == nil {
                chosenScored = candidate
            }
        }

        guard let chosen = chosenScored else {
            let doneIssues = sorted.map { "#\($0.number)" }.joined(separator: ", ")
            let breakdown = skipReasons
                .sorted { $0.value > $1.value }
                .map { "\($0.value) \($0.key)" }
                .joined(separator: ", ")
            TriosLogBus.shared.info(
                .queen, "queen.choose",
                "Nothing to choose from \(sorted.count) candidate(s): "
                    + (breakdown.isEmpty ? "no reasons recorded" : breakdown),
                [
                    "considered": String(sorted.count),
                    "chosen": "(none)",
                    "skipped": doneIssues,
                    "why": breakdown,
                ]
            )
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "Nothing to act on among \(sorted.count) candidate(s): "
                    + (breakdown.isEmpty ? "no reasons recorded" : breakdown)
                    + ". A count against \"held by another task\" is work waiting "
                    + "on a decision, not work in progress."
            )
            return
        }

        let reason: String
        if chosen.fileCount == Int.max {
            reason = "no Границы section (treats as ∞ files); lowest number among such issues."
        } else {
            reason = "smallest boundary: \(chosen.fileCount) file\(chosen.fileCount == 1 ? "" : "s") under Границы; ties break by lowest number."
        }

        TriosLogBus.shared.info(
            .queen,
            "queen.choose",
            "Chose gHashTag/trios#\(chosen.number) out of \(subIssues.count) open sub-issues",
            [
                "chosen": "gHashTag/trios#\(chosen.number)",
                "issueNumber": String(chosen.number),
                "considered": String(subIssues.count),
                "inFlight": String(inFlightNumbers.count),
                "fileCount": chosen.fileCount == Int.max ? "none" : String(chosen.fileCount),
                "reason": reason,
            ]
        )
        await postQueenNotice(
            SystemNoticeClassifier.successMarker
                + "Choose gHashTag/trios#\(chosen.number): \(chosen.title). "
                + reason
                + " Considered \(subIssues.count) open sub-issue\(subIssues.count == 1 ? "" : "s"), "
                + "\(inFlightNumbers.count) in flight."
                + (storeDisclaimer.map { " ⚠️ \($0)." } ?? "")
        )

        // ── 6a. Launch: post acceptance criteria and approve command ─
        // When the bootstrap at launch chooses without starting, post
        // the chosen issue's acceptance criteria, file boundary, and
        // the single approve command so the human can review and start
        // in one step — without tripping the approval gate's refusal.
        if isLaunchBootstrap && !startAfterChoosing {
            let criteriaList = QueenTaskSpec.criteriaFromIssue(body: chosen.body)
            let criteriaBlock: String
            if criteriaList.isEmpty {
                criteriaBlock = "(no «Готово, когда» / «Acceptance criteria» section found in the issue body)"
            } else {
                criteriaBlock = criteriaList.map { "- " + $0 }.joined(separator: "\n")
            }
            let boundary: String
            if let paths = chosen.paths, !paths.isEmpty {
                boundary = paths.joined(separator: "\n")
            } else {
                boundary = "(no Границы section)"
            }
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "Launch proposal — gHashTag/trios#\(chosen.number): \(chosen.title)\n"
                    + (storeDisclaimer.map { "⚠️ \($0).\n" } ?? "")
                    + "## Acceptance criteria\n"
                    + criteriaBlock + "\n\n"
                    + "## File boundary\n"
                    + boundary + "\n\n"
                    + "To start: `/delegate gHashTag/trios#\(chosen.number)`"
            )
            return
        }

        // ── 6. Delegate if --start was given ──────────────────────
        // `/choose` names and stops. `/choose --start` names then opens
        // the same work `/delegate` would, going through the identical
        // path — approval gate, capacity, budget, branch creation, worker
        // dispatch — so every refusal that applies to an explicit
        // delegation applies here too.
        if startAfterChoosing {
            // A task with no boundary cannot be auto-accepted: one of the
            // four gates in qualifiesForAutoAccept is !ownedPaths.isEmpty,
            // and work the Queen started but cannot close herself is work
            // that sits until a human notices.  The paths are already parsed
            // from the Границы section during scoring — pass them through.
            guard let paths = chosen.paths, !paths.isEmpty else {
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Cannot start gHashTag/trios#\(chosen.number): the issue has no "
                        + "Границы section, so there is no boundary to delegate. Add one "
                        + "and run /choose --start again."
                )
                TriosLogBus.shared.warn(
                    .queen, "queen.choose",
                    "Refused --start: \(chosen.number) has no Границы section",
                    [
                        "chosen": "gHashTag/trios#\(chosen.number)",
                        "reason": "no boundary",
                    ]
                )
                return
            }
            let issue = IssueReference(owner: "gHashTag", repo: "trios", number: chosen.number)
            // The last link, and the one that kept the Queen waiting.
            //
            // `delegateIssueToWorker` goes through `approvalBlockReason`, which
            // refuses an issue nobody approved this session. The inbox path
            // already approves each entry as it dispatches it - writing a line
            // into the Queen's own inbox IS the consent. Choosing had no such
            // step, so an autonomous tick ran the whole way to "Chose
            // gHashTag/trios#1127 out of 24 open sub-issues" and was then told
            // the issue was not approved, by the only party who could have
            // approved it.
            //
            // Only on the autonomous path. `/choose --start` typed by a person
            // is that person's decision and needs no help; the launch bootstrap
            // deliberately proposes and stops. This branch is reached only when
            // `queenAutonomyTick` passed every gate in `autonomyBlockReason`.
            if autonomous {
                delegationRegistry.approve(issue: issue)
                TriosLogBus.shared.info(
                    .queen, "queen.autonomy.approved",
                    "Approved \(issue.slug) on her own authority — autonomy is on",
                    ["issue": issue.slug]
                )
            }
            await delegateIssueToWorker(
                issue: issue,
                worker: "queen-swift",
                title: chosen.title,
                paths: paths
            )
        }
    }

    /// Loads the last successfully read sub-issue list from the store file
    /// created in `chooseNextOpenIssue`. Returns the parsed issues and a
    /// human-readable disclaimer describing their age, or nil when the store
    /// does not exist or is empty — in which case the caller refuses as
    /// before the fallback existed (#1214).
    private static func loadSubIssueStore(at path: String) -> (issues: [(number: Int, title: String, body: String)], disclaimer: String)? {
        guard FileManager.default.fileExists(atPath: path),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let issueArray = json["issues"] as? [[String: Any]] else {
            return nil
        }

        var issues: [(number: Int, title: String, body: String)] = []
        for iss in issueArray {
            guard let number = iss["number"] as? Int else { continue }
            issues.append((
                number: number,
                title: iss["title"] as? String ?? "",
                body: iss["body"] as? String ?? ""
            ))
        }

        guard !issues.isEmpty else { return nil }

        var ageDescription = "unknown age"
        if let readAtString = json["readAt"] as? String,
           let readAt = ISO8601DateFormatter().date(from: readAtString) {
            let interval = Date().timeIntervalSince(readAt)
            if interval < 60 {
                ageDescription = "less than a minute"
            } else if interval < 3600 {
                let mins = Int(interval / 60)
                ageDescription = "\(mins) minute\(mins == 1 ? "" : "s")"
            } else if interval < 86400 {
                let hours = Int(interval / 3600)
                ageDescription = "\(hours) hour\(hours == 1 ? "" : "s")"
            } else {
                let days = Int(interval / 86400)
                ageDescription = "\(days) day\(days == 1 ? "" : "s")"
            }
        }

        return (issues, "list from backup, \(ageDescription) old")
    }

    /// Count files listed under `## Границы` in an issue body.
    /// A directory path (trailing /) counts as 9999 — it is a region,
    /// not a boundary.  No `## Границы` section → Int.max (sorts last).
    private static func countBoundaryFiles(in body: String) -> Int {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        var inBounds = false
        var count = 0
        var found = false

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("## ") {
                if inBounds { break }
                inBounds = ChatViewModel.isBoundaryHeading(trimmed)
                if inBounds { found = true }
                continue
            }
            guard inBounds else { continue }

            let cleaned = trimmed
                .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                .trimmingCharacters(in: .whitespaces)
            if cleaned.isEmpty { continue }

            if cleaned.hasSuffix("/") {
                count += 9999
            } else {
                count += 1
            }
        }

        return found ? count : Int.max
    }

    /// Extracts the file paths listed under `## Границы` in an issue body.
    /// Returns nil when the section is absent — the caller must refuse to
    /// delegate, because a task with no boundary cannot be auto-accepted.
    private static func boundaryPaths(from body: String) -> [String]? {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        var inBounds = false
        var paths: [String] = []
        var found = false

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("## ") {
                if inBounds { break }
                inBounds = ChatViewModel.isBoundaryHeading(trimmed)
                if inBounds { found = true }
                continue
            }
            guard inBounds else { continue }

            if trimmed.isEmpty { continue }

            // Extract only the path-shaped token — no spaces, containing "/"
            // or ending in a file extension. A boundary line may carry prose
            // after the path ("rings/SR-02/Foo.swift, see notes"), so taking
            // the whole line yields a non-existent path and narrowing fails
            // silently.
            if let token = boundaryPathToken(from: trimmed) {
                paths.append(token)
            } else {
                TriosLogBus.shared.info(
                    .queen, "queen.brief.no_path",
                    "Границы line yielded no path: \(trimmed)",
                    ["line": trimmed]
                )
            }
        }

        return found ? paths : nil
    }

    /// Extracts the path-shaped token from a boundary line. The token has no
    /// spaces, contains "/" or ends in a dotted file extension, and is stripped
    /// of trailing prose punctuation (commas, semicolons, backticks, etc.).
    /// Whether a heading opens the boundary section.
    ///
    /// Two spellings, because the repository writes its documentation and code
    /// in English while every issue written before that rule says `Границы`.
    /// The heading is a parser token, not prose: recognising only one spelling
    /// would have made every English issue undelegatable, and the failure would
    /// have read as "no boundary section, so there is nothing to delegate" -
    /// true of the parser, not of the issue.
    static func isBoundaryHeading(_ trimmed: String) -> Bool {
        trimmed.hasPrefix("## Границы") || trimmed.hasPrefix("## Boundary")
    }

    static func boundaryPathToken(from line: String) -> String? {
        for raw in line.split(separator: " ", omittingEmptySubsequences: true) {
            // Strip backticks and prose punctuation from both ends, in any
            // order, until nothing more comes off.
            //
            // The two passes used to be sequential - backticks first, then
            // trailing punctuation - and that order fails on the commonest
            // shape of all: a path in backticks followed by a comma. The
            // trailing character is the comma, so the backtick strip does not
            // reach the backtick; the punctuation strip then removes the comma
            // and leaves it exposed at the end, where nothing looks again.
            //
            // Five of the sixty-three boundary paths in the live registries
            // carried a trailing backtick because of it, all of them
            // `rings/SR-02/ChatViewModel.swift` + "`". A path like that matches
            // nothing: `git add --` does not stage it, and the boundary filter
            // drops the worker's real edits to that file as being outside its
            // boundary. The bee is then recorded as having produced nothing,
            // which is the commonest failure in the registry.
            var cleaned = String(raw)
            var changed = true
            while changed, !cleaned.isEmpty {
                changed = false
                if let first = cleaned.first, "`\"'(".contains(first) {
                    cleaned.removeFirst()
                    changed = true
                }
                if let last = cleaned.last, "`\"'.,;:!?)".contains(last) {
                    cleaned.removeLast()
                    changed = true
                }
            }
            guard !cleaned.isEmpty else { continue }
            if cleaned.contains("/")
                || cleaned.range(of: #"\.\w{1,10}$"#, options: .regularExpression) != nil {
                return cleaned
            }
        }
        return nil
    }

    /// Identifiers an issue body uses to name code: backtick-quoted spans
    /// and CamelCase words. Fed to `QueenLocalisation.region` so the worker
    /// is pointed at the declaration the issue talks about, not the whole file.
    private static func identifiers(from body: String) -> [String] {
        var found = Set<String>()

        // Backtick-quoted spans: `QueenLocalisation`, `ChatViewModel.swift`, etc.
        if let regex = try? NSRegularExpression(pattern: "`([^`]+)`") {
            let nsBody = body as NSString
            regex.enumerateMatches(
                in: body,
                range: NSRange(location: 0, length: nsBody.length)
            ) { match, _, _ in
                guard let match else { return }
                let captured = nsBody.substring(with: match.range(at: 1))
                if !captured.isEmpty { found.insert(captured) }
            }
        }

        // Bare words from prose: requestReviewerVerdicts,
        // ChatViewModel, QueenLocalisation, etc. Matches runs of
        // Latin letters and digits that contain an uppercase letter
        // which is not the first character (#1179).
        if let regex = try? NSRegularExpression(
            pattern: "\\b[a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\\b"
        ) {
            let nsBody = body as NSString
            regex.enumerateMatches(
                in: body,
                range: NSRange(location: 0, length: nsBody.length)
            ) { match, _, _ in
                guard let match else { return }
                let captured = nsBody.substring(with: match.range)
                if !captured.isEmpty { found.insert(captured) }
            }
        }

        // Filter to identifier-shaped tokens only: reject prose, keywords,
        // paths, and file extensions (#1178).
        let swiftKeywords: Set<String> = [
            "return", "func", "let", "var", "guard", "where",
            "case", "class", "struct", "enum", "self",
            "true", "false", "nil", "async", "await", "throws",
        ]
        return found.filter { token in
            // ≥6 chars, starts with a letter, only letters and digits
            // (no spaces, slashes, dots / file extensions).
            guard token.count >= 6,
                  let first = token.first,
                  first.isLetter,
                  token.allSatisfy({ $0.isLetter || $0.isNumber })
            else { return false }
            return !swiftKeywords.contains(token)
        }
    }

    /// Heuristic: does this issue's work look already done against the current
    /// tree? Returns evidence text when it does, nil when it does not (#1180).
    /// The cheapest honest signal: every file named in its boundary exists on
    /// disk, and the acceptance criteria name symbols that are present in them.
    private static func looksAlreadyDone(body: String, paths: [String]?) -> String? {
        guard let paths, !paths.isEmpty else { return nil }

        // Every boundary file must exist. Resolve against the project
        // root because the app's working directory is not the repo when
        // launched from Finder (#1180).
        for path in paths {
            let fullPath = "\(ProjectPaths.root)/\(path)"
            guard FileManager.default.fileExists(atPath: fullPath) else { return nil }
        }

        // Extract acceptance criteria, then the code symbols they name.
        let criteria = QueenTaskSpec.criteriaFromIssue(body: body)
        let symbols = identifiers(from: criteria.joined(separator: "\n"))

        // No named identifiers means no evidence: a behavioural task's
        // files exist from day one, so their mere presence is not a
        // signal that the work is done (#1180).
        if symbols.isEmpty {
            return nil
        }

        // Read boundary file contents and check every named symbol is present.
        var fileContents = ""
        for path in paths {
            let fullPath = "\(ProjectPaths.root)/\(path)"
            if let text = try? String(contentsOfFile: fullPath, encoding: .utf8) {
                fileContents += "\n" + text
            }
        }
        let missing = symbols.filter { !fileContents.contains($0) }
        guard missing.isEmpty else { return nil }

        return "boundary files present: \(paths.joined(separator: ", ")); named identifiers found: \(symbols.joined(separator: ", "))"
    }

    // MARK: - Review Loop

    private func reportSwarm() async {
        let registry = delegationRegistry
        guard !registry.tasks.isEmpty else {
            await postQueenNotice(SystemNoticeClassifier.infoMarker
                    + "The hive is empty. Give me an issue and a worker - "
                    + "/delegate owner/repo#N queen-swift --paths rings/SR-02 Fix the thing - "
                    + "and I will open it a chat and a branch of its own.")
            return
        }
        let lines = registry.tasks.map { task in
            let marker = task.state.needsQueenAttention ? "!" : " "
            return "\(marker) \(task.issue.slug)  \(task.state.rawValue)  \(task.worker)  "
                + "\(task.virtualBranch ?? "-")  -  \(task.title)"
        }
        let waiting = registry.reviewQueue.count
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "\(registry.running.count) of "
                + "\(QueenDelegationPolicy.maximumConcurrentWorkers) slots busy, "
                + "\(waiting) waiting on you.\n" + lines.joined(separator: "\n")
        )
    }

    // MARK: - Interface divergence watchdog (#1128)

    /// #1128: proof that the interface divergence watchdog ran, the combined
    /// state of every open lane assembled, and the combined tree built.
    ///
    /// This type is load-bearing, not decorative. Its only constructor
    /// refuses a `CombinedBuildResult` that did not build, and the only
    /// producer of a `CombinedBuildResult` in the app is
    /// `QueenBranchCommitter.verifyCombinedBuild`. So a `CombinedBuildProof`
    /// in hand means the watchdog ran and passed - and
    /// `transitionToAccepted` below takes this proof as a parameter, which
    /// is criterion 4 made structural: delete the `verifyCombinedBuild`
    /// call from an acceptance path and the proof has no source, the
    /// transition has no argument, and the file stops compiling. The check
    /// cannot be quietly dropped; it can only be loudly edited around, and
    /// the type name says what was lost.
    private struct CombinedBuildProof {
        let summary: String
        let combinedTreeSha: String?

        /// The only way in. Nil for a failed result, so a combined build
        /// that failed can never be mistaken for one that passed.
        fileprivate init?(result: QueenBranchCommitter.CombinedBuildResult) {
            guard result.builds else { return nil }
            self.summary = result.summary
            self.combinedTreeSha = result.combinedTreeSha
        }

        /// The honest proof for "there was nothing to combine".
        ///
        /// Not a failure and not a fabricated success: with no lane carrying
        /// content there is no divergence to find, and the summary says so
        /// rather than pretending a build ran. Kept as a separate initialiser
        /// so the failing-result path above stays the only way a REAL build
        /// can produce a proof.
        fileprivate init(emptyAgainst base: String) {
            self.summary = "No lane carried content to combine against \(base); "
                + "there is nothing that could diverge."
            self.combinedTreeSha = nil
        }
    }

    /// #1128: the outcome of one watchdog run, for one acceptance. `refused`
    /// carries the named cause - what exactly did not converge - because a
    /// refusal that does not name its subject sends the reader hunting for
    /// the wrong problem.
    private enum InterfaceDivergenceGate {
        /// The combined state did not assemble or did not compile. `summary`
        /// names the branches, the tree, and the errors that did not
        /// converge.
        case refused(summary: String, branches: [String])
        /// The combined state built together. The proof is the entry ticket
        /// to `.accepted`.
        case passed(CombinedBuildProof)
    }

    /// Runs the interface divergence watchdog once, for one acceptance
    /// (#1128).
    ///
    /// Slow, and deliberately so (criterion 3): assembling the combined
    /// state means extracting every open lane's branch into a scratch tree
    /// and running a full `swift build` in it - minutes, not milliseconds.
    /// The check therefore runs exactly once per acceptance and nowhere
    /// else: not per build, not when a worker commits, not when a branch is
    /// proposed. The question it answers - "do these lanes still compile
    /// *together*?" - is an acceptance question. Each lane already builds
    /// alone; asking it per build would multiply minutes across every
    /// commit for an answer that cannot change until someone accepts.
    private func runInterfaceDivergenceWatchdog(
        accepting task: DelegatedTask,
        in registry: QueenDelegationRegistry
    ) async -> InterfaceDivergenceGate {
        // The combined state: every lane whose branch will land beside this
        // one. Accepted-but-unmerged branches are in - an accepted lane's
        // signature change is exactly what breaks the next lane's caller,
        // and acceptance is the last moment that can catch it. Merged
        // branches are out: their content is already in the base the tree
        // is cut from. Cancelled and failed work will not land, so it
        // cannot diverge from anything.
        let combinableStates: Set<DelegatedTaskState> = [
            .queued, .running, .awaitingReview, .rejected, .accepted
        ]
        var branches: [String] = []
        for lane in registry.tasks where combinableStates.contains(lane.state) {
            guard let branch = lane.virtualBranch else { continue }
            if branch != task.virtualBranch && !branches.contains(branch) {
                branches.append(branch)
            }
        }
        // The branch being accepted goes last: on a same-path collision the
        // last branch in the overlay wins, and the state this acceptance is
        // about is the one that should win it.
        if let own = task.virtualBranch, !branches.contains(own) {
            branches.append(own)
        }

        guard let base = QueenBranchCommitter.baseBranch() else {
            return .refused(
                summary: "The combined state could not be assembled: the base "
                    + "branch to combine the lanes against could not be resolved "
                    + "(detached HEAD, or no current branch).",
                branches: branches
            )
        }

        // Only lanes that can actually contribute. A queued or running bee has
        // no commits yet, and a leftover branch cut before the base drags old
        // content into the overlay - five of those were enough to fail every
        // acceptance, so one stale lane held thirteen healthy ones.
        let contributing = await Task.detached(priority: .utility) {
            QueenBranchCommitter.contributingBranches(branches, baseRef: base)
        }.value
        if contributing.count != branches.count {
            TriosLogBus.shared.info(
                .queen, "queen.combined.narrowed",
                "Combining \(contributing.count) of \(branches.count) lanes; "
                    + "the rest have nothing to contribute or predate the base",
                ["kept": contributing.joined(separator: ", ")]
            )
        }
        guard !contributing.isEmpty else {
            // Nothing to combine is not a failure to combine. With no lane
            // carrying content there is no divergence to find, and refusing
            // here would block the first acceptance of every fresh swarm.
            return .passed(CombinedBuildProof(emptyAgainst: base))
        }
        let result = await QueenBranchCommitter.verifyCombinedBuild(
            branches: contributing, baseRef: base
        )
        if let proof = CombinedBuildProof(result: result) {
            return .passed(proof)
        }
        return .refused(summary: result.summary, branches: branches)
    }

    /// Posts the #1128 structural refusal: the lanes do not build together.
    ///
    /// Kept apart from the criterion refusal on purpose - a different log
    /// event, different wording - because "does not build together" and
    /// "criterion not met" demand different fixes: the first is fixed in
    /// the lanes, the second in the verdicts. A refusal that hides which
    /// kind it is sends the reader looking for the wrong problem
    /// (criterion 2).
    private func refuseAcceptanceForDivergence(
        issue: IssueReference,
        summary: String,
        branches: [String],
        logEvent: String = "queen.accept.combined_build_failed"
    ) async {
        TriosLogBus.shared.warn(
            .queen, logEvent,
            "Acceptance refused: the combined state does not build together",
            [
                "issue": issue.slug,
                "branches": branches.joined(separator: ", "),
                "summary": summary
            ]
        )
        await postQueenNotice(
            SystemNoticeClassifier.warningMarker
                + "Not accepting \(issue.slug): the lanes do not build together. "
                + "This is not a criterion verdict - no criterion was judged. The "
                + "combined state itself would not assemble or compile, so there "
                + "is no tree in which the criteria could be checked. What did "
                + "not converge:\n\(summary)"
                + (branches.isEmpty
                    ? ""
                    : "\nLanes in the combined tree: \(branches.joined(separator: ", ")).")
                + "\nFix the lanes; the criteria stand unchanged."
        )
    }

    /// The only door from an acceptance path to `.accepted` (#1128).
    ///
    /// Takes the watchdog's proof as a parameter so the transition cannot
    /// be separated from the check: no `verifyCombinedBuild`, no proof, no
    /// compilation (criterion 4). Every acceptance in this file goes
    /// through here.
    @discardableResult
    private func transitionToAccepted(
        taskID: UUID,
        in registry: QueenDelegationRegistry,
        watchdogProof: CombinedBuildProof
    ) -> Bool {
        registry.transition(taskID: taskID, to: .accepted)
    }

    /// Accepts or returns a worker's result.
    ///
    /// Rejection re-briefs the same worker in the same chat on the same branch,
    /// because starting a second chat for one issue is how two bees end up
    /// fighting over the same change.
    private func reviewDelegatedTask(
        issue: IssueReference,
        decision: ReviewDecision,
        note: String
    ) async {
        let registry = delegationRegistry
        guard let task = registry.task(forIssue: issue) else {
            await postQueenNotice(SystemNoticeClassifier.warningMarker + "\(issue.slug) has no open task to review.")
            return
        }
        guard task.state == .awaitingReview else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "\(issue.slug) is \(task.state.rawValue), not awaiting review. Nothing to decide yet."
            )
            return
        }

        // Every decision is a labelled example: accepting means the ranking did
        // not need to shout, sending it back means it did.
        SalienceLearner.shared.record(task: task, neededUser: decision == .reject)

        switch decision {
        case .accept:
            // --- Build the combined state (#1128) ---
            // Acceptance reads the boundary-scoped fingerprint the verdicts
            // were carved against alongside the boundary's current fingerprint.
            // Only the task's own files are hashed, so the Queen's state
            // writes cannot age a verdict (#1131). Without both fingerprints,
            // staleness is invisible: a verdict checked against yesterday's
            // code silently passes because nothing compares the two.
            let verdictTreeState = verdictTreeStates[task.id] ?? task.treeStateFingerprint
            let currentBoundaryState = await QueenBranchCommitter.fingerprintBoundary(
                ownedPaths: task.ownedPaths
            )
            // When the boundary is empty (no ownedPaths), both states are nil
            // and the staleness check is skipped — "missing ≠ stale" (#1131).
            // When the boundary exists but the snapshot failed, that is a
            // structural failure: the tool cannot answer.
            guard task.ownedPaths.isEmpty || currentBoundaryState != nil else {
                // The combined state could not be assembled. This is a structural
                // failure, not a criterion verdict: "does not build together" is
                // not "criterion not met". The first says the check cannot run;
                // the second says it ran and the answer was no. Mixing them hides
                // a broken tool behind a verdict that was never reached.
                TriosLogBus.shared.warn(
                    .queen, "queen.accept.state_failed",
                    "Boundary fingerprint could not be assembled — snapshot returned nil",
                    [
                        "issue": issue.slug,
                        "verdictTreeState": verdictTreeState ?? "(none)",
                        "ownedPaths": task.ownedPaths.joined(separator: ", "),
                        "criteria": String(task.acceptanceCriteria.count),
                        "verdicts": String(task.criterionVerdicts.count),
                    ]
                )
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Not accepting \(issue.slug): the boundary fingerprint could not be "
                        + "assembled — the working tree snapshot failed. This is a structural "
                        + "failure, not a criterion verdict. The state acceptance needs to read "
                        + "was not built, so the verdicts cannot be checked for staleness."
                )
                return
            }
            let currentTreeState = currentBoundaryState ?? ""

            // Acceptance is checked against the contract before it is checked
            // against anything else. This is the whole point of writing criteria
            // down: without it the Queen signs off on an impression, and the
            // specification becomes decoration that made the brief longer.
            //
            // Ahead of the divergence watchdog below, and the ordering matters.
            // The watchdog was placed first with a stated reason - criteria are
            // judged inside a tree, and a tree that does not compile is no
            // place to judge them - which is true of criteria and NOT true of
            // the contract refusals: "the reviewer was asked and gave no
            // answer" is a fact about the reviewer, established without any
            // tree at all. Running the watchdog first replaced that answer with
            // "does not build together" and lost the distinction #1117 exists
            // to keep. So: refusals that need no tree are reported first, and
            // the watchdog guards the case where the contract is satisfied and
            // something is actually about to land.
            if let reason = acceptanceBlockReasonDistinguishingEmptyAnswers(
                for: task,
                verdictTreeState: verdictTreeState,
                currentTreeState: currentTreeState
            ) {
                // Logged as well as said. The refusal is the contract doing its
                // job, and until it was visible outside her chat every run that
                // hit it looked identical to a run where nothing happened.
                TriosLogBus.shared.warn(
                    .queen, "queen.accept.blocked", "Acceptance blocked by the contract",
                    [
                        "issue": issue.slug,
                        "reason": reason,
                        "criteria": String(task.acceptanceCriteria.count),
                        "verdicts": String(task.criterionVerdicts.count),
                        "asked_unanswered": String(askedButUnanswered[task.id]?.count ?? 0),
                        "declined_no_diff": String(declinedNoDiff[task.id]?.count ?? 0)
                    ]
                )
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Not accepting \(issue.slug) yet. \(reason)\n\n"
                        + QueenAcceptancePolicy.table(
                            criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts,
                            verdictTreeState: verdictTreeState,
                            currentTreeState: currentTreeState
                        )
                        + "\n\nRecord what you found with "
                        + "`/verify \(issue.slug) <criterion text> met|unmet`."
                )
                return
            }

            // --- The interface divergence watchdog (#1128) ---
            // The contract is satisfied, so something is about to land. The
            // combined state of every open lane is assembled and built once,
            // here. A refusal from this gate is a different kind of refusal
            // from the contract's - "does not build together" is not
            // "criterion not met" - so it gets its own words, its own log
            // event, and it never touches the verdicts.
            let watchdogProof: CombinedBuildProof
            let divergenceGate = await runInterfaceDivergenceWatchdog(
                accepting: task, in: registry
            )
            switch divergenceGate {
            case .refused(let summary, let branches):
                await refuseAcceptanceForDivergence(
                    issue: issue, summary: summary, branches: branches
                )
                return
            case .passed(let proof):
                watchdogProof = proof
            }
            // The proof is the entry ticket (#1128 criterion 4): without
            // the watchdog having passed above, this call does not compile.
            guard transitionToAccepted(
                taskID: task.id, in: registry, watchdogProof: watchdogProof
            ) else {
                await postQueenNotice(SystemNoticeClassifier.failureMarker + (registry.lastError ?? "Could not accept \(issue.slug)."))
                return
            }
            let tail = note.isEmpty ? "" : "\n\(note)"
            // The table, not a sentence saying it went well. A reviewer reading
            // this later should see what was checked, not that someone was
            // satisfied.
            let evidence = task.acceptanceCriteria.isEmpty
                ? ""
                : "\n\n" + QueenAcceptancePolicy.table(
                    criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts,
                    verdictTreeState: verdictTreeState,
                    currentTreeState: currentTreeState
                )
            await postQueenNotice(
                SystemNoticeClassifier.successMarker
                    + "Accepted \(issue.slug) from \(task.worker).\(evidence)\nIts work is on "
                    + "`\(task.virtualBranch ?? "-")`. It stays open until its pull "
                    + "request merges - acceptance is my opinion, a merge is a fact.\(tail)"
            )
            // Acceptance now proposes the work, rather than leaving a reviewed
            // branch sitting for someone to remember. The gate that matters
            // already happened: you approved the task before it opened, and the
            // criteria decided this acceptance. Making the person who wrote
            // neither of those type one more command adds a step without adding
            // a decision.
            //
            // It still refuses on its own terms - no branch, no commits, or a
            // pull request already open - and says why.
            await openPullRequestForTask(issue: issue)
        case .reject:
            guard !note.isEmpty else {
                await postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Rejecting \(issue.slug) needs a reason: /review \(issue.slug) reject <why>."
                )
                return
            }
            guard await sendTaskBackToWorker(task: task, reason: note) else { return }
            await postQueenNotice(SystemNoticeClassifier.infoMarker
                    + "Sent \(issue.slug) back to \(task.worker) with your reason: \(note). "
                    + "Same chat, same branch - it picks up where it left off rather than "
                    + "starting a second attempt that would fight the first one for the "
                    + "same files.")
        }
        await loadConversations()
    }

    /// Opens a pull request for a task's branch, on request.
    ///
    /// Deliberately a command rather than a step of acceptance. Acceptance is
    /// the Queen's judgement and happens unattended; opening a pull request
    /// publishes work to a place other people read. Those should not be the
    /// same event until someone decides they should be.
    func openPullRequestForTask(issue: IssueReference) async {
        TriosLogBus.shared.info(
            .queen, "queen.pr.attempt", "Trying to open a pull request", ["issue": issue.slug]
        )
        let registry = delegationRegistry
        guard let task = registry.anyTask(forIssue: issue) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker + "I have no task for \(issue.slug)."
            )
            return
        }
        if let reason = QueenDelegationPolicy.pullRequestBlockReason(for: task) {
            TriosLogBus.shared.warn(
                .queen, "queen.pr.refused", "Refused to open a pull request",
                ["issue": issue.slug, "reason": reason]
            )
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "Not opening a pull request for \(issue.slug): \(reason)"
            )
            return
        }
        guard let branch = task.virtualBranch else {
            // Used to return without a word, which is how this step stayed
            // invisible: the cycle simply stopped and nothing said so.
            TriosLogBus.shared.error(
                .queen, "queen.pr.noBranch", "The task has no branch to propose",
                ["issue": issue.slug]
            )
            return
        }

        // Publish it first. GitHub cannot open a pull request from a branch it
        // has never seen, and until now nothing in the delegation path pushed:
        // the bee committed locally, the Queen asked for a pull request, and
        // the cycle stopped one step short of the only thing it is for.
        //
        // #1251: say that the branch is being published *before* the push
        // begins. A push that stalls on a network hiccup leaves the user
        // staring at a silent screen; the notice is the difference between
        // "the app froze" and "the Queen is working".
        await postQueenNotice("Publishing `\(branch)`…")
        TriosLogBus.shared.info(
            .queen, "queen.pr.pushing", "Publishing the branch",
            ["issue": issue.slug, "branch": branch]
        )

        // #1251: if the push runs long, say so again with the elapsed time.
        // The push itself races a 90 s deadline; this notice fires well
        // before that — long enough not to cry wolf on an ordinary push,
        // short enough to arrive before the user assumes it died.
        let pushStart = Date()
        let stallNotice = Task { [weak self] in
            // #1251: repeat the notice every 10 s while the push is still
            // running. A single notice at 10 s falls silent again by 20 s;
            // a long push must keep talking, not cry wolf once and stop.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled, let self else { return }
                let elapsed = Int(Date().timeIntervalSince(pushStart))
                // #1251: log before posting — observability must not queue
                // behind the chat write. The structured event hits the log
                // bus first so it is on disk and in the LOGS tab even if the
                // chat write that follows is slow or dropped.
                TriosLogBus.shared.warn(
                    .queen, "queen.pr.pushStall",
                    "Push is taking long: \(elapsed) s so far",
                    ["issue": issue.slug, "branch": branch, "elapsed_s": String(elapsed)]
                )
                await self.postQueenNotice(
                    SystemNoticeClassifier.warningMarker
                        + "Still publishing `\(branch)` — \(elapsed) s so far."
                )
            }
        }

        if let pushFailure = await QueenBranchCommitter.pushBranch(branch) {
            stallNotice.cancel()
            TriosLogBus.shared.error(
                .queen, "queen.pr.pushFailed", "Could not publish the branch",
                ["issue": issue.slug, "branch": branch, "detail": pushFailure]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Could not publish `\(branch)`, so there is no pull request for "
                    + "\(issue.slug) yet. git said: \(pushFailure)"
            )
            return
        }
        stallNotice.cancel()

        // Where the branch is, not where the issue is. Those differ here and the
        // mismatch is what stopped the cycle: the branch lives in the checkout's
        // own origin, the issue in another repository entirely, and GitHub
        // cannot open a pull request from a ref it has never seen.
        guard let prRepo = QueenBranchCommitter.originRepository() else {
            TriosLogBus.shared.error(
                .queen, "queen.pr.noRepository", "Could not derive the branch's repository",
                ["issue": issue.slug, "branch": branch]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "I could not work out which repository `\(branch)` belongs to, so there "
                    + "is no pull request for \(issue.slug)."
            )
            return
        }

        // The PR targets the project's real branch, not a throwaway
        // snapshot (#1142). The old flow pushed a `*-base` branch at the
        // merge-base so GitHub would show only the bee's commits, but the
        // bee now works in a worktree cut from `origin/<targetBranch>`, so
        // the diff is already clean. No `-base` branch is created, and the
        // PR base is the existing target branch name.
        guard let prBase = QueenBranchCommitter.baseBranch() else {
            TriosLogBus.shared.error(
                .queen, "queen.pr.noBaseBranch", "Could not resolve the project's base branch",
                ["issue": issue.slug]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "I could not determine the project's base branch, so there "
                    + "is no pull request for \(issue.slug)."
            )
            return
        }

        do {
            let pr = try await GitHubAPIClient().createPR(
                repo: prRepo,
                title: QueenDelegationPolicy.conventionalPRTitle(for: task),
                body: "For \(issue.url)\n\nOpened by the Queen for \(task.worker).",
                head: branch,
                base: prBase
            )
            registry.recordPullRequest(taskID: task.id, number: pr.number)
            await postQueenNotice(
                SystemNoticeClassifier.successMarker
                    + "Opened #\(pr.number) for \(issue.slug) from `\(branch)`. "
                    + "The task stays open until that merges - a closed pull request "
                    + "that never merged is not the same as landed work."
            )
            TriosLogBus.shared.info(
                .queen, "queen.pr.opened", "Opened a pull request",
                ["issue": issue.slug, "pr": "\(pr.number)", "branch": branch,
                 "base": prBase]
            )
            // The thirty-minute scheduler wake polls on a steady cadence, but a
            // pull request that just opened should not wait half an hour for its
            // first outcome. Sleep long enough for checks to start, then poll once.
            Task.detached { [weak self] in
                try? await Task.sleep(nanoseconds: 90_000_000_000)
                await self?.pollPullRequests()
            }
        } catch {
            TriosLogBus.shared.error(
                .queen, "queen.pr.failed", "Could not open a pull request",
                ["issue": issue.slug, "branch": branch, "error": "\(error)"]
            )
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + "Could not open a pull request for \(issue.slug): \(error.localizedDescription)"
            )
        }
    }

    /// Asks the forge what happened to each open pull request and settles the
    /// tasks waiting on them.
    ///
    /// This is the step that makes archiving a fact rather than an opinion. It
    /// only ever asks about tasks that actually have a pull request, so a swarm
    /// that never opens one costs nothing and behaves exactly as before.
    func pollPullRequests() async {
        let registry = delegationRegistry
        let waiting = registry.tasks.filter {
            $0.pullRequestNumber != nil && $0.state == .accepted
        }
        guard !waiting.isEmpty else { return }

        // The repository the pull requests are in, which is the checkout's
        // origin - not the issue's. Creating them was already corrected for
        // this; polling and merging still asked the issue's repository about a
        // number that only exists in the other one.
        guard let prRepo = QueenBranchCommitter.originRepository() else { return }
        let client = GitHubAPIClient()
        for task in waiting {
            guard let number = task.pullRequestNumber else { continue }
            let pullRequest: GitHubPullRequest
            do {
                pullRequest = try await client.fetchPullRequest(
                    repo: prRepo, number: number
                )
            } catch {
                // A forge that cannot be reached says nothing about the work.
                // Leaving the task where it is beats guessing in either
                // direction; the next poll asks again.
                TriosLogBus.shared.warn(
                    .queen, "queen.pr.poll_failed", "Could not read a pull request",
                    ["issue": task.issue.slug, "pr": "\(number)"]
                )
                continue
            }

            // Capture the reviewed head SHA: record it once from the PR's head
            // ref, then reuse it on every poll so the merge request pins the
            // exact commit the Queen saw. The forge returns 409 if the branch
            // has moved since, which is how the task knows to go back for
            // review rather than silently merge code nobody checked (#1254).
            let reviewedSHA = task.reviewedHeadSHA ?? pullRequest.head?.sha
            if task.reviewedHeadSHA == nil, let reviewedSHA {
                registry.recordReviewedHeadSHA(taskID: task.id, sha: reviewedSHA)
            }

            // An open pull request for accepted work is the Queen's to finish.
            // She reviewed it against the criteria; waiting for a human to press
            // the same button she already decided on is ceremony, not oversight.
            // The forge is still the authority - branch protection or a red
            // check refuses, and the task just stays open until the next poll.
            if QueenDelegationPolicy.outcome(
                merged: pullRequest.isMerged, closedUnmerged: pullRequest.isClosedUnmerged
            ) == .pending {
                // The gate, before the merge and not instead of it.
                //
                // GitHub refuses a red pull request only when branch protection
                // makes it refuse; without protection the merge succeeds and a
                // failing change lands. Three of hers merged that way and only
                // luck decided they were green.
                let (rollup, failingChecks) = (try? await client.checkRollup(
                    repo: prRepo, sha: reviewedSHA ?? ""
                )) ?? (.none, [])
                let gate = QueenMergeGate.decision(
                    rollup: rollup,
                    mergeable: nil,
                    isDraft: false,
                    checksConfigured: Self.repositoryHasChecks
                )
                switch gate {
                case .wait(let why):
                    TriosLogBus.shared.info(
                        .queen, "queen.pr.gate_waiting",
                        "Not merging #\(number) yet: \(why)",
                        ["issue": task.issue.slug, "pr": "\(number)", "rollup": rollup.rawValue]
                    )
                    return
                case .refuse(let why):
                    TriosLogBus.shared.warn(
                        .queen, "queen.pr.gate_refused",
                        "Will not merge #\(number): \(why)",
                        ["issue": task.issue.slug, "pr": "\(number)"]
                    )
                    return
                case .wakeWorker(let why):
                    // A red made only of administrative checks is the
                    // operator's, not a worker's: every queen/* pull request
                    // fails the `cla` bot, so this path woke bees dozens of
                    // times a day about a red no code change can turn green.
                    // Name the checks and stand down.
                    if QueenMergeGate.administrativeOnly(failingChecks) {
                        TriosLogBus.shared.info(
                            .queen, "queen.pr.gate_administrative",
                            "#\(number) is red only on administrative check(s) "
                                + "(\(failingChecks.joined(separator: ", "))); "
                                + "nothing a worker can fix - waiting on the operator",
                            ["issue": task.issue.slug, "pr": "\(number)"]
                        )
                        return
                    }
                    // Red means the bee goes back to work, not that the Queen
                    // fixes it. The instruction names the failing checks,
                    // because a wake-up that says only "it is red" gives the
                    // worker nothing to act on and it repeats what it did.
                    TriosLogBus.shared.warn(
                        .queen, "queen.pr.gate_red",
                        "#\(number) is red: \(why). Waking \(task.worker).",
                        [
                            "issue": task.issue.slug, "pr": "\(number)",
                            "checks": failingChecks.joined(separator: ", "),
                        ]
                    )
                    await appendCorrectionToWorkerChat(
                        task: task,
                        text: QueenMergeGate.wakeInstruction(
                            prNumber: number, reason: why, failingChecks: failingChecks
                        )
                    )
                    // NOT a transition to .rejected: pull requests are polled
                    // for ACCEPTED tasks, and .accepted allows only .merged
                    // (QueenDelegation transition table) - so the attempt was
                    // refused on every single execution, logging "Cannot
                    // move ... from accepted to rejected" beside each wake.
                    // The correction in the worker chat is the wake; the
                    // record stays accepted until the forge says merged.
                    return
                case .merge:
                    break
                }
                TriosLogBus.shared.info(
                    .queen, "queen.pr.merge_attempt", "Attempting to merge a reviewed pull request",
                    ["issue": task.issue.slug, "pr": "\(number)"]
                )
                do {
                    let mergeOutcome = try await client.mergePullRequest(
                        repo: prRepo,
                        number: number,
                        title: "\(task.title) (\(task.issue.slug))",
                        sha: reviewedSHA
                    )
                    switch mergeOutcome {
                    case .merged:
                        TriosLogBus.shared.info(
                            .queen, "queen.pr.merged", "Merged a reviewed pull request",
                            ["issue": task.issue.slug, "pr": "\(number)"]
                        )
                        registry.transition(taskID: task.id, to: .merged)
                        await appendSystemMessageToQueenChat(
                            SystemNoticeClassifier.successMarker
                                + "Merged #\(number) for \(task.issue.slug). The work is in, and "
                                + "the chat is archived because the forge says so - not because "
                                + "I liked the result."
                        )
                        continue
                    case .conflict(let mergeable, let mergeState):
                        // A conflict is permanent: the branches diverge and
                        // retrying will never succeed. Emit its own event
                        // naming the conflict, then transition the task out
                        // of .accepted so pollPullRequests stops picking it
                        // up — the task is back in the review queue until
                        // someone rebases (#1252).
                        TriosLogBus.shared.warn(
                            .queen, "queen.pr.conflict",
                            "Pull request has merge conflicts and will not be retried",
                            ["issue": task.issue.slug, "pr": "\(number)",
                             "mergeable": "\(mergeable ?? false)",
                             "merge_state": mergeState ?? "dirty"]
                        )
                        if registry.transition(taskID: task.id, to: .awaitingReview) {
                            await appendSystemMessageToQueenChat(
                                SystemNoticeClassifier.failureMarker
                                    + "#\(number) for \(task.issue.slug) has merge conflicts "
                                    + "(merge_state: \(mergeState ?? "dirty")). "
                                    + "The task is back in the review queue - it will not be "
                                    + "retried until the branch is rebased."
                            )
                        }
                        continue
                    case .headMoved:
                        // The branch head moved since the reviewed commit (409).
                        // The code the Queen approved is no longer the code on
                        // the branch. Transition the task back to review so the
                        // new head is examined, and clear the SHA so it is
                        // re-captured on the next review (#1254).
                        TriosLogBus.shared.warn(
                            .queen, "queen.pr.head_moved",
                            "The branch head moved since the reviewed commit (409)",
                            ["issue": task.issue.slug, "pr": "\(number)",
                             "reviewed_sha": reviewedSHA ?? "-"]
                        )
                        registry.clearReviewedHeadSHA(taskID: task.id)
                        if registry.transition(taskID: task.id, to: .awaitingReview) {
                            await appendSystemMessageToQueenChat(
                                SystemNoticeClassifier.warningMarker
                                    + "#\(number) for \(task.issue.slug) was pushed to after "
                                    + "my review, so the commit I approved is no longer the head. "
                                    + "The task is back in the review queue - the new head must be "
                                    + "checked before it can be merged."
                            )
                        }
                        continue
                    case .refused(let statusCode, _, _):
                        TriosLogBus.shared.warn(
                            .queen, "queen.pr.merge_refused",
                            "The forge refused the merge (HTTP \(statusCode))",
                            ["issue": task.issue.slug, "pr": "\(number)", "status": "\(statusCode)"]
                        )
                    }
                } catch {
                    TriosLogBus.shared.warn(
                        .queen, "queen.pr.merge_refused", "The forge refused the merge",
                        ["issue": task.issue.slug, "pr": "\(number)", "error": "\(error)"]
                    )
                }
            }

            let outcome = QueenDelegationPolicy.outcome(
                merged: pullRequest.isMerged,
                closedUnmerged: pullRequest.isClosedUnmerged
            )
            guard let next = QueenDelegationPolicy.nextState(for: outcome),
                  registry.transition(taskID: task.id, to: next) else { continue }

            switch outcome {
            case .landed:
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.successMarker
                        + "#\(number) merged, so \(task.issue.slug) is done and its chat is "
                        + "archived. That is the forge saying the work landed, not me saying "
                        + "I liked it."
                )
            case .abandoned:
                await appendSystemMessageToQueenChat(
                    SystemNoticeClassifier.warningMarker
                        + "#\(number) was closed without merging, so \(task.issue.slug) is "
                        + "back in the review queue. Nothing landed - the branch still holds "
                        + "the work, and it needs a decision rather than an archive."
                )
            case .pending:
                break
            }
            TriosLogBus.shared.info(
                .queen, "queen.pr.polled", "Read a pull request outcome",
                ["issue": task.issue.slug, "pr": "\(number)", "outcome": outcome.rawValue]
            )
        }
        registry.pruneArchive()
    }

    /// Seals a task's verdicts against the boundary state they were carved
    /// from (#1131).
    ///
    /// Called at every moment verdicts are recorded — the evidence pass, the
    /// reviewer's answer, a verdict recorded by hand — so the fingerprint and
    /// the verdicts share one instant. Only the task's `ownedPaths` are
    /// hashed, so the Queen's own state writes cannot age a verdict.
    ///
    /// A re-seal starts from nothing: the binding from an earlier recording
    /// is cleared first, so verdicts recorded now are never silently
    /// presented as checked against an older tree. If the fingerprint then
    /// cannot be computed (git refused to stage or write the tree), the
    /// binding stays missing — which reads as "missing, not stale" at
    /// acceptance (#1131 criterion 3), never as a freshness it did not earn.
    ///
    /// The closing assertion is #1131 criterion 4: if the write below is
    /// removed or bypassed, `queen.assertion.fingerprint_not_recorded` fires
    /// in the journal — verdicts recorded without a state binding make the
    /// staleness check blind, and the blindness is named rather than passed
    /// silently. That is the sense in which "the check breaks if you remove
    /// the fingerprint recording."
    private func sealVerdictsWithBoundaryState(_ task: DelegatedTask) async {
        // An empty boundary has nothing to fingerprint. nil is "missing,"
        // not "stale" — the verdicts stand as they were (#1131 criterion 3).
        guard !task.ownedPaths.isEmpty else { return }
        // Clear the earlier binding before computing the new one: verdicts
        // recorded now must not inherit the tree an earlier recording was
        // sealed against — especially not through a failed computation.
        verdictTreeStates.removeValue(forKey: task.id)
        let snapshot = await QueenBranchCommitter.fingerprintBoundary(
            ownedPaths: task.ownedPaths
        )
        guard let snapshot else {
            // A distinct, named case (#1131): git could not produce the
            // tree. This is not the removed-write regression below — the
            // write ran and had nothing to write. The binding stays
            // missing, which acceptance reads as "missing ≠ stale".
            TriosLogBus.shared.warn(
                .queen, "queen.review.fingerprint_unavailable",
                "Boundary fingerprint could not be computed; verdicts are recorded without a state binding",
                [
                    "issue": task.issue.slug,
                    "owned_paths": task.ownedPaths.joined(separator: ", ")
                ]
            )
            return
        }
        verdictTreeStates[task.id] = snapshot
        // Regression guard (#1131 criterion 4): a snapshot existed, yet the
        // binding is missing — the write above was removed or bypassed.
        // Without the binding, `isStale` answers false for every verdict
        // and the gate can never block on moved code, which is exactly the
        // original defect: the mechanism written, the wiring gone, every
        // acceptance passing on a check that cannot fire.
        if verdictTreeStates[task.id] == nil {
            TriosLogBus.shared.warn(
                .queen, "queen.assertion.fingerprint_not_recorded",
                "Verdicts were recorded but no state fingerprint was bound — the staleness check is blind. If the write in sealVerdictsWithBoundaryState was removed or bypassed, this is that break (#1131 criterion 4).",
                [
                    "issue": task.issue.slug,
                    "owned_paths": task.ownedPaths.joined(separator: ", ")
                ]
            )
        }
    }

    /// Records what was found when one acceptance criterion was checked.
    func recordCriterionVerdict(
        issue: IssueReference,
        criterion: String,
        verdict: QueenCriterionVerdict
    ) async {
        let registry = delegationRegistry
        guard let task = registry.task(forIssue: issue) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker + "I have no task for \(issue.slug)."
            )
            return
        }
        guard registry.recordVerdict(taskID: task.id, criterion: criterion, verdict: verdict) else {
            // Refused rather than filed under a criterion that does not exist.
            // A verdict nobody can see is worse than no verdict, because the
            // table would then show unchecked while someone believes they
            // answered it.
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "No criterion on \(issue.slug) reads \"\(criterion)\". The ones that exist:\n"
                    + QueenAcceptancePolicy.table(
                        criteria: task.acceptanceCriteria, recorded: task.criterionVerdicts
                    )
            )
            return
        }
        // Record the boundary-scoped fingerprint at the moment a verdict is
        // recorded by hand (#1131). Only the task's own files are hashed,
        // so the Queen's state writes cannot age a verdict. This is the
        // moment the fingerprint is written — at verdict recording time.
        await sealVerdictsWithBoundaryState(task)
        // A criterion that was asked-but-unanswered and now has a recorded
        // verdict is no longer unanswered. Clearing it here keeps the
        // tracking from going stale (#1117).
        if var unanswered = askedButUnanswered[task.id], !unanswered.isEmpty {
            unanswered.remove(criterion)
            if unanswered.isEmpty {
                askedButUnanswered.removeValue(forKey: task.id)
            } else {
                askedButUnanswered[task.id] = unanswered
            }
        }
        // A criterion that was declined (no diff) and now has a recorded
        // verdict is no longer declined — the diff must have changed.
        // Clearing it here keeps the tracking from going stale (#1165).
        if var declined = declinedNoDiff[task.id], !declined.isEmpty {
            declined.remove(criterion)
            if declined.isEmpty {
                declinedNoDiff.removeValue(forKey: task.id)
            } else {
                declinedNoDiff[task.id] = declined
            }
        }
        let updated = registry.task(forIssue: issue) ?? task
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Recorded.\n"
                + QueenAcceptancePolicy.table(
                    criteria: updated.acceptanceCriteria, recorded: updated.criterionVerdicts
                )
        )

        // If verdicts arrive after a decision, the decision is reconsidered,
        // not ignored (#1133). A criterion that was unchecked when acceptance
        // happened, or one whose verdict now contradicts the basis for it,
        // reopens the task so the new evidence can change the outcome. This is
        // the mirror of the gate in autoAcceptIfUnambiguous: that gate stops a
        // premature decision; this one undoes one the evidence has overtaken.
        if updated.state == .accepted, !updated.acceptanceCriteria.isEmpty {
            let reopenVerdictTreeState = verdictTreeStates[updated.id]
                ?? updated.treeStateFingerprint
            let reopenBoundaryState = await QueenBranchCommitter.fingerprintBoundary(
                ownedPaths: updated.ownedPaths
            )
            let reopenCurrentState = reopenBoundaryState ?? ""
            if let reason = acceptanceBlockReasonDistinguishingEmptyAnswers(
                for: updated,
                verdictTreeState: reopenVerdictTreeState,
                currentTreeState: reopenCurrentState
            ) {
                if registry.transition(taskID: updated.id, to: .awaitingReview) {
                    TriosLogBus.shared.info(
                        .queen, "queen.accept.reopened",
                        "Reopened after a late verdict changed the outcome",
                        [
                            "issue": issue.slug,
                            "reason": reason,
                            "criterion": criterion,
                            "verdict": verdict.rawValue
                        ]
                    )
                    await postQueenNotice(
                        SystemNoticeClassifier.warningMarker
                            + "Reopened \(issue.slug). A verdict recorded after "
                            + "acceptance changed the outcome: \(reason)"
                    )
                }
            }
        }
    }

    /// Records that the user agreed to a piece of work.
    func approveDelegation(issue: IssueReference) async {
        delegationRegistry.approve(issue: issue)
        await postQueenNotice(
            SystemNoticeClassifier.successMarker
                + "Noted - I may open a chat for \(issue.slug). I will not start "
                + "anything else without asking."
        )
    }

    // MARK: - Self-audit

    /// Reads the repository for the defect shape that keeps recurring here and
    /// reports a ranked roadmap.
    ///
    /// Runs `grep` rather than asking a model, because "what should we improve"
    /// produces plausible roadmaps and no findings, while a symbol nobody calls
    /// is a fact.
    func runSelfAudit() async {
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Reading my own code. This takes a moment - I am counting call sites, "
                + "not asking anyone's opinion."
        )
        let findings = await Task.detached(priority: .utility) {
            Self.auditRepository(root: ProjectPaths.root)
        }.value
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + QueenSelfAudit.report(findings: findings, now: Date())
        )
        // The audit says what is wrong; this says what she would do about it.
        // Since she may no longer open a chat unasked, proposing is the only
        // way she moves the project at all - without it the consent gate makes
        // her passive rather than careful.
        let options = QueenEvolutionOptions.options(from: findings)
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker + QueenEvolutionOptions.message(for: options)
        )
        TriosLogBus.shared.info(
            .queen,
            "queen.selfaudit",
            "Self-audit complete",
            ["findings": String(findings.count), "options": String(options.count)]
        )
    }

    /// How often each function declared in the Queen's own files is mentioned
    /// anywhere in her subsystem.
    ///
    /// Scoped by filename rather than by symbol prefix, because Swift methods
    /// are named after what they do and no `func Queen...` convention exists to
    /// match on. Files called Queen*, Skill* or Swarm* are the same "her own
    /// organs" boundary the type scan uses, arrived at from the other side.
    nonisolated static func functionOccurrences(
        root: String,
        scopes: [String]
    ) -> [String: Int] {
        let declared = QueenStatusViewModel.runProcess(
            "/bin/sh",
            arguments: [
                "-c",
                "grep -rhoE 'func [a-z][A-Za-z0-9_]*' "
                    + "\(root)/rings/SR-00/Queen*.swift \(root)/rings/SR-01/Skill*.swift "
                    + "\(root)/rings/SR-02/Queen*.swift \(root)/BR-OUTPUT/Queen*.swift "
                    + "2>/dev/null | sed 's/func //' | sort -u"
            ],
            workDir: root,
            timeout: 30
        )
        // Three characters or fewer are too common to count honestly - `id`
        // appears everywhere and means nothing here.
        let names = declared
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.count > 3 }
        guard !names.isEmpty else { return [:] }

        let uses = QueenStatusViewModel.runProcess(
            "/usr/bin/grep",
            arguments: ["-rhowE", names.joined(separator: "|")] + scopes,
            workDir: root,
            timeout: 120
        )
        var counts: [String: Int] = [:]
        // Every declared name starts at zero, so one that appears nowhere is
        // reported rather than missing from the dictionary entirely - absent
        // and zero are different answers and this one must be zero.
        for name in names { counts[name] = 0 }
        for line in uses.components(separatedBy: .newlines) {
            let word = line.trimmingCharacters(in: .whitespaces)
            guard counts[word] != nil else { continue }
            counts[word, default: 0] += 1
        }
        return counts
    }

    /// Counts declarations against occurrences for the public surface of the
    /// Queen's own subsystem.
    nonisolated static func auditRepository(root: String) -> [QueenSelfAudit.Finding] {
        // Scoped to her own organs on purpose. An audit of the whole app returns
        // a wall of results nobody reads; an audit of the thing being changed
        // this week returns items someone will act on.
        let scopes = [
            "\(root)/rings/SR-00", "\(root)/rings/SR-01",
            "\(root)/rings/SR-02", "\(root)/BR-OUTPUT"
        ]
        // Types, not functions. Swift methods are named after what they do, so
        // matching `func Queen...` matched nothing at all and the first audit
        // reported a clean bill of health it had not earned.
        let declarationPattern = "(struct|class|enum|actor) (Queen|Skill|Swarm)[A-Za-z0-9_]*"
        let declared = QueenStatusViewModel.runProcess(
            "/usr/bin/grep",
            arguments: ["-rhoE", declarationPattern] + scopes,
            workDir: root,
            timeout: 30
        )

        var symbols: Set<String> = []
        for line in declared.components(separatedBy: .newlines) {
            guard let symbol = line.split(separator: " ").last.map(String.init),
                  symbol.count > 3 else { continue }
            symbols.insert(symbol)
        }

        // One occurrence is the declaration itself. Two is a declaration plus a
        // single mention, which for a type usually means only its own file
        // refers to it.
        var occurrences: [String: Int] = [:]
        for symbol in symbols.sorted() {
            let uses = QueenStatusViewModel.runProcess(
                "/usr/bin/grep",
                arguments: ["-rhow", symbol] + scopes,
                workDir: root,
                timeout: 20
            )
            occurrences[symbol] = uses.components(separatedBy: .newlines).filter { !$0.isEmpty }.count
        }

        // Functions as well as types now, in one pass rather than one grep per
        // name: there are 208 of them against 45 types, and 208 subprocesses is
        // a button nobody presses twice.
        //
        // Counting a bare word rather than `name(` is the whole reason this is
        // trustworthy. A scan I kept privately for a week matched only calls
        // written with a parenthesis, so it missed `plan { ... }` written as a
        // trailing closure and `Button(action: copyDiff)` written as a value -
        // both everyday Swift - and called three live functions dead. This
        // counts the identifier wherever it appears, which is what the type
        // scan above has always done.
        occurrences.merge(Self.functionOccurrences(root: root, scopes: scopes)) { a, _ in a }

        // The ranking rule lives in QueenSelfAudit.deadSymbols, which has tests
        // and, until now, no caller: this function counted occurrences and then
        // applied the same threshold inline. Two implementations of one idea,
        // and the one that ran was the one nothing checked. Whichever of them
        // drifted, the audit would have kept reporting confidently.
        var findings: [QueenSelfAudit.Finding] = []
        for symbol in QueenSelfAudit.deadSymbols(declarations: occurrences) {
            findings.append(QueenSelfAudit.Finding(
                severity: .dead,
                kind: "zero-call-sites",
                subject: symbol,
                explanation: "It is declared once and referenced nowhere else, so whatever "
                    + "it does, nothing asks it to.",
                proposal: "Either wire it to a caller or delete it - a capability with no "
                    + "path to it is worse than an absent one, because it reads as done."
            ))
        }
        return findings
    }

    /// What the Queen has learned about which signals actually need the user.
    ///
    /// The learner was writing to disk with nothing reading it back out in
    /// words - which is the same zero-call-site shape `/roadmap` exists to
    /// catch, written by the hand that built the detector.
    private func reportSalience() async {
        let learner = SalienceLearner.shared
        let lines = QueenSalience.Feature.allCases.map { feature -> String in
            let weight = learner.weight(for: feature)
            let source = weight == feature.prior ? "prior" : "learned"
            // Shown in whole weights, stored in milli-weights: the operator is
            // reading a ranking, not auditing the third decimal.
            let shown = Double(weight) / 1000
            let startedAt = Double(feature.prior) / 1000
            return String(
                format: "  %@  weight %.1f (%@, started at %.0f)  -  %@",
                feature.rawValue, shown, source, startedAt,
                learner.evidence(for: feature)
            )
        }
        let drifted = learner.drift()
        let driftLine: String
        if drifted.isEmpty {
            driftLine = "\n\nNothing has moved off my starting estimates yet. "
                + "Come back after a week of real reviews and this line will say "
                + "what changed."
        } else {
            let moves = drifted.map {
                String(
                    format: "%@ %.0f -> %.1f after %d",
                    $0.feature.rawValue, $0.from, $0.to, $0.seen
                )
            }
            driftLine = "\n\nMoved so far: " + moves.joined(separator: "; ") + "."
        }

        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "How loudly each signal shouts when I order your review queue. "
                + "A weight starts as my estimate and becomes the rate at which "
                + "tasks carrying that signal actually needed you, once I have seen "
                + "\(learner.minimumObservations) of them - a threshold I derive from "
                + "how finely the estimates are trying to distinguish, not a number I "
                + "picked.\n" + lines.joined(separator: "\n") + driftLine
        )
    }

    // MARK: - Skills

    /// Recalled memory plus, in the Queen's chat, her standing orders.
    ///
    /// Without this the model driving the Queen had no idea she had skills,
    /// workers or commands: she could only run a skill if the user already knew
    /// its exact name and typed it. A capability the agent cannot see is a
    /// capability it does not have.
    private func composedSystemPrompt() -> String? {
        let memory = memoryService.promptContext(for: recalledMemories)
        guard conversationId == ChatConversation.trinityQueenId else { return memory }

        let registry = delegationRegistry
        let store = skillStore
        let charter = QueenSystemPrompt.text(
            skills: store.enabled,
            disabledSkills: store.skills
                .filter { !store.isEnabled($0) }
                .map(\.id),
            runningWorkers: registry.running.count,
            awaitingReview: registry.reviewQueue.count
        )
        guard let memory, !memory.isEmpty else { return charter }
        return charter + "\n\n" + memory
    }

    private func reportSkills() async {
        let store = skillStore
        store.reload()
        guard !store.skills.isEmpty else {
            await postQueenNotice(
                SystemNoticeClassifier.infoMarker
                    + "I have no skills installed. They live in .claude/skills/<name>/SKILL.md; "
                    + "write one and it appears here without a rebuild."
            )
            return
        }
        // Stamped, because this listing lives in the transcript forever while
        // the toggles behind it keep moving. An undated snapshot is read later
        // as a standing fact - which is exactly how a switched-on skill got
        // reported as switched off from scrollback.
        let stamp = DateFormatter()
        stamp.dateFormat = "HH:mm"
        let asOf = stamp.string(from: Date())
        let lines = store.skills.map { skill -> String in
            let mark = store.isEnabled(skill) ? " " : "off"
            return "\(mark) \(skill.id)  (\(skill.source.displayName))  -  \(skill.description)"
        }
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "As of \(asOf): \(store.enabled.count) of \(store.skills.count) skills are available to me. "
                + "Each one is a rehearsed procedure rather than something I improvise, which is "
                + "why switching one off narrows what I can do rather than how well I do it. "
                + "Manage them in the Skills tab.\n"
                + lines.joined(separator: "\n")
        )
    }

    private func runQueenSkill(command: String, arguments: [String]) async {
        let store = skillStore
        guard let skill = store.skill(named: command) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "There is no skill called `\(command)`. Say /skills to see what I have."
            )
            return
        }
        guard store.isEnabled(skill) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "`\(command)` is switched off in the Skills tab, so I left it alone."
            )
            return
        }
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Running `\(command)`: \(skill.description)"
        )
        let output = await store.run(command, arguments: arguments)
        await postQueenNotice(SystemNoticeClassifier.infoMarker + "`\(command)` said:\n\(output)")
    }

    /// Stops a worker and says so.
    ///
    /// Exposed as a command and as a button, because the moment you want it is
    /// the moment the observer has just told you a bee is looping - and hunting
    /// for the right syntax then is how a wasted turn becomes a wasted ten.
    func cancelDelegatedTask(issue: IssueReference, reason: String) async {
        let registry = delegationRegistry
        guard let task = registry.task(forIssue: issue) else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker + "\(issue.slug) has no open task to stop."
            )
            return
        }
        // A cancel is the strongest label there is: it needed you badly enough
        // that you stopped it mid-flight.
        SalienceLearner.shared.record(task: task, neededUser: true)
        workerRunner?.stop(conversationId: task.conversationId)
        guard registry.transition(taskID: task.id, to: .cancelled) else {
            await postQueenNotice(
                SystemNoticeClassifier.failureMarker
                    + (registry.lastError ?? "Could not stop \(issue.slug).")
            )
            return
        }
        let because = reason.isEmpty ? "" : " Reason: \(reason)."
        await postQueenNotice(
            SystemNoticeClassifier.warningMarker
                + "Stopped \(task.worker) on \(issue.slug).\(because) Its chat and branch "
                + "survive, so whatever it managed before I cut it is still there to look at. "
                + "Re-delegate when you want another attempt."
        )
        TriosLogBus.shared.warn(
            .queen,
            "queen.worker.cancelled",
            "Worker stopped by request",
            ["issue": issue.slug, "worker": task.worker]
        )
        await loadConversations()
    }

    /// Files away every FAILED record of an issue, once somebody has looked.
    ///
    /// `failed` is deliberately not archivable so a failure gets eyes before
    /// it disappears; this command IS the record of those eyes. It drives the
    /// legal (.failed, .cancelled) transition that no command could reach -
    /// measured 2026-08-21 when three queued /cancel verdicts were refused:
    /// task(forIssue:) hides terminal records, so looked-at failures haunted
    /// the reconcile pass with no way to retire them. All failed records of
    /// the issue go together: the looking happened at issue level.
    func dismissFailedTask(issue: IssueReference, reason: String) async {
        let registry = delegationRegistry
        let failed = registry.tasks.filter { $0.issue == issue && $0.state == .failed }
        guard !failed.isEmpty else {
            await postQueenNotice(
                SystemNoticeClassifier.warningMarker
                    + "\(issue.slug) has no failed record to dismiss."
            )
            return
        }
        var moved = 0
        for task in failed where registry.transition(taskID: task.id, to: .cancelled) {
            moved += 1
            TriosLogBus.shared.info(
                .queen, "queen.task.dismissed",
                "Dismissed a failed record of \(issue.slug): \(reason)",
                ["issue": issue.slug, "record": task.id.uuidString]
            )
        }
        await postQueenNotice(
            SystemNoticeClassifier.infoMarker
                + "Filed away \(moved) failed record(s) of \(issue.slug). "
                + "Reason: \(reason). Branches and chats survive; the archive "
                + "sweep will stamp them on its next pass."
        )
        await loadConversations()
    }

    private func delegateTaskToAgent(agentIdString: String, taskDescription: String) async {
        await queenBackgroundService?.delegateTask(agentId: agentIdString, description: taskDescription)
    }

    private func broadcastToAgents(_ message: String) async {
        await queenBackgroundService?.broadcast(message: message)
    }

    private func recallQueenMemory() async {
        let goal = "Queen self-improvement and recent system activity"
        let matches = await memoryService.recall(for: goal, limit: 5)
        let lines = matches.map { "* \($0.record.displayBody.prefix(120))" }
        let text = lines.isEmpty ? "No recent memory entries found." : lines.joined(separator: "\n")
        await appendSystemMessageToQueenChat("Recalled memory:\n\(text)")
    }

    private func runQueenEvolution() async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        await service.runAudit()
        if let event = service.lastAudit {
            let proposalLines = service.proposals.filter { $0.status == .pending }.map {
                "* \($0.id.uuidString.prefix(8))  -  \($0.targetFile): \($0.rationale.prefix(80))"
            }
            let proposalText = proposalLines.isEmpty ? "No pending proposals." : proposalLines.joined(separator: "\n")
            await appendSystemMessageToQueenChat(
                "Audit complete: \(event.findings.joined(separator: "; "))\n\nPending proposals:\n\(proposalText)"
            )
        }
    }

    private func listQueenProposals() async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        let pending = service.proposals.filter { $0.status == .pending }
        let lines = pending.map {
            "\($0.id.uuidString)  -  \($0.targetFile)\n  Trigger: \($0.trigger)\n  Rationale: \($0.rationale.prefix(120))"
        }
        let text = lines.isEmpty ? "No pending proposals. Run /evolve to generate some." : lines.joined(separator: "\n\n")
        await appendSystemMessageToQueenChat("Pending Queen proposals:\n\(text)")
    }

    private func applyQueenProposal(id: UUID, confirmed: Bool) async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        guard let proposal = service.approveProposal(id: id) else {
            await appendSystemMessageToQueenChat("Proposal \(id.uuidString.prefix(8)) not found or already processed.")
            return
        }

        if !confirmed {
            await appendSystemMessageToQueenChat(
                "Proposal \(proposal.id.uuidString.prefix(8)) approved. Staging preview (build only)..."
            )
            let result = await QueenProposalApplier.shared.apply(
                proposal,
                projectRoot: ProjectPaths.root,
                confirmed: false
            )
            if result.success, let branchName = result.branchName {
                stagedProposalIds.insert(proposal.id)
                stagedProposalBranches[proposal.id] = branchName
                await appendSystemMessageToQueenChat(
                    result.summary + "\n\nTo land this change, run `/apply \(proposal.id.uuidString) confirm`."
                )
            } else {
                await appendSystemMessageToQueenChat(result.summary)
            }
            return
        }

        await appendSystemMessageToQueenChat(
            "Proposal \(proposal.id.uuidString.prefix(8)) confirmed. Committing, pushing, and opening draft PR..."
        )
        let reuseBranch = stagedProposalBranches[proposal.id]
        let result = await QueenProposalApplier.shared.apply(
            proposal,
            projectRoot: ProjectPaths.root,
            confirmed: true,
            reuseBranch: reuseBranch
        )
        stagedProposalIds.remove(proposal.id)
        stagedProposalBranches.removeValue(forKey: proposal.id)
        await appendSystemMessageToQueenChat(result.summary)
    }

    private func rejectQueenProposal(id: UUID) async {
        guard let service = queenBackgroundService else {
            await appendSystemMessageToQueenChat("Queen background service is not available.")
            return
        }
        service.rejectProposal(id: id)
        await appendSystemMessageToQueenChat("Proposal \(id.uuidString.prefix(8)) rejected and removed from pending queue.")
    }
}

extension ChatViewModel: QueenBackgroundServiceDelegate {
    func queenBackgroundService(
        _ service: QueenBackgroundService,
        didReceiveA2AMessage message: ChatMessage
    ) {
        guard conversationId == ChatConversation.trinityQueenId else {
            Task {
                await loadConversations()
            }
            return
        }

        // QueenBackgroundService already persisted the inbound A2A message to the
        // persister before calling the delegate. Reload the canonical history so we
        // never double-write the same message, then append only if the delegate
        // message is not already present.
        Task {
            let history = await persister.load(conversationId: ChatConversation.trinityQueenId)
            var updated = history
            if !history.contains(where: { $0.id == message.id }) {
                updated.append(message)
                await persister.save(messages: updated, conversationId: ChatConversation.trinityQueenId)
            }
            messages = updated
            rebuildCache()
            await loadConversations()
        }
    }

    func queenBackgroundServiceDidUpdateState(_ service: QueenBackgroundService) {
        isA2ARegistered = service.isA2ARegistered
    }
}

struct ChatRequestAttachment: Equatable, Sendable {
    let kind: String
    let mediaType: String
    let dataURL: String
}

struct ChatRequestBuilder {
    let conversationId: UUID
    let message: String
    let mode: String
    let origin: String
    let userSystemPrompt: String?
    let previousConversation: [ChatMessage]
    let browserContext: BrowserContext?
    let modelConfiguration: ModelRuntimeConfiguration?
    let attachments: [ChatRequestAttachment]?
    /// Where the agent's file tools start. `nil` means the user's home
    /// directory, which suits a general assistant. A delegated worker must be
    /// pointed at the repository its branch lives in: left at home, one bee
    /// found an unrelated old checkout under ~/gitbutler and edited that
    /// instead, so its branch here stayed empty.
    let workingDirectory: String?

    init(
        conversationId: UUID,
        message: String,
        mode: String,
        origin: String,
        userSystemPrompt: String?,
        previousConversation: [ChatMessage],
        browserContext: BrowserContext?,
        modelConfiguration: ModelRuntimeConfiguration? = nil,
        attachments: [ChatRequestAttachment]? = nil,
        workingDirectory: String? = nil
    ) {
        self.conversationId = conversationId
        self.message = message
        self.mode = mode
        self.origin = origin
        self.userSystemPrompt = userSystemPrompt
        self.previousConversation = previousConversation
        self.browserContext = browserContext
        self.modelConfiguration = modelConfiguration
        self.attachments = attachments
        self.workingDirectory = workingDirectory
    }

    private var memoryPrompt: String {
        """
        You are \(TriosBranding.displayName), a native macOS AI assistant with full memory of this conversation. \
        You can see all previous messages, reasoning steps, tool calls, and user instructions. \
        Reference prior context naturally. If the user refers to "that", "it", or previous topics, \
        use your memory to understand the reference. Maintain continuity across the entire session.
        """
    }

    /// Return a sensible default model for common providers so that an
    /// unconfigured launch does not immediately fail with a model mismatch
    /// (e.g., Ollama cannot load a cloud-only model name).
    static func defaultModel(for provider: String) -> String {
        switch provider {
        case "zai":
            return "glm-4.6"
        case "openrouter":
            return "anthropic/claude-4-sonnet"
        case "anthropic":
            return "claude-4-sonnet"
        case "openai":
            return "gpt-5"
        case "ollama":
            return "llama3.1"
        default:
            return "llama3.1"
        }
    }

    func build() throws -> Data {
        var messages: [[String: Any]] = []

        // System memory prompt. Recalled context is explicitly marked as untrusted
        // so the model does not treat it as a privileged instruction.
        let systemContent: String
        if let userSystemPrompt = userSystemPrompt, !userSystemPrompt.isEmpty {
            systemContent = "\(memoryPrompt)\n[Recalled memory  -  verify before acting]\n\(userSystemPrompt)"
        } else {
            systemContent = memoryPrompt
        }
        messages.append(["role": "system", "content": systemContent])

        // Conversation history: only the public message content is sent to the
        // model. Reasoning, tool inputs/outputs, and error metadata remain in the
        // local UI store and are not forwarded as prompt context.
        for msg in previousConversation {
            messages.append(["role": msg.role.rawValue, "content": msg.content])
        }

        // Current user message
        messages.append(["role": "user", "content": message])

        let homeDir = workingDirectory
            ?? FileManager.default.homeDirectoryForCurrentUser.path

        let runtimeConfiguration = modelConfiguration ?? .environmentFallback()

        var body: [String: Any] = [
            "conversationId": conversationId.uuidString,
            "message": message,
            "mode": mode,
            "origin": origin,
            "supportsImages": true,
            "messages": messages,
            "userWorkingDir": homeDir
        ]
        runtimeConfiguration.apply(to: &body)

        if let attachments = attachments, !attachments.isEmpty {
            body["attachments"] = attachments.map { attachment in
                [
                    "kind": attachment.kind,
                    "mediaType": attachment.mediaType,
                    "dataUrl": attachment.dataURL
                ]
            }
        }

        // Flatten history for backward-compatible servers.
        // Server-side validators for the legacy previousConversation field only
        // accept user/assistant roles; system/error messages must be translated or
        // omitted to avoid 400 Bad Request.
        if !previousConversation.isEmpty {
            let history = previousConversation.compactMap { msg -> [String: String]? in
                switch msg.role {
                case .user, .assistant:
                    return ["role": msg.role.rawValue, "content": msg.content]
                case .system:
                    // Translate error messages into assistant context so the server
                    // accepts them while preserving the failure signal for the model.
                    return ["role": "assistant", "content": "[SYSTEM ERROR] \(msg.content)"]
                case .tool:
                    return ["role": "assistant", "content": "[TOOL RESULT] \(msg.content)"]
                }
            }
            if !history.isEmpty {
                body["previousConversation"] = history
            }
        }

        if let context = browserContext {
            body["browserContext"] = [
                "url": context.url,
                "title": context.title
            ]
        }

        return try JSONSerialization.data(withJSONObject: body, options: [])
    }
}

struct BrowserContext {
    let url: String
    let title: String
}

// MARK: - Character-count criteria (#1151)

/// The result of a character-count check: the verdict, how many
/// characters were measured, and what the threshold was. The measured
/// number is carried so a log or a test can show it — a verdict that
/// says "met" without showing the count is the model's word again,
/// just in code's clothing.
struct CharacterCountResult {
    let verdict: QueenCriterionVerdict
    let measured: Int
    let threshold: Int
}

extension ChatViewModel {

    /// Parses a minimum character threshold from criterion text.
    ///
    /// Recognises three shapes: plain digits ("at least 300 characters"),
    /// English word numbers ("at least three hundred characters"), and
    /// Russian word numbers in genitive ("не меньше трёхсот знаков").
    /// Returns nil when the criterion names no character threshold —
    /// that shape is not recognised and still goes to the model (#1151).
    static func characterThreshold(in criterion: String) -> Int? {
        let lower = criterion.lowercased()

        // 1. Plain digits: "300 characters", "500 знаков"
        //    Preceded by "at least", "не менее", or bare.
        let digitRegexes: [String] = [
            "(?:at least|minimum)\\s+(\\d+)\\s+(?:char|знак|символ)",
            "(?:не менее|не меньше)\\s+(\\d+)\\s+(?:знак|символ|char)",
            "(\\d+)\\s+(?:characters|chars|знаков|знака|символов|символа)",
        ]
        for pattern in digitRegexes {
            if let regex = try? NSRegularExpression(
                pattern: pattern, options: [.caseInsensitive]),
               let match = regex.firstMatch(
                in: lower, range: NSRange(lower.startIndex..., in: lower)),
               match.numberOfRanges >= 2,
               let numberRange = Range(match.range(at: 1), in: lower),
               let n = Int(lower[numberRange])
            {
                return n
            }
        }

        // 2. English word numbers: "three hundred characters"
        let engOnes: [String: Int] = [
            "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
            "six": 6, "seven": 7, "eight": 8, "nine": 9,
        ]
        let engPattern =
            "(?:at least\\s+)?(one|two|three|four|five|six|seven|eight|nine)\\s+hundred\\s+char"
        if let regex = try? NSRegularExpression(
            pattern: engPattern, options: [.caseInsensitive]),
           let match = regex.firstMatch(
            in: lower, range: NSRange(lower.startIndex..., in: lower)),
           match.numberOfRanges >= 2,
           let wordRange = Range(match.range(at: 1), in: lower)
        {
            let word = String(lower[wordRange])
            if let n = engOnes[word] {
                return n * 100
            }
        }

        // 3. Russian word numbers (genitive, after "не меньше/не менее"):
        //    "трёхсот знаков" → 300, "пятисот знаков" → 500.
        //    Both ё and е variants are accepted.
        let ruHundreds: [String: Int] = [
            "двухсот": 200, "трёхсот": 300, "трехсот": 300,
            "четырёхсот": 400, "четырехсот": 400,
            "пятисот": 500, "шестисот": 600, "семисот": 700,
            "восьмисот": 800, "девятисот": 900,
        ]
        let hasCharWord = lower.contains("знак")
            || lower.contains("символ")
            || lower.contains("char")
        for (word, value) in ruHundreds where hasCharWord && lower.contains(word) {
            return value
        }

        return nil
    }

    /// Verdicts the Queen can reach by counting characters in the files
    /// the task boundary owns — without taking the model's word.
    ///
    /// A criterion whose threshold `characterThreshold` can recognise
    /// gets a measured verdict: the file is read, characters are counted,
    /// and the count is compared to the threshold. One whose shape is
    /// not recognised gets no entry and stays unchecked, so it still
    /// goes to the reviewer. This is the second mechanical shape after
    /// file-existence (#1151).
    ///
    /// `projectRoot` defaults to `ProjectPaths.root` in production and
    /// is overridable so a test can point it at a scratch directory.
    static func characterCountVerdicts(
        criteria: [String],
        ownedPaths: [String],
        projectRoot: String? = nil
    ) -> [String: CharacterCountResult] {
        let root = projectRoot ?? ProjectPaths.root
        var results: [String: CharacterCountResult] = [:]

        for criterion in criteria {
            guard let threshold = characterThreshold(in: criterion) else { continue }

            // Find the file(s) to count. A criterion that names a path
            // ("Write docs/foo.md …") is checked against that file; one
            // that names none is checked against the task's owned paths.
            let mentioned = QueenAcceptancePolicy.pathsMentioned(in: criterion)
            let candidates = mentioned.isEmpty
                ? ownedPaths.map { QueenDelegationPolicy.normalizePath($0) }
                    .filter { !$0.isEmpty }
                : mentioned

            var measured = 0
            for path in candidates {
                let fullPath = "\(root)/\(path)"
                if let content = try? String(contentsOfFile: fullPath, encoding: .utf8) {
                    measured += content.count
                }
            }

            let verdict: QueenCriterionVerdict = measured >= threshold ? .met : .unmet
            results[criterion] = CharacterCountResult(
                verdict: verdict,
                measured: measured,
                threshold: threshold
            )
        }

        return results
    }
}
