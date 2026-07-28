import Foundation
import AppKit

// MARK: - Severity levels

enum LogLevel: Int, CaseIterable, Equatable, Sendable {
    case trace = 10
    case debug = 20
    case info = 30
    case warn = 40
    case error = 50
    case fatal = 60

    var label: String {
        switch self {
        case .trace: return "TRACE"
        case .debug: return "DEBUG"
        case .info: return "INFO"
        case .warn: return "WARN"
        case .error: return "ERROR"
        case .fatal: return "FATAL"
        }
    }
}

// MARK: - Parser kind

enum LogParserKind: String, CaseIterable, Equatable, Hashable, Sendable {
    case eventLog
    case pinoJSON
    case plainText
}

// MARK: - Source category

enum LogSourceCategory: String, CaseIterable, Equatable, Sendable {
    case runtime
    case service
    case build
    case test
    case artifact
}

// MARK: - Parsed log line

struct ParsedLogLine: Identifiable, Equatable, Sendable {
    let id = UUID().uuidString
    let rawLine: String
    let timestamp: String?
    let level: LogLevel
    let sourceID: String
    let message: String
    let event: String?
    let details: String?
    let metadata: [String: String]
    let duplicateCount: Int

    var isDuplicateGroup: Bool { duplicateCount > 1 }
}

// MARK: - Log source

struct LogSource: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let path: String
    let icon: String
    let tintName: String
    let category: LogSourceCategory
    let rawLines: [ParsedLogLine]
    let lines: [ParsedLogLine]
    let parser: LogParserKind
    let lastReadOffset: UInt64
    let errorCount: Int
    let warningCount: Int
    let duplicateGroupCount: Int
    let totalDuplicates: Int
    let wasCapped: Bool
    let originalLineCount: Int

    var displayName: String {
        (path as NSString).lastPathComponent
    }

    init(
        id: String,
        name: String,
        path: String,
        icon: String,
        tintName: String,
        category: LogSourceCategory = .runtime,
        rawLines: [ParsedLogLine],
        lines: [ParsedLogLine],
        parser: LogParserKind,
        lastReadOffset: UInt64,
        errorCount: Int,
        warningCount: Int,
        duplicateGroupCount: Int,
        totalDuplicates: Int,
        wasCapped: Bool,
        originalLineCount: Int
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.icon = icon
        self.tintName = tintName
        self.category = category
        self.rawLines = rawLines
        self.lines = lines
        self.parser = parser
        self.lastReadOffset = lastReadOffset
        self.errorCount = errorCount
        self.warningCount = warningCount
        self.duplicateGroupCount = duplicateGroupCount
        self.totalDuplicates = totalDuplicates
        self.wasCapped = wasCapped
        self.originalLineCount = originalLineCount
    }
}

// MARK: - Scroll policy

enum LogsTabScrollPolicy {
    static func shouldAutoScroll(isLive: Bool, isFollowPaused: Bool) -> Bool {
        isLive && !isFollowPaused
    }
}

// MARK: - Timeline mode

enum LogTimelineMode: String, CaseIterable, Equatable, Sendable {
    case sources
    case unified
}

// MARK: - Query tokens

enum LogQueryToken: Equatable, Sendable {
    case level(LogLevel)
    case source(String)
    case event(String)
    case text(String)
}

// MARK: - Saved search

struct LogSavedSearch: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let query: String
}

actor LogSavedSearchStore {
    private let path: String

    init(path: String = "\(ProjectPaths.trinity)/state/logs_saved_searches.json") {
        self.path = path
    }

    func load() -> [LogSavedSearch] {
        guard let data = FileManager.default.contents(atPath: path),
              let list = try? JSONDecoder().decode([LogSavedSearch].self, from: data),
              !list.isEmpty else {
            return LogSavedSearchStore.defaultSavedSearches()
        }
        return list
    }

    func save(_ searches: [LogSavedSearch]) {
        guard let data = try? JSONEncoder().encode(searches) else { return }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url)
    }

    static func defaultSavedSearches() -> [LogSavedSearch] {
        [
            LogSavedSearch(id: "errors-only", label: "Errors only", query: "level:error"),
            LogSavedSearch(id: "cron-warn", label: "Cron warnings", query: "source:cron level:warn"),
            LogSavedSearch(id: "companion-errors", label: "Companion errors", query: "source:companion level:error"),
            LogSavedSearch(id: "drift-events", label: "Drift events", query: "event:drift")
        ]
    }
}

// MARK: - Noise rule

struct LogNoiseRule: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var label: String
    var event: String?
    var message: String?
    var raw: String?
    var sourceIDs: [String]?
    var enabled: Bool

    init(
        id: String = UUID().uuidString,
        label: String,
        event: String? = nil,
        message: String? = nil,
        raw: String? = nil,
        sourceIDs: [String]? = nil,
        enabled: Bool = true
    ) {
        self.id = id
        self.label = label
        self.event = event
        self.message = message
        self.raw = raw
        self.sourceIDs = sourceIDs
        self.enabled = enabled
    }

    /// True if at least one matcher field is non-empty.
    var isValid: Bool {
        !(event?.isEmpty ?? true) || !(message?.isEmpty ?? true) || !(raw?.isEmpty ?? true)
    }

    /// True if this rule applies to the given source.
    /// nil or empty sourceIDs means the rule is global.
    func applies(toSourceID sourceID: String) -> Bool {
        guard let ids = sourceIDs, !ids.isEmpty else { return true }
        return ids.contains(sourceID)
    }
}

// MARK: - Noise profile

struct LogNoiseProfile: Codable, Equatable, Sendable {
    var customRules: [LogNoiseRule]

    init(customRules: [LogNoiseRule] = []) {
        self.customRules = customRules
    }

    static let defaultRules: [LogNoiseRule] = [
        LogNoiseRule(id: "builtin-watchdog", label: "watchdog heartbeat", event: "watchdog_heartbeat", enabled: true),
        LogNoiseRule(id: "builtin-drift", label: "drift detected", event: "drift_detected", enabled: true),
        LogNoiseRule(id: "builtin-awareness", label: "awareness updated", event: "awareness_updated", enabled: true),
        LogNoiseRule(id: "builtin-leases", label: "stale task leases", message: "Reclaiming stale task leases", enabled: true),
        LogNoiseRule(id: "builtin-tools", label: "registered tools", message: "Registered 73 tools", enabled: true),
        LogNoiseRule(id: "builtin-list-pages", label: "list_pages request", message: "list_pages request", enabled: true),
        LogNoiseRule(id: "builtin-empty", label: "empty message", message: "", enabled: true),
        LogNoiseRule(id: "builtin-enoent", label: "ENOENT reading", raw: "ENOENT reading", enabled: true),
        LogNoiseRule(id: "builtin-bun", label: "Bun startup banner", raw: "Bun v", enabled: true)
    ]

