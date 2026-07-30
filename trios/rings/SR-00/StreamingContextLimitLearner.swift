import Foundation

/// Learned effective context-window limits for a single provider endpoint.
struct StreamingContextLearnedLimits: Equatable, Sendable {
    let effectiveMaxOutputTokens: Int?
    let effectiveMaxContextTokens: Int?
    let outputObservationCount: Int
    let totalObservationCount: Int

    static let empty = StreamingContextLearnedLimits(
        effectiveMaxOutputTokens: nil,
        effectiveMaxContextTokens: nil,
        outputObservationCount: 0,
        totalObservationCount: 0
    )
}

/// Learns per-(provider, baseURL, model) effective output and context limits
/// from observed `finish_reason=length` events and context-limit pauses.
///
/// The learner uses exponential moving averages (EMA) so a single noisy
/// observation does not dominate the advertised profile, but repeated hits
/// gradually tighten the watchdog's ratios. Learned limits are always kept
/// below advertised limits with a safety buffer; they never expand the window.
actor StreamingContextLimitLearner: Sendable {
    static let shared = StreamingContextLimitLearner()

    private var limits: [ModelEndpointTuple: StreamingContextLearnedLimits] = [:]
    private var outputEma: [ModelEndpointTuple: Double] = [:]
    private var totalEma: [ModelEndpointTuple: Double] = [:]
    private var outputObservationCounts: [ModelEndpointTuple: Int] = [:]
    private var totalObservationCounts: [ModelEndpointTuple: Int] = [:]

    private let emaAlpha: Double
    private let minObservations: Int
    private let safetyBuffer: Double

    init(
        emaAlpha: Double = 0.3,
        minObservations: Int = 3,
        safetyBuffer: Double = 0.95
    ) {
        self.emaAlpha = max(0.01, min(1.0, emaAlpha))
        self.minObservations = max(1, minObservations)
        self.safetyBuffer = max(0.5, min(1.0, safetyBuffer))
    }

    /// Records an observed outcome and updates the learned limits for its tuple.
    func recordOutcome(_ outcome: ModelOutcome) {
        let tuple = ModelEndpointTuple(
            provider: outcome.provider,
            baseURL: outcome.baseURL,
            model: outcome.model
        )

        // Tighten the output ceiling when the provider reports finish_reason=length,
        // because that means the response was truncated at the output limit.
        if let outputTokens = outcome.observedOutputTokens,
           outcome.finishReason == "length" {
            outputObservationCounts[tuple] = (outputObservationCounts[tuple] ?? 0) + 1
            updateEMA(for: tuple, value: Double(outputTokens), into: &outputEma)
        }

        // Tighten the total-context ceiling when the stream paused for a context
        // limit or when a provider-side context error is reported.
        if let totalTokens = outcome.observedTotalTokens,
           isContextLimitObservation(outcome) {
            totalObservationCounts[tuple] = (totalObservationCounts[tuple] ?? 0) + 1
            updateEMA(for: tuple, value: Double(totalTokens), into: &totalEma)
        }

        recomputeLimits(for: tuple)
    }

    /// Returns the learned profile for a tuple, applying learned ceilings with
    /// a safety buffer when enough observations exist.
    func learnedProfile(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        advertised: ModelContextProfile
    ) -> ModelContextProfile {
        let tuple = ModelEndpointTuple(provider: provider, baseURL: baseURL, model: model)
        let learned = limits[tuple] ?? .empty

        let effectiveOutput: Int
        if let output = learned.effectiveMaxOutputTokens,
           learned.outputObservationCount >= minObservations {
            effectiveOutput = min(advertised.maxOutputTokens, output)
        } else {
            effectiveOutput = advertised.maxOutputTokens
        }

        let effectiveContext: Int
        if let context = learned.effectiveMaxContextTokens,
           learned.totalObservationCount >= minObservations {
            effectiveContext = min(advertised.maxContextTokens, context)
        } else {
            effectiveContext = advertised.maxContextTokens
        }

        return ModelContextProfile(
            maxContextTokens: max(1, effectiveContext),
            maxOutputTokens: max(1, effectiveOutput)
        )
    }

    /// Exposes the raw learned limits for a tuple (used by UI/debug badges).
    func learnedLimits(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) -> StreamingContextLearnedLimits {
        let tuple = ModelEndpointTuple(provider: provider, baseURL: baseURL, model: model)
        return limits[tuple] ?? .empty
    }

    /// Resets learned limits, e.g. when a provider endpoint changes materially.
    func reset(
        model: String,
        provider: ModelProvider,
        baseURL: String
    ) {
        let tuple = ModelEndpointTuple(provider: provider, baseURL: baseURL, model: model)
        limits.removeValue(forKey: tuple)
        outputEma.removeValue(forKey: tuple)
        totalEma.removeValue(forKey: tuple)
        outputObservationCounts.removeValue(forKey: tuple)
        totalObservationCounts.removeValue(forKey: tuple)
    }

    private func isContextLimitObservation(_ outcome: ModelOutcome) -> Bool {
        if outcome.reason?.lowercased().contains("context limit") == true {
            return true
        }
        let message = (outcome.reason ?? "").lowercased()
        return message.contains("context length") || message.contains("maximum context")
    }

    private func updateEMA(
        for tuple: ModelEndpointTuple,
        value: Double,
        into store: inout [ModelEndpointTuple: Double]
    ) {
        let previous = store[tuple] ?? value
        store[tuple] = emaAlpha * value + (1.0 - emaAlpha) * previous
    }

    private func recomputeLimits(for tuple: ModelEndpointTuple) {
        let outputCount = outputObservationCounts[tuple] ?? 0
        let totalCount = totalObservationCounts[tuple] ?? 0

        let effectiveOutput = outputEma[tuple].map { Int(floor($0 * safetyBuffer)) }
        let effectiveTotal = totalEma[tuple].map { Int(floor($0 * safetyBuffer)) }

        limits[tuple] = StreamingContextLearnedLimits(
            effectiveMaxOutputTokens: effectiveOutput,
            effectiveMaxContextTokens: effectiveTotal,
            outputObservationCount: outputCount,
            totalObservationCount: totalCount
        )
    }
}
