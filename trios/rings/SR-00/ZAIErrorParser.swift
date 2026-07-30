import Foundation

/// Outcome of a Z.AI completion probe, derived from the provider's error envelope.
///
/// Z.AI answers `GET /api/paas/v4/models` with HTTP 200 for any key that
/// authenticates, including keys whose account balance is spent. Reporting that
/// as a plain "valid" is misleading: the next completion fails with HTTP 429 and
/// business code 1113. `isBalanceExhausted` carries that distinction.
struct ZAIError: Equatable, Sendable {
    /// Provider business code, e.g. "1113". Distinct from the HTTP status.
    let code: String
    /// Provider-supplied message, verbatim.
    let message: String
    /// True when the account cannot pay for requests.
    let isBalanceExhausted: Bool
    /// True when retrying the identical request cannot succeed.
    let isTerminal: Bool
}

/// Pure, dependency-free parser for Z.AI error payloads. Kept separate from
/// `ModelHealthService` so it can be unit-tested with a single-file `swiftc`
/// invocation, matching `OpenRouterCreditsParser`.
enum ZAIErrorParser {
    /// Business code returned when the account balance or resource package is spent.
    static let insufficientBalanceCode = "1113"
    /// Business codes returned for authentication problems.
    static let authFailedCodes: Set<String> = ["1000", "1001", "1002"]

    static let depletedWarning = """
        This key authenticates, but the Z.AI account balance is exhausted. Every \
        model keeps failing with business code 1113 (Insufficient balance) until \
        the account is topped up.
        """

    /// Parses a Z.AI error body. Returns nil when the payload is not an error
    /// envelope, so callers can treat the response as a success.
    static func parse(_ bodyString: String) -> ZAIError? {
        guard let data = bodyString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any] else {
            return nil
        }

        // Z.AI sends the code as a string; tolerate a number for robustness.
        let code: String
        if let stringCode = error["code"] as? String {
            code = stringCode
        } else if let intCode = error["code"] as? Int {
            code = String(intCode)
        } else {
            code = ""
        }
        let message = error["message"] as? String ?? "Z.AI returned an error."

        let isBalanceExhausted = code == insufficientBalanceCode || mentionsBalance(message)
        // Auth failures and balance exhaustion cannot be fixed by retrying the
        // same request; retrying only multiplies the noise and the latency.
        let isTerminal = isBalanceExhausted || authFailedCodes.contains(code)

        return ZAIError(
            code: code,
            message: message,
            isBalanceExhausted: isBalanceExhausted,
            isTerminal: isTerminal
        )
    }

    /// Text fallback for the case where Z.AI changes the numeric code but keeps
    /// the wording. Both phrases must be matched case-insensitively.
    static func mentionsBalance(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower.contains("insufficient balance")
            || lower.contains("no resource package")
            || lower.contains("please recharge")
    }

    /// One-line summary suitable for the Models tab key-test result.
    static func summary(for error: ZAIError) -> String {
        if error.isBalanceExhausted {
            return "Key valid - but the Z.AI balance is exhausted (code \(error.code))."
        }
        if error.code.isEmpty {
            return "Z.AI error: \(error.message)"
        }
        return "Z.AI error \(error.code): \(error.message)"
    }
}
