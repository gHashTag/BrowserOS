import Foundation

/// The kind of limit the streaming watchdog is approaching.
enum StreamingContextLimitKind: Equatable, Sendable {
    case outputTokens
    case totalContext
}

/// Decision emitted by the watchdog as the assistant response grows.
enum StreamingContextDecision: Equatable, Sendable {
    /// The response is well within budget.
    case ok
    /// The response is approaching a limit; the UI may show a warning.
    case approachingLimit(remainingTokens: Int, kind: StreamingContextLimitKind)
    /// The response has reached the limit; the stream should pause and the
    /// user must choose an action.
    case limitReached(partialText: String, suggestedAction: StreamingContextSuggestedAction)
}

/// Action the UI can offer when a stream hits a context limit.
enum StreamingContextSuggestedAction: Equatable, Sendable {
    case continueOnLargerModel(CrossProviderModelCandidate)
    case summarizeSoFar
    case stopHere
}

/// Watches an assistant response as it streams in and detects when it is
/// approaching the model's effective output limit or the remaining context
/// budget. Estimates are intentionally cheap and conservative; they are used
/// only for watchdog decisions, never for billing.
actor StreamingContextWatchdog: Sendable {
    static let shared = StreamingContextWatchdog()

    /// Ratio of output tokens at which the UI first warns.
    let warningOutputRatio: Double
    /// Ratio of output tokens at which the stream should pause.
    let pauseOutputRatio: Double
    /// Ratio of total context window at which the UI first warns.
    let warningTotalRatio: Double
    /// Ratio of total context window at which the stream should pause.
    let pauseTotalRatio: Double

    private var modelProfile: ModelContextProfile?
    private var estimatedInputTokens: Int = 0
    private var estimatedOutputTokens: Int = 0
    private var accumulatedText: String = ""
    private var margin: Double = 0.85
    private var hasWarned: Bool = false
    private var hasPaused: Bool = false

    init(
        warningOutputRatio: Double = 0.80,
        pauseOutputRatio: Double = 0.95,
        warningTotalRatio: Double = 0.90,
        pauseTotalRatio: Double = 0.98
    ) {
        self.warningOutputRatio = max(0.0, min(1.0, warningOutputRatio))
        self.pauseOutputRatio = max(warningOutputRatio, min(1.0, pauseOutputRatio))
        self.warningTotalRatio = max(0.0, min(1.0, warningTotalRatio))
        self.pauseTotalRatio = max(warningTotalRatio, min(1.0, pauseTotalRatio))
    }

    /// Resets the watchdog for a new stream.
    func beginStream(
        modelProfile: ModelContextProfile,
        estimatedInputTokens: Int,
        margin: Double
    ) {
        self.modelProfile = modelProfile
        self.estimatedInputTokens = max(0, estimatedInputTokens)
        self.margin = max(0.0, min(1.0, margin))
        self.estimatedOutputTokens = 0
        self.accumulatedText = ""
        self.hasWarned = false
        self.hasPaused = false
    }

    /// Adds a delta of assistant text and returns the watchdog decision.
    /// Thread-safe because the actor isolates all state.
    func append(deltaText: String) -> StreamingContextDecision {
        guard !hasPaused else {
            return .limitReached(
                partialText: accumulatedText,
                suggestedAction: .stopHere
            )
        }
        accumulatedText.append(deltaText)
        estimatedOutputTokens += max(1, deltaText.utf8.count / 4)

        guard let profile = modelProfile else { return .ok }

        let outputLimit = max(1, profile.maxOutputTokens)
        let usableTotal = max(1.0, Double(profile.maxContextTokens) * margin)
        let outputRatio = Double(estimatedOutputTokens) / Double(outputLimit)
        let totalRatio = Double(estimatedInputTokens + estimatedOutputTokens) / usableTotal

        if outputRatio >= pauseOutputRatio || totalRatio >= pauseTotalRatio {
            hasPaused = true
            let remainingOutput = max(0, outputLimit - estimatedOutputTokens)
            let kind: StreamingContextLimitKind = outputRatio >= pauseOutputRatio
                ? .outputTokens
                : .totalContext
            return .limitReached(
                partialText: accumulatedText,
                suggestedAction: defaultSuggestedAction(kind: kind, remainingOutput: remainingOutput)
            )
        }

        if !hasWarned && (outputRatio >= warningOutputRatio || totalRatio >= warningTotalRatio) {
            hasWarned = true
            let remainingOutput = max(0, outputLimit - estimatedOutputTokens)
            let kind: StreamingContextLimitKind = outputRatio >= warningOutputRatio
                ? .outputTokens
                : .totalContext
            return .approachingLimit(remainingTokens: remainingOutput, kind: kind)
        }

        return .ok
    }

    /// Marks the stream complete; the watchdog is no longer watching.
    func endStream() {
        modelProfile = nil
        estimatedInputTokens = 0
        estimatedOutputTokens = 0
        accumulatedText = ""
        hasWarned = false
        hasPaused = false
    }

    /// The accumulated text so far, used when pausing to retain partial output.
    func currentPartialText() -> String {
        accumulatedText
    }

    /// Estimated input and output tokens tracked by the watchdog.
    func estimatedTokens() -> (input: Int, output: Int) {
        (estimatedInputTokens, estimatedOutputTokens)
    }

    /// Ratios and absolute token counts against the active profile and margin.
    /// Returns `nil` when no stream is being watched.
    func budgetRatios() -> (
        outputUsed: Int,
        outputCeiling: Int,
        totalUsed: Int,
        totalCeiling: Int,
        outputRatio: Double,
        totalRatio: Double
    )? {
        guard let profile = modelProfile else { return nil }
        let outputCeiling = max(1, profile.maxOutputTokens)
        let totalCeiling = max(1, Int(Double(profile.maxContextTokens) * margin))
        let outputUsed = max(0, estimatedOutputTokens)
        let totalUsed = max(0, estimatedInputTokens + estimatedOutputTokens)
        let outputRatio = min(1.0, Double(outputUsed) / Double(outputCeiling))
        let totalRatio = min(1.0, Double(totalUsed) / Double(totalCeiling))
        return (outputUsed, outputCeiling, totalUsed, totalCeiling, outputRatio, totalRatio)
    }

    private func defaultSuggestedAction(
        kind: StreamingContextLimitKind,
        remainingOutput: Int
    ) -> StreamingContextSuggestedAction {
        // Learned data shows output-token hits are best recovered by switching
        // to a larger model. Total-context hits are best recovered by summarizing
        // when enough partial text exists, otherwise stop.
        switch kind {
        case .outputTokens:
            return .continueOnLargerModel(
                CrossProviderModelCandidate(provider: .openai, baseURL: "", model: "")
            )
        case .totalContext:
            return remainingOutput < 256 ? .summarizeSoFar : .stopHere
        }
    }
}
