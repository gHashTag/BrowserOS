import SwiftUI
import Foundation

// MARK: - TRIOS Plugin Protocol

/// Core protocol that all TRIOS plugins must conform to
@objc public protocol TRIOSPlugin {
    /// Unique plugin identifier (reverse DNS notation)
    static var pluginID: String { get }
    
    /// Human-readable plugin name
    static var pluginName: String { get }
    
    /// Plugin version (SemVer)
    static var version: String { get }
    
    /// Plugin description
    static var description: String { get }
    
    /// Author information
    static var author: String { get }
    
    /// Minimum TRIOS version required
    static var minimumTRIOSVersion: String { get }
    
    /// Called when plugin is loaded
    func onLoad(context: PluginContext)
    
    /// Called when plugin is unloaded
    func onUnload()
    
    /// Called when user invokes a plugin command
    func execute(command: String, parameters: [String: Any], completion: @escaping (Result<Any, PluginError>) -> Void)
    
    /// Optional: Custom UI view for plugin settings
    func settingsView() -> AnyView?
}

// MARK: - PluginContext

/// Context provided to plugins for interacting with TRIOS
public class PluginContext {
    /// Access to TRIOS hotkey system
    public let hotkeyManager: HotkeyManagerProtocol
    
    /// Access to TRIOS macro system
    public let macroManager: MacroManagerProtocol
    
    /// Access to file system (sandboxed)
    public let fileManager: PluginFileManager
    
    /// Access to network (with user permission)
    public let networkManager: PluginNetworkManager
    
    /// Access to AI/LLM services
    public let aiManager: PluginAIManager
    
    /// Logging facility
    public let logger: PluginLogger
    
    /// User preferences storage
    public let preferences: PluginPreferences
    
    init() {
        self.hotkeyManager = HotkeyManagerProxy()
        self.macroManager = MacroManagerProxy()
        self.fileManager = PluginFileManager()
        self.networkManager = PluginNetworkManager()
        self.aiManager = PluginAIManager()
        self.logger = PluginLogger()
        self.preferences = PluginPreferences()
    }
}

// MARK: - Plugin Registration

public class PluginRegistry {
    public static let shared = PluginRegistry()
    
    private var plugins: [String: TRIOSPlugin] = [:]
    private var pluginConfigs: [String: PluginConfig] = [:]
    
    public struct PluginConfig {
        let enabled: Bool
        let autoLoad: Bool
        let permissions: [String]
        var settings: [String: Any]
    }
    
    /// Register a plugin
    public func register(_ plugin: TRIOSPlugin.Type) {
        let instance = plugin.init()
        plugins[plugin.pluginID] = instance
        
        pluginConfigs[plugin.pluginID] = PluginConfig(
            enabled: true,
            autoLoad: true,
            permissions: [],
            settings: [:]
        )
        
        NSLog("[PluginAPI] Registered: \(plugin.pluginName) v\(plugin.version)")
    }
    
    /// Load a plugin
    public func load(pluginID: String) {
        guard let plugin = plugins[pluginID],
              let config = pluginConfigs[pluginID],
              config.enabled else { return }
        
        let context = PluginContext()
        plugin.onLoad(context: context)
        
        NSLog("[PluginAPI] Loaded: \(pluginID)")
    }
    
    /// Unload a plugin
    public func unload(pluginID: String) {
        guard let plugin = plugins[pluginID] else { return }
        
        plugin.onUnload()
        
        NSLog("[PluginAPI] Unloaded: \(pluginID)")
    }
    
    /// Execute a plugin command
    public func execute(pluginID: String, command: String, parameters: [String: Any], completion: @escaping (Result<Any, PluginError>) -> Void) {
        guard let plugin = plugins[pluginID] else {
            completion(.failure(.pluginNotFound(pluginID)))
            return
        }
        
        plugin.execute(command: command, parameters: parameters, completion: completion)
    }
    
    /// Get all registered plugins
    public func getPlugins() -> [TRIOSPlugin] {
        return Array(plugins.values)
    }
}

// MARK: - Plugin Errors

public enum PluginError: Error, LocalizedError {
    case pluginNotFound(String)
    case commandNotFound(String)
    case invalidParameters(String)
    case permissionDenied(String)
    case executionFailed(String)
    case versionMismatch(String)
    
    public var errorDescription: String? {
        switch self {
        case .pluginNotFound(let id):
            return "Plugin not found: \(id)"
        case .commandNotFound(let cmd):
            return "Command not found: \(cmd)"
        case .invalidParameters(let msg):
            return "Invalid parameters: \(msg)"
        case .permissionDenied(let perm):
            return "Permission denied: \(perm)"
        case .executionFailed(let msg):
            return "Execution failed: \(msg)"
        case .versionMismatch(let msg):
            return "Version mismatch: \(msg)"
        }
    }
}

// MARK: - Plugin Managers (Protocols)

public protocol HotkeyManagerProtocol {
    func registerHotkey(key: String, modifiers: NSEvent.ModifierFlags, action: @escaping () -> Void) -> String
    func unregisterHotkey(id: String)
}

