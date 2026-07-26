// AGENT-V-WAIVER: browseros-ai/BrowserOS#2023
// Reason: URL construction hardening and input validation to prevent force-unwrap crashes.
// Agent Social Network Client for Trios
// Provides Swift interface to BrowserOS Agent Network API

import Foundation

// MARK: - Models

struct Conversation: Codable, Identifiable {
    let id: String
    let profileId: String
    let createdAt: String
    let lastMessagedAt: String
    let title: String?
    let metadata: [String: Any]?

    enum CodingKeys: String, CodingKey {
        case id, profileId, createdAt, lastMessagedAt, title, metadata
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        profileId = try container.decode(String.self, forKey: .profileId)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        lastMessagedAt = try container.decode(String.self, forKey: .lastMessagedAt)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        metadata = try container.decodeIfPresent([String: Any].self, forKey: .metadata)
    }
}

struct Message: Codable, Identifiable {
    let id: String
    let conversationId: String
    let role: String
    let content: String
    let timestamp: String
    let orderIndex: Int
}

struct AgentNetworkTask: Codable, Identifiable {
    let id: String
    let agentId: String
    let taskType: String
    let payload: [String: Any]
    let priority: Int
    let status: String
    let retryCount: Int
    let maxRetries: Int
    let createdAt: String
    let startedAt: String?
    let completedAt: String?
    let errorMessage: String?
    let result: [String: Any]?

    enum CodingKeys: String, CodingKey {
        case id, agentId, taskType, payload, priority, status, retryCount, maxRetries
        case createdAt, startedAt, completedAt, errorMessage, result
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        agentId = try container.decode(String.self, forKey: .agentId)
        taskType = try container.decode(String.self, forKey: .taskType)
        payload = try container.decode([String: Any].self, forKey: .payload)
        priority = try container.decode(Int.self, forKey: .priority)
        status = try container.decode(String.self, forKey: .status)
        retryCount = try container.decode(Int.self, forKey: .retryCount)
        maxRetries = try container.decode(Int.self, forKey: .maxRetries)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
        errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        result = try container.decodeIfPresent([String: Any].self, forKey: .result)
    }
}

struct Agent: Codable, Identifiable {
    let id: String
    let name: String
    let status: String
    let capabilities: [String]
}

// MARK: - API Client

@MainActor
final class AgentNetworkClient {
    static let shared: AgentNetworkClient = {
        let configuredURL = URL(string: "http://localhost:\(ProjectPaths.mcpPort)")
        let fallbackURL = URL(string: "http://localhost:9105")!
        guard let baseURL = configuredURL, baseURL.scheme == "http" || baseURL.scheme == "https" else {
            print("[AgentNetworkClient] Warning: invalid or missing baseURL, using fallback \(fallbackURL.absoluteString)")
            return AgentNetworkClient(baseURL: fallbackURL)
        }
        return AgentNetworkClient(baseURL: baseURL)
    }()

    private let baseURL: URL
    private let session: URLSession

