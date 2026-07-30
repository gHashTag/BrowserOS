// Standalone unit tests for ChatDiagnosticsEvaluator - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/chat_diagnostics_test.swift \
//     rings/SR-00/ChatDiagnostics.swift rings/SR-00/ZAIErrorParser.swift \
//     -o /tmp/trios_chat_diagnostics_test && /tmp/trios_chat_diagnostics_test

import Foundation

@main
enum ChatDiagnosticsTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        serverChecks()
        endpointChecks()
        theTrapCase()
        chatProbeChecks()
        a2aAndSummary()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All ChatDiagnostics tests passed.")
    }

    static func serverChecks() {
        scenario("agent server health is read from the body, not just the status")

        let ok = ChatDiagnosticsEvaluator.evaluateServer(
            status: 200,
            body: "{\"status\":\"ok\",\"cdpConnected\":true}",
            latencyMs: 12
        )
        check(ok.status == .pass, "a healthy server passes")
        check(ok.detail.contains("browser connected"), "browser connectivity is reported")

        let noBrowser = ChatDiagnosticsEvaluator.evaluateServer(
            status: 200,
            body: "{\"status\":\"ok\"}",
            latencyMs: 12
        )
        check(noBrowser.status == .pass, "server without a browser still passes")
        check(noBrowser.detail.contains("not connected"), "missing browser is called out")

        let down = ChatDiagnosticsEvaluator.evaluateServer(status: nil, body: "", latencyMs: 0)
        check(down.status == .fail, "no response fails")
        check(down.remedy != nil, "a failure carries a remedy")
    }

    static func endpointChecks() {
        scenario("endpoint problems are distinguished from key problems")

        let good = ChatDiagnosticsEvaluator.evaluateEndpoint(
            baseURL: "https://api.z.ai/api/coding/paas/v4", status: 200, latencyMs: 30
        )
        check(good.status == .pass, "a reachable endpoint passes")

        let notFound = ChatDiagnosticsEvaluator.evaluateEndpoint(
            baseURL: "https://api.z.ai/wrong", status: 404, latencyMs: 30
        )
        check(notFound.status == .fail, "404 fails")
        check(notFound.remedy?.contains("base URL") == true, "404 blames the base URL")

        let rejected = ChatDiagnosticsEvaluator.evaluateEndpoint(
            baseURL: "https://api.z.ai/api/paas/v4", status: 401, latencyMs: 30
        )
        check(rejected.status == .fail, "401 fails")
        check(rejected.remedy?.contains("key") == true, "401 blames the key")
    }

    /// The exact situation that made six paid keys look dead.
    static func theTrapCase() {
        scenario("endpoint 200 plus chat 1113 is reported as balance, not as a healthy key")

        let endpoint = ChatDiagnosticsEvaluator.evaluateEndpoint(
            baseURL: "https://api.z.ai/api/paas/v4", status: 200, latencyMs: 40
        )
        check(endpoint.status == .pass, "the endpoint check passes, as the provider really does answer 200")

        let key = ChatDiagnosticsEvaluator.evaluateKey(hasKey: true, endpointStatus: 200)
        check(key.status == .pass, "the key check also passes")

        let body = """
        {"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}
        """
        let probe = ChatDiagnosticsEvaluator.evaluateChatProbe(
            model: "glm-5.2", status: 429, body: body, latencyMs: 300
        )
        check(probe.status == .fail, "the live probe is what fails")
        check(probe.detail.contains("balance exhausted"), "the failure names the balance")
        check(
            probe.remedy?.contains("Coding Plan") == true,
            "the remedy points at the Coding Plan endpoint, which is the actual fix"
        )
    }

    static func chatProbeChecks() {
        scenario("live probe outcomes map to actionable rows")

        let ok = ChatDiagnosticsEvaluator.evaluateChatProbe(
            model: "glm-5.2", status: 200, body: "{\"choices\":[]}", latencyMs: 900
        )
        check(ok.status == .pass, "a 200 passes")
        check(ok.latencyMs == 900, "latency is carried through")

        let limited = ChatDiagnosticsEvaluator.evaluateChatProbe(
            model: "glm-5.2",
            status: 429,
            body: "{\"error\":{\"code\":\"1302\",\"message\":\"Concurrency limit\"}}",
            latencyMs: 100
        )
        check(limited.status == .warn, "a genuine rate limit is a warning, not a failure")
        check(limited.remedy?.contains("rotation") == true, "the remedy suggests key rotation")

        let missing = ChatDiagnosticsEvaluator.evaluateChatProbe(
            model: "glm-9", status: 404, body: "", latencyMs: 50
        )
        check(missing.status == .fail, "an unavailable model fails")

        let noKey = ChatDiagnosticsEvaluator.evaluateKey(hasKey: false, endpointStatus: nil)
        check(noKey.status == .fail, "no stored key fails")
        check(noKey.remedy?.contains("Add a key") == true, "the remedy tells you to add one")
    }

    static func a2aAndSummary() {
        scenario("A2A is a warning, and the summary reflects the worst result")

        let notRegistered = ChatDiagnosticsEvaluator.evaluateA2A(isRegistered: false, agentCount: 0)
        check(notRegistered.status == .warn, "A2A being down does not fail the run - chat still works")

        let registered = ChatDiagnosticsEvaluator.evaluateA2A(isRegistered: true, agentCount: 1)
        check(registered.status == .pass, "a registered agent passes")

        check(
            ChatDiagnosticsEvaluator.summary(for: ChatDiagnosticsEvaluator.initialChecks()) == "Not run yet",
            "a fresh list summarises as not run"
        )
        check(
            ChatDiagnosticsEvaluator.initialChecks().count == 6,
            "six checks are defined"
        )

        var mixed = ChatDiagnosticsEvaluator.initialChecks()
        mixed[0].status = .pass
        mixed[1].status = .pass
        mixed[2].status = .warn
        mixed[3].status = .fail
        let summary = ChatDiagnosticsEvaluator.summary(for: mixed)
        check(summary.contains("1 failed"), "a failure dominates the summary")
        check(summary.contains("1 warning"), "warnings are counted too")

        var allGood = ChatDiagnosticsEvaluator.initialChecks()
        for index in allGood.indices { allGood[index].status = .pass }
        check(
            ChatDiagnosticsEvaluator.summary(for: allGood) == "All 6 checks passed",
            "a clean run says so plainly"
        )
    }
}
