import Foundation

enum TokenUsageSource: Equatable {
    case provider
    case estimate
}

struct TokenUsageLedger: Equatable {
    private(set) var inputTokens = 0
    private(set) var outputTokens = 0
    private(set) var includesEstimate = false

    var totalTokens: Int {
        inputTokens + outputTokens
    }

    var compactTotal: String {
        let prefix = includesEstimate && totalTokens > 0 ? "~" : ""
        return prefix + Self.compact(totalTokens)
    }

    var compactBreakdown: String {
        let prefix = includesEstimate && totalTokens > 0 ? "~" : ""
        return "\(prefix)\(Self.compact(inputTokens)) in / \(prefix)\(Self.compact(outputTokens)) out"
    }

    var detailText: String {
        let prefix = includesEstimate && totalTokens > 0 ? "Estimated - " : ""
        return "\(prefix)\(Self.compact(inputTokens)) input / \(Self.compact(outputTokens)) output"
    }

    mutating func record(inputTokens: Int, outputTokens: Int, source: TokenUsageSource) {
        self.inputTokens += max(0, inputTokens)
        self.outputTokens += max(0, outputTokens)
        if source == .estimate {
            includesEstimate = true
        }
    }

    mutating func reset() {
        self = TokenUsageLedger()
    }

    private static func compact(_ value: Int) -> String {
        if value >= 1_000_000 {
            return formatted(Double(value) / 1_000_000) + "M"
        }
        if value >= 1_000 {
            return formatted(Double(value) / 1_000) + "K"
        }
        return String(value)
    }

    private static func formatted(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        if rounded.rounded() == rounded {
            return String(Int(rounded))
        }
        return String(format: "%.1f", rounded)
    }
}

enum TokenEstimator {
    static func estimate(_ text: String) -> Int {
        guard !text.isEmpty else { return 0 }
        return max(1, Int(ceil(Double(text.utf8.count) / 4.0)))
    }
}
