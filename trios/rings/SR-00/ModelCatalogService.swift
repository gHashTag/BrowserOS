import Foundation

enum ModelCatalogError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case httpError(Int)
    case noModels

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL: return "Invalid model catalog URL"
        case .invalidResponse: return "Invalid model catalog response"
        case .httpError(let code): return "Model catalog returned HTTP \(code)"
        case .noModels: return "The provider returned no models"
        }
    }
}

enum ModelCatalogParser {
    static func parse(data: Data, provider: ModelProvider) -> [String] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }

        let identifiers: [String]
        if provider == .ollama {
            let models = root["models"] as? [[String: Any]] ?? []
            identifiers = models.compactMap { model in
                (model["name"] as? String) ?? (model["model"] as? String)
            }
        } else {
            let models = root["data"] as? [[String: Any]] ?? []
            identifiers = models.compactMap { $0["id"] as? String }
        }

        return Array(Set(identifiers.filter { !$0.isEmpty })).sorted()
    }
}

actor ModelCatalogService {
    func fetchModels(
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async throws -> [String] {
        if provider == .zai {
            return provider.suggestedModels
        }

        let request = try catalogRequest(provider: provider, baseURL: baseURL, apiKey: apiKey)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ModelCatalogError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw ModelCatalogError.httpError(http.statusCode)
        }
        let models = ModelCatalogParser.parse(data: data, provider: provider)
        guard !models.isEmpty else { throw ModelCatalogError.noModels }
        return models
    }

    private func catalogRequest(
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) throws -> URLRequest {
        let url: URL
        if provider == .ollama {
            guard var components = URLComponents(string: baseURL) else {
                throw ModelCatalogError.invalidBaseURL
            }
            components.path = "/api/tags"
            components.query = nil
            guard let resolvedURL = components.url else {
                throw ModelCatalogError.invalidBaseURL
            }
            url = resolvedURL
        } else {
            guard let resolvedURL = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/models") else {
                throw ModelCatalogError.invalidBaseURL
            }
            url = resolvedURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let apiKey, !apiKey.isEmpty {
            if provider == .anthropic {
                request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
                request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            } else {
                request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            }
        }
        return request
    }
}
