// Standalone tests for LogParser.parseTriosAppLine - the bridge that makes
// TriosLogBus records visible in the LOGS tab.
//
// Run (from trios root):
//   swiftc tests/swift/log_parser_trios_app_test.swift \
//     tests/swift/TriosLogBusTestStubs.swift \
//     rings/SR-01/TriosLogBus.swift rings/SR-02/LogParser.swift \
//     -o /tmp/trios_log_parser_app_test && /tmp/trios_log_parser_app_test
//
// Exits non-zero when any assertion fails.

import Foundation

@main
enum LogParserTriosAppTests {
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
        roundTripFromBus()
        severityMapping()
        malformedLines()
        subsystemMetadata()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 {
            exit(1)
        }
        print("All LogParser trios-app tests passed.")
    }

    /// The encoder and the parser must agree. This is the contract that decides
    /// whether in-app events actually show up in the LOGS tab.
    static func roundTripFromBus() {
        scenario("a record written by the bus parses back into a log line")

        let record = TriosLogRecord(
            timestamp: "2026-07-28T06:12:00.000Z",
            severity: .error,
            severityNumber: TriosLogSeverity.error.otelNumber,
            subsystem: .a2a,
            event: "a2a.register.failed",
            message: "Registry rejected the local authorization token",
            attributes: ["error": "invalidResponse(403)"]
        )
        guard let line = TriosLogBus.encode(record) else {
            check(false, "the record encodes")
            return
        }
        let parsed = LogParser.parseTriosAppLine(line, sourceID: TriosAppLogSourceID.value)
        check(parsed.level == .error, "an error record parses as ERROR")
        check(parsed.event == "a2a.register.failed", "the event name is carried through")
        check(
            parsed.message == "Registry rejected the local authorization token",
            "the message is carried through"
        )
        check(parsed.timestamp == "2026-07-28T06:12:00.000Z", "the timestamp is carried through")
        check(parsed.sourceID == TriosAppLogSourceID.value, "the line is attributed to the app stream")
        check(
            parsed.metadata[LogParser.triosSubsystemMetadataKey] == "a2a",
            "the subsystem lands in metadata so per-tab filtering can use it"
        )
        check(
            parsed.metadata["error"] == "invalidResponse(403)",
            "attributes land in metadata alongside the subsystem"
        )
        check(
            parsed.details?.contains("error=invalidResponse(403)") == true,
            "details render the attributes for display"
        )
    }

    static func severityMapping() {
        scenario("severity numbers map onto the LOGS tab levels")

        func level(forNumber number: Int) -> LogLevel {
            let line = """
            {"ts":"t","level":"x","severity_number":\(number),"subsystem":"app","event":"e","message":"m"}
            """
            return LogParser.parseTriosAppLine(line, sourceID: "s").level
        }
        check(level(forNumber: 5) == .debug, "severity 5 is debug")
        check(level(forNumber: 9) == .info, "severity 9 is info")
        check(level(forNumber: 13) == .warn, "severity 13 is warn")
        check(level(forNumber: 17) == .error, "severity 17 is error")

        // Without a number, the readable name decides.
        let namedWarn = """
        {"ts":"t","level":"warn","subsystem":"app","event":"e","message":"m"}
        """
        check(
            LogParser.parseTriosAppLine(namedWarn, sourceID: "s").level == .warn,
            "the readable level name is used when no number is present"
        )
        let unknown = """
        {"ts":"t","level":"nonsense","subsystem":"app","event":"e","message":"m"}
        """
        check(
            LogParser.parseTriosAppLine(unknown, sourceID: "s").level == .info,
            "an unrecognised level falls back to info rather than dropping the line"
        )
    }

    static func malformedLines() {
        scenario("malformed lines degrade instead of disappearing")

        let garbage = LogParser.parseTriosAppLine("this is not json", sourceID: "s")
        check(garbage.rawLine == "this is not json", "a non-JSON line keeps its raw text")

        let empty = LogParser.parseTriosAppLine("", sourceID: "s")
        check(empty.rawLine.isEmpty, "an empty line does not crash the parser")

        // A record missing its message must still be visible.
        let noMessage = """
        {"ts":"t","level":"info","subsystem":"chat","event":"e"}
        """
        let parsed = LogParser.parseTriosAppLine(noMessage, sourceID: "s")
        check(!parsed.message.isEmpty, "a record without a message falls back to the raw line")
        check(parsed.event == "e", "the event still parses when the message is absent")
    }

    static func subsystemMetadata() {
        scenario("every subsystem round-trips through the metadata tag")

        for subsystem in TriosLogSubsystem.allCases {
            let record = TriosLogRecord(
                timestamp: "t",
                severity: .info,
                severityNumber: 9,
                subsystem: subsystem,
                event: "e",
                message: "m",
                attributes: [:]
            )
            guard let line = TriosLogBus.encode(record) else {
                check(false, "\(subsystem.rawValue) encodes")
                continue
            }
            let parsed = LogParser.parseTriosAppLine(line, sourceID: "s")
            check(
                parsed.metadata[LogParser.triosSubsystemMetadataKey] == subsystem.rawValue,
                "\(subsystem.rawValue) survives the round trip"
            )
        }
    }
}
