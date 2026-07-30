import Foundation

/// Estimated size of a chat request against a model profile.
struct ChatRequestSize: Equatable, Sendable {
    let estimatedInputTokens: Int
    /// Clamped effective output budget (never exceeds the profile ceiling).
    let requestedOutputTokens: Int
    /// Effective output ceiling that the budget was clamped against.
    let effectiveOutputCeiling: Int
    let margin: Double
    let fitsCurrentModel: Bool

    /// True when the user-requested output budget reached or exceeded the
    /// effective output ceiling for the profile. This signals that a larger-
    /// output model might be able to honor more of the requested budget.
    var isOutputBudgetSaturated: Bool {
        requestedOutputTokens >= effectiveOutputCeiling
    }
}

/// Routing decision made before building the final provider request.
enum ContextRoutingDecision: Equatable {
    /// The current model's window fits the request with the configured margin.
    case useCurrent
    /// A larger-context healthy candidate fits; the caller should switch to it.
    case routeTo(CrossProviderModelCandidate)
    /// No larger candidate fits; drop oldest conversation turns before sending.
    case trimHistory(ContextTrimPolicy)
    /// Even the single current message exceeds the largest available window.
    case tooLargeEvenEmpty
}

/// Description of a history-trimming operation.
struct ContextTrimPolicy: Equatable, Sendable {
    let originalMessageCount: Int
    let retainedMessageCount: Int
    let droppedMessageCount: Int
    let preservedSystemPrompt: Bool
}

/// Pre-send draft context status for the composer.
struct DraftContextStatus: Equatable, Sendable {
    let estimatedInputTokens: Int
    let usableWindow: Int
    let utilizationPercent: Double
    let isTooLarge: Bool
    let wouldTrimToFit: Bool
}

