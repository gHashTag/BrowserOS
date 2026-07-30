import Foundation

/// Turns a tool call into a step title that names the actual target.
///
/// Generic titles ("Read files", "Run commands") describe a category, not the
/// work: a plan full of them tells the user nothing they could not have
/// guessed. Tool calls carry their arguments, so the title can name the file,
/// the command, or the host actually involved.
///
/// Pure and dependency-free so the extraction rules are unit-testable.
enum PlanStepNaming {
    /// Longest title we will render before truncating.
    static let maximumTitleLength = 52

    /// Argument keys that identify a target, in priority order.
    private static let pathKeys = ["path", "file", "filePath", "file_path", "filename"]
    private static let commandKeys = ["command", "cmd", "script"]
    private static let urlKeys = ["url", "href", "link"]
    private static let queryKeys = ["query", "q", "pattern", "search"]

    /// Builds a specific title, falling back to the generic one when the
    /// arguments carry nothing useful.
    static func title(toolName: String, argumentsJSON: String?, generic: String) -> String {
        guard let target = target(toolName: toolName, argumentsJSON: argumentsJSON) else {
            return generic
        }
        return truncate("\(verb(forTool: toolName)) \(target)")
    }

    /// Imperative verb matching the tool's category.
    static func verb(forTool rawName: String) -> String {
        switch rawName.lowercased() {
        case "filesystem_read", "read_file", "read":
            return "Read"
        case "filesystem_write", "write_file", "write", "edit":
            return "Edit"
        case "shell_execute", "bash", "run_command":
            return "Run"
        case "navigate", "browser_navigate":
            return "Open"
        case "screenshot", "browser_screenshot":
            return "Capture"
        case "search", "web_search", "grep":
            return "Search"
        default:
            return "Use"
        }
    }

    /// Extracts the most meaningful argument value.
    static func target(toolName: String, argumentsJSON: String?) -> String? {
        guard let argumentsJSON,
              let data = argumentsJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        if let path = firstString(in: object, keys: pathKeys) {
            return lastPathComponent(path)
        }
        if let command = firstString(in: object, keys: commandKeys) {
            return firstWords(command, limit: 4)
        }
        if let url = firstString(in: object, keys: urlKeys) {
            return host(from: url) ?? firstWords(url, limit: 1)
        }
        if let query = firstString(in: object, keys: queryKeys) {
            return "\"\(firstWords(query, limit: 5))\""
        }
        return nil
    }

    // MARK: - Helpers

    private static func firstString(in object: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = object[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    /// `/a/b/ChatPanelView.swift` -> `ChatPanelView.swift`. A bare name is
    /// returned unchanged; the full path is noise in a one-line title.
    static func lastPathComponent(_ path: String) -> String {
        let parts = path.split(separator: "/").filter { !$0.isEmpty }
        return parts.last.map(String.init) ?? path
    }

    /// `https://example.com/a/b?c=1` -> `example.com`.
    static func host(from urlString: String) -> String? {
        guard let components = URLComponents(string: urlString),
              let host = components.host,
              !host.isEmpty else {
            return nil
        }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// Keeps a command recognisable without pasting the whole line.
    static func firstWords(_ text: String, limit: Int) -> String {
        let words = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
        guard !words.isEmpty else { return text }
        let head = words.prefix(limit).joined(separator: " ")
        return words.count > limit ? head + "..." : head
    }

    static func truncate(_ title: String) -> String {
        guard title.count > maximumTitleLength else { return title }
        return String(title.prefix(maximumTitleLength - 1)) + "\u{2026}"
    }
}