    var allRules: [LogNoiseRule] {
        LogNoiseProfile.defaultRules + customRules
    }
}

// MARK: - Portable noise profile envelope

struct LogNoiseProfileEnvelope: Codable, Equatable, Sendable {
    var schemaVersion: Int
    var exportedAt: Date?
    var rules: [LogNoiseRule]
}

struct LogNoiseImportResult: Equatable, Sendable {
    var imported: [LogNoiseRule]
    var skippedInvalid: Int
    var skippedUnsupportedSchema: Bool
}

actor LogNoiseProfileStore {
    private let path: String

    init(path: String = "\(ProjectPaths.trinity)/state/logs_noise_profile.json") {
        self.path = path
    }

    func load() -> LogNoiseProfile {
        guard let data = FileManager.default.contents(atPath: path),
              let profile = try? JSONDecoder().decode(LogNoiseProfile.self, from: data) else {
            return LogNoiseProfile()
        }
        return profile
    }

    func save(_ profile: LogNoiseProfile) {
        guard let data = try? JSONEncoder().encode(profile) else { return }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url)
    }

    func addRule(_ rule: LogNoiseRule) {
        var profile = load()
        profile.customRules.removeAll { $0.id == rule.id }
        profile.customRules.insert(rule, at: 0)
        save(profile)
    }

    func updateRules(_ rules: [LogNoiseRule]) {
        var profile = load()
        profile.customRules = rules
        save(profile)
    }
    func exportRules(
        _ rules: [LogNoiseRule],
        to directory: String = NSHomeDirectory() + "/Downloads"
    ) -> URL? {
        let envelope = LogNoiseProfileEnvelope(
            schemaVersion: 1,
            exportedAt: Date(),
            rules: rules
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(envelope) else { return nil }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        let timestamp = formatter.string(from: Date())
        let filename = "trios-noise-profile-\(timestamp).json"

        let dirURL = URL(fileURLWithPath: directory)
        let fileURL = dirURL.appendingPathComponent(filename)
        try? FileManager.default.createDirectory(
            at: dirURL,
            withIntermediateDirectories: true
        )
        do {
            try data.write(to: fileURL)
            return fileURL
        } catch {
            return nil
        }
    }

    func importRules(from url: URL) -> LogNoiseImportResult {
        guard let data = FileManager.default.contents(atPath: url.path) else {
            return LogNoiseImportResult(imported: [], skippedInvalid: 0, skippedUnsupportedSchema: false)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let envelope = try? decoder.decode(LogNoiseProfileEnvelope.self, from: data) else {
            return LogNoiseImportResult(imported: [], skippedInvalid: 0, skippedUnsupportedSchema: false)
        }
        if envelope.schemaVersion > 1 {
            return LogNoiseImportResult(imported: [], skippedInvalid: 0, skippedUnsupportedSchema: true)
        }
        var imported: [LogNoiseRule] = []
        var skippedInvalid = 0
        for rule in envelope.rules {
            if rule.isValid {
                imported.append(rule)
            } else {
                skippedInvalid += 1
            }
        }
        return LogNoiseImportResult(
            imported: imported,
            skippedInvalid: skippedInvalid,
            skippedUnsupportedSchema: false
        )
    }

}

// MARK: - Noise filter

struct LogNoiseFilter: Sendable {
    static let shared = LogNoiseFilter(profile: LogNoiseProfile())

    let profile: LogNoiseProfile

    init(profile: LogNoiseProfile) {
        self.profile = profile
    }

    func isNoise(_ line: ParsedLogLine) -> Bool {
        for rule in profile.allRules where rule.enabled {
            if matches(rule, line) { return true }
        }
        return false
    }

    private func matches(_ rule: LogNoiseRule, _ line: ParsedLogLine) -> Bool {
        guard rule.applies(toSourceID: line.sourceID) else { return false }
        if let event = rule.event, !event.isEmpty,
           let lineEvent = line.event,
           lineEvent.lowercased().contains(event.lowercased()) {
            return true
        }
        if let message = rule.message {
            let lineMessage = line.message.trimmingCharacters(in: .whitespaces)
            if message.isEmpty {
                if lineMessage.isEmpty { return true }
            } else if lineMessage.lowercased().contains(message.lowercased()) {
                return true
            }
        }
        if let raw = rule.raw, !raw.isEmpty,
           line.rawLine.contains(raw) {
            return true
        }
        return false
    }
}

// MARK: - Noise pattern proposer

enum LogNoisePatternProposer {
    /// Derive a single noise rule from a parsed log line.
    /// Prefers structured fields (event > message snippet > raw substring) and
    /// avoids overly broad patterns (short tokens, pure numbers, common words).
    /// When sourceID is provided the rule is scoped to that source.
    static func propose(
        from line: ParsedLogLine,
        sourceID: String? = nil,
        label: String? = nil
    ) -> LogNoiseRule? {
        // 1. Event is the most specific structured matcher.
        if let event = line.event, !event.isEmpty, !isTooBroad(event) {
            return LogNoiseRule(
                label: label ?? "event: \(event)",
                event: event,
                message: nil,
                raw: nil,
                sourceIDs: sourceID.map { [$0] },
                enabled: true
            )
        }

        // 2. Message: use a meaningful phrase rather than the whole line.
        let message = line.message.trimmingCharacters(in: .whitespaces)
        if !message.isEmpty {
            if let phrase = longestSignificantPhrase(message), !isTooBroad(phrase) {
                return LogNoiseRule(
                    label: label ?? "message: \(phrase)",
                    event: nil,
                    message: phrase,
                    raw: nil,
                    sourceIDs: sourceID.map { [$0] },
                    enabled: true
                )
            }
        }

        // 3. Raw substring: fall back to a distinctive token from the raw line.
        if !line.rawLine.isEmpty {
            if let phrase = longestSignificantPhrase(line.rawLine), !isTooBroad(phrase) {
                return LogNoiseRule(
                    label: label ?? "raw: \(phrase)",
                    event: nil,
                    message: nil,
                    raw: phrase,
                    sourceIDs: sourceID.map { [$0] },
                    enabled: true
                )
            }
        }

        return nil
    }

    /// Returns the longest phrase of at least two significant words,
    /// after stripping punctuation and ignoring overly short/common words.
    private static func longestSignificantPhrase(_ text: String) -> String? {
        let cleaned = text
            .replacingOccurrences(of: "[^a-zA-Z0-9:/_.-]", with: " ", options: .regularExpression)
            .lowercased()
        let words = cleaned
            .split(separator: " ")
            .map { String($0) }
            .filter { $0.count >= 3 && !commonWords.contains($0) }

        guard words.count >= 2 else { return words.first }

        // Prefer a consecutive 2-4 word window near the start of the message.
        let windowSize = min(words.count, 4)
        let candidates = (2...windowSize).flatMap { size in
            stride(from: 0, through: words.count - size, by: 1).map { start in
                Array(words[start..<(start + size)]).joined(separator: " ")
            }
        }
        return candidates.max { $0.count < $1.count }
    }

    private static func isTooBroad(_ phrase: String) -> Bool {
        let trimmed = phrase.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        if trimmed.count < 3 { return true }
        // Pure numbers or single punctuation-delimited tokens are too broad.
        let tokens = trimmed.split(separator: " ")
        if tokens.count == 1, Int(trimmed) != nil { return true }
        // High-frequency noise words alone are too broad.
        if tokens.count == 1 && commonBroadWords.contains(String(tokens[0])) { return true }
        return false
    }

    private static let commonWords: Set<String> = [
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
        "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
        "how", "its", "may", "new", "now", "old", "see", "two", "way", "who",
        "boy", "did", "she", "use", "her", "man", "men", "run", "sun", "dog"
    ]

    private static let commonBroadWords: Set<String> = [
        "info", "debug", "trace", "warn", "error", "log", "message", "event",
        "request", "response", "ok", "true", "false", "done", "started", "finished"
    ]
}


// MARK: - Noise suggestion

struct LogNoiseSuggestion: Equatable, Identifiable, Sendable {
    let id: String
    let rule: LogNoiseRule
    let sourceID: String
    let matchedCount: Int
    let sampleLine: String
}

enum LogNoiseSuggester {
    /// Propose source-scoped noise rules from high-frequency patterns in the loaded logs.
    static func suggest(
        from sources: [LogSource],
        profile: LogNoiseProfile,
        minOccurrences: Int = 5,
        topN: Int = 10
    ) -> [LogNoiseSuggestion] {
        let allLines = sources.flatMap { $0.rawLines }
        var candidates: [LogNoiseSuggestion] = []

        // 1. Prefer structured event matchers.
        var eventCounts: [String: Int] = [:]
        var eventSample: [String: ParsedLogLine] = [:]
        for line in allLines {
            guard let event = line.event, !event.isEmpty else { continue }
            let key = "\(line.sourceID)|\(event)"
            eventCounts[key, default: 0] += 1
            if eventSample[key] == nil { eventSample[key] = line }
        }

        for (key, count) in eventCounts where count >= minOccurrences {
            guard let sample = eventSample[key] else { continue }
            let synthetic = ParsedLogLine(
                rawLine: sample.rawLine,
                timestamp: sample.timestamp,
                level: sample.level,
                sourceID: sample.sourceID,
                message: sample.message,
                event: sample.event,
                details: sample.details,
                metadata: sample.metadata,
                duplicateCount: 1
            )
            if LogNoiseFilter(profile: profile).isNoise(synthetic) { continue }

            let rule = LogNoiseRule(
                label: "event: \(sample.event!)",
                event: sample.event,
                message: nil,
                raw: nil,
                sourceIDs: [sample.sourceID],
                enabled: true
            )
            let scopedProfile = LogNoiseProfile(customRules: [rule])
            let matchedCount = allLines.filter { LogNoiseFilter(profile: scopedProfile).isNoise($0) }.count
            candidates.append(LogNoiseSuggestion(
                id: "\(sample.sourceID)-event-\(sample.event!)",
                rule: rule,
                sourceID: sample.sourceID,
                matchedCount: matchedCount,
                sampleLine: sample.rawLine
            ))
        }

        // 2. Fallback to message phrases when no event-bearing patterns qualify.
        if candidates.isEmpty {
            var phraseCounts: [String: Int] = [:]
            var phraseSample: [String: ParsedLogLine] = [:]
            for line in allLines where line.event == nil || line.event!.isEmpty {
                guard let phrase = longestSignificantPhrase(line.message), !isTooBroad(phrase) else { continue }
                let key = "\(line.sourceID)|\(phrase)"
                phraseCounts[key, default: 0] += 1
                if phraseSample[key] == nil { phraseSample[key] = line }
            }
            for (key, count) in phraseCounts where count >= minOccurrences {
                guard let sample = phraseSample[key] else { continue }
                let rule = LogNoiseRule(
                    label: "message: \(key.components(separatedBy: "|").last!)",
                    event: nil,
                    message: key.components(separatedBy: "|").last,
                    raw: nil,
                    sourceIDs: [sample.sourceID],
                    enabled: true
                )
                let scopedProfile = LogNoiseProfile(customRules: [rule])
                let matchedCount = allLines.filter { LogNoiseFilter(profile: scopedProfile).isNoise($0) }.count
                candidates.append(LogNoiseSuggestion(
                    id: "\(sample.sourceID)-message-\(rule.message!)",
                    rule: rule,
                    sourceID: sample.sourceID,
                    matchedCount: matchedCount,
                    sampleLine: sample.rawLine
                ))
            }
        }

        return candidates
            .sorted { $0.matchedCount > $1.matchedCount }
            .prefix(topN)
            .map { $0 }
    }

    /// Duplicated minimal phrase heuristic from LogNoisePatternProposer so the
    /// suggester can fall back to message patterns without exposing internals.
    private static func longestSignificantPhrase(_ text: String) -> String? {
        let cleaned = text
            .replacingOccurrences(of: "[^a-zA-Z0-9:/_.-]", with: " ", options: .regularExpression)
            .lowercased()
        let words = cleaned
            .split(separator: " ")
            .map { String($0) }
            .filter { $0.count >= 3 && !commonWords.contains($0) }

        guard words.count >= 2 else { return words.first }

        let windowSize = min(words.count, 4)
        let candidates = (2...windowSize).flatMap { size in
            stride(from: 0, through: words.count - size, by: 1).map { start in
                Array(words[start..<(start + size)]).joined(separator: " ")
            }
        }
        return candidates.max { $0.count < $1.count }
    }

    private static func isTooBroad(_ phrase: String) -> Bool {
        let trimmed = phrase.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        if trimmed.count < 3 { return true }
        let tokens = trimmed.split(separator: " ")
        if tokens.count == 1, Int(trimmed) != nil { return true }
        if tokens.count == 1 && commonBroadWords.contains(String(tokens[0])) { return true }
        return false
    }

    private static let commonWords: Set<String> = [
        "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
        "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
        "how", "its", "may", "new", "now", "old", "see", "two", "way", "who",
        "boy", "did", "she", "use", "her", "man", "men", "run", "sun", "dog"
    ]

    private static let commonBroadWords: Set<String> = [
        "info", "debug", "trace", "warn", "error", "log", "message", "event",
        "request", "response", "ok", "true", "false", "done", "started", "finished"
    ]
}

// MARK: - Rotation policy

struct LogRotationPolicy: Sendable {
    let maxFileSizeBytes: UInt64
    let maxArchiveCount: Int
    let keepTailLines: Int
    let maxArchiveAgeSeconds: TimeInterval?
    let maxAgeBeforeRotationSeconds: TimeInterval?

    static let `default` = LogRotationPolicy(
        maxFileSizeBytes: 1_048_576, // 1 MB
        maxArchiveCount: 5,
        keepTailLines: 500,
        maxArchiveAgeSeconds: nil,
        maxAgeBeforeRotationSeconds: nil
    )

    static let audit = LogRotationPolicy(
        maxFileSizeBytes: 1_048_576,
        maxArchiveCount: 5,
        keepTailLines: 500,
        maxArchiveAgeSeconds: 30 * 24 * 60 * 60,
        maxAgeBeforeRotationSeconds: 24 * 60 * 60
    )

    static let security = LogRotationPolicy(
        maxFileSizeBytes: 1_048_576,
        maxArchiveCount: 10,
        keepTailLines: 500,
        maxArchiveAgeSeconds: 365 * 24 * 60 * 60,
        maxAgeBeforeRotationSeconds: 24 * 60 * 60
    )

    static let experience = LogRotationPolicy(
        maxFileSizeBytes: 5_242_880,
        maxArchiveCount: 5,
        keepTailLines: 500,
        maxArchiveAgeSeconds: 90 * 24 * 60 * 60,
        maxAgeBeforeRotationSeconds: 7 * 24 * 60 * 60
    )

    func rotateIfNeeded(path: String) {
        guard FileManager.default.fileExists(atPath: path) else { return }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attrs[.size] as? UInt64,
              let mtime = attrs[.modificationDate] as? Date else { return }
        let now = Date().timeIntervalSince1970
        let age = now - mtime.timeIntervalSince1970
        let shouldRotate = size > maxFileSizeBytes ||
            (maxAgeBeforeRotationSeconds != nil && age > maxAgeBeforeRotationSeconds!)
        // Do not truncate files another process is currently writing; copy-truncate
        // without a reopen handshake can leave holes or lost records.
        guard !hasExternalWriters(path: path) else { return }

        if shouldRotate {
            archive(path: path)
            truncate(path: path, keepingLast: keepTailLines)
            cleanupArchives(of: path)
        }
        cleanupOldArchives(path: path)
    }

    private func hasExternalWriters(path: String) -> Bool {
        let env = "/usr/bin/env"
        guard FileManager.default.fileExists(atPath: env) else { return false }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: env)
        task.arguments = ["lsof", path]
        let pipe = Pipe()
        task.standardOutput = pipe
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return true
        }
        guard task.terminationStatus == 0 else { return true }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8), !output.isEmpty else { return false }
        let ourPID = ProcessInfo.processInfo.processIdentifier
        // lsof header: COMMAND PID USER FD TYPE ...
        for line in output.components(separatedBy: CharacterSet.newlines).dropFirst() {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            if let pidPart = parts.dropFirst(1).first,
               let pid = Int32(pidPart),
               pid != ourPID {
                return true
            }
        }
        return false
    }

    private func archive(path: String) {
        let timestamp = Int(Date().timeIntervalSince1970)
        let archivePath = "\(path).archive.\(timestamp).zlib"
        guard FileManager.default.fileExists(atPath: path) else { return }
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            // NSData compression supports zlib (DEFLATE), not gzip.
            let compressed = try (data as NSData).compressed(using: .zlib)
            try (compressed as Data).write(to: URL(fileURLWithPath: archivePath))
        } catch {
            // Archive best-effort only; do not truncate if archive failed.
        }
    }

    private func truncate(path: String, keepingLast lines: Int) {
        guard FileManager.default.fileExists(atPath: path) else { return }
        guard let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .utf8) else { return }
        let all = text.components(separatedBy: "\n")
        let keep = Array(all.suffix(lines)).joined(separator: "\n")
        let trimmed = keep.hasSuffix("\n") ? keep : keep + "\n"
        try? trimmed.write(toFile: path, atomically: true, encoding: .utf8)
    }

    private static let archiveSuffixes: [String?] = [".zlib", ".gz", nil]

    private func cleanupArchives(of path: String) {
        let dir = (path as NSString).deletingLastPathComponent
        let base = (path as NSString).lastPathComponent
        let prefix = "\(base).archive."
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        let archives = files
            .filter { $0.hasPrefix(prefix) && LogRotationPolicy.archiveTimestamp($0, prefix: prefix) != nil }
            .sorted { lhs, rhs in
                (LogRotationPolicy.archiveTimestamp(lhs, prefix: prefix) ?? 0) >
                (LogRotationPolicy.archiveTimestamp(rhs, prefix: prefix) ?? 0)
            }
            .dropFirst(maxArchiveCount)
        for old in archives {
            try? FileManager.default.removeItem(atPath: "\(dir)/\(old)")
        }
    }

    private func cleanupOldArchives(path: String) {
        guard let maxArchiveAgeSeconds = maxArchiveAgeSeconds else { return }
        let dir = (path as NSString).deletingLastPathComponent
        let base = (path as NSString).lastPathComponent
        let prefix = "\(base).archive."
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        let now = Date().timeIntervalSince1970
        for file in files {
            guard file.hasPrefix(prefix), let timestamp = LogRotationPolicy.archiveTimestamp(file, prefix: prefix) else { continue }
            if now - timestamp > maxArchiveAgeSeconds {
                try? FileManager.default.removeItem(atPath: "\(dir)/\(file)")
            }
        }
    }

    private static func archiveTimestamp(_ file: String, prefix: String) -> TimeInterval? {
        for suffix in archiveSuffixes {
            if let suffix = suffix {
                guard file.hasPrefix(prefix), file.hasSuffix(suffix) else { continue }
                let middle = file.dropFirst(prefix.count).dropLast(suffix.count)
                if let ts = TimeInterval(middle) { return ts }
            } else {
                guard file.hasPrefix(prefix), !file.dropFirst(prefix.count).contains(".") else { continue }
                let middle = file.dropFirst(prefix.count)
                if let ts = TimeInterval(middle) { return ts }
            }
        }
        return nil
    }

    static func worktreeAuditLogPaths(repoRoot: String) -> [(path: String, policy: LogRotationPolicy)] {
        let fm = FileManager.default
        let worktreesRoot = "\(repoRoot)/.worktrees"
        guard fm.fileExists(atPath: worktreesRoot),
              let entries = try? fm.contentsOfDirectory(atPath: worktreesRoot) else {
            return []
        }
        var result: [(path: String, policy: LogRotationPolicy)] = []
        for entry in entries {
            let trinityDir = "\(worktreesRoot)/\(entry)/trios/.trinity"
            guard fm.fileExists(atPath: trinityDir) else { continue }
            result.append(("\(trinityDir)/event_log.jsonl", .audit))
            result.append(("\(trinityDir)/events/akashic-log.jsonl", .audit))
            result.append(("\(trinityDir)/state/local-auth-audit.jsonl", .security))
            result.append(("\(trinityDir)/experience/episodes.jsonl", .experience))
        }
        return result
    }

    static func rotateAuditLogs() {
        let repoRoot = ProjectPaths.root
        let policies: [(path: String, policy: LogRotationPolicy)] = [
            (ProjectPaths.trinityEventLog, .audit),
            ("\(ProjectPaths.trinity)/events/akashic-log.jsonl", .audit),
            ("\(ProjectPaths.trinity)/state/local-auth-audit.jsonl", .security),
            ("\(ProjectPaths.trinity)/experience/episodes.jsonl", .experience),
        ] + worktreeAuditLogPaths(repoRoot: repoRoot)
        for item in policies {
            item.policy.rotateIfNeeded(path: item.path)
        }
    }
}

