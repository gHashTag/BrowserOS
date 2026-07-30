// Standalone unit tests for TriosLogBus record encoding and subsystem routing.
//
// Run (from trios root):
//   swiftc tests/swift/trios_log_bus_test.swift tests/swift/TriosLogBusTestStubs.swift \
//     rings/SR-01/TriosLogBus.swift -o /tmp/trios_log_bus_test && /tmp/trios_log_bus_test
//
// Exits non-zero when any assertion fails.

import Foundation

@main
enum TriosLogBusTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)")
        }
    }

    static func scenario(_ name: String) {
        print("\n# Scenario: \(name)")
    }

    static func main() {
        recordEncoding()
        tabRouting()
        ringBuffer()
        durableAppend()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 {
            exit(1)
        }
        print("All TriosLogBus tests passed.")
    }

    // MARK: - Encoding

    static func recordEncoding() {
        scenario("records encode as one parseable JSON line")

        let record = TriosLogRecord(
            timestamp: "2026-07-28T06:00:00.000Z",
            severity: .error,
            severityNumber: TriosLogSeverity.error.otelNumber,
            subsystem: .chat,
            event: "chat.transport.error",
            message: "Insufficient balance",
            attributes: ["provider": "zai", "model": "glm-5.2"]
        )
        guard let line = TriosLogBus.encode(record) else {
            check(false, "the record encodes")
            return
        }
        check(!line.contains("\n"), "the encoded record occupies exactly one line")

        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            check(false, "the encoded record is valid JSON")
            return
        }
        check(json["subsystem"] as? String == "chat", "the subsystem survives the round trip")
        check(json["event"] as? String == "chat.transport.error", "the event name survives")
        check(json["message"] as? String == "Insufficient balance", "the message survives")
        check(json["level"] as? String == "error", "the severity is written as a readable name")
        check(
            json["severity_number"] as? Int == 17,
            "the OpenTelemetry severity number is written alongside the name"
        )
        check(
            (json["attrs"] as? [String: Any])?["model"] as? String == "glm-5.2",
            "attributes survive under the attrs key"
        )
        check(json["ts"] as? String == "2026-07-28T06:00:00.000Z", "the timestamp survives")
    }

    // MARK: - Tab routing

    static func tabRouting() {
        scenario("each tab maps to the subsystems it actually writes")

        let chat = Set(TriosLogSubsystem.forTab(.chat))
        check(chat.contains(.chat), "the chat tab sees chat records")
        check(chat.contains(.a2a), "the chat tab sees A2A records, since they surface as chat banners")
        check(!chat.contains(.models), "the chat tab does not pull in model-settings noise")

        let models = Set(TriosLogSubsystem.forTab(.models))
        check(models.contains(.models), "the models tab sees model records")
        check(models.contains(.health), "the models tab sees health probes")
        check(!models.contains(.chat), "the models tab does not pull in chat traffic")

        check(
            Set(TriosLogSubsystem.forTab(.logs)) == Set(TriosLogSubsystem.allCases),
            "the logs tab itself sees the whole stream"
        )
    }

    // MARK: - Ring buffer

    static func ringBuffer() {
        scenario("the ring buffer is bounded and filterable")

        let path = NSTemporaryDirectory() + "trios-log-bus-ring-\(UUID().uuidString).jsonl"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let bus = TriosLogBus(path: path, mirrorsToNSLog: false)

        bus.info(.chat, "chat.one", "first")
        bus.warn(.models, "models.one", "second")
        bus.error(.a2a, "a2a.one", "third")
        bus.flush()

        check(bus.recent().count == 3, "every record is retained")
        check(
            bus.recent(subsystems: [.models]).map(\.event) == ["models.one"],
            "filtering by subsystem returns only that subsystem"
        )
        check(
            bus.recent(subsystems: [.chat, .a2a]).count == 2,
            "filtering accepts several subsystems at once"
        )
        check(
            bus.recent(subsystems: []).count == 3,
            "an empty filter means no filter rather than no results"
        )
        check(
            bus.recent(limit: 2).map(\.event) == ["models.one", "a2a.one"],
            "a limit keeps the newest records, not the oldest"
        )
        check(bus.recent().last?.severity == .error, "severity is preserved per record")
    }

    // MARK: - Durability

    static func durableAppend() {
        scenario("records reach disk as newline delimited JSON")

        let path = NSTemporaryDirectory() + "trios-log-bus-file-\(UUID().uuidString).jsonl"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let bus = TriosLogBus(path: path, mirrorsToNSLog: false)

        bus.info(.models, "models.key.added", "Stored a new API key", ["provider": "zai"])
        bus.error(.chat, "chat.transport.error", "boom")
        bus.flush()

        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
            check(false, "the log file exists after writing")
            return
        }
        let lines = contents.split(separator: "\n").map(String.init)
        check(lines.count == 2, "each record is its own line")

        let decoded = lines.compactMap { line -> [String: Any]? in
            guard let data = line.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        check(decoded.count == 2, "every written line is valid JSON")
        check(
            decoded.first?["event"] as? String == "models.key.added",
            "records are appended in the order they were emitted"
        )
        check(
            (decoded.first?["attrs"] as? [String: Any])?["provider"] as? String == "zai",
            "attributes reach disk"
        )

        // Appending must not truncate what a previous session wrote.
        let second = TriosLogBus(path: path, mirrorsToNSLog: false)
        second.info(.queen, "queen.tick", "later session")
        second.flush()
        let after = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        check(
            after.split(separator: "\n").count == 3,
            "a new bus instance appends instead of overwriting"
        )
    }
}
