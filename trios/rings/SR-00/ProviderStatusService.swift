import Foundation

/// Native provider catalog status for a single model.
enum ProviderModelStatus: Equatable, Sendable {
    case present
    case disabled
    case missing
    case unknown(error: String)
}

/// Abstract provider status check that can be injected for testing.
protocol ProviderStatusServiceProtocol: Sendable {
    func status(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ProviderModelStatus

    func invalidate() async
}

/// Fast, free provider-native catalog check.
///
/// Queries each provider's public model list (OpenRouter `/api/v1/models`,
/// OpenAI `/v1/models`, Anthropic `/v1/models`, Ollama `/api/tags`) before
/// falling back to a paid liveness probe. Results are cached independently
/// from health probes because catalog changes are much slower than availability
/// blips.
actor ProviderStatusService: ProviderStatusServiceProtocol {
    struct CacheEntry: Equatable {
        let status: ProviderModelStatus
        let timestamp: Date
    }

    private var cache: [String: CacheEntry] = [:]
    private let ttl: TimeInterval
    private let session: URLSession

    init(
        ttl: TimeInterval = 300,
        session: URLSession = URLSession.shared
    ) {
        self.ttl = ttl
        self.session = session
    }

    /// Returns the provider-native status of a model. Cached entries younger
    /// than `ttl` are returned without a network call.
    func status(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ProviderModelStatus {
        let key = cacheKey(model: model, provider: provider, baseURL: baseURL)
        if let entry = cache[key], Date().timeIntervalSince(entry.timestamp) < ttl {
            return entry.status
        }

        let status = await fetchStatus(
            model: model,
            provider: provider,
            baseURL: baseURL,
            apiKey: apiKey
        )
        cache[key] = CacheEntry(status: status, timestamp: Date())
        return status
    }

    /// Clears cached provider status entries, e.g. when the endpoint or key changes.
    func invalidate() async {
        cache.removeAll()
    }

    /// Fetches the provider catalog and looks up the model.
    private func fetchStatus(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ProviderModelStatus {
        let catalogURL: URL
        do {
            catalogURL = try makeCatalogURL(provider: provider, baseURL: baseURL)
        } catch {
            return .unknown(error: "Invalid catalog URL: \(error.localizedDescription)")
        }

        var request = URLRequest(url: catalogURL)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        if let apiKey, !apiKey.isEmpty {
            if provider == .anthropic {
                request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
                request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            } else {
                request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            }
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .unknown(error: "Non-HTTP catalog response")
            }
            guard (200...299).contains(http.statusCode) else {
                if http.statusCode == 401 || http.statusCode == 403 {
                    return .unknown(error: "Catalog auth error \(http.statusCode)")
                }
                return .unknown(error: "Catalog HTTP \(http.statusCode)")
            }

            let entries = parseCatalog(data: data, provider: provider)
            if let entry = entries.first(where: { $0.id == model }) {
                return entry.enabled ? .present : .disabled
            }
            return .missing
        } catch let urlError as URLError {
            return .unknown(error: "Catalog network error: \(urlError.localizedDescription)")
        } catch {
            return .unknown(error: "Catalog fetch failed: \(error.localizedDescription)")
        }
    }

    private func makeCatalogURL(provider: ModelProvider, baseURL: String) throws -> URL {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else {
            throw URLError(.badURL)
        }
        switch provider {
        case .ollama:
            return url.appendingPathComponent("/api/tags")
        case .zai:
            // z.ai does not publish a public model list endpoint.
            throw URLError(.badURL)
        default:
            return url.appendingPathComponent("/models")
        }
    }

    private struct CatalogEntry {
        let id: String
        let enabled: Bool
    }

    private func parseCatalog(data: Data, provider: ModelProvider) -> [CatalogEntry] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }

        if provider == .ollama {
            let models = root["models"] as? [[String: Any]] ?? []
            return models.compactMap { model in
                guard let id = model["name"] as? String else { return nil }
                return CatalogEntry(id: id, enabled: true)
            }
        }

        let models = root["data"] as? [[String: Any]] ?? []
        return models.compactMap { model in
            guard let id = model["id"] as? String else { return nil }
            let enabled = !(model["disabled"] as? Bool ?? false)
            return CatalogEntry(id: id, enabled: enabled)
        }
    }

    private func cacheKey(model: String, provider: ModelProvider, baseURL: String) -> String {
        "\(provider.rawValue)|\(baseURL)|\(model)"
    }
}
