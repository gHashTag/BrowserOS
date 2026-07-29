import Foundation

/// Ships `TriosLogBus` records to an OpenTelemetry collector.
///
/// The bus already writes OTel-shaped records; without an exporter they only
/// ever reach a local file, so the swarm can be read on this machine and
/// nowhere else. Once the swarm spans more than one machine, or once anyone
/// wants to keep more history than the log rotation allows, an external
/// collector is the only sane answer - and the standard one costs nothing to
/// speak.
///
/// Off unless `TRIOS_OTLP_ENDPOINT` is set. Telemetry that leaves the machine
/// by default is not a decision an app gets to make for its user.
actor TriosOTLPExporter {
    static let shared = TriosOTLPExporter()

    /// Records wait here until a batch is worth sending. Bounded, because a
    /// collector that is down must not turn into unbounded memory growth.
    private var pending: [TriosLogRecord] = []
    private var flushTask: Task<Void, Never>?
    private let endpoint: URL?
    private let headers: [String: String]
    private let session: URLSession
    private let batchSize: Int
    private let maximumQueue: Int

    /// Consecutive failures, used to stop hammering a collector that is down.
    private var consecutiveFailures = 0
    private static let backoffAfterFailures = 3

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        session: URLSession = .shared,
        batchSize: Int = 32,
        maximumQueue: Int = 512
    ) {
        let raw = environment["TRIOS_OTLP_ENDPOINT"] ?? ""
        endpoint = raw.isEmpty ? nil : URL(string: raw)
        self.session = session
        self.batchSize = batchSize
        self.maximumQueue = maximumQueue

        // `TRIOS_OTLP_HEADERS=key=value,key2=value2`, matching the OTLP
        // convention so an existing collector config can be pasted in.
        var parsed: [String: String] = [:]
        for pair in (environment["TRIOS_OTLP_HEADERS"] ?? "").split(separator: ",") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            parsed[parts[0].trimmingCharacters(in: .whitespaces)] =
                parts[1].trimmingCharacters(in: .whitespaces)
        }
        headers = parsed
    }

    var isEnabled: Bool { endpoint != nil }

    func enqueue(_ record: TriosLogRecord) {
        guard endpoint != nil else { return }
        pending.append(record)
        // Drop oldest rather than newest: during an incident the newest records
        // are the ones being read.
        if pending.count > maximumQueue {
            pending.removeFirst(pending.count - maximumQueue)
        }
        guard pending.count >= batchSize, flushTask == nil else { return }
        flushTask = Task { [weak self] in
            await self?.flush()
        }
    }

    func flush() async {
        defer { flushTask = nil }
        guard let endpoint, !pending.isEmpty else { return }
        if consecutiveFailures >= Self.backoffAfterFailures {
            // Keep buffering, stop dialling. The next successful manual flush
            // resets this; an app that retries forever just burns battery.
            return
        }

        let batch = pending
        pending = []
        guard let body = try? JSONSerialization.data(
            withJSONObject: Self.payload(for: batch)
        ) else { return }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        request.httpBody = body
        request.timeoutInterval = 10

        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200...299).contains(status) {
                consecutiveFailures = 0
            } else {
                consecutiveFailures += 1
            }
        } catch {
            consecutiveFailures += 1
        }
    }

    /// Builds an OTLP/HTTP JSON `logs` payload.
    ///
    /// Written by hand rather than pulled from a dependency: the shape is small,
    /// stable, and adding an SDK to a menu-bar app for one POST is a poor trade.
    static func payload(for records: [TriosLogRecord]) -> [String: Any] {
        let logRecords: [[String: Any]] = records.map { record in
            var attributes: [[String: Any]] = [
                ["key": "event.name", "value": ["stringValue": record.event]],
                ["key": "subsystem", "value": ["stringValue": record.subsystem.rawValue]]
            ]
            for (key, value) in record.attributes.sorted(by: { $0.key < $1.key }) {
                attributes.append(["key": key, "value": ["stringValue": value]])
            }
            var entry: [String: Any] = [
                "timeUnixNano": String(nanoseconds(from: record.timestamp)),
                "severityNumber": record.severityNumber,
                "severityText": record.severity.rawValue.uppercased(),
                "body": ["stringValue": record.message],
                "attributes": attributes
            ]
            // One delegated task, one trace. A worker's records carry the
            // task's trace id and their own span id, so a collector nests the
            // bee's work under the Queen's decision instead of showing two
            // unrelated streams. Derived from the ids already in the record,
            // so no extra plumbing has to stay in sync.
            if let issue = record.attributes["issue"] {
                entry["traceId"] = traceID(for: issue)
                if let conversation = record.attributes["conversation"] {
                    entry["spanId"] = spanID(for: conversation)
                } else if let worker = record.attributes["worker"] {
                    entry["spanId"] = spanID(for: worker + issue)
                }
            }
            return entry
        }

        return [
            "resourceLogs": [[
                "resource": [
                    "attributes": [
                        ["key": "service.name", "value": ["stringValue": "trios"]],
                        [
                            "key": "service.instance.id",
                            "value": ["stringValue": TriosAppLogSourceID.value]
                        ]
                    ]
                ],
                "scopeLogs": [["scope": ["name": "TriosLogBus"], "logRecords": logRecords]]
            ]]
        ]
    }

    /// OTLP wants 16 hex bytes for a trace id and 8 for a span id. A stable
    /// hash of the identifier gives both, and the same issue always maps to the
    /// same trace across app restarts - which is the point.
    static func traceID(for value: String) -> String {
        hex(from: value, bytes: 16)
    }

    static func spanID(for value: String) -> String {
        hex(from: value, bytes: 8)
    }

    private static func hex(from value: String, bytes: Int) -> String {
        // FNV-1a, repeated with a salt per chunk. Not cryptographic and does
        // not need to be: collisions cost a merged trace, not a security hole.
        var output = ""
        var salt: UInt64 = 0
        while output.count < bytes * 2 {
            var hash: UInt64 = 0xcbf2_9ce4_8422_2325 &+ salt
            for byte in value.utf8 {
                hash ^= UInt64(byte)
                hash = hash &* 0x1000_0000_01b3
            }
            output += String(format: "%016lx", hash)
            salt &+= 1
        }
        return String(output.prefix(bytes * 2))
    }

    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func nanoseconds(from timestamp: String) -> Int64 {
        let date = parser.date(from: timestamp) ?? Date(timeIntervalSince1970: 0)
        return Int64(date.timeIntervalSince1970 * 1_000_000_000)
    }
}
