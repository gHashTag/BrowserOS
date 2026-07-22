// T27-CANON: ChatLogic.swift
// Domain: Language
// Agent: L / t27-creator
// Task: CHATLOGIC-001
// Claim: claim-CHATLOGIC-001
// Issue: #T27-EPIC-001
// Spec: trios/.trinity/specs/chat-logic.md
// Status: canon
//
// This file is a T27 canon artifact. Any change must follow the spec change flow:
//   1. Spec update (chat-logic.md)
//   2. t27-creator implementation
//   3. t27-verifier L1-L7 verdict
//   4. /t27-tri-pipeline seal
//   5. Land with `Closes #T27-EPIC-001`
//   6. /t27-experience-save
//
// Invariants enforced:
//   INV-1 No Raw Shell Fallthrough
//   INV-2 Strict Command Recognition
//   INV-3 Recursive Self-Launch Block
//   INV-4 Page ID Threading
//   INV-5 URL Extraction
//   INV-6 First Page ID Parsing

import Foundation

/// Pure, framework-free chat parsing helpers for routing user chat input to
/// BrowserOS MCP tools. Foundation only (no SwiftUI/Combine). Unit tests live
/// in tests/swift/chat_logic_test.swift.
enum ChatLogic {

    /// Extract the first page id from a `list_pages` text listing. Each page
    /// entry starts with `"<id>. "`; returns the id of the first such entry.
    /// (The MCP `list_pages` tool returns human-readable text, not JSON.)
    static func firstPageId(in text: String) -> Int? {
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let dotIndex = trimmed.firstIndex(of: ".") else { continue }
            if let id = Int(trimmed[..<dotIndex]) {
                return id
            }
        }
        return nil
    }

    /// Prefixes (each ending in a space) that mark an explicit command. The
    /// trailing space prevents matching innocent words like "running".
    static let explicitPrefixes = [
        "shell ", "run ", "exec ", "navigate ", "click ", "screenshot ", "extract ",
        "open ", "go to ", "browse ", "cat ", "ls ", "cd ", "mkdir ", "rm ",
        "git ", "curl ", "wget ", "npm ", "bun ", "node ", "python ", "swift ",
    ]

    /// Single-word commands that must match exactly (not as a substring).
    static let exactCommands = ["click", "screenshot", "extract", "pwd"]

    /// Whether `text` should be routed to command execution rather than the LLM.
    /// Strict matching only: explicit prefix, exact single-word, or a slash path.
    static func isLikelyCommand(_ text: String) -> Bool {
        let lower = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let isPrefixMatch = explicitPrefixes.contains { lower.hasPrefix($0) }
        let isExactMatch = exactCommands.contains { lower == $0 }
        let isSlashCommand = lower.hasPrefix("/") || lower.hasPrefix("./")
        return isPrefixMatch || isExactMatch || isSlashCommand
    }

    /// Patterns that would recursively launch trios - blocked from shell exec.
    /// Uses regex matching; literal dots must be escaped.
    static let recursiveLaunchPatterns = [
        "trios_app",
        "open trios\\b",      // "open trios" as a word
        "open trios\\.app",  // "open trios.app"
        "swiftc.*trios",
        "launchd.*trios",
        "clade-promote.*boot",
    ]

    /// Map a command string to an MCP tool name + arguments, or nil if no intent
    /// is recognized (the caller must NOT fall through to raw shell execution).
    /// Shell commands matching a recursive-launch pattern are rewritten to a safe
    /// echo instead of executing.
    static func parseIntent(_ text: String, pageId: Int?) -> (String, [String: Any])? {
        let lower = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)

        if lower.hasPrefix("navigate ") || lower.hasPrefix("go to ") || lower.hasPrefix("open ") || lower.hasPrefix("browse ") {
            let url = extractURL(from: text) ?? "https://google.com"
            var args: [String: Any] = ["url": url]
            if let pageId = pageId { args["page"] = pageId }
            return ("navigate_page", args)
        }

        if lower == "click" || lower.hasPrefix("click ") || lower == "press" || lower.hasPrefix("press ") {
            var args: [String: Any] = ["element": "1"]
            if let pageId = pageId { args["page"] = pageId }
            return ("click", args)
        }

        if lower == "screenshot" || lower.hasPrefix("screenshot ") || lower == "capture" || lower.hasPrefix("capture ") {
            var args: [String: Any] = [:]
            if let pageId = pageId { args["page"] = pageId }
            return ("take_screenshot", args)
        }

        if lower == "extract" || lower.hasPrefix("extract ") || lower.hasPrefix("get data ") || lower.hasPrefix("content ") {
            var args: [String: Any] = [:]
            if let pageId = pageId { args["page"] = pageId }
            return ("get_page_content", args)
        }

        if lower.hasPrefix("shell ") || lower.hasPrefix("run ") || lower.hasPrefix("exec ") {
            let prefixLen = lower.hasPrefix("shell ") ? 6 : (lower.hasPrefix("run ") ? 4 : 5)
            let cmd = String(text.dropFirst(prefixLen)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cmd.isEmpty else { return nil }

            // SAFETY: Block commands that would recursively launch trios.
            let lowerCmd = cmd.lowercased()
            for pattern in recursiveLaunchPatterns {
                if lowerCmd.range(of: pattern, options: .regularExpression) != nil {
                    return ("filesystem_bash", ["command": "echo 'Blocked: command may cause recursive self-launch: \(cmd)'", "description": "Blocked self-launch"])
                }
            }
            return ("filesystem_bash", ["command": cmd, "description": "User shell command"])
        }

        // No recognized intent - do NOT fall through to shell execution.
        return nil
    }

    /// Extract the first http(s) URL from free text, or nil if none is present.
    static func extractURL(from text: String) -> String? {
        let pattern = #"(https?://[^\s]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        if let match = regex.firstMatch(in: text, range: range),
           let matchRange = Range(match.range, in: text) {
            return String(text[matchRange])
        }
        return nil
    }
}