// MARK: - Audit rotation scheduler

@MainActor
final class AuditRotationScheduler {
    static let shared = AuditRotationScheduler()

    var isRunning: Bool { timer != nil }
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private let interval: TimeInterval
    private let rotationLock = NSLock()
    private(set) var lastRotationDate: Date?
    private let dateProvider: () -> Date

    init(
        interval: TimeInterval = 6 * 60 * 60,
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.interval = interval
        self.dateProvider = dateProvider
    }

    func start() {
        guard !isRunning else { return }
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.rotateNow()
            }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleWakeNotification()
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let observer = wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            wakeObserver = nil
        }
    }

    func rotateNow() {
        lastRotationDate = dateProvider()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            self.rotationLock.lock()
            defer { self.rotationLock.unlock() }
            LogRotationPolicy.rotateAuditLogs()
        }
    }

    func shouldRotateOnWake() -> Bool {
        guard let last = lastRotationDate else { return true }
        return dateProvider().timeIntervalSince(last) > interval / 2
    }

    private func handleWakeNotification() {
        guard shouldRotateOnWake() else { return }
        rotateNow()
    }
}

// MARK: - Recent search

struct LogRecentSearch: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let query: String
    let timestamp: Date
}

actor LogRecentSearchStore {
    private let path: String
    private let maxCount: Int

    init(
        path: String = "\(ProjectPaths.trinity)/state/logs_search_history.json",
        maxCount: Int = 20
    ) {
        self.path = path
        self.maxCount = maxCount
    }

    func load() -> [LogRecentSearch] {
        guard let data = FileManager.default.contents(atPath: path),
              let list = try? JSONDecoder().decode([LogRecentSearch].self, from: data) else {
            return []
        }
        return list
    }

    func record(query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }

        var list = load()
        list.removeAll { $0.query == trimmed }
        let entry = LogRecentSearch(
            id: UUID().uuidString,
            query: trimmed,
            timestamp: Date()
        )
        list.insert(entry, at: 0)
        if list.count > maxCount {
            list = Array(list.prefix(maxCount))
        }
        save(list)
    }

    func remove(id: String) {
        var list = load()
        list.removeAll { $0.id == id }
        save(list)
    }

    func clear() {
        save([])
    }

    private func save(_ searches: [LogRecentSearch]) {
        guard let data = try? JSONEncoder().encode(searches) else { return }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url)
    }
}

