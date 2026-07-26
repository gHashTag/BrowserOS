// AGENT-V-WAIVER: Emergency retry + detailed error surfacing for A2A requests.
import Foundation

enum A2AError: Error, Equatable, CustomStringConvertible {
    case notRegistered
    case invalidURL
    case networkError(Error)
    case transport(URLError)
    case invalidResponse(Int, body: String?)
    case decodingError(String?)
    case timeout(URL, TimeInterval)
    case retryExhausted([Error])
    case reconnectExhausted(attempts: Int)

    static func == (lhs: A2AError, rhs: A2AError) -> Bool {
        switch (lhs, rhs) {
        case (.notRegistered, .notRegistered): return true
        case (.invalidURL, .invalidURL): return true
        case (.decodingError, .decodingError): return true
        case (.invalidResponse(let a, _), .invalidResponse(let b, _)): return a == b
        case (.timeout(let u1, let t1), .timeout(let u2, let t2)): return u1 == u2 && t1 == t2
        case (.retryExhausted, .retryExhausted): return true
        case (.reconnectExhausted(let a), .reconnectExhausted(let b)): return a == b
        case (.transport(let a), .transport(let b)): return a.code == b.code
        case (.networkError, .networkError): return false
        default: return false
        }
    }

    var description: String {
        switch self {
        case .notRegistered:
            return "A2A client is not registered with the registry"
        case .invalidURL:
            return "A2A request URL is invalid"
        case .networkError(let error):
            return "A2A network error: \(error.localizedDescription)"
        case .transport(let urlError):
            return "A2A transport failure: URLError code \(urlError.code.rawValue): \(urlError.localizedDescription)"
        case .invalidResponse(let status, let body):
            return "A2A server returned \(status)" + (body.map { ". Response: \($0)" } ?? "")
        case .decodingError(let detail):
            return "A2A response decoding failed" + (detail.map { ": \($0)" } ?? "")
        case .timeout(let url, let interval):
            return "A2A request to \(url.absoluteString) timed out after \(interval.rounded(toPlaces: 1))s"
        case .retryExhausted(let errors):
            return "A2A request failed after \(errors.count) attempt(s): \(errors.last?.localizedDescription ?? "unknown")"
        case .reconnectExhausted(let attempts):
            return "A2A stream reconnect budget exhausted after \(attempts) attempt(s)"
        }
    }

    var localizedDescription: String { description }
}

