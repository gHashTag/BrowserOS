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
    /// Micro-dollars per million tokens. `0.60` per million is `600_000`.
    ///
    /// Integer minor units, because money is counted rather than measured.
    /// Both binary and ternary floats represent `0.10` approximately, and this
    /// number is summed over every task in a day and then compared against a
    /// budget threshold - which is precisely the shape where the approximation
    /// stops being invisible. `spentToday` was a `reduce(0, +)` over `Double`.
    let inputPerMillion: Int
    let outputPerMillion: Int

    /// Cost in micro-dollars.
    ///
    /// The division comes last so the intermediate keeps full resolution: a
    /// thousand tokens at 600000 micro-dollars per million is 600 exactly,
    /// where dividing first would have given zero.
    func cost(inputTokens: Int, outputTokens: Int) -> Int {
        (inputTokens * inputPerMillion) / 1_000_000
            + (outputTokens * outputPerMillion) / 1_000_000
    }
}

enum ModelPricing {
    /// Matched by longest prefix, so `glm-5.2-air` inherits `glm-5` unless it
    /// has its own entry. Exact-match tables go stale the moment a provider
    /// ships a point release.
    static let table: [String: ModelPrice] = [
        "glm-5": ModelPrice(inputPerMillion: 600000, outputPerMillion: 2200000),
        "glm-4": ModelPrice(inputPerMillion: 600000, outputPerMillion: 2200000),
        "claude-opus": ModelPrice(inputPerMillion: 15000000, outputPerMillion: 75000000),
        "claude-sonnet": ModelPrice(inputPerMillion: 3000000, outputPerMillion: 15000000),
        "claude-haiku": ModelPrice(inputPerMillion: 800000, outputPerMillion: 4000000),
        "gpt-5": ModelPrice(inputPerMillion: 1250000, outputPerMillion: 10000000),
        "gpt-4": ModelPrice(inputPerMillion: 2500000, outputPerMillion: 10000000),
        "deepseek": ModelPrice(inputPerMillion: 280000, outputPerMillion: 420000)
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
    ) -> Int? {
        price(forModel: model, provider: provider)?
            .cost(inputTokens: inputTokens, outputTokens: outputTokens)
    }

    /// Human-facing amount. Sub-cent spends read as "<$0.01" rather than
    /// "$0.00", which would look like nothing happened.
    static func format(_ micros: Int) -> String {
        if micros <= 0 { return "$0.00" }
        // Under a cent reads as "<$0.01" rather than "$0.00", which would look
        // like nothing happened. 10_000 micro-dollars is one cent.
        if micros < 10_000 { return "<$0.01" }
        let usd = Double(micros) / 1_000_000
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
    /// Micro-dollars. Ten dollars is `10_000_000`.
    var dailyLimitUSD: Int

    static let `default` = SwarmBudget(dailyLimitUSD: 10_000_000)

    /// The operator's knob, resolved fresh on every ask so a raised cap takes
    /// effect without a relaunch. Order: the `TRIOS_SWARM_DAILY_CAP_USD`
    /// environment variable (harness and probes), then the per-variant knob
    /// file `<trinity>/state/swarm_budget.json` (`{"dailyCapUSD": 30}`), then
    /// the $10 default. The knob exists because the operator said "we have
    /// tokens" on the first day both lanes hit the ceiling - the cap is their
    /// budget decision, not the code's.
    /// Takes the state directory rather than asking `ProjectPaths` for it.
    ///
    /// One reference was the only thing keeping this file - and with it the
    /// whole selection core, `QueenDelegation` included - out of the module a
    /// Linux server can build: `ProjectPaths` resolves an app bundle, which a
    /// server does not have. Everything else here was already pure.
    ///
    /// The caller that knows where state lives passes it; the convenience that
    /// asks ProjectPaths lives beside ProjectPaths, in a file the server does
    /// not compile.
    static func current(stateDirectory: String) -> SwarmBudget {
        if let raw = ProcessInfo.processInfo.environment["TRIOS_SWARM_DAILY_CAP_USD"],
           let fromEnv = parsed(dollarsText: raw) {
            return fromEnv
        }
        let knobPath = "\(stateDirectory)/state/swarm_budget.json"
        if let data = FileManager.default.contents(atPath: knobPath),
           let fromKnob = parsed(knobJSON: data) {
            return fromKnob
        }
        return .default
    }

    /// Pure parse of the knob file body. Accepts `{"dailyCapUSD": 30}` with an
    /// integer or fractional value. Returns nil - never a guess - for
    /// anything unparsable, non-positive, or absurd (over $1M/day), so a
    /// corrupt knob falls back to the default instead of disabling the cap.
    static func parsed(knobJSON data: Data) -> SwarmBudget? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["dailyCapUSD"] else { return nil }
        if let n = value as? NSNumber { return parsed(dollars: n.doubleValue) }
        if let s = value as? String { return parsed(dollarsText: s) }
        return nil
    }

    static func parsed(dollarsText: String) -> SwarmBudget? {
        guard let dollars = Double(dollarsText.trimmingCharacters(in: .whitespaces)) else {
            return nil
        }
        return parsed(dollars: dollars)
    }

    static func parsed(dollars: Double) -> SwarmBudget? {
        guard dollars.isFinite, dollars > 0, dollars <= 1_000_000 else { return nil }
        return SwarmBudget(dailyLimitUSD: Int(dollars * 1_000_000))
    }

    enum Verdict: Equatable {
        case fine(remaining: Int)
        case nearingLimit(remaining: Int)
        case exhausted(overBy: Int)
    }

    func verdict(spentToday: Int) -> Verdict {
        let remaining = dailyLimitUSD - spentToday
        if remaining <= 0 { return .exhausted(overBy: -remaining) }
        // A fifth, expressed as a division rather than a multiplication by 0.2
        // - which is one of the values a binary float cannot hold exactly, and
        // this comparison decides whether the swarm keeps working.
        if remaining <= dailyLimitUSD / 5 { return .nearingLimit(remaining: remaining) }
        return .fine(remaining: remaining)
    }
}
