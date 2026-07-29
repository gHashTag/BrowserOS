import Foundation

// MARK: - Source identity

/// Shared identifier for the in-app stream, so the bus, the parser, and the
/// LOGS tab all agree on one name.
enum TriosAppLogSourceID {
    static let value = "trios-app"
}

// MARK: - Subsystem

/// Logical origin of an in-app log record. Every tab maps to one or more
/// subsystems so the LOGS tab can present a per-tab slice of the single stream.
enum TriosLogSubsystem: String, CaseIterable, Codable, Sendable {
    case app
    case chat
    case models
    case health
    case queen
    case a2a
    case network
    case security
    case logs

    var displayName: String {
        switch self {
        case .app: return "App"
        case .chat: return "Chat"
        case .models: return "Models"
        case .health: return "Health"
        case .queen: return "Queen"
        case .a2a: return "A2A"
        case .network: return "Network"
        case .security: return "Security"
        case .logs: return "Logs"
        }
    }

    /// Subsystems surfaced when a tab asks for "my logs".
    static func forTab(_ tab: TriosLogTab) -> [TriosLogSubsystem] {
        switch tab {
        case .chat: return [.chat, .queen, .a2a, .network]
        case .models: return [.models, .health, .network]
        case .logs: return TriosLogSubsystem.allCases
        }
    }
}

/// Tabs that own a Logs affordance. Each funnels into the same LOGS tab.
enum TriosLogTab: String, Sendable {
    case chat
    case models
    case logs
}

// MARK: - Severity

enum TriosLogSeverity: String, Codable, Sendable {
    case debug
    case info
    case warn
    case error

    /// OpenTelemetry severity number, so records stay ingestible by an
    /// OTLP collector without a translation step.
    var otelNumber: Int {
        switch self {
        case .debug: return 5
        case .info: return 9
        case .warn: return 13
        case .error: return 17
        }
    }
}

// MARK: - Record

/// One structured log record. Field names follow the OpenTelemetry log data
/// model closely enough that the file can be shipped as-is.
struct TriosLogRecord: Codable, Equatable, Sendable {
    let timestamp: String
    let severity: TriosLogSeverity
    let severityNumber: Int
    let subsystem: TriosLogSubsystem
    let event: String
    let message: String
    let attributes: [String: String]

    enum CodingKeys: String, CodingKey {
        case timestamp = "ts"
        case severity = "level"
        case severityNumber = "severity_number"
        case subsystem
        case event
        case message
        case attributes = "attrs"
    }
}

// MARK: - Bus

/// Single source of truth for in-app events.
///
/// Every record is appended to `.trinity/logs/trios-app.jsonl` as newline
/// delimited JSON, retained in a bounded in-memory ring buffer for instant
/// display, and mirrored to `NSLog` so existing console workflows keep working.
///
/// Writes happen on a serial queue, so the bus is safe to call from any actor
/// or thread. Failures to write are swallowed on purpose: logging must never
/// take down the caller.
final class TriosLogBus: @unchecked Sendable {
    static let shared = TriosLogBus()

    /// Maximum records retained in memory. Roughly a session's worth of
    /// activity at a few records per second.
    static let ringCapacity = 2000

    private let path: String
    private let queue = DispatchQueue(label: "com.browseros.trios.logbus", qos: .utility)
    private let lock = NSLock()
    private var ring: [TriosLogRecord] = []
    private let mirrorsToNSLog: Bool
    private let dateProvider: () -> Date

    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    init(
        path: String = TriosLogBus.defaultPath,
        mirrorsToNSLog: Bool = true,
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.path = path
        self.mirrorsToNSLog = mirrorsToNSLog
        self.dateProvider = dateProvider
        ring.reserveCapacity(Self.ringCapacity)
    }

    static var defaultPath: String {
        "\(ProjectPaths.trinity)/logs/trios-app.jsonl"
    }

    var logPath: String { path }

    // MARK: Emit