    private static let queryAllowedCharacters: CharacterSet = {
        CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))
    }()

    convenience init() {
        let configuredURL = URL(string: "http://localhost:\(ProjectPaths.mcpPort)")
        let fallbackURL = URL(string: "http://localhost:9105")!
        let url: URL
        if let configured = configuredURL, configured.scheme == "http" || configured.scheme == "https" {
            url = configured
        } else {
            print("[AgentNetworkClient] Warning: invalid or missing baseURL, using fallback \(fallbackURL.absoluteString)")
            url = fallbackURL
        }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        self.init(baseURL: url, session: URLSession(configuration: config))
    }

    init(baseURL: URL, session: URLSession = .shared) {
        guard baseURL.scheme == "http" || baseURL.scheme == "https" else {
            print("[AgentNetworkClient] Warning: invalid baseURL scheme '\(baseURL.scheme ?? "nil")', falling back to http://localhost:9105")
            self.baseURL = URL(string: "http://localhost:9105")!
            self.session = session
            return
        }
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Input Validation

    private func validateIdentifier(_ value: String, name: String) throws {
        guard !value.isEmpty,
              value.count <= 64,
              value.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
            throw AgentNetworkError.invalidInput("\(name) must be non-empty, ≤ 64 chars, and match [A-Za-z0-9._-]")
        }
    }

    // MARK: - URL Construction

    private func makeURL(path: String, queryItems: [URLQueryItem]? = nil) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            throw AgentNetworkError.invalidInput("Malformed base URL: \(baseURL.absoluteString)")
        }
        components.path = path
        if let queryItems = queryItems {
            components.percentEncodedQueryItems = queryItems.map { item in
                URLQueryItem(
                    name: item.name.addingPercentEncoding(withAllowedCharacters: Self.queryAllowedCharacters) ?? item.name,
                    value: item.value?.addingPercentEncoding(withAllowedCharacters: Self.queryAllowedCharacters)
                )
            }
        }
        guard let url = components.url else {
            throw AgentNetworkError.invalidInput("Unable to construct URL for path: \(path)")
        }
        return url
    }

    // MARK: - Chat API

    func createChat(profileId: String, title: String? = nil, metadata: [String: Any]? = nil) async throws -> Conversation {
        try validateIdentifier(profileId, name: "profileId")
        let url = try makeURL(path: "/api/chats")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["profileId": profileId]
        if let title = title { body["title"] = title }
        if let metadata = metadata { body["metadata"] = metadata }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let convData = json["conversation"] as? [String: Any] else {
            throw AgentNetworkError.parseError
        }

        return try JSONDecoder().decode(Conversation.self, from: JSONSerialization.data(withJSONObject: convData))
    }

    func addMessage(conversationId: String, role: String, content: String) async throws -> Message {
        try validateIdentifier(conversationId, name: "conversationId")
        let url = try makeURL(path: "/api/chats/\(conversationId)/messages")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "role": role,
            "content": content
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let msgData = json["message"] as? [String: Any] else {
            throw AgentNetworkError.parseError
        }

        return try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: msgData))
    }

    func listChats(profileId: String, limit: Int = 50, offset: Int = 0) async throws -> [Conversation] {
        try validateIdentifier(profileId, name: "profileId")
        let url = try makeURL(path: "/api/chats", queryItems: [
            URLQueryItem(name: "profileId", value: profileId),
            URLQueryItem(name: "limit", value: "\(limit)"),
            URLQueryItem(name: "offset", value: "\(offset)")
        ])

        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let convs = json["conversations"] as? [[String: Any]] else {
            throw AgentNetworkError.parseError
        }

        return try convs.map { try JSONDecoder().decode(Conversation.self, from: JSONSerialization.data(withJSONObject: $0)) }
    }

    // MARK: - Task Queue API

    func createTask(agentId: String, taskType: String, payload: [String: Any], priority: Int = 0) async throws -> AgentNetworkTask {
        try validateIdentifier(agentId, name: "agentId")
        let url = try makeURL(path: "/api/tasks")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "agentId": agentId,
            "taskType": taskType,
            "payload": payload,
            "priority": priority
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let taskData = json["task"] as? [String: Any] else {
            throw AgentNetworkError.parseError
        }

        return try JSONDecoder().decode(AgentNetworkTask.self, from: JSONSerialization.data(withJSONObject: taskData))
    }

    func dequeueTask(agentId: String) async throws -> AgentNetworkTask? {
        try validateIdentifier(agentId, name: "agentId")
        let url = try makeURL(path: "/api/tasks/queue/\(agentId)")
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let taskData = json["task"] as? [String: Any], taskData.count > 0 else {
            return nil
        }

        return try JSONDecoder().decode(AgentNetworkTask.self, from: JSONSerialization.data(withJSONObject: taskData))
    }

    func updateTaskStatus(taskId: String, status: String, result: [String: Any]? = nil) async throws -> Bool {
        try validateIdentifier(taskId, name: "taskId")
        let url = try makeURL(path: "/api/tasks/\(taskId)")
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["status": status]
        if let result = result { body["result"] = result }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }

        return true
    }

    // MARK: - A2A API

    func registerAgent(id: String, name: String, capabilities: [String]) async throws {
        try validateIdentifier(id, name: "extension id")
        let url = try makeURL(path: "/api/a2a/register")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "id": id,
            "name": name,
            "capabilities": capabilities,
            "status": "active"
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }
    }

    func sendMessage(sender: String, recipient: String, type: String, payload: [String: Any]) async throws {
        let url = try makeURL(path: "/api/a2a/message")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "id": "msg-\(UUID().uuidString)",
            "sender": sender,
            "recipient": recipient,
            "type": type,
            "payload": payload
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw AgentNetworkError.httpError
        }
    }
}

// MARK: - Errors

enum AgentNetworkError: LocalizedError {
    case httpError
    case parseError
    case notFound
    case invalidInput(String)

    var errorDescription: String? {
        switch self {
        case .httpError: return "HTTP request failed"
        case .parseError: return "Failed to parse response"
        case .notFound: return "Resource not found"
        case .invalidInput(let detail): return "Invalid input: \(detail)"
        }
    }
}