public protocol MacroManagerProtocol {
    func executeMacro(id: String, completion: @escaping (Result<Void, Error>) -> Void)
    func createMacro(name: String, steps: [String: Any]) -> String
}

// MARK: - Plugin Managers (Implementations)

class HotkeyManagerProxy: HotkeyManagerProtocol {
    func registerHotkey(key: String, modifiers: NSEvent.ModifierFlags, action: @escaping () -> Void) -> String {
        let hotkeyID = UUID().uuidString
        NSLog("[PluginAPI] Hotkey registered: \(key) (ID: \(hotkeyID))")
        return hotkeyID
    }
    
    func unregisterHotkey(id: String) {
        NSLog("[PluginAPI] Hotkey unregistered: \(id)")
    }
}

class MacroManagerProxy: MacroManagerProtocol {
    func executeMacro(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
        NSLog("[PluginAPI] Macro executed: \(id)")
        completion(.success(()))
    }
    
    func createMacro(name: String, steps: [String: Any]) -> String {
        let macroID = UUID().uuidString
        NSLog("[PluginAPI] Macro created: \(name) (ID: \(macroID))")
        return macroID
    }
}

class PluginFileManager {
    func read(file: String) -> Data? {
        NSLog("[PluginAPI] File read: \(file)")
        return nil
    }
    
    func write(file: String, data: Data) -> Bool {
        NSLog("[PluginAPI] File written: \(file)")
        return true
    }
    
    func exists(file: String) -> Bool {
        return false
    }
}

class PluginNetworkManager {
    func get(url: String, completion: @escaping (Result<Data, Error>) -> Void) {
        NSLog("[PluginAPI] Network GET: \(url)")
        // In production: actual network request
    }
    
    func post(url: String, body: Data, completion: @escaping (Result<Data, Error>) -> Void) {
        NSLog("[PluginAPI] Network POST: \(url)")
    }
}

class PluginAIManager {
    func infer(prompt: String, completion: @escaping (Result<String, Error>) -> Void) {
        NSLog("[PluginAPI] AI inference: \(prompt)")
        // In production: call local LLM or cloud API
        completion(.success("AI response"))
    }
}

class PluginLogger {
    func info(_ message: String) {
        NSLog("[Plugin:Info] \(message)")
    }
    
    func warning(_ message: String) {
        NSLog("[Plugin:Warning] \(message)")
    }
    
    func error(_ message: String) {
        NSLog("[Plugin:Error] \(message)")
    }
    
    func debug(_ message: String) {
        NSLog("[Plugin:Debug] \(message)")
    }
}

class PluginPreferences {
    func get<T>(key: String, default: T) -> T {
        return `default`
    }
    
    func set<T>(key: String, value: T) {
        NSLog("[PluginAPI] Preference set: \(key)")
    }
}

// MARK: - Example Plugin: GitHub Integration

@objc class GitHubPlugin: NSObject, TRIOSPlugin {
    static var pluginID: String = "com.trios.plugins.github"
    static var pluginName: String = "GitHub Integration"
    static var version: String = "1.0.0"
    static var description: String = "GitHub API integration for PRs, issues, and actions"
    static var author: String = "TRIOS Community"
    static var minimumTRIOSVersion: String = "4.0.0"
    
    private var context: PluginContext?
    
    func onLoad(context: PluginContext) {
        self.context = context
        context.logger.info("GitHub Plugin loaded")
        
        // Register hotkeys
        context.hotkeyManager.registerHotkey(
            key: "G",
            modifiers: [.command, .shift],
            action: { [weak self] in
                self?.openGitHub()
            }
        )
    }
    
    func onUnload() {
        context?.logger.info("GitHub Plugin unloaded")
    }
    
    func execute(command: String, parameters: [String: Any], completion: @escaping (Result<Any, PluginError>) -> Void) {
        switch command {
        case "getPR":
            getPullRequest(number: parameters["number"] as? Int ?? 0, completion: completion)
        case "createIssue":
            createIssue(title: parameters["title"] as? String ?? "", completion: completion)
        default:
            completion(.failure(.commandNotFound(command)))
        }
    }
    
    func settingsView() -> AnyView? {
        return AnyView(GitHubPluginSettingsView())
    }
    
    private func openGitHub() {
        if let url = URL(string: "https://github.com") {
            NSWorkspace.shared.open(url)
        }
    }
    
    private func getPullRequest(number: Int, completion: @escaping (Result<Any, PluginError>) -> Void) {
        // In production: call GitHub API
        completion(.success(["number": number, "title": "Example PR", "state": "open"]))
    }
    
    private func createIssue(title: String, completion: @escaping (Result<Any, PluginError>) -> Void) {
        // In production: call GitHub API
        completion(.success(["id": 123, "title": title, "number": 456]))
    }
}

// MARK: - Example Plugin: Slack Integration

@objc class SlackPlugin: NSObject, TRIOSPlugin {
    static var pluginID: String = "com.trios.plugins.slack"
    static var pluginName: String = "Slack Integration"
    static var version: String = "1.0.0"
    static var description: String = "Slack API integration for messaging and notifications"
    static var author: String = "TRIOS Community"
    static var minimumTRIOSVersion: String = "4.0.0"
    