actor A2ARegistryClient {
    private let serverURL: URL
    private let agentCard: AgentCard
    private var registered = false
    private var registeredAgentId: AgentId? { registered ? agentCard.id : nil }
    private var heartbeatTask: Task<Void, Never>?
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder
    private let retrier: NetworkRetrier
    private let localAuthProvider: LocalAuthProviding?
    private var lastEventID: Int? = nil

    init(
        serverURL: URL,
        agentCard: AgentCard,
        session: URLSession = .shared,
        localAuthProvider: LocalAuthProviding? = nil
    ) {
        self.serverURL = serverURL
        self.agentCard = agentCard
        self.session = session
        self.localAuthProvider = localAuthProvider
        // The Hono server expects camelCase keys (agentId, createdAt, etc.).
        // Using convertToSnakeCase would serialize them as agent_id, causing 400s.
        let configuredDecoder = JSONDecoder()
        configuredDecoder.keyDecodingStrategy = .convertFromSnakeCase
        configuredDecoder.dateDecodingStrategy = .iso8601
        self.decoder = configuredDecoder
        self.retrier = NetworkRetrier(policy: NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 1,
            maxDelay: 15,
            exponentialBackoff: true,
            retryableURLErrorCodes: NetworkRetryPolicy.default.retryableURLErrorCodes,
            extraShouldRetry: { error in
                if case let A2AError.invalidResponse(statusCode, _) = error {
                    return statusCode >= 500 || statusCode == 429
                }
                return false
            }
        ))
    }

    // MARK: - Registration

    func register() async throws {
        let url = serverURL.appendingPathComponent("a2a/register")
        // Encode the registration payload explicitly so the endpoint is always
        // present, regardless of how AgentCard's optional URL is serialized.
        let payload = A2ARegisterPayload(
            id: agentCard.id.rawValue,
            name: agentCard.name,
            description: agentCard.description,
            capabilities: agentCard.capabilities.map(\.rawValue),
            version: agentCard.version,
            endpoint: agentCard.endpoint?.absoluteString
                ?? serverURL.appendingPathComponent("a2a").absoluteString
        )
        let (data, http) = try await performAuthorizedDataRequest(
            url: url, method: "POST", body: payload
        )
        guard (200...299).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            throw A2AError.invalidResponse(http.statusCode, body: body)
        }
        registered = true
    }

    func unregister() async throws {
        let url = serverURL.appendingPathComponent("a2a/unregister")
        let body = ["agentId": agentCard.id.rawValue] as [String: String]
        _ = try await performAuthorizedDataRequest(url: url, method: "POST", body: body)
        registered = false
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    // MARK: - Heartbeat

    func startHeartbeat(interval: TimeInterval = 30) {
        heartbeatTask?.cancel()
        heartbeatTask = Task {
            while !Task.isCancelled {
                do {
                    try await heartbeat()
                } catch {
                    // Silent heartbeat failure; server will mark offline if too many missed
                }
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private static let dateFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func heartbeat() async throws {
        guard registered else { throw A2AError.notRegistered }
        let url = serverURL.appendingPathComponent("a2a/heartbeat")
        let payload = HeartbeatPayload(
            agentId: agentCard.id,
            timestamp: Self.dateFormatter.string(from: Date())
        )
        let (_, http) = try await performAuthorizedDataRequest(
            url: url, method: "POST", body: payload
        )
        guard (200...299).contains(http.statusCode) else {
            throw A2AError.invalidResponse(http.statusCode, body: nil)
        }
    }

    // MARK: - Agent Discovery

    func listAgents() async throws -> [AgentCard] {
        let url = serverURL.appendingPathComponent("a2a/agents")
        let (data, http) = try await performAuthorizedGetRequest(url: url)
        guard (200...299).contains(http.statusCode) else {
            throw A2AError.invalidResponse(http.statusCode, body: nil)
        }
        // BrowserOS A2A registry wraps the agent array under an `agents` key.
        do {
            return try decoder.decode(AgentsListResponse.self, from: data).agents
        } catch {
            throw A2AError.decodingError(error.localizedDescription)
        }
    }

    // MARK: - Messaging

    func sendMessage(_ message: A2AMessage) async throws {
        guard registered else { throw A2AError.notRegistered }
        let url = serverURL.appendingPathComponent("a2a/message")
        let (_, http) = try await performAuthorizedDataRequest(
            url: url, method: "POST", body: message
        )
        guard (200...299).contains(http.statusCode) else {
            throw A2AError.invalidResponse(http.statusCode, body: nil)
        }
    }

    /// Convenience broadcast from this agent to all online peers.
    func broadcast(payload: Data, correlationId: UUID? = nil) async throws {
        let message = A2AMessage(
            id: UUID(),
            sender: agentCard.id,
            recipient: nil,
            type: .broadcast,
            payload: payload,
            timestamp: Self.dateFormatter.string(from: Date())
        )
        try await sendMessage(message)
    }

    func assignTask(_ task: AgentTask, to agent: AgentId) async throws {
        guard registered else { throw A2AError.notRegistered }
        let url = serverURL.appendingPathComponent("a2a/task/assign")
        let payload = TaskAssignPayload(task: task, agentId: agent)
        let (_, http) = try await performAuthorizedDataRequest(
            url: url, method: "POST", body: payload
        )
        guard (200...299).contains(http.statusCode) else {
            throw A2AError.invalidResponse(http.statusCode, body: nil)
        }
    }

    func updateTaskState(id: UUID, state: AgentTaskState) async throws {
        guard registered else { throw A2AError.notRegistered }
        let url = serverURL.appendingPathComponent("a2a/task/update")
        let payload = TaskUpdatePayload(id: id, state: state)
        let (_, http) = try await performAuthorizedDataRequest(
            url: url, method: "POST", body: payload
        )
        guard (200...299).contains(http.statusCode) else {
            throw A2AError.invalidResponse(http.statusCode, body: nil)
        }
    }

    // MARK: - Inbound Message Stream

    func messageStream() async throws -> AsyncStream<A2AMessage> {
        guard registered else { throw A2AError.notRegistered }
        guard let agentId = self.registeredAgentId?.rawValue.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            throw A2AError.notRegistered
        }
        var urlComponents = URLComponents(url: serverURL.appendingPathComponent("a2a/stream"), resolvingAgainstBaseURL: true)!
        urlComponents.queryItems = [URLQueryItem(name: "agentId", value: agentId)]
        guard let url = urlComponents.url else {
            throw A2AError.invalidURL
        }
        return AsyncStream<A2AMessage> { continuation in
            let task = Task {
                var attempt = 0
                let maxReconnectAttempts = 20
                while !Task.isCancelled {
                    do {
                        let session = self.session
                        let request = await self.makeAuthorizedStreamRequest(
                            url: url, forceRefresh: attempt > 0
                        )
                        let (bytes, response) = try await self.retrier.execute(
                            url: url,
                            description: "A2A SSE stream \(url.absoluteString)"
                        ) {
                            try await session.bytes(for: request)
                        }
                        guard let http = response as? HTTPURLResponse,
                              (200...299).contains(http.statusCode) else {
                            throw A2AError.invalidResponse(
                                (response as? HTTPURLResponse)?.statusCode ?? 0,
                                body: nil
                            )
                        }
                        attempt = 0
                        for try await line in bytes.lines {
                            if Task.isCancelled { break }
                            if let message = await self.handleSSELine(line) {
                                continuation.yield(message)
                            }
                        }
                    } catch {
                        attempt += 1
                        if attempt >= maxReconnectAttempts {
                            let errorPayload = A2AStreamErrorPayload(
                                code: "reconnectExhausted",
                                message: "A2A stream reconnect budget exhausted after \(attempt) attempt(s)"
                            )
                            let payload = (try? JSONEncoder().encode(errorPayload)) ?? Data()
                            continuation.yield(A2AMessage(
                                id: UUID(),
                                sender: self.agentCard.id,
                                recipient: nil,
                                type: .error,
                                payload: payload
                            ))
                            continuation.finish()
                            break
                        }
                        // Retry with capped exponential backoff: max ~30s.
                        let delay = min(30.0, pow(2.0, Double(attempt)))
                        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    // MARK: - Request helpers

    private func makeRequest(url: URL, method: String, body: some Encodable & Sendable) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        request.timeoutInterval = 60
        return request
    }

    private func makeGetRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 60
        return request
    }

    private func makeStreamRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 60
        if let lastEventID = lastEventID {
            request.setValue("\(lastEventID)", forHTTPHeaderField: "Last-Event-ID")
        }
        return request
    }

    private func makeAuthorizedRequest(
        url: URL,
        method: String,
        body: some Encodable & Sendable,
        forceRefresh: Bool = false
    ) async throws -> URLRequest {
        var request = try makeRequest(url: url, method: method, body: body)
        if let token = try? await localAuthProvider?.validToken(forcingRefresh: forceRefresh) {
            request.setValue(token, forHTTPHeaderField: LocalAuthProvider.headerName)
        }
        return request
    }

    private func makeAuthorizedGetRequest(url: URL, forceRefresh: Bool = false) async -> URLRequest {
        var request = makeGetRequest(url: url)
        if let token = try? await localAuthProvider?.validToken(forcingRefresh: forceRefresh) {
            request.setValue(token, forHTTPHeaderField: LocalAuthProvider.headerName)
        }
        return request
    }

    private func makeAuthorizedStreamRequest(url: URL, forceRefresh: Bool = false) async -> URLRequest {
        var request = makeStreamRequest(url: url)
        if let token = try? await localAuthProvider?.validToken(forcingRefresh: forceRefresh) {
            request.setValue(token, forHTTPHeaderField: LocalAuthProvider.headerName)
        }
        return request
    }

    private func performAuthorizedDataRequest(
        url: URL,
        method: String,
        body: some Encodable & Sendable
    ) async throws -> (Data, HTTPURLResponse) {
        let request = try await makeAuthorizedRequest(url: url, method: method, body: body)
        do {
            return try await performDataRequest(url: url, request: request)
        } catch let A2AError.invalidResponse(403, _) {
            await LocalAuthMonitor.shared.record403Retry()
            let request = try await makeAuthorizedRequest(
                url: url, method: method, body: body, forceRefresh: true
            )
            return try await performDataRequest(url: url, request: request)
        }
    }

    private func performAuthorizedGetRequest(url: URL) async throws -> (Data, HTTPURLResponse) {
        let request = await makeAuthorizedGetRequest(url: url)
        do {
            return try await performDataRequest(url: url, request: request)
        } catch let A2AError.invalidResponse(403, _) {
            await LocalAuthMonitor.shared.record403Retry()
            let request = await makeAuthorizedGetRequest(url: url, forceRefresh: true)
            return try await performDataRequest(url: url, request: request)
        }
    }

    private func performDataRequest(url: URL, request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let session = self.session
        let (data, http) = try await retrier.execute(task: {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw A2AError.invalidResponse(0, body: nil)
            }
            return (data, http)
        })
        return (data, http)
    }

    private func handleSSELine(_ line: String) -> A2AMessage? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("id:") {
            let idString = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
            if let id = Int(idString) {
                self.lastEventID = id
            }
            return nil
        }
        return parseSSELine(trimmed)
    }

    nonisolated private func parseSSELine(_ line: String) -> A2AMessage? {
        guard line.hasPrefix("data: ") else { return nil }
        let json = String(line.dropFirst(6))
        guard let data = json.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601

        // Server sends object payloads as JSON strings so they can be decoded as
        // Data (UTF-8 bytes). If the top-level payload is a string, wrap it in a
        // structure that lets us recover the original bytes.
        if let wrapper = try? decoder.decode(A2AMessagePayloadWrapper.self, from: data) {
            let payloadData = wrapper.payload?.data(using: .utf8) ?? Data()
            return A2AMessage(
                id: wrapper.id,
                sender: wrapper.sender,
                recipient: wrapper.recipient,
                type: wrapper.type,
                payload: payloadData,
                timestamp: wrapper.timestamp
            )
        }
        return nil
    }
}

/// Explicit registration payload so the A2A registry always receives a string
/// `endpoint`, even if AgentCard's optional URL is omitted by the encoder.
private struct A2ARegisterPayload: Codable, Sendable {
    let id: String
    let name: String
    let description: String
    let capabilities: [String]
    let version: String
    let endpoint: String
}

/// Structured payload carried by a synthetic `.error` A2AMessage emitted by the stream.
private struct A2AStreamErrorPayload: Codable, Sendable {
    let code: String
    let message: String
}

// Decodes an SSE message whose `payload` field is a JSON string (server-side
// normalization for Swift Data compatibility).
private struct A2AMessagePayloadWrapper: Codable, Sendable {
    let id: UUID
    let sender: AgentId
    let recipient: AgentId?
    let type: A2AMessageType
    let payload: String?
    let timestamp: String
}

// MARK: - Payload Types

private struct AgentsListResponse: Codable, Sendable {
    let agents: [AgentCard]
}

private struct HeartbeatPayload: Codable, Sendable {
    let agentId: AgentId
    let timestamp: String
}

private struct TaskAssignPayload: Codable, Sendable {
    let task: AgentTask
    let agentId: AgentId
}

private struct TaskUpdatePayload: Codable, Sendable {
    let id: UUID
    let state: AgentTaskState
}
