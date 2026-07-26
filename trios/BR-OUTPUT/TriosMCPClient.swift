import Foundation
import SwiftUI

/// Actor that communicates with BrowserOS MCP server (port 9105) for reverse integration.
/// Trios (SwiftUI) -> TriosMCPClient -> HTTP JSON-RPC -> MCP Server -> BrowserOS Agent
@MainActor
final class TriosMCPClient: ObservableObject {
    private let serverURL: URL
    private let session: URLSession
    private let retrier: NetworkRetrier

    @Published var isConnected = false
    @Published var lastError: String?
    @Published var browserState = BrowserState()

    private var localAuthToken: String?

    init(serverURL: URL = URL(string: ProjectPaths.mcpBaseURL) ?? URL(fileURLWithPath: "/dev/null")) {
        self.serverURL = serverURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
        self.retrier = NetworkRetrier(policy: NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 1,
            maxDelay: 15,
            exponentialBackoff: true,
            retryableURLErrorCodes: NetworkRetryPolicy.default.retryableURLErrorCodes,
            extraShouldRetry: { error in
                if case let MCPError.serverError(statusCode, _) = error {
                    return statusCode >= 500 || statusCode == 429
                }
                return false
            }
        ))
    }

    // MARK: - Local Authorization

    /// Fetches the server-issued local authorization token from the trusted
    /// loopback endpoint. The token is required by high-impact routes such as
    /// agent/skill creation and shutdown.
    func fetchLocalAuthToken() async {
        guard let url = URL(string: "\(serverURL.absoluteString)/auth/local-token") else { return }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            struct TokenResponse: Decodable { let token: String }
            let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
            localAuthToken = decoded.token
        } catch {
            NSLog("[TriosMCPClient] Failed to fetch local auth token: \(error.localizedDescription)")
        }
    }

    /// Returns a request with the local authorization header attached when a token
    /// has been obtained. Callers should `fetchLocalAuthToken()` first.
    func requestWithLocalAuth(
        url: URL,
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = "application/json"
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let contentType = contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if let token = localAuthToken {
            request.setValue(token, forHTTPHeaderField: "X-TriOS-Local-Auth")
        }
        request.httpBody = body
        return request
    }

    // MARK: - Health

    func checkHealth() async -> Bool {
        guard let url = URL(string: "\(serverURL.absoluteString)/health") else { return false }
        do {
            let session = self.session
            let (_, response) = try await retrier.execute(
                url: url,
                description: "MCP health check"
            ) {
                try await session.data(from: url)
            }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            isConnected = ok
            return ok
        } catch let urlError as URLError {
            lastError = MCPError.networkError(urlError).localizedDescription
            isConnected = false
            return false
        } catch let retryError as RetryError {
            lastError = MCPError.networkError(retryError).localizedDescription
            isConnected = false
            return false
        } catch {
            lastError = error.localizedDescription
            isConnected = false
            return false
        }
    }

    // MARK: - Generic Tool Call

    func callTool(name: String, arguments: [String: Any]) async throws -> MCPResponse {
        let url = serverURL.appendingPathComponent("mcp")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let requestId = Int.random(in: 1...999999)
        let body: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": [
                "name": name,
                "arguments": arguments
            ],
            "id": requestId
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 120
        let networkRequest = request

        do {
            let session = self.session
            let decoded = try await retrier.execute(
                url: url,
                description: "MCP tools/call \(name)"
            ) {
                let (data, response) = try await session.data(for: networkRequest)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw MCPError.invalidResponse
                }
                guard httpResponse.statusCode == 200 else {
                    let bodySample = String(data: data, encoding: .utf8)
                    throw MCPError.serverError(statusCode: httpResponse.statusCode, body: bodySample)
                }
                return try JSONDecoder().decode(MCPResponse.self, from: data)
            }
            guard decoded.id == requestId else {
                throw MCPError.invalidResponse
            }
            if let error = decoded.error {
                throw MCPError.toolError("MCP error \(error.code): \(error.message)")
            }
            if let result = decoded.result, result.isError == true {
                throw MCPError.toolError("Tool returned an error")
            }
            return decoded
        } catch let urlError as URLError {
            let mapped = MCPError.networkError(urlError)
            lastError = mapped.localizedDescription
            throw mapped
        } catch let retryError as RetryError {
            let mapped = MCPError.networkError(retryError)
            lastError = mapped.localizedDescription
            throw mapped
        } catch {
            lastError = error.localizedDescription
            throw error
        }
    }

    // MARK: - Filesystem Tools

    func readFile(path: String, limit: Int? = nil, offset: Int? = nil) async throws -> String {
        var args: [String: Any] = ["path": path]
        if let limit = limit { args["limit"] = limit }
        if let offset = offset { args["offset"] = offset }
        let response = try await callTool(name: "fs_read", arguments: args)
        return response.textContent ?? ""
    }

    func writeFile(path: String, content: String) async throws {
        let args: [String: Any] = ["path": path, "content": content]
        _ = try await callTool(name: "fs_write", arguments: args)
    }

    func listDirectory(path: String) async throws -> String {
        let response = try await callTool(name: "fs_list", arguments: ["path": path])
        return response.textContent ?? ""
    }

    // MARK: - Shell (working tool: filesystem_bash)

    func shell(command: String, description: String = "trios shell") async throws -> String {
        let args: [String: Any] = [
            "command": command,
            "description": description
        ]
        let response = try await callTool(name: "filesystem_bash", arguments: args)
        guard let text = response.textContent else {
            throw MCPError.toolError("Shell command returned no output")
        }
        if let error = response.error {
            throw MCPError.toolError("Shell command failed: \(error.message)")
        }
        return text
    }

    // MARK: - Browser Tools

    func navigate(to urlString: String, pageId: Int? = nil) async throws {
        var args: [String: Any] = ["url": urlString]
        if let pageId = pageId { args["page"] = pageId }
        _ = try await callTool(name: "navigate_page", arguments: args)
        browserState.currentURL = urlString
    }

    func click(element: String, pageId: Int? = nil) async throws {
        var args: [String: Any] = ["element": element]
        if let pageId = pageId { args["page"] = pageId }
        _ = try await callTool(name: "click", arguments: args)
    }

    func type(text: String, into element: String, pageId: Int? = nil) async throws {
        var args: [String: Any] = [
            "element": element,
            "text": text
        ]
        if let pageId = pageId { args["page"] = pageId }
        _ = try await callTool(name: "type_at", arguments: args)
    }

    func takeScreenshot(pageId: Int? = nil) async throws -> Data {
        var args: [String: Any] = [:]
        if let pageId = pageId { args["page"] = pageId }
        let response = try await callTool(name: "take_screenshot", arguments: args)
        // Screenshot returns base64 or URL; parse accordingly
        guard let text = response.textContent else {
            throw MCPError.invalidResponse
        }
        // If base64 encoded image data
        if let data = Data(base64Encoded: text) {
            return data
        }
        throw MCPError.invalidResponse
    }

    func getPageContent(pageId: Int? = nil) async throws -> String {
        var args: [String: Any] = [:]
        if let pageId = pageId { args["page"] = pageId }
        let response = try await callTool(name: "get_page_content", arguments: args)
        return response.textContent ?? ""
    }

    func scroll(direction: String, amount: Int = 3, pageId: Int? = nil) async throws {
        var args: [String: Any] = [
            "direction": direction,
            "amount": amount
        ]
        if let pageId = pageId { args["page"] = pageId }
        _ = try await callTool(name: "scroll", arguments: args)
    }

    func listPages() async throws -> String {
        let response = try await callTool(name: "list_pages", arguments: [:])
        return response.textContent ?? ""
    }

    // MARK: - Cleanup

    func disconnect() {
        session.invalidateAndCancel()
    }
}

