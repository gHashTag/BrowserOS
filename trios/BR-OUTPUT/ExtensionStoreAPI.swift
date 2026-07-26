//
//  ExtensionStoreAPI.swift
//  TriOS — Extension Marketplace API
//
//  Browse, install, and manage community plugins
//

import Foundation

/// ExtensionStoreAPI — Community plugin marketplace
@MainActor
class ExtensionStoreAPI: ObservableObject {
    
    @Published var extensions: [ExtensionInfo] = .init()
    @Published var installedExtensions: Set<String> = .init()
    @Published var isLoading: Bool = false
    @Published var error: String?
    
    private let apiBaseUrl: URL
    private let apiKey: String

    init?(apiBaseUrl: String = "https://extensions.trios.ai", apiKey: String = "") {
        guard let url = URL(string: apiBaseUrl),
              url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty else {
            return nil
        }
        self.apiBaseUrl = url
        self.apiKey = apiKey
        loadInstalledExtensions()
    }
    
    // MARK: - Public API
    
    /// Browse all extensions
    func browseExtensions(category: String? = nil, search: String? = nil) async {
        isLoading = true
        error = nil

        do {
            guard var components = URLComponents(url: apiBaseUrl, resolvingAgainstBaseURL: true) else {
                throw ExtensionStoreError.invalidInput
            }
            components.path = "/api/v1/extensions"

            var queryItems: [URLQueryItem] = []
            if let category = category {
                queryItems.append(URLQueryItem(name: "category", value: category))
            }
            if let search = search {
                queryItems.append(URLQueryItem(name: "q", value: search))
            }
            components.queryItems = queryItems

            guard let url = components.url else {
                throw ExtensionStoreError.invalidInput
            }

            var request = URLRequest(url: url)
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw ExtensionStoreError.networkError
            }

            let decoded = try JSONDecoder().decode(ExtensionListResponse.self, from: data)
            extensions = decoded.extensions

            AnalyticsService.shared.track("extensions_browsed", properties: [
                "count": extensions.count,
                "category": category ?? "all"
            ])

        } catch {
            self.error = error.localizedDescription
            AnalyticsService.shared.trackError(error, context: "ExtensionStoreAPI.browseExtensions")
        }

        isLoading = false
    }
    
    /// Get extension details
    func getExtensionDetails(id: String) async -> ExtensionInfo? {
        guard validateExtensionId(id), let url = endpointURL(path: "/extensions/\(id)") else {
            AnalyticsService.shared.trackError(ExtensionStoreError.invalidInput, context: "ExtensionStoreAPI.getExtensionDetails")
            return nil
        }

        do {
            var request = URLRequest(url: url)
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                return nil
            }
            return try JSONDecoder().decode(ExtensionInfo.self, from: data)

        } catch {
            AnalyticsService.shared.trackError(error, context: "ExtensionStoreAPI.getExtensionDetails")
            return nil
        }
    }

    /// Install extension
    func installExtension(id: String) async -> Bool {
        guard validateExtensionId(id), let url = endpointURL(path: "/extensions/\(id)/install") else {
            AnalyticsService.shared.trackError(ExtensionStoreError.invalidInput, context: "ExtensionStoreAPI.installExtension")
            return false
        }

        do {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                return false
            }

            installedExtensions.insert(id)
            saveInstalledExtensions()

            AnalyticsService.shared.track("extension_installed", properties: ["extension_id": id])

            return true

        } catch {
            AnalyticsService.shared.trackError(error, context: "ExtensionStoreAPI.installExtension")
            return false
        }
    }
    
    /// Uninstall extension
    func uninstallExtension(id: String) async {
        installedExtensions.remove(id)
        saveInstalledExtensions()
        AnalyticsService.shared.track("extension_uninstalled", properties: ["extension_id": id])
    }
    
    /// Check if extension is installed
    func isInstalled(_ id: String) -> Bool {
        installedExtensions.contains(id)
    }
    
    // MARK: - Private Methods

    /// Validates an extension id: only alphanumerics, hyphen, and underscore;
    /// length between 1 and 64 characters.
    private func validateExtensionId(_ id: String) -> Bool {
        id.count >= 1
            && id.count <= 64
            && id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }

    /// Builds an HTTPS URL under the configured API base.
    private func endpointURL(path: String) -> URL? {
        var components = URLComponents(url: apiBaseUrl, resolvingAgainstBaseURL: true)
        components?.path = "/api/v1\(path)"
        return components?.url
    }

    private func loadInstalledExtensions() {
        if let data = UserDefaults.standard.data(forKey: "trios_installed_extensions"),
           let ids = try? JSONDecoder().decode(Set<String>.self, from: data) {
            installedExtensions = ids
        }
    }
    
    private func saveInstalledExtensions() {
        if let data = try? JSONEncoder().encode(installedExtensions) {
            UserDefaults.standard.set(data, forKey: "trios_installed_extensions")
        }
    }
}

// MARK: - Models

struct ExtensionListResponse: Codable {
    let extensions: [ExtensionInfo]
    let total: Int
    let page: Int
    let perPage: Int
}

struct ExtensionInfo: Identifiable, Codable {
    let id: String
    let name: String
    let description: String
    let version: String
    let author: String
    let category: String
    let downloads: Int
    let rating: Double
    let iconUrl: String
    let screenshotUrls: [String]
    let downloadUrl: String
    let createdAt: Date
    let updatedAt: Date
}

enum ExtensionStoreError: Error {
    case networkError
    case decodingError
    case notFound
    case invalidInput
}

// MARK: - Loaded Extension

struct LoadedExtension {
    let id: String
    let name: String
    let version: String
    let isActive: Bool
}
