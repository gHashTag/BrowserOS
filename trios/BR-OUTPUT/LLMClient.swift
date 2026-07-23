import Foundation

/// Minimal LLM client for OpenRouter (Claude models).
/// Streams or completes chat messages and returns assistant text.
final class LLMClient {
    private let apiKey: String
    private let baseURL: URL = {
        guard let url = URL(string: "https://openrouter.ai/api/v1/chat/completions") else {
            fatalError("LLMClient: hardcoded baseURL is invalid - this is a compile-time constant error")
        }
        return url
    }()
    private let session = URLSession.shared

    var isConfigured: Bool {
        !apiKey.isEmpty
    }

    /// Creates a client with an explicit API key. Keys are never read from
    /// environment variables inside this initializer; callers must supply a key
    /// obtained from macOS Keychain (e.g. via `ModelCredentialStore`). This
    /// prevents accidental exfiltration via `.env` files or shell history.
    init(apiKey: String? = nil) {
        self.apiKey = apiKey ?? ""
    }

    struct Message: Codable {
        let role: String
        let content: String
    }

    /// Non-streaming completion. Returns assistant content.
    func complete(messages: [Message]) async throws -> String {
        guard !apiKey.isEmpty else {
            throw LLMError.missingAPIKey
        }

        let body: [String: Any] = [
            "model": "anthropic/claude-4-sonnet",
            "messages": messages.map { ["role": $0.role, "content": $0.content] },
            "max_tokens": 4096,
            "temperature": 0.7
        ]

        var request = URLRequest(url: baseURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("BrowserOS-trios/1.0", forHTTPHeaderField: "HTTP-Referer")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw LLMError.httpError(text)
        }

        struct Response: Codable {
            struct Choice: Codable {
                struct Message: Codable {
                    let content: String?
                }
                let message: Message
            }
            let choices: [Choice]
        }

        let decoded = try JSONDecoder().decode(Response.self, from: data)
        return decoded.choices.first?.message.content ?? "(no response)"
    }
}

enum LLMError: Error, LocalizedError {
    case missingAPIKey
    case httpError(String)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "LLM: API key is required. Store it in macOS Keychain via ModelCredentialStore and pass it to LLMClient.init(apiKey:)."
        case .httpError(let text): return "LLM HTTP error: \(text)"
        }
    }
}