    private var context: PluginContext?
    
    func onLoad(context: PluginContext) {
        self.context = context
        context.logger.info("Slack Plugin loaded")
    }
    
    func onUnload() {
        context?.logger.info("Slack Plugin unloaded")
    }
    
    func execute(command: String, parameters: [String: Any], completion: @escaping (Result<Any, PluginError>) -> Void) {
        switch command {
        case "sendMessage":
            sendMessage(channel: parameters["channel"] as? String ?? "", text: parameters["text"] as? String ?? "", completion: completion)
        case "getChannels":
            getChannels(completion: completion)
        default:
            completion(.failure(.commandNotFound(command)))
        }
    }
    
    func settingsView() -> AnyView? {
        return AnyView(SlackPluginSettingsView())
    }
    
    private func sendMessage(channel: String, text: String, completion: @escaping (Result<Any, PluginError>) -> Void) {
        // In production: call Slack API
        completion(.success(["ok": true, "ts": "1234567890.123456"]))
    }
    
    private func getChannels(completion: @escaping (Result<Any, PluginError>) -> Void) {
        // In production: call Slack API
        completion(.success([["id": "C123", "name": "general"], ["id": "C456", "name": "random"]]))
    }
}

// MARK: - Plugin Settings Views

struct GitHubPluginSettingsView: View {
    @State private var apiToken = ""
    @State private var defaultRepo = ""
    
    var body: some View {
        Form {
            TextField("GitHub API Token", text: $apiToken)
                .secureTextEntry()
            
            TextField("Default Repository", text: $defaultRepo)
            
            Text("Example: gHashTag/BrowserOS-full")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
        }
        .padding(20)
        .frame(width: 400, height: 200)
    }
}

struct SlackPluginSettingsView: View {
    @State private var apiToken = ""
    @State private var defaultChannel = ""
    
    var body: some View {
        Form {
            TextField("Slack Bot Token", text: $apiToken)
                .secureTextEntry()
            
            TextField("Default Channel", text: $defaultChannel)
            
            Text("Example: C1234567890")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
        }
        .padding(20)
        .frame(width: 400, height: 200)
    }
}

// MARK: - Plugin Manager View

struct PluginManagerView: View {
    @StateObject private var registry = PluginRegistry.shared
    @State private var selectedPlugin: TRIOSPlugin?
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Plugin Manager")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.grokText)
                
                Spacer()
                
                Button("Install Plugin") {
                    // Open plugin installation dialog
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(20)
            
            Divider().overlay(Color.grokDivider)
            
            HStack(spacing: 0) {
                // Plugin list
                pluginList
                
                Divider().overlay(Color.grokDivider)
                
                // Plugin details
                if let plugin = selectedPlugin {
                    pluginDetails(plugin: plugin)
                } else {
                    Text("Select a plugin")
                        .foregroundColor(.grokDim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(width: 800, height: 600)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
    
    private var pluginList: some View {
        List(registry.getPlugins(), id: \.pluginID) { plugin in
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(type(of: plugin).pluginName)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.grokText)
                    
                    Text(type(of: plugin).version)
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                }
                
                Spacer()
                
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.green)
            }
            .onTapGesture {
                selectedPlugin = plugin
            }
        }
        .frame(width: 300)
    }
    
    private func pluginDetails(plugin: TRIOSPlugin) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(type(of: plugin).pluginName)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(.grokText)
                
                Text(type(of: plugin).description)
                    .font(.system(size: 13))
                    .foregroundColor(.grokDim)
                
                HStack(spacing: 20) {
                    DetailBadge(label: "Version", value: type(of: plugin).version)
                    DetailBadge(label: "Author", value: type(of: plugin).author)
                    DetailBadge(label: "ID", value: type(of: plugin).pluginID)
                }
                
                Divider().overlay(Color.grokDivider)
                
                Text("Settings")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.grokText)
                
                if let settingsView = plugin.settingsView() {
                    settingsView
                } else {
                    Text("No settings available")
                        .font(.system(size: 12))
                        .foregroundColor(.grokDim)
                }
            }
            .padding(20)
        }
    }
}

struct DetailBadge: View {
    let label: String
    let value: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
            Text(value)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.grokText)
        }
    }
}

// MARK: - Plugin Initialization

public class PluginInitializer {
    public static func loadAllPlugins() {
        let registry = PluginRegistry.shared
        
        // Register built-in plugins
        registry.register(GitHubPlugin.self)
        registry.register(SlackPlugin.self)
        
        // Load auto-load plugins
        for plugin in registry.getPlugins() {
            let pluginID = type(of: plugin).pluginID
            if let config = registry.pluginConfigs[pluginID], config.autoLoad {
                registry.load(pluginID: pluginID)
            }
        }
        
        NSLog("[PluginAPI] All plugins loaded: \(registry.getPlugins().count)")
    }
}

// MARK: - Preview

#Preview {
    PluginManagerView()
}
