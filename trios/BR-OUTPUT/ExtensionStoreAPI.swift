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
    
    @Published var extensions: [ExtensionInfo] = []
    @Published var installedExtensions: Set<String> = []
    @Published var isLoading: Bool = false
    @Published var error: String?
    
    private let apiBaseUrl: String
    private let apiKey: String
    
    init(apiBaseUrl: String = "https://extensions.trios.ai", apiKey: String = "") {
        self.apiBaseUrl = apiBaseUrl
        self.apiKey = apiKey
        loadInstalledExtensions()
    }
    
    // MARK: - Public API
    
    /// Browse all extensions
    func browseExtensions(category: String? = nil, search: String? = nil) async {
        isLoading = true
        error = nil
        
        do {
            var url = URL(string: "\(apiBaseUrl)/api/v1/extensions")!
            var components = URLComponents(url: url, resolvingAgainstBaseURL: true)!
            
            var queryItems: [URLQueryItem] = []
            if let category = category {
                queryItems.append(URLQueryItem(name: "category", value: category))
            }
            if let search = search {
                queryItems.append(URLQueryItem(name: "q", value: search))
            }
            
            components.queryItems = queryItems
            url = components.url!
            
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
        guard let url = URL(string: "\(apiBaseUrl)/api/v1/extensions/\(id)") else { return nil }
        
        do {
            var request = URLRequest(url: url)
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            
            let (data, _) = try await URLSession.shared.data(for: request)
            return try JSONDecoder().decode(ExtensionInfo.self, from: data)
            
        } catch {
            AnalyticsService.shared.trackError(error, context: "ExtensionStoreAPI.getExtensionDetails")
            return nil
        }
    }
    
    /// Install extension
    func installExtension(id: String) async -> Bool {
        guard let url = URL(string: "\(apiBaseUrl)/api/v1/extensions/\(id)/install") else { return false }
        
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
}

// MARK: - Extension Manager

@MainActor
class ExtensionManager: ObservableObject {
    
    @Published var extensions: [LoadedExtension] = []
    
    private let storeAPI: ExtensionStoreAPI

    // There was a `pluginAPI: PluginAPI` here, injected and then never read -
    // no method in this file touched it. `PluginAPI` is also not a type: that
    // file declares PluginContext, PluginRegistry and PluginError. Rather than
    // guess which one was meant and wire a dependency nothing uses, the field
    // is gone. Whoever connects extensions to the plugin registry can add it
    // back deliberately, against a type that exists.
    // The default cannot be `ExtensionStoreAPI()` written inline: default
    // arguments are evaluated outside the actor context, and that type is
    // @MainActor. Built in the body instead, which is isolated, so injection
    // still works for tests without crossing an actor boundary at the call site.
    init(storeAPI: ExtensionStoreAPI? = nil) {
        self.storeAPI = storeAPI ?? ExtensionStoreAPI()
    }
    
    func loadExtensions() async {
        // Load installed extensions
        // Initialize plugin system
    }
}

struct LoadedExtension {
    let id: String
    let name: String
    let version: String
    let isActive: Bool
}
