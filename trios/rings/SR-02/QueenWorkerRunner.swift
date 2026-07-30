import Combine
import Foundation

/// Runs a delegated worker's turn without occupying the chat UI.
///
/// The Queen delegates and stays in her own chat; a worker that only exists as
/// a saved briefing is not a worker at all. This runner opens its own transport
/// per task, drives the same SSE parser the main chat uses, and writes the
/// resulting transcript into the worker's conversation. Nothing here reads or
/// writes `ChatViewModel.messages`, which is why navigating between chats
/// cannot cancel a bee mid-flight.
@MainActor
final class QueenWorkerRunner: ObservableObject {
    /// Live transcript per worker conversation, so a chat opened while its
    /// worker is still running shows the stream instead of a stale snapshot.
    @Published private(set) var transcripts: [UUID: [ChatMessage]] = [:]
    /// Conversations with a turn in flight right now.
    @Published private(set) var runningConversationIds: Set<UUID> = []

    /// Called when a worker's turn ends, on the main actor.
    /// `failure` is nil when the worker finished cleanly.
    var onFinish: ((DelegatedTask, _ failure: String?, _ usage: WorkerUsage) -> Void)?

    /// Called once the model for a turn is resolved.
    var onModelResolved: ((DelegatedTask, _ provider: String, _ model: String) -> Void)?

    /// Called as a worker streams, so an observer can read it without waiting
    /// for the turn to end. Passing the transcript rather than the delta keeps
    /// the observer stateless.
    var onProgress: ((DelegatedTask, QueenWorkerTranscript) -> Void)?

    /// What one worker turn consumed.
    struct WorkerUsage: Equatable {
        let inputTokens: Int
        let outputTokens: Int
        let toolCalls: Int
        static let zero = WorkerUsage(inputTokens: 0, outputTokens: 0, toolCalls: 0)
    }

    private let persister: ChatPersisterProtocol
    private let modelStore: ModelConfigurationStore
    private let makeTransport: @Sendable () -> ChatTransportProtocol
    private var runs: [UUID: Task<Void, Never>] = [:]
    private var liveUsage: [UUID: WorkerUsage] = [:]

    init(
        persister: ChatPersisterProtocol,
        modelStore: ModelConfigurationStore,
        makeTransport: @escaping @Sendable () -> ChatTransportProtocol
    ) {
        self.persister = persister
        self.modelStore = modelStore
        self.makeTransport = makeTransport
    }

    func isRunning(conversationId: UUID) -> Bool {
        runningConversationIds.contains(conversationId)
    }

    /// Starts the worker on its briefing. Returns immediately; the turn runs in
    /// the background and reports through `onFinish`.
    func start(task: DelegatedTask, brief: String) {
        guard runs[task.conversationId] == nil else { return }
        runningConversationIds.insert(task.conversationId)
        let run = Task { [weak self] () -> Void in
            await self?.execute(task: task, brief: brief)
        }
        runs[task.conversationId] = run
    }

    func stop(conversationId: UUID) {
        runs[conversationId]?.cancel()
        runs[conversationId] = nil
        runningConversationIds.remove(conversationId)
    }

    // MARK: - Execution

    private func execute(task: DelegatedTask, brief: String) async {
        // The briefing IS the worker's first user turn. Persisting it as a
        // system note and sending nothing was the whole bug: the chat existed,
        // the instructions existed, and no request was ever made.
        // Its own prior turns, and only its own. Empty on the first run; on a
        // re-brief after rejection this is what lets the worker see the attempt
        // the Queen sent back instead of starting from nothing.
        let priorTurns = await persister.load(conversationId: task.conversationId)
        priorTurns.forEach { $0.isStreaming = false }
        let prompt = ChatMessage(role: .user, content: brief)
        var transcript = QueenWorkerTranscript(seed: priorTurns + [prompt])
        publish(transcript, for: task.conversationId)
        await persister.save(messages: transcript.messages, conversationId: task.conversationId)

        let configuration = await modelStore.runtimeConfiguration
        // Remember which model did the work; a cost estimate after the fact
        // needs the price of the model that actually ran, not whatever is
        // selected when someone opens the swarm view later.
        onModelResolved?(task, configuration.provider.rawValue, configuration.model)
        TriosLogBus.shared.info(
            .queen,
            "queen.worker.start",
            "Worker turn starting",
            [
                "issue": task.issue.slug,
                "worker": task.worker,
                "provider": configuration.provider.rawValue,
                "model": configuration.model
            ]
        )

        guard let body = try? ChatRequestBuilder(
            conversationId: task.conversationId,
            message: brief,
            mode: "agent",
            origin: "sidepanel",
            userSystemPrompt: Self.workerSystemPrompt(for: task),
            // Only this worker's own chat, never the Queen's. Context subsetting
            // is the point of the supervisor pattern, not an optimisation.
            previousConversation: priorTurns,
            browserContext: nil,
            modelConfiguration: configuration,
            attachments: nil,
            // The repository the task's branch lives in. Anything else and the
            // bee's edits and its branch end up in different checkouts.
            workingDirectory: ProjectPaths.root
        ).build() else {
            await finish(task: task, transcript: &transcript, failure: "Could not build the worker request.")
            return
        }

        let transport = makeTransport()
        let parser = UIMessageStreamParser()
        do {
            let stream = try await transport.sendMessage(body: body)
            for await event in stream {
                if Task.isCancelled { break }
                if let action = await parser.parse(event) {
                    transcript.apply(action)
                    publish(transcript, for: task.conversationId)
                    liveUsage[task.conversationId] = WorkerUsage(
                        inputTokens: transcript.inputTokens,
                        outputTokens: transcript.outputTokens,
                        toolCalls: transcript.toolCallCount
                    )
                    onProgress?(task, transcript)
                }
            }
        } catch {
            transcript.failWithoutStream(Self.describe(error))
        }

        if !transcript.didComplete && !Task.isCancelled {
            // An unterminated stream must not be filed as a clean result; the
            // Queen would review an empty answer as if the worker had finished.
            transcript.failWithoutStream("The worker's stream ended without a terminal event.")
        }
        await finish(task: task, transcript: &transcript, failure: transcript.failure)
    }