// MARK: - Models

struct BrowserState {
    var currentURL: String?
    var pageTitle: String?
    var isLoading = false
    var tabs: [BrowserTab] = []
}

struct BrowserTab: Identifiable {
    let id = UUID()
    let url: String
    let title: String
    let favicon: Data?
}

struct MCPResponse: Codable {
    let jsonrpc: String
    let result: MCPResult?
    let error: MCPErrorDetail?
    let id: Int

    var textContent: String? {
        result?.content.first?.text
    }

    var isError: Bool {
        error != nil || (result?.isError ?? false)
    }
}

struct MCPResult: Codable {
    let content: [MCPContent]
    let isError: Bool?
}

struct MCPContent: Codable {
    let type: String
    let text: String?
}

struct MCPErrorDetail: Codable {
    let code: Int
    let message: String
}

enum MCPError: Error, LocalizedError {
    case invalidURL
    case serverError(statusCode: Int, body: String?)
    case noData
    case invalidResponse
    case toolNotFound
    case toolError(String)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL"
        case .serverError(let statusCode, let body):
            var parts = ["MCP HTTP request failed with status \(statusCode)"]
            if let body = body, !body.isEmpty {
                parts.append("response: \(body)")
            }
            return parts.joined(separator: ". ")
        case .noData: return "No data received"
        case .invalidResponse: return "Invalid server response"
        case .toolNotFound: return "MCP tool not found"
        case .toolError(let message): return message
        case .networkError(let error):
            return "MCP network error: \(error.localizedDescription)"
        }
    }
}
