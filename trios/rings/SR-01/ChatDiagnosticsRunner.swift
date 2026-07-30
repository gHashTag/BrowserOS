import Combine
import Foundation

/// Executes the diagnostic checks against the live system.
///
/// Every step is a real request - the agent server, the provider endpoint, and
/// an actual chat completion. Nothing is inferred from configuration, because
/// the failure this was built for (a Coding Plan key on the pay-as-you-go host)
/// looks perfectly healthy right up until a real completion is attempted.
///
/// Results are mirrored into `TriosLogBus`, so a run is also visible in the LOGS
/// tab under the `health` subsystem.
@MainActor
final class ChatDiagnosticsRunner: ObservableObject {
    @Published private(set) var checks: [DiagnosticCheck] = ChatDiagnosticsEvaluator.initialChecks()
    @Published private(set) var isRunning = false
    @Published private(set) var lastRunAt: Date?

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    var summary: String {
        ChatDiagnosticsEvaluator.summary(for: checks)
    }

    func run(
        serverHealthURL: String,
        localTokenURL: String,
        provider: ModelProvider,
        baseURL: String,
        model: String,
        apiKey: String,
        a2aAgentsURL: String,
        isA2ARegistered: Bool
    ) async {
        guard !isRunning else { return }
        isRunning = true
        checks = ChatDiagnosticsEvaluator.initialChecks()
        TriosLogBus.shared.info(.health, "diagnostics.started", "Running chat diagnostics", [
            "provider": provider.rawValue,
            "model": model,
            "endpoint": baseURL
        ])

        // 1. Agent server.
        markRunning(ChatDiagnosticsEvaluator.serverCheckID)
        let server = await get(serverHealthURL)
        update(ChatDiagnosticsEvaluator.evaluateServer(
            status: server.status, body: server.body, latencyMs: server.latencyMs
        ))

        // 2. Local authorization.
        markRunning(ChatDiagnosticsEvaluator.authCheckID)
        let auth = await get(localTokenURL)
        update(ChatDiagnosticsEvaluator.evaluateLocalAuth(
            status: auth.status,
            hasToken: auth.body.contains("\"token\""),
            latencyMs: auth.latencyMs
        ))

        // 3. Provider endpoint.
        markRunning(ChatDiagnosticsEvaluator.endpointCheckID)
        let endpoint = await get(
            baseURL.hasSuffix("/") ? baseURL + "models" : baseURL + "/models",
            bearer: apiKey
        )
        update(ChatDiagnosticsEvaluator.evaluateEndpoint(
            baseURL: baseURL, status: endpoint.status, latencyMs: endpoint.latencyMs
        ))

        // 4. API key.
        update(ChatDiagnosticsEvaluator.evaluateKey(
            hasKey: !apiKey.isEmpty, endpointStatus: endpoint.status
        ))

        // 5. Live chat probe - the decisive one.
        markRunning(ChatDiagnosticsEvaluator.chatCheckID)
        let probe = await chatProbe(baseURL: baseURL, model: model, apiKey: apiKey)
        update(ChatDiagnosticsEvaluator.evaluateChatProbe(
            model: model, status: probe.status, body: probe.body, latencyMs: probe.latencyMs
        ))

        // 6. A2A.
        markRunning(ChatDiagnosticsEvaluator.a2aCheckID)
        let a2a = await get(a2aAgentsURL)
        let agentCount = a2a.body.components(separatedBy: "\"id\"").count - 1
        update(ChatDiagnosticsEvaluator.evaluateA2A(
            isRegistered: isA2ARegistered, agentCount: max(0, agentCount)
        ))

        lastRunAt = Date()
        isRunning = false

        for check in checks where check.status == .fail || check.status == .warn {
            TriosLogBus.shared.log(
                check.status == .fail ? .error : .warn,
                subsystem: .health,
                event: "diagnostics.\(check.id)",
                message: "\(check.title): \(check.detail)",
                attributes: ["remedy": check.remedy ?? "-"]
            )
        }
        TriosLogBus.shared.info(.health, "diagnostics.finished", summary)
    }

    // MARK: - Probes

    private struct ProbeResult {
        let status: Int?
        let body: String
        let latencyMs: Int
    }

    private func get(_ urlString: String, bearer: String? = nil) async -> ProbeResult {
        guard let url = URL(string: urlString) else {
            return ProbeResult(status: nil, body: "", latencyMs: 0)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        if let bearer, !bearer.isEmpty {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        let start = Date()
        do {
            let (data, response) = try await session.data(for: request)
            return ProbeResult(
                status: (response as? HTTPURLResponse)?.statusCode,
                body: String(data: data, encoding: .utf8) ?? "",
                latencyMs: Int(max(0, Date().timeIntervalSince(start) * 1000))
            )
        } catch {
            return ProbeResult(
                status: nil,
                body: error.localizedDescription,
                latencyMs: Int(max(0, Date().timeIntervalSince(start) * 1000))
            )
        }
    }

    /// Smallest possible real completion: one token, one word.
    private func chatProbe(baseURL: String, model: String, apiKey: String) async -> ProbeResult {
        let path = baseURL.hasSuffix("/") ? baseURL + "chat/completions" : baseURL + "/chat/completions"
        guard let url = URL(string: path) else {
            return ProbeResult(status: nil, body: "", latencyMs: 0)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = [
            "model": model,
            "messages": [["role": "user", "content": "ping"]],
            "max_tokens": 1
        ]
        guard let encoded = try? JSONSerialization.data(withJSONObject: body) else {
            return ProbeResult(status: nil, body: "", latencyMs: 0)
        }
        request.httpBody = encoded

        let start = Date()
        do {
            let (data, response) = try await session.data(for: request)
            return ProbeResult(
                status: (response as? HTTPURLResponse)?.statusCode,
                body: String(data: data, encoding: .utf8) ?? "",
                latencyMs: Int(max(0, Date().timeIntervalSince(start) * 1000))
            )
        } catch {
            return ProbeResult(
                status: nil,
                body: error.localizedDescription,
                latencyMs: Int(max(0, Date().timeIntervalSince(start) * 1000))
            )
        }
    }

    // MARK: - State

    private func markRunning(_ id: String) {
        guard let index = checks.firstIndex(where: { $0.id == id }) else { return }
        checks[index].status = .running
    }

    private func update(_ check: DiagnosticCheck) {
        guard let index = checks.firstIndex(where: { $0.id == check.id }) else { return }
        checks[index] = check
    }
}