    /// Live usage for a running worker, so the dashboard can show cost before
    /// the turn ends rather than only in hindsight.
    func usage(forConversation id: UUID) -> WorkerUsage? { liveUsage[id] }

    private func finish(
        task: DelegatedTask,
        transcript: inout QueenWorkerTranscript,
        failure: String?
    ) async {
        publish(transcript, for: task.conversationId)
        await persister.save(messages: transcript.messages, conversationId: task.conversationId)
        // Name the orphans. The server repairs them, but only a client-side
        // record makes "this run produced one" assertable - and the bug they
        // cause kills every later send on the conversation, not just this turn.
        let orphans = transcript.orphanedToolCallIDs
        if !orphans.isEmpty {
            TriosLogBus.shared.warn(
                .queen,
                "queen.worker.orphaned_tool_calls",
                "The stream ended with \(orphans.count) tool call(s) still unanswered",
                [
                    "issue": task.issue.slug,
                    "worker": task.worker,
                    "tool_calls": orphans.joined(separator: ",")
                ]
            )
        }
        runs[task.conversationId] = nil
        runningConversationIds.remove(task.conversationId)
        TriosLogBus.shared.info(
            .queen,
            failure == nil ? "queen.worker.finish" : "queen.worker.failed",
            failure ?? "Worker turn finished",
            [
                "issue": task.issue.slug,
                "worker": task.worker,
                "tools": String(transcript.toolCallCount),
                "chars": String(transcript.assistantText.count),
                // A preview, not the whole answer: enough to see what the bee
                // concluded without opening its chat, which is the difference
                // between diagnosing a silent worker and guessing at it.
                "preview": String(transcript.assistantText.suffix(400))
            ]
        )
        let usage = WorkerUsage(
            inputTokens: transcript.inputTokens,
            outputTokens: transcript.outputTokens,
            toolCalls: transcript.toolCallCount
        )
        liveUsage[task.conversationId] = usage
        onFinish?(task, failure, usage)
    }

    private func publish(_ transcript: QueenWorkerTranscript, for conversationId: UUID) {
        transcripts[conversationId] = transcript.messages
    }

    /// The worker's standing orders. Kept separate from the briefing so the
    /// boundary survives even if a worker is re-briefed later.
    static func workerSystemPrompt(for task: DelegatedTask) -> String {
        var lines = [
            "You are \(task.worker), a worker agent supervised by the Trinity Queen.",
            "You work on exactly one GitHub issue: \(task.issue.slug) (\(task.issue.url)).",
            "The repository is \(ProjectPaths.root). Work only inside it: "
                + "other checkouts of this project exist on this machine and "
                + "editing one of those puts your work where nobody looks for it.",
            "Do the work yourself. Do not delegate and do not open other chats."
        ]
        if let branch = task.virtualBranch {
            // The same sentence the specification carries, from the same
            // source. Restating it here is what let the two drift: these
            // standing orders kept "attribute every edit to the branch" - the
            // wording that made the first live worker run `git switch` - after
            // the specification had been corrected, and standing orders are the
            // ones an agent trusts.
            lines.append(QueenBranchPolicy.ownershipRule(branch: branch))
        }
        if task.ownedPaths.isEmpty {
            lines.append("No file boundary was set; ask before editing shared files.")
        } else {
            lines.append("You may edit only these paths: \(task.ownedPaths.joined(separator: ", ")).")
        }
        lines.append("When you are done, end with a short report the Queen can review.")
        return lines.joined(separator: " ")
    }

    private static func describe(_ error: Error) -> String {
        if let transportError = error as? TransportError {
            return "\(transportError)"
        }
        return error.localizedDescription
    }
}
