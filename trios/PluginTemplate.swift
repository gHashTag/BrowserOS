//
//  PluginTemplate.swift
//  TriOS Hotkey System — Plugin Template
//
//  Copy this file to start building your own plugin.
//  See README.md for integration instructions.
//

import Foundation
import AppKit

// MARK: - Plugin Protocol

/// Define your plugin's public interface
public protocol TriOSPluginProtocol {
    /// Plugin name (displayed in UI)
    static var name: String { get }
    
    /// Plugin version (semver)
    static var version: String { get }
    
    /// Initialize plugin
    init()
    
    /// Execute an action
    /// - Parameters:
    ///   - action: Action name (e.g., "open_github", "copy_link")
    ///   - params: Action parameters
    /// - Returns: Result of execution
    /// - Throws: TriOSPluginError if action fails
    func execute(action: String, params: [String: Any]) async throws -> Any
}

// MARK: - Plugin Errors

public enum TriOSPluginError: Error, LocalizedError {
    case unknownAction(String)
    case missingParameter(String)
    case invalidParameter(String, expectedType: String)
    case externalAPIError(String)
    case permissionDenied(String)
    
    public var errorDescription: String? {
        switch self {
        case .unknownAction(let action):
            return "Unknown action: \(action)"
        case .missingParameter(let param):
            return "Missing required parameter: \(param)"
        case .invalidParameter(let param, let type):
            return "Invalid parameter '\(param)': expected \(type)"
        case .externalAPIError(let message):
            return "External API error: \(message)"
        case .permissionDenied(let resource):
            return "Permission denied: \(resource)"
        }
    }
}

// MARK: - Example Plugin Implementation

/// Example plugin: GitHub integration
@TriOSPlugin
public class GitHubPlugin: TriOSPluginProtocol {
    public static var name: String = "GitHub"
    public static var version: String = "1.0.0"
    
    private let apiBaseURL = "https://api.github.com"
    
    public init() {}
    
    public func execute(action: String, params: [String: Any]) async throws -> Any {
        switch action {
        case "open_repo":
            guard let owner = params["owner"] as? String,
                  let repo = params["repo"] as? String else {
                throw TriOSPluginError.missingParameter("owner or repo")
            }
            let url = "https://github.com/\(owner)/\(repo)"
            if let nsURL = URL(string: url) {
                NSWorkspace.shared.open(nsURL)
                return ["success": true, "url": url]
            }
            throw TriOSPluginError.externalAPIError("Invalid URL")
            
        case "find_latest_pr":
            guard let owner = params["owner"] as? String,
                  let repo = params["repo"] as? String else {
                throw TriOSPluginError.missingParameter("owner or repo")
            }
            // Simulate API call (replace with real implementation)
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5s delay
            return [
                "pr_number": 42,
                "title": "Fix critical bug",
                "url": "https://github.com/\(owner)/\(repo)/pull/42"
            ]
            
        case "copy_link":
            guard let url = params["url"] as? String else {
                throw TriOSPluginError.missingParameter("url")
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
            return ["success": true, "copied": url]
            
        default:
            throw TriOSPluginError.unknownAction(action)
        }
    }
}

// MARK: - Plugin Registration

/// Register your plugin with TriOS
/// Call this in your plugin's entry point
public func registerPlugin(_ plugin: TriOSPluginProtocol.Type) {
    print("Registering plugin: \(plugin.name) v\(plugin.version)")
    // Integration with TriOS plugin manager happens here
}

// MARK: - Usage Example

/*
 // In your plugin initialization code:
 registerPlugin(GitHubPlugin.self)
 
 // User creates macro via natural language:
 // "Open BrowserOS repo, find latest PR, copy link"
 
 // TriOS parses and executes:
 let macro = [
     ("open_repo", ["owner": "gHashTag", "repo": "BrowserOS"]),
     ("find_latest_pr", ["owner": "gHashTag", "repo": "BrowserOS"]),
     ("copy_link", ["url": "$pr.url"])
 ]
 
 for (action, params) in macro {
     let result = try await GitHubPlugin().execute(action: action, params: params)
     print("Result: \(result)")
 }
 */

// MARK: - Best Practices

/*
 1. **Error Handling**: Always throw TriOSPluginError with clear messages
 2. **Async**: Use async/await for network calls
 3. **Validation**: Validate all parameters before execution
 4. **Logging**: Log actions for analytics (respect privacy)
 5. **Permissions**: Request permissions explicitly
 6. **Testing**: Write unit tests for all actions
 7. **Documentation**: Document all actions and parameters
 
 Example test:
 
 import XCTest
 
 final class GitHubPluginTests: XCTestCase {
     func testOpenRepo() async throws {
         let plugin = GitHubPlugin()
         let result = try await plugin.execute(
             action: "open_repo",
             params: ["owner": "gHashTag", "repo": "BrowserOS"]
         )
         let dict = result as? [String: Any]
         XCTAssertEqual(dict?["success"] as? Bool, true)
     }
 }
 */