    func log(
        _ severity: TriosLogSeverity,
        subsystem: TriosLogSubsystem,
        event: String,
        message: String,
        attributes: [String: String] = [:]
    ) {
        let record = TriosLogRecord(
            timestamp: Self.formatter.string(from: dateProvider()),
            severity: severity,
            severityNumber: severity.otelNumber,
            subsystem: subsystem,
            event: event,
            message: message,
            attributes: attributes
        )
        append(record)
    }

    func debug(
        _ subsystem: TriosLogSubsystem,
        _ event: String,
        _ message: String,
        _ attributes: [String: String] = [:]
    ) {
        log(.debug, subsystem: subsystem, event: event, message: message, attributes: attributes)
    }

    func info(
        _ subsystem: TriosLogSubsystem,
        _ event: String,
        _ message: String,
        _ attributes: [String: String] = [:]
    ) {
        log(.info, subsystem: subsystem, event: event, message: message, attributes: attributes)
    }

    func warn(
        _ subsystem: TriosLogSubsystem,
        _ event: String,
        _ message: String,
        _ attributes: [String: String] = [:]
    ) {
        log(.warn, subsystem: subsystem, event: event, message: message, attributes: attributes)
    }

    func error(
        _ subsystem: TriosLogSubsystem,
        _ event: String,
        _ message: String,
        _ attributes: [String: String] = [:]
    ) {
        log(.error, subsystem: subsystem, event: event, message: message, attributes: attributes)
    }

    // MARK: Read

    /// Newest-last snapshot of the ring buffer, optionally narrowed to a set of
    /// subsystems.
    func recent(subsystems: Set<TriosLogSubsystem>? = nil, limit: Int = ringCapacity) -> [TriosLogRecord] {
        lock.lock()
        let snapshot = ring
        lock.unlock()
        let filtered: [TriosLogRecord]
        if let subsystems, !subsystems.isEmpty {
            filtered = snapshot.filter { subsystems.contains($0.subsystem) }
        } else {
            filtered = snapshot
        }
        guard filtered.count > limit else { return filtered }
        return Array(filtered.suffix(limit))
    }

    /// Blocks until every queued write has reached disk. Used by tests and by
    /// shutdown paths that must not lose the final records.
    func flush() {
        queue.sync {}
    }

    // MARK: Internals

    private func append(_ record: TriosLogRecord) {
        lock.lock()
        ring.append(record)
        if ring.count > Self.ringCapacity {
            ring.removeFirst(ring.count - Self.ringCapacity)
        }
        lock.unlock()

        if mirrorsToNSLog {
            NSLog("[%@] %@ %@", record.subsystem.rawValue, record.event, record.message)
        }

        queue.async { [path] in
            guard let line = Self.encode(record) else { return }
            Self.appendLine(line, to: path)
        }

        // Fan out to an external collector when one is configured. Detached so
        // a slow or dead collector can never stall the caller: logging is on
        // the path of everything, including the code that reports the outage.
        Task.detached(priority: .utility) {
            await TriosOTLPExporter.shared.enqueue(record)
        }
    }

    static func encode(_ record: TriosLogRecord) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(record),
              let json = String(data: data, encoding: .utf8) else {
            return nil
        }
        // Records are newline delimited; a literal newline inside would corrupt
        // the stream. JSONEncoder escapes them already, but be explicit.
        return json.replacingOccurrences(of: "\n", with: " ")
    }

    private static func appendLine(_ line: String, to path: String) {
        let manager = FileManager.default
        let directory = (path as NSString).deletingLastPathComponent
        if !manager.fileExists(atPath: directory) {
            try? manager.createDirectory(atPath: directory, withIntermediateDirectories: true)
        }
        if !manager.fileExists(atPath: path) {
            manager.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else { return }
        defer { try? handle.close() }
        guard let data = (line + "\n").data(using: .utf8) else { return }
        // Seek on every write instead of holding an open offset, so reader-side
        // rotation can truncate the file without stranding this handle.
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}
