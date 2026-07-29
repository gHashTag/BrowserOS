import Foundation

/// What a thousand tokens costs, per provider and model family.
///
/// Tokens are a unit only the machine cares about. "This bee cost 40 cents" is
/// a sentence a person can act on; "this bee cost 180k tokens" needs a lookup
/// table the user does not have. So the table lives here.
///
/// Prices are list rates in USD and will drift. That is acceptable for the job
/// they do - deciding whether a worker is worth cancelling - and every figure
/// the UI prints from them is labelled an estimate rather than a bill.
struct ModelPrice: Equatable, Sendable {
    let inputPerMillion: Double
    let outputPerMillion: Double

    func cost(inputTokens: Int, outputTokens: Int) -> Double {
        Double(inputTokens) / 1_000_000 * inputPerMillion
            + Double(outputTokens) / 1_000_000 * outputPerMillion
    }
}

enum ModelPricing {
    /// Matched by longest prefix, so `glm-5.2-air` inherits `glm-5` unless it
    /// has its own entry. Exact-match tables go stale the moment a provider
    /// ships a point release.
    static let table: [String: ModelPrice] = [
        "glm-5": ModelPrice(inputPerMillion: 0.60, outputPerMillion: 2.20),
        "glm-4": ModelPrice(inputPerMillion: 0.60, outputPerMillion: 2.20),
        "claude-opus": ModelPrice(inputPerMillion: 15.0, outputPerMillion: 75.0),
        "claude-sonnet": ModelPrice(inputPerMillion: 3.0, outputPerMillion: 15.0),
        "claude-haiku": ModelPrice(inputPerMillion: 0.80, outputPerMillion: 4.0),
        "gpt-5": ModelPrice(inputPerMillion: 1.25, outputPerMillion: 10.0),
        "gpt-4": ModelPrice(inputPerMillion: 2.50, outputPerMillion: 10.0),
        "deepseek": ModelPrice(inputPerMillion: 0.28, outputPerMillion: 0.42)
    ]

    /// Models that run on the user's own machine cost nothing per token. Saying
    /// "$0.00" for them is correct, not a missing measurement.
    static let freeProviders: Set<String> = ["ollama", "lmstudio", "llamacpp"]

    static func price(forModel model: String, provider: String) -> ModelPrice? {
        if freeProviders.contains(provider.lowercased()) {
            return ModelPrice(inputPerMillion: 0, outputPerMillion: 0)
        }
        let normalized = model.lowercased()
        // Longest prefix wins, so a specific entry beats its family.
        return table
            .filter { normalized.hasPrefix($0.key) || normalized.contains($0.key) }
            .max { $0.key.count < $1.key.count }?
            .value
    }

    /// `nil` when the model is not in the table. An unknown price must stay
    /// unknown: inventing an average is how a cheap run gets reported as
    /// expensive and a human cancels work that was fine.
    static func estimatedCost(
        inputTokens: Int,
        outputTokens: Int,
        model: String,
        provider: String
    ) -> Double? {
        price(forModel: model, provider: provider)?
            .cost(inputTokens: inputTokens, outputTokens: outputTokens)
    }

    /// Human-facing amount. Sub-cent spends read as "<$0.01" rather than
    /// "$0.00", which would look like nothing happened.
    static func format(_ usd: Double) -> String {
        if usd <= 0 { return "$0.00" }
        if usd < 0.01 { return "<$0.01" }
        if usd < 10 { return String(format: "$%.2f", usd) }
        return String(format: "$%.0f", usd)
    }
}

/// A ceiling on what the swarm may spend in one day.
///
/// Advisory rather than enforced at the transport, for the same reason the
/// token threshold is: killing a bee mid-edit leaves the repository in a state
/// nobody chose. The Queen stops *starting* new work instead, which is a
/// decision that can be taken safely at any moment.
struct SwarmBudget: Equatable, Sendable {
    var dailyLimitUSD: Double

    static let `default` = SwarmBudget(dailyLimitUSD: 10.0)

    enum Verdict: Equatable {
        case fine(remaining: Double)
        case nearingLimit(remaining: Double)
        case exhausted(overBy: Double)
    }

    func verdict(spentToday: Double) -> Verdict {
        let remaining = dailyLimitUSD - spentToday
        if remaining <= 0 { return .exhausted(overBy: -remaining) }
        if remaining <= dailyLimitUSD * 0.2 { return .nearingLimit(remaining: remaining) }
        return .fine(remaining: remaining)
    }
}