// MARK: - Parser

enum LogParser {
    static func parser(for kind: LogParserKind) -> (String, String) -> ParsedLogLine {
        switch kind {
        case .eventLog: return parseEventLogLine
        case .pinoJSON: return parsePinoJSONLine
        case .plainText: return parsePlainTextLine
        }
    }

    static func category(for filename: String) -> LogSourceCategory {
        let lower = filename.lowercased()
        if lower.hasPrefix("build_") || lower.hasPrefix("clade-build_") || lower == "clade-build_prod.log" {
            return .build
        }
        if lower.hasPrefix("chat_sse_e2e_build_") || lower.hasPrefix("queen_autonomous_test_") {
            return .test
        }
        if lower.hasSuffix(".stdout.log") || lower.hasSuffix(".stderr.log") {
            return .service
        }
        if lower.hasPrefix("event-log") || lower.hasPrefix("cron-log") || lower.hasPrefix("queen-log") || lower.contains("browseros-companion") {
            return .runtime
        }
        return .artifact
    }

    static func loadLogSources(includeArtifacts: Bool = false, maxLinesPerSource: Int = 500) -> [LogSource] {
        var loaded: [LogSource] = []

        // Reader-side rotation: prevent unbounded growth of watched log files.
        let rotation = LogRotationPolicy.default
        rotation.rotateIfNeeded(path: ProjectPaths.trinityEventLog)
        rotation.rotateIfNeeded(path: ProjectPaths.trinityLog)
        rotation.rotateIfNeeded(path: "\(ProjectPaths.trinity)/queen.log")
        LogRotationPolicy.rotateAuditLogs()

        loaded.append(parseSource(
            id: "event-log",
            name: "Trinity Event Log",
            path: ProjectPaths.trinityEventLog,
            icon: "list.bullet.rectangle",
            tintName: "blue",
            category: .runtime,
            parser: parseEventLogLine,
            parserKind: .eventLog
        ))

        loaded.append(parseSource(
            id: "cron-log",
            name: "Queen Cron Log",
            path: ProjectPaths.trinityLog,
            icon: "clock.arrow.2.circlepath",
            tintName: "purple",
            category: .runtime,
            parser: parsePlainTextLine,
            parserKind: .plainText
        ))

        let logsDir = "\(ProjectPaths.trinity)/logs"
        if let files = try? FileManager.default.contentsOfDirectory(atPath: logsDir).sorted() {
            for file in files where file.hasSuffix(".log") {
                let path = "\(logsDir)/\(file)"
                // Rotate reader-side for every service log; lsof guard skips active writers.
                rotation.rotateIfNeeded(path: path)
                let name = file.replacingOccurrences(of: ".log", with: "")
                let category = LogParser.category(for: file)
                let isCompanion = name.contains("companion")
                let parser: (String, String) -> ParsedLogLine = isCompanion ? parsePinoJSONLine : parsePlainTextLine
                let kind: LogParserKind = isCompanion ? .pinoJSON : .plainText
                loaded.append(parseSource(
                    id: "log-\(name)",
                    name: name,
                    path: path,
                    icon: "doc.text",
                    tintName: "grokMuted",
                    category: category,
                    parser: parser,
                    parserKind: kind
                ))
            }
        }

        let queenLogPath = "\(ProjectPaths.trinity)/queen.log"
        loaded.append(parseSource(
            id: "queen-log",
            name: "Queen Log",
            path: queenLogPath,
            icon: "crown",
            tintName: "yellow",
            category: .runtime,
            parser: parsePlainTextLine,
            parserKind: .plainText
        ))

        let result = loaded.filter { !$0.lines.isEmpty || FileManager.default.fileExists(atPath: $0.path) }
        guard includeArtifacts else {
            return result.filter { $0.category == .runtime || $0.category == .service }
        }
        return result
    }

