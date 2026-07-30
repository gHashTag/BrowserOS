import Foundation

/// Outcome of a single diagnostic step.
enum DiagnosticStatus: String, Equatable, Sendable {
    case pending
    case running
    case pass
    case warn
    case fail
    case skipped

    var symbolName: String {
        switch self {
        case .pending: return "circle"
        case .running: return "clock"
        case .pass: return "checkmark.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .fail: return "xmark.circle.fill"
        case .skipped: return "minus.circle"
        }
    }
}

/// One row in the diagnostics report.
struct DiagnosticCheck: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    var status: DiagnosticStatus
    var detail: String
    var latencyMs: Int?
    /// Suggested next step when the check did not pass.
    var remedy: String?

    init(
        id: String,
        title: String,
        status: DiagnosticStatus = .pending,
        detail: String = "",
        latencyMs: Int? = nil,
        remedy: String? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.detail = detail
        self.latencyMs = latencyMs
        self.remedy = remedy
    }
}

/// Interprets raw probe results into diagnostic rows.
///
/// Pure and dependency-free so the judgement calls - which HTTP status means
/// "your key is fine but the account is empty", which means "wrong endpoint" -
/// are unit-testable without any network.
enum ChatDiagnosticsEvaluator {
    static let serverCheckID = "server"
    static let authCheckID = "local-auth"
    static let endpointCheckID = "endpoint"
    static let keyCheckID = "api-key"
    static let chatCheckID = "chat-probe"
    static let a2aCheckID = "a2a"

    /// Ordered list of checks, all pending.
    static func initialChecks() -> [DiagnosticCheck] {
        [
            DiagnosticCheck(id: serverCheckID, title: "Agent server"),
            DiagnosticCheck(id: authCheckID, title: "Local authorization"),
            DiagnosticCheck(id: endpointCheckID, title: "Provider endpoint"),
            DiagnosticCheck(id: keyCheckID, title: "API key"),
            DiagnosticCheck(id: chatCheckID, title: "Live chat probe"),
            DiagnosticCheck(id: a2aCheckID, title: "A2A registration"),
        ]
    }

    static func evaluateServer(status: Int?, body: String, latencyMs: Int) -> DiagnosticCheck {
        var check = DiagnosticCheck(id: serverCheckID, title: "Agent server", latencyMs: latencyMs)
        if status == 200, body.contains("\"status\":\"ok\"") {
            check.status = .pass
            check.detail = body.contains("cdpConnected\":true")
                ? "Reachable, browser connected"
                : "Reachable, browser not connected"
        } else if status == nil {
            check.status = .fail
            check.detail = "No response"
            check.remedy = "The bundled agent server is not running. Relaunch TriOS."
        } else {
            check.status = .fail
            check.detail = "HTTP \(status ?? 0)"
            check.remedy = "The server answered but is unhealthy."
        }
        return check
    }

    static func evaluateLocalAuth(status: Int?, hasToken: Bool, latencyMs: Int) -> DiagnosticCheck {
        var check = DiagnosticCheck(id: authCheckID, title: "Local authorization", latencyMs: latencyMs)
        if status == 200, hasToken {
            check.status = .pass
            check.detail = "Token issued"
        } else {
            check.status = .fail
            check.detail = status.map { "HTTP \($0)" } ?? "No response"
            check.remedy = "A2A and chat both need this token. Restart the server."
        }
        return check
    }

