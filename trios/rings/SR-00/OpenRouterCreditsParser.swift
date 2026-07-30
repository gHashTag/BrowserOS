import Foundation

/// Credit state parsed from OpenRouter's `GET /auth/key` response.
///
/// The endpoint answers HTTP 200 for any key that authenticates, including keys
/// whose balance is spent. Reporting that as a plain "valid" is misleading: the
/// next paid completion still fails with HTTP 402. `isDepleted` carries that
/// distinction so callers can warn instead of celebrating.
struct OpenRouterCredits: Equatable, Sendable {
    /// Human-readable one-line summary, e.g. "Key valid — paid tier, used $1.0000, ...".
    let message: String
    /// Non-nil when the key authenticates but the account cannot pay.
    let warning: String?
    /// True when the remaining balance is known to be zero or below.
    let isDepleted: Bool
}

/// Pure, dependency-free parser for the OpenRouter key-info payload.
/// Kept separate from `ModelHealthService` so it can be unit-tested with a
/// single-file `swiftc` invocation, like the other SR-00 logic helpers.
enum OpenRouterCreditsParser {
    static let depletedWarning = """
        This key authenticates, but the OpenRouter balance is exhausted. Paid \
        models keep failing with HTTP 402 (Insufficient balance) until the \
        account is topped up — only ":free" models will answer.
        """

    /// Parses an OpenRouter `/auth/key` body. Returns nil when the payload is
    /// not the expected `{"data": {...}}` shape, so callers can fall back to a
    /// generic success message rather than inventing numbers.
    static func parse(_ bodyString: String) -> OpenRouterCredits? {
        guard let data = bodyString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let info = json["data"] as? [String: Any] else {
            return nil
        }

        let isFreeTier = info["is_free_tier"] as? Bool
        let usage = info["usage"] as? Double
        // `limit` is null for keys with no spend cap; `limit_remaining` is the
        // authoritative figure whenever OpenRouter supplies it.
        let limit = info["limit"] as? Double
        let limitRemaining = info["limit_remaining"] as? Double
        let remaining = limitRemaining ?? limit.map { max(0, $0 - (usage ?? 0)) }

        var parts: [String] = []
        if let isFreeTier {
            parts.append(isFreeTier ? "free tier" : "paid tier")
        }
        if let usage {
            parts.append("used \(formatCredits(usage))")
        }
        if let limit {
            parts.append("limit \(formatCredits(limit))")
        } else {
            parts.append("no spend limit")
        }
        if let remaining {
            parts.append("remaining \(formatCredits(remaining))")
        }

        let message = parts.isEmpty
            ? "Key valid — OpenRouter accepted the auth check."
            : "Key valid — \(parts.joined(separator: ", "))."

        // An unknown remaining balance must not be treated as depleted: an
        // uncapped key legitimately reports no limit at all.
        let isDepleted: Bool
        if let remaining {
            isDepleted = remaining <= 0
        } else {
            isDepleted = false
        }

        return OpenRouterCredits(
            message: message,
            warning: isDepleted ? depletedWarning : nil,
            isDepleted: isDepleted
        )
    }

    static func formatCredits(_ value: Double) -> String {
        String(format: "$%.4f", value)
    }
}