    static func parseSource(
        id: String,
        name: String,
        path: String,
        icon: String,
        tintName: String,
        category: LogSourceCategory = .runtime,
        parser: (String, String) -> ParsedLogLine,
        parserKind: LogParserKind = .plainText,
        maxLines: Int = 500
    ) -> LogSource {
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? UInt64) ?? 0
        var allLines: [String] = []
        if let data = FileManager.default.contents(atPath: path),
           let text = String(data: data, encoding: .utf8)?.replacingOccurrences(of: "\r\n", with: "\n") {
            allLines = text.components(separatedBy: "\n").filter { !$0.isEmpty }
        }
        let wasCapped = allLines.count > maxLines
        let window = Array(allLines.suffix(maxLines))
        let parsed = window.map { parser($0, id) }
        let deduped = deduplicateConsecutive(parsed)
        let errorCount = deduped.filter { $0.level == .error || $0.level == .fatal }.count
        let warningCount = deduped.filter { $0.level == .warn }.count
        let totalDuplicates = deduped.reduce(0) { $0 + max(0, $1.duplicateCount - 1) }
        return LogSource(
            id: id,
            name: name,
            path: path,
            icon: icon,
            tintName: tintName,
            category: category,
            rawLines: parsed,
            lines: deduped,
            parser: parserKind,
            lastReadOffset: fileSize,
            errorCount: errorCount,
            warningCount: warningCount,
            duplicateGroupCount: deduped.filter(\.isDuplicateGroup).count,
            totalDuplicates: totalDuplicates,
            wasCapped: wasCapped,
            originalLineCount: allLines.count
        )
    }

    // MARK: - Incremental refresh (live tail)

    static func incrementalRefresh(
        sources: [LogSource],
        maxLinesPerSource: Int = 500
    ) -> [LogSource] {
        sources.map { refreshSource($0, maxLines: maxLinesPerSource) }
    }

    private static func refreshSource(_ source: LogSource, maxLines: Int) -> LogSource {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: source.path),
              let fileSize = attrs[.size] as? UInt64 else {
            return source
        }

        if fileSize == source.lastReadOffset {
            return source
        }

        let parser = parser(for: source.parser)

        // Rotation / truncation: the file got smaller, so re-read from the beginning.
        if fileSize < source.lastReadOffset {
            return parseSource(
                id: source.id,
                name: source.name,
                path: source.path,
                icon: source.icon,
                tintName: source.tintName,
                category: source.category,
                parser: parser,
                parserKind: source.parser,
                maxLines: maxLines
            )
        }

        let (newLines, nextOffset, originalLineCount) = readNewLines(
            at: source.path,
            from: source.lastReadOffset,
            to: fileSize,
            previousOriginalCount: source.originalLineCount
        )
        let parsed = newLines.map { parser($0, source.id) }

        var combinedRaw = source.rawLines + parsed
        if combinedRaw.count > maxLines {
            combinedRaw = Array(combinedRaw.suffix(maxLines))
        }

        let deduped = deduplicateConsecutive(combinedRaw)
        let errorCount = deduped.filter { $0.level == .error || $0.level == .fatal }.count
        let warningCount = deduped.filter { $0.level == .warn }.count
        let totalDuplicates = deduped.reduce(0) { $0 + max(0, $1.duplicateCount - 1) }

        return LogSource(
            id: source.id,
            name: source.name,
            path: source.path,
            icon: source.icon,
            tintName: source.tintName,
            category: source.category,
            rawLines: combinedRaw,
            lines: deduped,
            parser: source.parser,
            lastReadOffset: nextOffset,
            errorCount: errorCount,
            warningCount: warningCount,
            duplicateGroupCount: deduped.filter(\.isDuplicateGroup).count,
            totalDuplicates: totalDuplicates,
            wasCapped: combinedRaw.count >= maxLines && originalLineCount > maxLines,
            originalLineCount: originalLineCount
        )
    }

    private static func readNewLines(
        at path: String,
        from offset: UInt64,
        to fileSize: UInt64,
        previousOriginalCount: Int
    ) -> (lines: [String], nextOffset: UInt64, originalLineCount: Int) {
        guard offset < fileSize else {
            return ([], offset, previousOriginalCount)
        }
        let data = readBytes(at: path, from: offset, length: fileSize - offset)
        guard !data.isEmpty else {
            return ([], fileSize, previousOriginalCount)
        }

        let (completeData, incompleteLength) = completeLineData(from: data)
        guard !completeData.isEmpty else {
            return ([], fileSize - UInt64(incompleteLength), previousOriginalCount)
        }

        guard let text = String(data: completeData, encoding: .utf8) else {
            return ([], fileSize - UInt64(incompleteLength), previousOriginalCount)
        }

        let lines = text.components(separatedBy: "\n").filter { !$0.isEmpty }
        let nextOffset = fileSize - UInt64(incompleteLength)
        return (lines, nextOffset, previousOriginalCount + lines.count)
    }

    private static func readBytes(at path: String, from offset: UInt64, length: UInt64) -> Data {
        guard let handle = FileHandle(forReadingAtPath: path) else { return Data() }
        defer { try? handle.close() }
        if #available(macOS 10.15.4, *) {
            try? handle.seek(toOffset: offset)
            return (try? handle.read(upToCount: Int(length))) ?? Data()
        } else {
            handle.seek(toFileOffset: offset)
            return handle.readData(ofLength: Int(length))
        }
    }

    /// Splits appended file data into the complete-line prefix and the trailing incomplete byte count.
    private static func completeLineData(from data: Data) -> (complete: Data, incompleteLength: Int) {
        guard !data.isEmpty else { return (Data(), 0) }
        if data.last == 0x0A {
            return (data, 0)
        }
        if let lastNewlineIndex = data.lastIndex(of: 0x0A) {
            let completeEnd = data.index(after: lastNewlineIndex)
            let complete = data.prefix(upTo: completeEnd)
            let incompleteLength = data.count - complete.count
            return (Data(complete), incompleteLength)
        }
        return (Data(), data.count)
    }

    // MARK: - Deduplication

    static func deduplicateConsecutive(_ lines: [ParsedLogLine]) -> [ParsedLogLine] {
        guard !lines.isEmpty else { return [] }
        var result: [ParsedLogLine] = []
        var current = lines[0]
        var count = 1
        for index in 1..<lines.count {
            let line = lines[index]
            if line.message == current.message && line.level == current.level && line.event == current.event {
                count += 1
            } else {
                result.append(ParsedLogLine(
                    rawLine: current.rawLine,
                    timestamp: current.timestamp,
                    level: current.level,
                    sourceID: current.sourceID,
                    message: current.message,
                    event: current.event,
                    details: current.details,
                    metadata: current.metadata,
                    duplicateCount: count
                ))
                current = line
                count = 1
            }
        }
        result.append(ParsedLogLine(
            rawLine: current.rawLine,
            timestamp: current.timestamp,
            level: current.level,
            sourceID: current.sourceID,
            message: current.message,
            event: current.event,
            details: current.details,
            metadata: current.metadata,
            duplicateCount: count
        ))
        return result
    }

    // MARK: - Query parsing and matching

    static func parseQuery(_ query: String) -> [LogQueryToken] {
        var tokens: [LogQueryToken] = []
        var freeTextParts: [String] = []
        let scanner = Scanner(string: query)
        scanner.charactersToBeSkipped = CharacterSet.whitespaces

        while !scanner.isAtEnd {
            if let token = scanQueryToken(scanner) {
                switch token {
                case .text(let part):
                    if !part.isEmpty { freeTextParts.append(part) }
                default:
                    tokens.append(token)
                }
            }
        }

        if !freeTextParts.isEmpty {
            tokens.append(.text(freeTextParts.joined(separator: " ")))
        }
        return tokens
    }

    private static func scanQueryToken(_ scanner: Scanner) -> LogQueryToken? {
        let startIndex = scanner.currentIndex
        guard let word = scanWord(scanner), !word.isEmpty else {
            scanner.currentIndex = scanner.string.index(after: startIndex)
            return nil
        }

        if let colonIndex = word.firstIndex(of: ":"), colonIndex > word.startIndex {
            let key = String(word[..<colonIndex]).lowercased()
            let value = String(word[word.index(after: colonIndex)...])
            switch key {
            case "level":
                if let level = queryLevel(named: value) {
                    return .level(level)
                }
            case "source":
                return .source(value.lowercased())
            case "event":
                return .event(value.lowercased())
            default:
                break
            }
        }
        return .text(word.lowercased())
    }

    private static func scanWord(_ scanner: Scanner) -> String? {
        let index = scanner.currentIndex
        let remainder = String(scanner.string[index...])
        let trimmed = remainder.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        scanner.currentIndex = scanner.string.index(index, offsetBy: remainder.count - trimmed.count)
        if trimmed.hasPrefix("\"") {
            return scanQuotedWord(scanner)
        }
        if let space = trimmed.firstIndex(of: " ") {
            let word = String(trimmed[..<space])
            scanner.currentIndex = scanner.string.index(scanner.currentIndex, offsetBy: word.count)
            return word
        }
        scanner.currentIndex = scanner.string.endIndex
        return trimmed
    }

    private static func scanQuotedWord(_ scanner: Scanner) -> String? {
        let start = scanner.currentIndex
        guard scanner.string[start] == "\"" else { return nil }
        var current = scanner.string.index(after: start)
        var result = ""
        while current < scanner.string.endIndex {
            let char = scanner.string[current]
            if char == "\"" {
                scanner.currentIndex = scanner.string.index(after: current)
                return result
            }
            if char == "\\", let next = scanner.string.index(current, offsetBy: 1, limitedBy: scanner.string.endIndex) {
                result.append(scanner.string[next])
                current = scanner.string.index(after: next)
                continue
            }
            result.append(char)
            current = scanner.string.index(after: current)
        }
        scanner.currentIndex = start
        return nil
    }

    private static func queryLevel(named value: String) -> LogLevel? {
        switch value.lowercased() {
        case "trace": return .trace
        case "debug": return .debug
        case "info": return .info
        case "warn", "warning": return .warn
        case "error": return .error
        case "fatal": return .fatal
        default:
            if let int = Int(value), let level = LogLevel(rawValue: int) {
                return level
            }
            return nil
        }
    }

    static func matchesQuery(
        _ line: ParsedLogLine,
        tokens: [LogQueryToken],
        source: LogSource
    ) -> Bool {
        for token in tokens {
            switch token {
            case .level(let level):
                if line.level.rawValue < level.rawValue { return false }
            case .source(let query):
                let idMatch = source.id.lowercased().contains(query)
                let nameMatch = source.displayName.lowercased().contains(query)
                let sourceNameMatch = source.name.lowercased().contains(query)
                if !(idMatch || nameMatch || sourceNameMatch) { return false }
            case .event(let query):
                guard let event = line.event?.lowercased(), event.contains(query) else { return false }
            case .text(let query):
                let haystack = [
                    line.message,
                    line.event,
                    line.details,
                    line.timestamp
                ].compactMap { $0 }.joined(separator: " ").lowercased()
                let metadataHaystack = line.metadata.values.joined(separator: " ").lowercased()
                if !haystack.contains(query) && !metadataHaystack.contains(query) { return false }
            }
        }
        return true
    }

    static func exportLines(_ lines: [ParsedLogLine], to path: String) -> Bool {
        let text = lines.map { $0.rawLine }.joined(separator: "\n")
        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Unified timeline

    static func parseLineTimestamp(_ value: String?) -> Date? {
        guard let value = value, !value.isEmpty else { return nil }
        let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))

        let isoFormatter = DateFormatter()
        isoFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        isoFormatter.locale = Locale(identifier: "en_US_POSIX")
        isoFormatter.timeZone = TimeZone.current
        if let date = isoFormatter.date(from: trimmed) {
            return date
        }

        let bracketFormatter = DateFormatter()
        bracketFormatter.dateFormat = "yyyy-MM-dd_HH:mm:ss"
        bracketFormatter.locale = Locale(identifier: "en_US_POSIX")
        bracketFormatter.timeZone = TimeZone.current
        if let date = bracketFormatter.date(from: trimmed) {
            return date
        }

        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH:mm:ss"
        timeFormatter.locale = Locale(identifier: "en_US_POSIX")
        timeFormatter.timeZone = TimeZone.current
        if let timeOnly = timeFormatter.date(from: trimmed) {
            let calendar = Calendar.current
            var components = calendar.dateComponents([.year, .month, .day], from: Date())
            let timeComponents = calendar.dateComponents([.hour, .minute, .second], from: timeOnly)
            components.hour = timeComponents.hour
            components.minute = timeComponents.minute
            components.second = timeComponents.second
            if let candidate = calendar.date(from: components), candidate <= Date() {
                return candidate
            }
            components.day = (components.day ?? 1) - 1
            return calendar.date(from: components)
        }

        if let epoch = Double(trimmed) {
            let date = Date(timeIntervalSince1970: epoch)
            if date.timeIntervalSince1970 > 0 {
                return date
            }
        }

        return nil
    }

    static func filterNoise(
        _ lines: [ParsedLogLine],
        isOn: Bool = true,
        profile: LogNoiseProfile? = nil
    ) -> [ParsedLogLine] {
        guard isOn else { return lines }
        let filter = profile.map { LogNoiseFilter(profile: $0) } ?? LogNoiseFilter.shared
        return lines.filter { !filter.isNoise($0) }
    }

    static func unifiedLines(
        sources: [LogSource],
        minLevel: LogLevel,
        searchText: String,
        deduplicate: Bool,
        suppressNoise: Bool = false,
        profile: LogNoiseProfile? = nil,
        maxRows: Int = 500
    ) -> [ParsedLogLine] {
        let tokens = parseQuery(searchText)
        let filter = profile.map { LogNoiseFilter(profile: $0) } ?? LogNoiseFilter.shared
        var timeline: [(line: ParsedLogLine, source: LogSource, date: Date)] = []

        for source in sources {
            let base = deduplicate ? source.lines : source.rawLines
            for line in base where line.level.rawValue >= minLevel.rawValue {
                if suppressNoise && filter.isNoise(line) { continue }
                if !searchText.isEmpty {
                    guard matchesQuery(line, tokens: tokens, source: source) else { continue }
                }
                let date = parseLineTimestamp(line.timestamp) ?? Date.distantPast
                timeline.append((line: line, source: source, date: date))
            }
        }

        timeline.sort {
            if $0.date == $1.date {
                return $0.line.id < $1.line.id
            }
            return $0.date < $1.date
        }

        let sortedLines = timeline.map { $0.line }
        let result = deduplicate ? deduplicateConsecutiveAcrossSources(sortedLines) : sortedLines
        if result.count > maxRows {
            return Array(result.suffix(maxRows))
        }
        return result
    }

    private static func deduplicateConsecutiveAcrossSources(_ lines: [ParsedLogLine]) -> [ParsedLogLine] {
        guard !lines.isEmpty else { return [] }
        var result: [ParsedLogLine] = []
        var current = lines[0]
        var count = 1
        for index in 1..<lines.count {
            let line = lines[index]
            if line.message == current.message && line.level == current.level && line.event == current.event && line.sourceID == current.sourceID {
                count += 1
            } else {
                result.append(ParsedLogLine(
                    rawLine: current.rawLine,
                    timestamp: current.timestamp,
                    level: current.level,
                    sourceID: current.sourceID,
                    message: current.message,
                    event: current.event,
                    details: current.details,
                    metadata: current.metadata,
                    duplicateCount: count
                ))
                current = line
                count = 1
            }
        }
        result.append(ParsedLogLine(
            rawLine: current.rawLine,
            timestamp: current.timestamp,
            level: current.level,
            sourceID: current.sourceID,
            message: current.message,
            event: current.event,
            details: current.details,
            metadata: current.metadata,
            duplicateCount: count
        ))
        return result
    }

    // MARK: - Format parsers

    static func parseEventLogLine(_ line: String, sourceID: String) -> ParsedLogLine {
        if let data = line.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let timestamp = json["timestamp"] as? String
            let event = json["event"] as? String ?? "event"
            let details = json["details"] as? String
            let correlation = json["correlation_id"] as? String
            let level = eventLogLevel(event: event, details: details)
            let message = "[\(event)] \(details ?? "")"
            var metadata: [String: String] = [:]
            if let correlation = correlation { metadata["correlation_id"] = correlation }
            return ParsedLogLine(
                rawLine: line,
                timestamp: timestamp,
                level: level,
                sourceID: sourceID,
                message: message,
                event: event,
                details: details,
                metadata: metadata,
                duplicateCount: 1
            )
        }
        return fallbackLine(line, sourceID: sourceID)
    }

    static func parsePinoJSONLine(_ line: String, sourceID: String) -> ParsedLogLine {
        if let data = line.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let rawLevel = json["level"] as? Int ?? 30
            let level = LogLevel(rawValue: rawLevel) ?? .info
            let msg = json["msg"] as? String ?? line
            let error = json["error"] as? String
            let time = json["time"] as? Double
            let timestamp = time.map { formatUnixSeconds($0) }
            return ParsedLogLine(
                rawLine: line,
                timestamp: timestamp,
                level: level,
                sourceID: sourceID,
                message: msg,
                event: nil,
                details: error,
                metadata: [:],
                duplicateCount: 1
            )
        }
        return fallbackLine(line, sourceID: sourceID)
    }

    static func parsePlainTextLine(_ line: String, sourceID: String) -> ParsedLogLine {
        var level = inferLevel(from: line)
        var timestamp: String? = nil
        var message = line

        if let match = line.range(of: "\\[[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}:[0-9]{2}:[0-9]{2}]", options: .regularExpression) {
            timestamp = String(line[match]).trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            let after = line.index(match.upperBound, offsetBy: 0)
            message = String(line[after...]).trimmingCharacters(in: .whitespaces)
        } else if let match = line.range(of: "^\\[[0-9]+]", options: .regularExpression) {
            let raw = String(line[match]).trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            if let epoch = Double(raw) {
                timestamp = formatUnixSeconds(epoch)
            }
            let after = line.index(match.upperBound, offsetBy: 0)
            message = String(line[after...]).trimmingCharacters(in: .whitespaces)
        }

        if level == .info {
            level = inferLevel(from: message)
        }

        return ParsedLogLine(
            rawLine: line,
            timestamp: timestamp,
            level: level,
            sourceID: sourceID,
            message: message,
            event: nil,
            details: nil,
            metadata: [:],
            duplicateCount: 1
        )
    }

    // MARK: - Helpers

    static func inferLevel(from text: String) -> LogLevel {
        let lower = text.lowercased()
        if lower.contains("fatal") { return .fatal }
        if lower.contains("error") && !lower.contains("no error") { return .error }
        if lower.contains("warning") || lower.contains("warn:") || lower.contains("warning:") { return .warn }
        if lower.contains("debug") { return .debug }
        return .info
    }

    private static func eventLogLevel(event: String, details: String?) -> LogLevel {
        let lower = event.lowercased()
        if lower.contains("error") || lower.contains("fail") || lower.contains("fatal") {
            return .error
        }
        if lower.contains("warn") || lower.contains("drift") {
            return .warn
        }
        if lower.contains("heartbeat") || lower.contains("alive") {
            return .debug
        }
        return .info
    }

    private static func fallbackLine(_ line: String, sourceID: String) -> ParsedLogLine {
        ParsedLogLine(
            rawLine: line,
            timestamp: nil,
            level: inferLevel(from: line),
            sourceID: sourceID,
            message: line,
            event: nil,
            details: nil,
            metadata: [:],
            duplicateCount: 1
        )
    }

    private static func formatUnixSeconds(_ s: Double) -> String {
        let date = Date(timeIntervalSince1970: s)
        return formatDate(date)
    }

    private static func formatUnixMillis(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        return formatDate(date)
    }

    private static func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        return formatter.string(from: date)
    }
}