/// Estimates input tokens and produces proactive routing/trim decisions.
///
/// Estimates use `TokenEstimator.estimate` (UTF-8 byte count / 4). This is naive
/// but deterministic and requires no provider state; it is used only for
/// routing/trimming, never for billing.
actor ChatRequestSizer: Sendable {
    static let shared = ChatRequestSizer()

    /// Default output budget when the caller does not request a specific cap.
    private static let defaultOutputBudget = 1_024

    /// Estimates the request size for `messages` (history excluding the current
    /// message), the `currentMessage`, the optional `systemPrompt`, and the
    /// clamped output budget.
    func size(
        messages: [ChatMessage],
        currentMessage: ChatMessage,
        systemPrompt: String?,
        modelProfile: ModelContextProfile,
        requestedOutputTokens: Int?,
        margin: Double
    ) -> ChatRequestSize {
        let estimatedInput = TokenEstimator.estimate(messages: messages, systemPrompt: systemPrompt)
            + TokenEstimator.estimate(currentMessage.content)
        let effectiveOutput = effectiveOutputTokens(requested: requestedOutputTokens, profile: modelProfile)
        let clampedMargin = max(0.0, min(1.0, margin))
        let usableWindow = Double(modelProfile.maxContextTokens) * clampedMargin
        let fits = Double(estimatedInput + effectiveOutput) <= usableWindow
        return ChatRequestSize(
            estimatedInputTokens: estimatedInput,
            requestedOutputTokens: effectiveOutput,
            effectiveOutputCeiling: modelProfile.maxOutputTokens,
            margin: clampedMargin,
            fitsCurrentModel: fits
        )
    }

    /// Cheap synchronous estimate of how much of the model's usable window the
    /// current draft would consume if sent now. Used by the composer to show a
    /// pre-send utilization badge without blocking on learned-limit lookups.
    static func draftContextUtilization(
        draft: String,
        history: [ChatMessage],
        systemPrompt: String?,
        modelProfile: ModelContextProfile,
        margin: Double
    ) -> DraftContextStatus? {
        guard modelProfile.maxContextTokens > 0 else { return nil }
        let estimatedInput = TokenEstimator.estimate(messages: history, systemPrompt: systemPrompt)
            + TokenEstimator.estimate(draft)
        let clampedMargin = max(0.0, min(1.0, margin))
        let usableWindow = Int(Double(modelProfile.maxContextTokens) * clampedMargin)
        guard usableWindow > 0 else { return nil }
        let percent = Double(estimatedInput) / Double(usableWindow) * 100.0
        let draftAlone = TokenEstimator.estimate(draft)
        // Match the routing "too large even empty" threshold: the draft alone
        // already exceeds the usable window, so sending would fail.
        let isTooLarge = draftAlone > usableWindow
        // Total input (history + draft) exceeds window, but the draft itself fits,
        // so a real send would likely trigger history trimming.
        let wouldTrimToFit = !isTooLarge && estimatedInput > usableWindow
        return DraftContextStatus(
            estimatedInputTokens: estimatedInput,
            usableWindow: usableWindow,
            utilizationPercent: percent,
            isTooLarge: isTooLarge,
            wouldTrimToFit: wouldTrimToFit
        )
    }

    /// Drops oldest conversation turns until the retained history plus the
    /// current message fits the model's usable window, or until only the
    /// current message and system prompt remain.
    ///
    /// Rules:
    /// - The current message is never in `messages` and is never dropped.
    /// - The system prompt is not part of `messages`; its token cost is accounted
    ///   for in every fit check and is never dropped.
    /// - A `toolUse` assistant message and its immediately following `.tool`
    ///   results are dropped as a single unit so pairs stay together.
    /// - `minRetainedTurns` is a preferred floor, but the trimmer will drop below
    ///   it when the request still does not fit, because sending a request that
    ///   exceeds the window is guaranteed to fail.
    func trim(
        messages: [ChatMessage],
        currentMessage: ChatMessage,
        systemPrompt: String?,
        modelProfile: ModelContextProfile,
        requestedOutputTokens: Int?,
        margin: Double,
        minRetainedTurns: Int
    ) -> ContextTrimPolicy {
        let originalCount = messages.count
        let units = removableUnits(from: messages)
        var remainingUnits = units

        while !remainingUnits.isEmpty {
            let remainingMessages = remainingUnits.flatMap { $0 }
            let size = self.size(
                messages: remainingMessages,
                currentMessage: currentMessage,
                systemPrompt: systemPrompt,
                modelProfile: modelProfile,
                requestedOutputTokens: requestedOutputTokens,
                margin: margin
            )
            if size.fitsCurrentModel {
                break
            }
            // Drop the oldest unit. `minRetainedTurns` is a preferred floor, but
            // the trimmer may drop below it to avoid sending a request that is
            // guaranteed to exceed the model window.
            remainingUnits.removeFirst()
        }

        let retainedMessages = remainingUnits.flatMap { $0 }
        let retainedCount = retainedMessages.count
        return ContextTrimPolicy(
            originalMessageCount: originalCount,
            retainedMessageCount: retainedCount,
            droppedMessageCount: originalCount - retainedCount,
            preservedSystemPrompt: !(systemPrompt?.isEmpty ?? true)
        )
    }

    /// Reconstructs the retained history from a trim policy. Trimming drops the
    /// oldest contiguous units, so the retained messages are the suffix of the
    /// original array.
    func trimmedMessages(from messages: [ChatMessage], policy: ContextTrimPolicy) -> [ChatMessage] {
        Array(messages.suffix(policy.retainedMessageCount))
    }

    private func effectiveOutputTokens(requested: Int?, profile: ModelContextProfile) -> Int {
        let budget = requested ?? min(Self.defaultOutputBudget, profile.maxOutputTokens)
        return max(0, min(budget, profile.maxOutputTokens))
    }

    /// Returns true when the requested output budget cannot be fully honored by
    /// the profile ceiling. This is used by the router to decide whether to try
    /// routing to a model with a larger effective output limit.
    func isOutputBudgetSaturated(
        requested: Int?,
        profile: ModelContextProfile
    ) -> Bool {
        guard let requested else { return false }
        return requested >= profile.maxOutputTokens
    }

    /// Groups messages into removable units. An assistant message that has
    /// outstanding tool calls absorbs any immediately following `.tool` role
    /// messages so tool pairs are dropped together.
    private func removableUnits(from messages: [ChatMessage]) -> [[ChatMessage]] {
        var units: [[ChatMessage]] = []
        var index = 0
        while index < messages.count {
            let message = messages[index]
            var unit = [message]
            var next = index + 1
            if message.role == .assistant, !message.toolCalls.isEmpty {
                while next < messages.count, messages[next].role == .tool {
                    unit.append(messages[next])
                    next += 1
                }
            }
            units.append(unit)
            index = next
        }
        return units
    }
}