    /// Endpoint reachability. A 200 here proves the host exists and the key
    /// authenticates - it does NOT prove the account can pay, which is exactly
    /// the trap that made Coding Plan keys look expired.
    static func evaluateEndpoint(
        baseURL: String,
        status: Int?,
        latencyMs: Int
    ) -> DiagnosticCheck {
        var check = DiagnosticCheck(id: endpointCheckID, title: "Provider endpoint", latencyMs: latencyMs)
        check.detail = baseURL
        switch status {
        case 200:
            check.status = .pass
        case 401, 403:
            check.status = .fail
            check.detail = "\(baseURL) — rejected the key (HTTP \(status ?? 0))"
            check.remedy = "Check the API key, or that it belongs to this endpoint."
        case .some(404):
            check.status = .fail
            check.detail = "\(baseURL) — HTTP 404"
            check.remedy = "Wrong base URL for this provider."
        case .none:
            check.status = .fail
            check.detail = "\(baseURL) — unreachable"
            check.remedy = "No network route to the provider."
        default:
            check.status = .warn
            check.detail = "\(baseURL) — HTTP \(status ?? 0)"
        }
        return check
    }

    static func evaluateKey(hasKey: Bool, endpointStatus: Int?) -> DiagnosticCheck {
        var check = DiagnosticCheck(id: keyCheckID, title: "API key")
        guard hasKey else {
            check.status = .fail
            check.detail = "No key stored for this provider"
            check.remedy = "Add a key in the API key section above."
            return check
        }
        switch endpointStatus {
        case 200:
            check.status = .pass
            check.detail = "Accepted by the endpoint"
        case 401, 403:
            check.status = .fail
            check.detail = "Rejected (HTTP \(endpointStatus ?? 0))"
            check.remedy = "The key is wrong or belongs to a different endpoint."
        default:
            check.status = .warn
            check.detail = "Stored, but the endpoint check was inconclusive"
        }
        return check
    }

    /// The decisive check: a real completion. Everything above can pass while
    /// this fails, which is precisely the case worth surfacing.
    static func evaluateChatProbe(
        model: String,
        status: Int?,
        body: String,
        latencyMs: Int
    ) -> DiagnosticCheck {
        var check = DiagnosticCheck(id: chatCheckID, title: "Live chat probe", latencyMs: latencyMs)
        if status == 200 {
            check.status = .pass
            check.detail = "\(model) answered"
            return check
        }
        if let zai = ZAIErrorParser.parse(body), zai.isBalanceExhausted {
            check.status = .fail
            check.detail = "\(model) — balance exhausted (code \(zai.code))"
            check.remedy = "This key cannot pay. Switch endpoint to Coding Plan if this is a "
                + "subscription key, otherwise top up or use another key."
            return check
        }
        switch status {
        case 429:
            check.status = .warn
            check.detail = "\(model) — rate limited"
            check.remedy = "Enable key rotation so requests spread across your keys."
        case 404:
            check.status = .fail
            check.detail = "\(model) — not available at this endpoint"
            check.remedy = "Pick a different model, or switch the endpoint preset."
        case .none:
            check.status = .fail
            check.detail = "\(model) — no response"
        default:
            check.status = .fail
            check.detail = "\(model) — HTTP \(status ?? 0)"
        }
        return check
    }

    static func evaluateA2A(isRegistered: Bool, agentCount: Int) -> DiagnosticCheck {
        var check = DiagnosticCheck(id: a2aCheckID, title: "A2A registration")
        if isRegistered || agentCount > 0 {
            check.status = .pass
            check.detail = "\(agentCount) agent(s) registered"
        } else {
            check.status = .warn
            check.detail = "Not registered"
            check.remedy = "Chat still works. A2A needs a fresh local-auth token; "
                + "restarting TriOS re-pairs it."
        }
        return check
    }

    /// One-line summary for the header.
    static func summary(for checks: [DiagnosticCheck]) -> String {
        let failed = checks.filter { $0.status == .fail }.count
        let warned = checks.filter { $0.status == .warn }.count
        let passed = checks.filter { $0.status == .pass }.count
        if failed > 0 {
            return "\(failed) failed, \(warned) warning(s), \(passed) passed"
        }
        if warned > 0 {
            return "\(passed) passed, \(warned) warning(s)"
        }
        if passed == 0 {
            return "Not run yet"
        }
        return "All \(passed) checks passed"
    }
}
