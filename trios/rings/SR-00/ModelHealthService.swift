import Foundation

/// Result of a lightweight model health probe.
enum ModelHealth: Equatable, Sendable {
    case healthy
    case unavailable(reason: String)
    case unknown(error: String)
}

/// Abstract health probe that can be injected for testing.
protocol ModelHealthServiceProtocol: Sendable {
    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealth

    func invalidate() async
}

/// Lightweight, cached model health probe.
///
/// Uses a tiny paid completion (max_tokens: 1) as the final liveness signal for
/// cloud providers, and Ollama's free `/api/tags` list for local models. Results
/// are cached with a TTL and require two consecutive failures before a model is
/// marked `.unavailable`, reducing false positives from transient blips.
actor ModelHealthService: ModelHealthServiceProtocol {
    struct CacheEntry: Equatable {
        let health: ModelHealth
        let timestamp: Date
        let failureStreak: Int
    }

    private var cache: [String: CacheEntry] = [:]
    private let ttl: TimeInterval
    private let failureThreshold: Int
    private let session: URLSession

    init(
        ttl: TimeInterval = 60,
        failureThreshold: Int = 2,
        session: URLSession = URLSession.shared
    ) {
        self.ttl = ttl
        self.failureThreshold = max(1, failureThreshold)
        self.session = session
    }

    /// Probes the given model and returns its health. Cached results are returned
    /// when the entry is younger than `ttl`.
    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealth {
        let key = cacheKey(model: model, provider: provider, baseURL: baseURL)
        if let entry = cache[key], Date().timeIntervalSince(entry.timestamp) < ttl {
            return entry.health
        }

        let health: ModelHealth
        switch provider {
        case .ollama:
            health = await probeOllama(model: model, baseURL: baseURL)
        default:
            health = await probeCloud(
                model: model,
                provider: provider,
                baseURL: baseURL,
                apiKey: apiKey
            )
        }

        let previousStreak = cache[key]?.failureStreak ?? 0
        let newStreak: Int
        switch health {
        case .healthy:
            newStreak = 0
        case .unavailable, .unknown:
            newStreak = previousStreak + 1
        }

        let storedHealth: ModelHealth
        if case .unavailable = health, newStreak < failureThreshold {
            // Degrade to unknown until the failure threshold is crossed.
            storedHealth = .unknown(error: "Transient failure (\(newStreak)/\(failureThreshold))")
        } else {
            storedHealth = health
        }

        cache[key] = CacheEntry(health: storedHealth, timestamp: Date(), failureStreak: newStreak)
        return storedHealth
    }

    /// Clears all cached health entries. Useful when the user changes the endpoint
    /// or API key.
    func invalidate() async {
        cache.removeAll()
    }

    /// Probes a cloud provider by sending a tiny chat completion request.
    private func probeCloud(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealth {
        let url: URL
        do {
            url = try makeChatURL(baseURL: baseURL, provider: provider)
        } catch {
            return .unknown(error: "Invalid base URL: \(error.localizedDescription)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        if let apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        let body: [String: Any] = [
            "model": model,
            "messages": [["role": "user", "content": "ping"]],
            "max_tokens": 1
        ]
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            return .unknown(error: "Failed to encode probe body")
        }

        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .unknown(error: "Non-HTTP response")
            }
            switch http.statusCode {
            case 200...299:
                return .healthy
            case 401, 403:
                return .unknown(error: "Auth error \(http.statusCode) — not a model problem")
            case 402:
                return .unknown(error: "Insufficient balance — not a model problem")
            case 404, 422:
                return .unavailable(reason: "Model not found or invalid (\(http.statusCode))")
            case 429:
                return .unavailable(reason: "Rate limited (\(http.statusCode))")
            case 502, 503, 504:
                return .unavailable(reason: "Provider gateway error (\(http.statusCode))")
            default:
                return .unavailable(reason: "Provider error \(http.statusCode)")
            }
        } catch let urlError as URLError {
            return .unavailable(reason: "Network error: \(urlError.localizedDescription)")
        } catch {
            return .unknown(error: "Probe failed: \(error.localizedDescription)")
        }
    }

    /// Probes Ollama by listing local models via `/api/tags`.
    private func probeOllama(model: String, baseURL: String) async -> ModelHealth {
        let tagsURL: URL
        do {
            tagsURL = try makeURL(baseURL: baseURL, path: "/api/tags")
        } catch {
            return .unknown(error: "Invalid Ollama base URL: \(error.localizedDescription)")
        }

        var request = URLRequest(url: tagsURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return .unavailable(reason: "Ollama unreachable")
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = json["models"] as? [[String: Any]] else {
                return .unknown(error: "Unexpected Ollama tags response")
            }
            let names = models.compactMap { $0["name"] as? String }
            if names.contains(model) || names.contains("\(model):latest") {
                return .healthy
            }
            return .unavailable(reason: "Model not loaded in Ollama")
        } catch let urlError as URLError {
            return .unavailable(reason: "Ollama connection failed: \(urlError.localizedDescription)")
        } catch {
            return .unknown(error: "Ollama probe failed: \(error.localizedDescription)")
        }
    }

    private func makeChatURL(baseURL: String, provider: ModelProvider) throws -> URL {
        switch provider {
        case .openai:
            return try makeURL(baseURL: baseURL, path: "/chat/completions")
        case .anthropic:
            return try makeURL(baseURL: baseURL, path: "/v1/messages")
        case .openrouter, .zai:
            return try makeURL(baseURL: baseURL, path: "/v1/chat/completions")
        case .ollama:
            return try makeURL(baseURL: baseURL, path: "/v1/chat/completions")
        }
    }

    private func makeURL(baseURL: String, path: String) throws -> URL {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else {
            throw URLError(.badURL)
        }
        return url.appendingPathComponent(path)
    }

    private func cacheKey(model: String, provider: ModelProvider, baseURL: String) -> String {
        "\(provider.rawValue)|\(baseURL)|\(model)"
    }
}
