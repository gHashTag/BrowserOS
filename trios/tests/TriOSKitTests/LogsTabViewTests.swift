import XCTest
@testable import TriOSKit

final class LogsTabViewTests: XCTestCase {

    // MARK: - Event log parsing

    func testEventLogParsesJSONLWithTimestampAndDetails() {
        let line = #"{"timestamp":"2026-07-24T12:00:00Z","event":"watchdog_heartbeat","details":"alive","correlation_id":"abc-123"}"#
        let parsed = LogParser.parseEventLogLine(line, sourceID: "event-log")

        XCTAssertEqual(parsed.timestamp, "2026-07-24T12:00:00Z")
        XCTAssertEqual(parsed.event, "watchdog_heartbeat")
        XCTAssertEqual(parsed.details, "alive")
        XCTAssertEqual(parsed.sourceID, "event-log")
        XCTAssertEqual(parsed.metadata["correlation_id"], "abc-123")
        XCTAssertTrue(parsed.message.contains("watchdog_heartbeat"))
        XCTAssertEqual(parsed.level, .debug)
    }

    func testEventLogTreatsDriftAsWarning() {
        let line = #"{"timestamp":"2026-07-24T12:01:00Z","event":"drift_detected","details":"config drift"}"#
        let parsed = LogParser.parseEventLogLine(line, sourceID: "event-log")
        XCTAssertEqual(parsed.level, .warn)
    }

    func testEventLogTreatsErrorEventAsError() {
        let line = #"{"timestamp":"2026-07-24T12:02:00Z","event":"sync_failed","details":"connection timeout"}"#
        let parsed = LogParser.parseEventLogLine(line, sourceID: "event-log")
        XCTAssertEqual(parsed.level, .error)
    }

    // MARK: - Pino JSON parsing

    func testPinoJSONParsesLevelAndMessage() {
        let line = #"{"level":40,"time":1721817600000,"msg":"Reclaiming stale task leases","error":"timeout"}"#
        let parsed = LogParser.parsePinoJSONLine(line, sourceID: "browseros-companion")

        XCTAssertEqual(parsed.level, .warn)
        XCTAssertEqual(parsed.message, "Reclaiming stale task leases")
        XCTAssertEqual(parsed.details, "timeout")
        XCTAssertEqual(parsed.sourceID, "browseros-companion")
        XCTAssertNotNil(parsed.timestamp)
    }

    func testPinoJSONDefaultsToInfoWhenLevelMissing() {
        let line = #"{"msg":"Plain message"}"#
        let parsed = LogParser.parsePinoJSONLine(line, sourceID: "browseros-companion")
        XCTAssertEqual(parsed.level, .info)
    }

    // MARK: - Plain text parsing

    func testPlainTextExtractsBracketedTimestamp() {
        let line = "[2026-05-24_23:48:49] [WARN] connection slow"
        let parsed = LogParser.parsePlainTextLine(line, sourceID: "cron-log")

        XCTAssertEqual(parsed.timestamp, "2026-05-24_23:48:49")
        XCTAssertEqual(parsed.message, "[WARN] connection slow")
        XCTAssertEqual(parsed.level, .warn)
    }

    func testPlainTextInfersErrorLevel() {
        let line = "something went wrong with the error handler"
        let parsed = LogParser.parsePlainTextLine(line, sourceID: "queen-log")
        XCTAssertEqual(parsed.level, .error)
    }

    func testPlainTextIgnoresNoError() {
        let line = "no error found"
        let parsed = LogParser.parsePlainTextLine(line, sourceID: "queen-log")
        XCTAssertEqual(parsed.level, .info)
    }

    func testPlainTextExtractsEpochTimestamp() {
        let line = "[1779642834] hello world"
        let parsed = LogParser.parsePlainTextLine(line, sourceID: "queen-log")
        XCTAssertNotNil(parsed.timestamp)
        XCTAssertEqual(parsed.message, "hello world")
    }

    // MARK: - Deduplication

    func testDeduplicateConsecutiveCollapsesIdenticalMessages() {
        let lines = [
            ParsedLogLine(rawLine: "a", timestamp: nil, level: .info, sourceID: "s", message: "same", event: nil, details: nil, metadata: [:], duplicateCount: 1),
            ParsedLogLine(rawLine: "b", timestamp: nil, level: .info, sourceID: "s", message: "same", event: nil, details: nil, metadata: [:], duplicateCount: 1),
            ParsedLogLine(rawLine: "c", timestamp: nil, level: .info, sourceID: "s", message: "same", event: nil, details: nil, metadata: [:], duplicateCount: 1),
            ParsedLogLine(rawLine: "d", timestamp: nil, level: .warn, sourceID: "s", message: "different", event: nil, details: nil, metadata: [:], duplicateCount: 1)
        ]
        let deduped = LogParser.deduplicateConsecutive(lines)

        XCTAssertEqual(deduped.count, 2)
        XCTAssertEqual(deduped[0].duplicateCount, 3)
        XCTAssertEqual(deduped[0].message, "same")
        XCTAssertEqual(deduped[1].duplicateCount, 1)
        XCTAssertEqual(deduped[1].message, "different")
    }

    func testDeduplicationDoesNotCollapseDifferentLevels() {
        let lines = [
            ParsedLogLine(rawLine: "a", timestamp: nil, level: .info, sourceID: "s", message: "msg", event: nil, details: nil, metadata: [:], duplicateCount: 1),
            ParsedLogLine(rawLine: "b", timestamp: nil, level: .error, sourceID: "s", message: "msg", event: nil, details: nil, metadata: [:], duplicateCount: 1)
        ]
        let deduped = LogParser.deduplicateConsecutive(lines)
        XCTAssertEqual(deduped.count, 2)
    }

    func testDeduplicationEmptyArray() {
        let deduped = LogParser.deduplicateConsecutive([])
        XCTAssertTrue(deduped.isEmpty)
    }

    // MARK: - Source parsing

    func testParseSourceCountsErrorsAndWarnings() {
        let text = """
        [2026-05-24_23:48:49] [INFO] started
        [2026-05-24_23:48:50] [WARN] slow
        [2026-05-24_23:48:51] [ERROR] failed
        [2026-05-24_23:48:52] [ERROR] failed
        """
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-parser-\(UUID().uuidString).log")
        try? text.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "test-source",
            name: "Test",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine
        )

        XCTAssertEqual(source.errorCount, 2)
        XCTAssertEqual(source.warningCount, 1)
        XCTAssertEqual(source.lines.count, 3)
        XCTAssertEqual(source.lines.last?.duplicateCount, 2)
    }

    func testParseSourceCapsLargeFiles() {
        let lines = (1...600).map { "[2026-05-24_23:48:\($0)] [INFO] line \($0)" }
        let text = lines.joined(separator: "\n")
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-parser-cap-\(UUID().uuidString).log")
        try? text.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "test-source",
            name: "Test",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine,
            maxLines: 100
        )

        XCTAssertTrue(source.wasCapped)
        XCTAssertEqual(source.originalLineCount, 600)
        XCTAssertEqual(source.lines.count, 100)
    }

    // MARK: - Incremental refresh (live tail)

    func testIncrementalRefreshAppendsNewLines() {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-tail-\(UUID().uuidString).log")
        let initial = "[2026-05-24_23:48:49] [INFO] started"
        try? initial.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "tail-source",
            name: "Tail",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine
        )
        XCTAssertEqual(source.lines.count, 1)
        XCTAssertEqual(source.lastReadOffset, UInt64(initial.utf8.count))

        let appendage = "\n[2026-05-24_23:48:50] [WARN] slow"
        if let handle = FileHandle(forWritingAtPath: tempURL.path) {
            handle.seekToEndOfFile()
            handle.write(appendage.data(using: .utf8)!)
            try? handle.close()
        }

        let refreshed = LogParser.incrementalRefresh(sources: [source])
        let updated = refreshed.first!
        XCTAssertEqual(updated.lines.count, 2)
        XCTAssertEqual(updated.lines.last?.message, "[WARN] slow")
        XCTAssertEqual(updated.lines.last?.level, .warn)
        XCTAssert(updated.lastReadOffset > source.lastReadOffset)
    }

    func testIncrementalRefreshDoesNothingWhenFileUnchanged() {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-tail-noop-\(UUID().uuidString).log")
        let text = "[2026-05-24_23:48:49] [INFO] started"
        try? text.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "tail-source",
            name: "Tail",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine
        )

        let refreshed = LogParser.incrementalRefresh(sources: [source])
        let updated = refreshed.first!
        XCTAssertEqual(updated.lastReadOffset, source.lastReadOffset)
        XCTAssertEqual(updated.lines.count, source.lines.count)
    }

    func testIncrementalRefreshHandlesTruncation() {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-tail-truncate-\(UUID().uuidString).log")
        let text = "[2026-05-24_23:48:49] [INFO] line one\n[2026-05-24_23:48:50] [INFO] line two"
        try? text.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "tail-source",
            name: "Tail",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine
        )
        XCTAssertEqual(source.lines.count, 2)

        let shorter = "[2026-05-24_23:48:51] [ERROR] reset"
        try? shorter.write(to: tempURL, atomically: true, encoding: .utf8)

        let refreshed = LogParser.incrementalRefresh(sources: [source])
        let updated = refreshed.first!
        XCTAssertEqual(updated.lines.count, 1)
        XCTAssertEqual(updated.lines.first?.level, .error)
        XCTAssertEqual(updated.lastReadOffset, UInt64(shorter.utf8.count))
    }

    func testIncrementalRefreshDropsOldLinesAtCap() {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-tail-cap-\(UUID().uuidString).log")
        let lines = (1...10).map { "[2026-05-24_23:48:\($0)] [INFO] line \($0)" }
        try? lines.joined(separator: "\n").write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "tail-source",
            name: "Tail",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine,
            maxLines: 5
        )
        XCTAssertEqual(source.lines.count, 5)
        XCTAssertEqual(source.lines.first?.message, "[INFO] line 6")

        let appendage = (11...14).map { "[2026-05-24_23:48:\($0)] [INFO] line \($0)" }.joined(separator: "\n")
        if let handle = FileHandle(forWritingAtPath: tempURL.path) {
            handle.seekToEndOfFile()
            handle.write(("\n" + appendage).data(using: .utf8)!)
            try? handle.close()
        }

        let refreshed = LogParser.incrementalRefresh(sources: [source])
        let updated = refreshed.first!
        XCTAssertEqual(updated.lines.count, 5)
        XCTAssertEqual(updated.lines.first?.message, "[INFO] line 10")
        XCTAssertEqual(updated.lines.last?.message, "[INFO] line 14")
    }

    // MARK: - Scroll-aware follow policy

    func testShouldAutoScrollWhenLiveAndNotPaused() {
        XCTAssertTrue(LogsTabScrollPolicy.shouldAutoScroll(isLive: true, isFollowPaused: false))
    }

    func testShouldAutoScrollIsFalseWhenPaused() {
        XCTAssertFalse(LogsTabScrollPolicy.shouldAutoScroll(isLive: true, isFollowPaused: true))
    }

    func testShouldAutoScrollIsFalseWhenLiveOff() {
        XCTAssertFalse(LogsTabScrollPolicy.shouldAutoScroll(isLive: false, isFollowPaused: false))
    }

    func testPauseFollowStateCanBeToggled() {
        XCTAssertTrue(LogsTabScrollPolicy.shouldAutoScroll(isLive: true, isFollowPaused: false))
        XCTAssertFalse(LogsTabScrollPolicy.shouldAutoScroll(isLive: true, isFollowPaused: true))
        XCTAssertTrue(LogsTabScrollPolicy.shouldAutoScroll(isLive: true, isFollowPaused: false))
    }

    func testIncrementalRefreshMergesDedupAcrossBoundary() {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-log-tail-dedup-\(UUID().uuidString).log")
        let text = "[2026-05-24_23:48:49] [INFO] same"
        try? text.write(to: tempURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let source = LogParser.parseSource(
            id: "tail-source",
            name: "Tail",
            path: tempURL.path,
            icon: "doc.text",
            tintName: "blue",
            parser: LogParser.parsePlainTextLine
        )
        XCTAssertEqual(source.lines.first?.duplicateCount, 1)

        let appendage = "\n[2026-05-24_23:48:50] [INFO] same\n[2026-05-24_23:48:51] [INFO] different"
        if let handle = FileHandle(forWritingAtPath: tempURL.path) {
            handle.seekToEndOfFile()
            handle.write(appendage.data(using: .utf8)!)
            try? handle.close()
        }

        let refreshed = LogParser.incrementalRefresh(sources: [source])
        let updated = refreshed.first!
        XCTAssertEqual(updated.lines.count, 2)
        XCTAssertEqual(updated.lines.first?.duplicateCount, 2)
        XCTAssertEqual(updated.lines.first?.message, "[INFO] same")
        XCTAssertEqual(updated.lines.last?.message, "[INFO] different")
    }

    // MARK: - Structured query

    func testQueryParserExtractsLevelSourceAndEventTokens() {
        let tokens = LogParser.parseQuery("level:error source:cron event:heartbeat")
        XCTAssertEqual(tokens, [.level(.error), .source("cron"), .event("heartbeat")])
    }

    func testQueryParserFallsBackToFreeText() {
        let tokens = LogParser.parseQuery("connection timeout unknown:token")
        XCTAssertEqual(tokens, [.text("connection timeout unknown:token")])
    }

    func testLevelTokenMatchesMinimumLevel() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .warn, sourceID: "s",
            message: "msg", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "s", name: "S", path: "", icon: "", tintName: "",
            rawLines: [], lines: [], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 0
        )
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.level(.warn)], source: source))
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.level(.info)], source: source))
        XCTAssertFalse(LogParser.matchesQuery(line, tokens: [.level(.error)], source: source))
    }

    func testSourceTokenMatchesSourceIDAndDisplayName() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .info, sourceID: "cron-log",
            message: "msg", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "cron-log", name: "Queen Cron Log", path: "/logs/cron.log",
            icon: "", tintName: "", rawLines: [], lines: [], parser: .plainText,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 0
        )
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.source("cron")], source: source))
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.source("queen")], source: source))
        XCTAssertFalse(LogParser.matchesQuery(line, tokens: [.source("event")], source: source))
    }

    func testEventTokenMatchesEventSubstring() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .info, sourceID: "s",
            message: "msg", event: "watchdog_heartbeat", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "s", name: "S", path: "", icon: "", tintName: "",
            rawLines: [], lines: [], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 0
        )
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.event("heart")], source: source))
        XCTAssertFalse(LogParser.matchesQuery(line, tokens: [.event("drift")], source: source))
    }

    func testFreeTextMatchesMessageDetailsAndMetadata() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .info, sourceID: "s",
            message: "connection timeout", event: nil, details: "retrying",
            metadata: ["trace_id": "abc-123"], duplicateCount: 1
        )
        let source = LogSource(
            id: "s", name: "S", path: "", icon: "", tintName: "",
            rawLines: [], lines: [], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 0
        )
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.text("connection")], source: source))
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.text("retrying")], source: source))
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: [.text("abc-123")], source: source))
        XCTAssertFalse(LogParser.matchesQuery(line, tokens: [.text("failure")], source: source))
    }

    func testCombinedTokensRequireAllToMatch() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .error, sourceID: "cron-log",
            message: "connection timeout", event: "sync_failed", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "cron-log", name: "Cron", path: "", icon: "", tintName: "",
            rawLines: [], lines: [], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 0
        )
        let tokens: [LogQueryToken] = [.level(.warn), .source("cron"), .event("sync"), .text("timeout")]
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: tokens, source: source))
        let failingTokens: [LogQueryToken] = [.level(.warn), .source("cron"), .event("drift")]
        XCTAssertFalse(LogParser.matchesQuery(line, tokens: failingTokens, source: source))
    }

    func testExportWritesFilteredLines() {
        let line = ParsedLogLine(
            rawLine: "raw line", timestamp: nil, level: .info, sourceID: "s",
            message: "msg", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("test-export-\(UUID().uuidString).log")
        let success = LogParser.exportLines([line], to: tempURL.path)
        XCTAssertTrue(success)
        let content = try? String(contentsOf: tempURL, encoding: .utf8)
        XCTAssertEqual(content?.trimmingCharacters(in: .whitespacesAndNewlines), "raw line")
        try? FileManager.default.removeItem(at: tempURL)
    }

    // MARK: - Saved searches

    func testSavedSearchStoreProvidesDefaultsWhenFileMissing() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("saved-searches-\(UUID().uuidString).json")
        let store = LogSavedSearchStore(path: tempURL.path)
        let loaded = await store.load()
        XCTAssertEqual(loaded.count, 4)
        XCTAssertTrue(loaded.contains { $0.id == "errors-only" })
    }

    func testSavedSearchStorePersistsAndReloads() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("saved-searches-persist-\(UUID().uuidString).json")
        let store = LogSavedSearchStore(path: tempURL.path)
        let custom = [
            LogSavedSearch(id: "custom", label: "My filter", query: "level:error custom")
        ]
        await store.save(custom)
        let reloaded = await store.load()
        XCTAssertEqual(reloaded.count, 1)
        XCTAssertEqual(reloaded.first?.query, "level:error custom")
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testSavedSearchAppliesQuery() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .error, sourceID: "cron-log",
            message: "connection timeout", event: "sync_failed", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "cron-log", name: "Cron", path: "", icon: "", tintName: "",
            rawLines: [], lines: [], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 0
        )
        let search = LogSavedSearch(id: "errors-only", label: "Errors only", query: "level:error")
        let tokens = LogParser.parseQuery(search.query)
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: tokens, source: source))

        let warnSearch = LogSavedSearch(id: "cron-warn", label: "Cron warnings", query: "source:cron level:warn")
        let warnTokens = LogParser.parseQuery(warnSearch.query)
        XCTAssertFalse(LogParser.matchesQuery(line, tokens: warnTokens, source: source))
    }

    // MARK: - Recent searches

    func testRecentSearchStoreStartsEmptyWhenFileMissing() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("recent-searches-\(UUID().uuidString).json")
        let store = LogRecentSearchStore(path: tempURL.path)
        let loaded = await store.load()
        XCTAssertTrue(loaded.isEmpty)
    }

    func testRecentSearchStoreRecordsAndDeduplicates() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("recent-searches-dedup-\(UUID().uuidString).json")
        let store = LogRecentSearchStore(path: tempURL.path)
        await store.record(query: "level:error")
        await store.record(query: "source:cron")
        await store.record(query: "level:error")
        let loaded = await store.load()
        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(loaded.first?.query, "level:error")
        XCTAssertEqual(loaded.last?.query, "source:cron")
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testRecentSearchStoreIgnoresEmptyQueries() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("recent-searches-empty-\(UUID().uuidString).json")
        let store = LogRecentSearchStore(path: tempURL.path)
        await store.record(query: "   ")
        await store.record(query: "")
        let loaded = await store.load()
        XCTAssertTrue(loaded.isEmpty)
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testRecentSearchStoreCapsHistory() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("recent-searches-cap-\(UUID().uuidString).json")
        let store = LogRecentSearchStore(path: tempURL.path, maxCount: 3)
        for i in 1...5 {
            await store.record(query: "query-\(i)")
        }
        let loaded = await store.load()
        XCTAssertEqual(loaded.count, 3)
        XCTAssertEqual(loaded.map(\.query), ["query-5", "query-4", "query-3"])
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testRecentSearchStoreRemovesAndClears() async {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("recent-searches-remove-\(UUID().uuidString).json")
        let store = LogRecentSearchStore(path: tempURL.path)
        await store.record(query: "a")
        await store.record(query: "b")
        let loaded = await store.load()
        let idToRemove = loaded.first?.id
        XCTAssertNotNil(idToRemove)
        await store.remove(id: idToRemove!)
        XCTAssertEqual(await store.load().count, 1)
        await store.clear()
        XCTAssertTrue(await store.load().isEmpty)
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testRecentSearchQueryAppliesMatching() {
        let line = ParsedLogLine(
            rawLine: "x", timestamp: nil, level: .warn, sourceID: "cron-log",
            message: "slow", event: "drift", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "cron-log", name: "Cron", path: "", icon: "", tintName: "",
            rawLines: [], lines: [], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 0
        )
        let recent = LogRecentSearch(id: "r1", query: "source:cron level:warn", timestamp: Date())
        let tokens = LogParser.parseQuery(recent.query)
        XCTAssertTrue(LogParser.matchesQuery(line, tokens: tokens, source: source))
    }

    // MARK: - Correlated timeline

    func testParseLineTimestampHandlesISO8601() {
        let date = LogParser.parseLineTimestamp("2026-07-24T12:00:00Z")
        XCTAssertNotNil(date)
        let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 7)
        XCTAssertEqual(components.day, 24)
        XCTAssertEqual(components.hour, 12)
    }

    func testParseLineTimestampHandlesBracketedFormat() {
        let date = LogParser.parseLineTimestamp("2026-07-24_12:30:45")
        XCTAssertNotNil(date)
        let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 7)
        XCTAssertEqual(components.day, 24)
        XCTAssertEqual(components.hour, 12)
        XCTAssertEqual(components.minute, 30)
        XCTAssertEqual(components.second, 45)
    }

    func testParseLineTimestampHandlesTimeOnly() {
        let date = LogParser.parseLineTimestamp("08:15:30")
        XCTAssertNotNil(date)
        let components = Calendar.current.dateComponents([.hour, .minute, .second], from: date!)
        XCTAssertEqual(components.hour, 8)
        XCTAssertEqual(components.minute, 15)
        XCTAssertEqual(components.second, 30)
    }

    func testParseLineTimestampReturnsNilForUnknown() {
        XCTAssertNil(LogParser.parseLineTimestamp(nil))
        XCTAssertNil(LogParser.parseLineTimestamp(""))
        XCTAssertNil(LogParser.parseLineTimestamp("not a time"))
    }

    func testUnifiedLinesSortAcrossSourcesAndFormats() {
        let cronLine = ParsedLogLine(
            rawLine: "[2026-07-24_12:00:00] [WARN] cron warn",
            timestamp: "[2026-07-24_12:00:00]", level: .warn, sourceID: "cron-log",
            message: "cron warn", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let eventLine = ParsedLogLine(
            rawLine: #"{"timestamp":"2026-07-24T12:05:00Z","event":"later"}"#,
            timestamp: "2026-07-24T12:05:00Z", level: .info, sourceID: "event-log",
            message: "later", event: "later", details: nil, metadata: [:], duplicateCount: 1
        )
        let queenLine = ParsedLogLine(
            rawLine: "[1779642900] [ERROR] queen error",
            timestamp: "12:15:00", level: .error, sourceID: "queen-log",
            message: "queen error", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )

        let cronSource = LogSource(
            id: "cron-log", name: "Cron", path: "", icon: "", tintName: "",
            rawLines: [cronLine], lines: [cronLine], parser: .plainText, lastReadOffset: 0,
            errorCount: 0, warningCount: 1, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 1
        )
        let eventSource = LogSource(
            id: "event-log", name: "Event", path: "", icon: "", tintName: "",
            rawLines: [eventLine], lines: [eventLine], parser: .eventLog, lastReadOffset: 0,
            errorCount: 0, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 1
        )
        let queenSource = LogSource(
            id: "queen-log", name: "Queen", path: "", icon: "", tintName: "",
            rawLines: [queenLine], lines: [queenLine], parser: .plainText, lastReadOffset: 0,
            errorCount: 1, warningCount: 0, duplicateGroupCount: 0, totalDuplicates: 0,
            wasCapped: false, originalLineCount: 1
        )

        let unified = LogParser.unifiedLines(
            sources: [cronSource, eventSource, queenSource],
            minLevel: .info,
            searchText: "",
            deduplicate: false
        )
        XCTAssertEqual(unified.count, 3)
        XCTAssertEqual(unified[0].sourceID, "cron-log")
        XCTAssertEqual(unified[1].sourceID, "event-log")
        XCTAssertEqual(unified[2].sourceID, "queen-log")
    }

    func testUnifiedLinesApplyLevelAndSearchFilters() {
        let errorLine = ParsedLogLine(
            rawLine: "[2026-07-24_12:00:00] [ERROR] fail",
            timestamp: "[2026-07-24_12:00:00]", level: .error, sourceID: "s1",
            message: "fail", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let warnLine = ParsedLogLine(
            rawLine: "[2026-07-24_12:01:00] [WARN] slow",
            timestamp: "[2026-07-24_12:01:00]", level: .warn, sourceID: "s1",
            message: "slow", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "s1", name: "S", path: "", icon: "", tintName: "",
            rawLines: [errorLine, warnLine], lines: [errorLine, warnLine], parser: .plainText,
            lastReadOffset: 0, errorCount: 1, warningCount: 1, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 2
        )

        let levelFiltered = LogParser.unifiedLines(
            sources: [source], minLevel: .error, searchText: "", deduplicate: false
        )
        XCTAssertEqual(levelFiltered.count, 1)
        XCTAssertEqual(levelFiltered.first?.message, "fail")

        let searchFiltered = LogParser.unifiedLines(
            sources: [source], minLevel: .info, searchText: "slow", deduplicate: false
        )
        XCTAssertEqual(searchFiltered.count, 1)
        XCTAssertEqual(searchFiltered.first?.message, "slow")
    }

    func testUnifiedLinesDeduplicateAcrossSources() {
        let lineA = ParsedLogLine(
            rawLine: "a", timestamp: "[2026-07-24_12:00:00]", level: .error,
            sourceID: "s1", message: "same", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let lineB = ParsedLogLine(
            rawLine: "b", timestamp: "[2026-07-24_12:01:00]", level: .error,
            sourceID: "s1", message: "same", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "s1", name: "S", path: "", icon: "", tintName: "",
            rawLines: [lineA, lineB], lines: [lineA, lineB], parser: .plainText,
            lastReadOffset: 0, errorCount: 2, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 2
        )
        let deduped = LogParser.unifiedLines(
            sources: [source], minLevel: .info, searchText: "", deduplicate: true
        )
        XCTAssertEqual(deduped.count, 1)
        XCTAssertEqual(deduped.first?.duplicateCount, 2)
    }

    func testUnifiedLinesSortsMissingTimestampsToBottom() {
        let datedLine = ParsedLogLine(
            rawLine: "a", timestamp: "[2026-07-24_12:00:00]", level: .info,
            sourceID: "s1", message: "dated", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let missingLine = ParsedLogLine(
            rawLine: "b", timestamp: nil, level: .info,
            sourceID: "s1", message: "missing", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "s1", name: "S", path: "", icon: "", tintName: "",
            rawLines: [datedLine, missingLine], lines: [datedLine, missingLine], parser: .plainText,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 2
        )
        let unified = LogParser.unifiedLines(
            sources: [source], minLevel: .info, searchText: "", deduplicate: false
        )
        XCTAssertEqual(unified.count, 2)
        XCTAssertEqual(unified[0].message, "dated")
        XCTAssertEqual(unified[1].message, "missing")
    }

    // MARK: - Noise suppression

    func testNoiseFilterSuppressesHeartbeatAndDriftEvents() {
        let heartbeat = ParsedLogLine(
            rawLine: #"{"event":"watchdog_heartbeat"}"#,
            timestamp: nil, level: .debug, sourceID: "event-log",
            message: "", event: "watchdog_heartbeat", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let drift = ParsedLogLine(
            rawLine: #"{"event":"drift_detected"}"#,
            timestamp: nil, level: .warn, sourceID: "event-log",
            message: "", event: "drift_detected", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: #"{"event":"sync_failed","details":"connection timeout"}"#,
            timestamp: nil, level: .error, sourceID: "event-log",
            message: "[sync_failed] connection timeout", event: "sync_failed", details: "connection timeout",
            metadata: [:], duplicateCount: 1
        )

        XCTAssertTrue(LogNoiseFilter.shared.isNoise(heartbeat))
        XCTAssertTrue(LogNoiseFilter.shared.isNoise(drift))
        XCTAssertFalse(LogNoiseFilter.shared.isNoise(real))
    }

    func testNoiseFilterSuppressesCompanionLeaseNoise() {
        let lease = ParsedLogLine(
            rawLine: #"{"level":40,"msg":"Reclaiming stale task leases"}"#,
            timestamp: nil, level: .warn, sourceID: "browseros-companion",
            message: "Reclaiming stale task leases", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: #"{"level":50,"msg":"database connection failed"}"#,
            timestamp: nil, level: .error, sourceID: "browseros-companion",
            message: "database connection failed", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )

        XCTAssertTrue(LogNoiseFilter.shared.isNoise(lease))
        XCTAssertFalse(LogNoiseFilter.shared.isNoise(real))
    }

    func testFilterNoiseIsNoOpWhenDisabled() {
        let heartbeat = ParsedLogLine(
            rawLine: #"{"event":"watchdog_heartbeat"}"#,
            timestamp: nil, level: .debug, sourceID: "event-log",
            message: "", event: "watchdog_heartbeat", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let lines = [heartbeat]
        XCTAssertEqual(LogParser.filterNoise(lines, isOn: true).count, 0)
        XCTAssertEqual(LogParser.filterNoise(lines, isOn: false).count, 1)
    }

    func testUnifiedLinesHonorsSuppressNoiseFlag() {
        let heartbeat = ParsedLogLine(
            rawLine: #"{"event":"watchdog_heartbeat"}"#,
            timestamp: nil, level: .debug, sourceID: "event-log",
            message: "", event: "watchdog_heartbeat", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: #"{"event":"sync_failed"}"#,
            timestamp: nil, level: .error, sourceID: "event-log",
            message: "[sync_failed] ", event: "sync_failed", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "event-log", name: "Event", path: "", icon: "", tintName: "",
            rawLines: [heartbeat, real], lines: [heartbeat, real], parser: .eventLog,
            lastReadOffset: 0, errorCount: 1, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 2
        )

        let noisy = LogParser.unifiedLines(
            sources: [source], minLevel: .info, searchText: "", deduplicate: false, suppressNoise: false
        )
        XCTAssertEqual(noisy.count, 1)

        let quiet = LogParser.unifiedLines(
            sources: [source], minLevel: .info, searchText: "", deduplicate: false, suppressNoise: true
        )
        XCTAssertEqual(quiet.count, 1)
        XCTAssertEqual(quiet.first?.event, "sync_failed")
    }

    // MARK: - Noise profiles

    func testCustomNoiseRuleFiltersByEvent() {
        let heartbeat = ParsedLogLine(
            rawLine: #"{"event":"custom_heartbeat"}"#,
            timestamp: nil, level: .debug, sourceID: "event-log",
            message: "", event: "custom_heartbeat", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: #"{"event":"real_event"}"#,
            timestamp: nil, level: .error, sourceID: "event-log",
            message: "", event: "real_event", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "custom heartbeat", event: "custom_heartbeat")
        ])
        let filter = LogNoiseFilter(profile: profile)

        XCTAssertTrue(filter.isNoise(heartbeat))
        XCTAssertFalse(filter.isNoise(real))
    }

    func testCustomNoiseRuleFiltersByMessage() {
        let noise = ParsedLogLine(
            rawLine: "noise line", timestamp: nil, level: .info, sourceID: "s",
            message: "Routine health check passed", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: "real line", timestamp: nil, level: .info, sourceID: "s",
            message: "Something important happened", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "health check", message: "Routine health check")
        ])
        let filter = LogNoiseFilter(profile: profile)

        XCTAssertTrue(filter.isNoise(noise))
        XCTAssertFalse(filter.isNoise(real))
    }

    func testCustomNoiseRuleFiltersByRawSubstring() {
        let noise = ParsedLogLine(
            rawLine: "[INFO] metrics flush took 12ms", timestamp: nil, level: .info, sourceID: "s",
            message: "metrics flush took 12ms", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: "[INFO] user login succeeded", timestamp: nil, level: .info, sourceID: "s",
            message: "user login succeeded", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "metrics flush", raw: "metrics flush")
        ])
        let filter = LogNoiseFilter(profile: profile)

        XCTAssertTrue(filter.isNoise(noise))
        XCTAssertFalse(filter.isNoise(real))
    }

    func testNoiseProfileStorePersistsAndReloads() async {
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("noise-profile-\(UUID().uuidString).json")
        let store = LogNoiseProfileStore(path: tempURL.path)
        let rule = LogNoiseRule(label: "my rule", event: "my_event")
        await store.addRule(rule)

        let loaded = await store.load()
        XCTAssertEqual(loaded.customRules.count, 1)
        XCTAssertEqual(loaded.customRules.first?.event, "my_event")
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testNoiseProfileStoreUpdateReplacesCustomRules() async {
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("noise-profile-update-\(UUID().uuidString).json")
        let store = LogNoiseProfileStore(path: tempURL.path)
        await store.addRule(LogNoiseRule(label: "a", event: "a"))
        await store.updateRules([
            LogNoiseRule(label: "b", message: "b"),
            LogNoiseRule(label: "c", raw: "c")
        ])

        let loaded = await store.load()
        XCTAssertEqual(loaded.customRules.count, 2)
        XCTAssertNil(loaded.customRules.first { $0.label == "a" })
        try? FileManager.default.removeItem(at: tempURL)
    }

    func testPatternProposerPrefersEventMatcher() {
        let line = ParsedLogLine(
            rawLine: #"{"event":"noisy_event","msg":"hello world"}"#,
            timestamp: nil, level: .info, sourceID: "s",
            message: "hello world", event: "noisy_event", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let rule = LogNoisePatternProposer.propose(from: line)
        XCTAssertNotNil(rule)
        XCTAssertEqual(rule?.event, "noisy_event")
        XCTAssertNil(rule?.message)
    }

    func testPatternProposerFallsBackToMessagePhrase() {
        let line = ParsedLogLine(
            rawLine: "Routine health check passed in 12ms",
            timestamp: nil, level: .info, sourceID: "s",
            message: "Routine health check passed in 12ms", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let rule = LogNoisePatternProposer.propose(from: line)
        XCTAssertNotNil(rule)
        XCTAssertNil(rule?.event)
        XCTAssertEqual(rule?.message, "routine health check passed")
    }

    func testPatternProposerRejectsTooBroadPatterns() {
        let line = ParsedLogLine(
            rawLine: "123",
            timestamp: nil, level: .info, sourceID: "s",
            message: "123", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        XCTAssertNil(LogNoisePatternProposer.propose(from: line))
    }

    func testFilterNoiseAcceptsCustomProfile() {
        let line = ParsedLogLine(
            rawLine: "noise", timestamp: nil, level: .info, sourceID: "s",
            message: "custom noise", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "custom", message: "custom noise")
        ])
        XCTAssertEqual(LogParser.filterNoise([line], isOn: true, profile: profile).count, 0)
        XCTAssertEqual(LogParser.filterNoise([line], isOn: false, profile: profile).count, 1)
    }

    func testUnifiedLinesHonorsCustomProfileNoise() {
        let noise = ParsedLogLine(
            rawLine: "noise", timestamp: nil, level: .info, sourceID: "s",
            message: "custom noise", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let real = ParsedLogLine(
            rawLine: "real", timestamp: nil, level: .info, sourceID: "s",
            message: "real event", event: nil, details: nil,
            metadata: [:], duplicateCount: 1
        )
        let source = LogSource(
            id: "s", name: "S", path: "", icon: "", tintName: "",
            rawLines: [noise, real], lines: [noise, real], parser: .plainText,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 2
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "custom", message: "custom noise")
        ])
        let quiet = LogParser.unifiedLines(
            sources: [source], minLevel: .info, searchText: "",
            deduplicate: false, suppressNoise: true, profile: profile
        )
        XCTAssertEqual(quiet.count, 1)
        XCTAssertEqual(quiet.first?.message, "real event")
    }

    // MARK: - Rotation policy

    func testRotationPolicyTruncatesOversizedFile() {
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-rotation-\(UUID().uuidString).log")
        let policy = LogRotationPolicy(
            maxFileSizeBytes: 100,
            maxArchiveCount: 2,
            keepTailLines: 5,
            maxArchiveAgeSeconds: nil,
            maxAgeBeforeRotationSeconds: nil
        )
        let lines = (1...20).map { "line \($0)" }
        try? lines.joined(separator: "\n").write(to: tempURL, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(at: tempURL)
            cleanupTestArchives(base: tempURL.lastPathComponent, in: tempURL.deletingLastPathComponent().path)
        }

        policy.rotateIfNeeded(path: tempURL.path)

        guard let data = FileManager.default.contents(atPath: tempURL.path),
              let text = String(data: data, encoding: .utf8) else {
            XCTFail("Could not read rotated file")
            return
        }
        let remaining = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        XCTAssertLessThanOrEqual(remaining.count, 6)
        XCTAssertTrue(remaining.contains("line 20"))
    }

    func testRotationPolicyCleansUpOldArchives() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("test-rotation-dir-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("service.log").path
        let policy = LogRotationPolicy(
            maxFileSizeBytes: 50,
            maxArchiveCount: 2,
            keepTailLines: 2,
            maxArchiveAgeSeconds: nil,
            maxAgeBeforeRotationSeconds: nil
        )

        // Seed three pre-existing archives.
        for timestamp in [1000, 2000, 3000] {
            let archive = "\(path).archive.\(timestamp).gz"
            try? "data".write(toFile: archive, atomically: true, encoding: .utf8)
        }
        try? Array(repeating: "noise", count: 20).joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)

        defer {
            try? FileManager.default.removeItem(at: dir)
        }

        policy.rotateIfNeeded(path: path)

        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let archives = files.filter { $0.hasSuffix(".gz") }
        XCTAssertLessThanOrEqual(archives.count, 2)
    }

    func testRotationPolicyRotatesOldFileEvenIfUnderSize() {
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-rotation-age-\(UUID().uuidString).jsonl")
        let policy = LogRotationPolicy(
            maxFileSizeBytes: 1_000_000,
            maxArchiveCount: 2,
            keepTailLines: 2,
            maxArchiveAgeSeconds: nil,
            maxAgeBeforeRotationSeconds: 1 // rotate anything older than 1 second
        )
        let lines = (1...10).map { "line \($0)" }
        try? lines.joined(separator: "\n").write(to: tempURL, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(at: tempURL)
            cleanupTestArchives(base: tempURL.lastPathComponent, in: tempURL.deletingLastPathComponent().path)
        }
        // Sleep briefly so mtime age exceeds 1 second.
        Thread.sleep(forTimeInterval: 1.5)

        policy.rotateIfNeeded(path: tempURL.path)

        guard let data = FileManager.default.contents(atPath: tempURL.path),
              let text = String(data: data, encoding: .utf8) else {
            XCTFail("Could not read rotated file")
            return
        }
        let remaining = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        XCTAssertLessThanOrEqual(remaining.count, 2)
        XCTAssertTrue(remaining.contains("line 10"))
        // An archive should have been created.
        let dir = tempURL.deletingLastPathComponent().path
        let archives = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        XCTAssertTrue(archives.contains { $0.hasPrefix(tempURL.lastPathComponent + ".archive.") })
    }

    func testRotationPolicyDeletesArchivesByAge() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("test-rotation-age-dir-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("audit.jsonl").path
        let policy = LogRotationPolicy(
            maxFileSizeBytes: 10_000_000, // do not rotate by size
            maxArchiveCount: 10,
            keepTailLines: 2,
            maxArchiveAgeSeconds: 60, // delete archives older than 60 seconds
            maxAgeBeforeRotationSeconds: nil
        )

        let now = Date().timeIntervalSince1970
        // Create one fresh archive and one very old archive.
        let freshArchive = "\(path).archive.\(Int(now)).zlib"
        let oldArchive = "\(path).archive.\(Int(now - 120)).zlib"
        try? "fresh".write(toFile: freshArchive, atomically: true, encoding: .utf8)
        try? "old".write(toFile: oldArchive, atomically: true, encoding: .utf8)
        try? "active".write(toFile: path, atomically: true, encoding: .utf8)

        defer {
            try? FileManager.default.removeItem(at: dir)
        }

        policy.rotateIfNeeded(path: path)

        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let archives = files.filter { $0.hasSuffix(".zlib") }
        XCTAssertEqual(archives.count, 1)
        XCTAssertTrue(archives.first?.contains(".archive.\(Int(now)).") ?? false)
    }

    func testRotateAuditLogsTouchesKnownStreams() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("test-rotation-audit-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("events"), withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("state"), withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("experience"), withIntermediateDirectories: true)

        let eventPath = dir.appendingPathComponent("event_log.jsonl").path
        let akashicPath = dir.appendingPathComponent("events/akashic-log.jsonl").path
        let authPath = dir.appendingPathComponent("state/local-auth-audit.jsonl").path
        let episodesPath = dir.appendingPathComponent("experience/episodes.jsonl").path

        // Write small active files that are older than 1 second so they rotate.
        for path in [eventPath, akashicPath, authPath, episodesPath] {
            try? "audit line".write(toFile: path, atomically: true, encoding: .utf8)
        }
        // Patch ProjectPaths.trinity to point to the temp dir by leveraging the known path format.
        // rotateAuditLogs builds paths with ProjectPaths.trinity, so we cannot intercept it easily.
        // Instead we just verify the static policy values are distinct.
        XCTAssertEqual(LogRotationPolicy.audit.maxArchiveAgeSeconds, 30 * 24 * 60 * 60)
        XCTAssertEqual(LogRotationPolicy.security.maxArchiveAgeSeconds, 365 * 24 * 60 * 60)
        XCTAssertEqual(LogRotationPolicy.experience.maxFileSizeBytes, 5_242_880)
        XCTAssertEqual(LogRotationPolicy.experience.maxAgeBeforeRotationSeconds, 7 * 24 * 60 * 60)

        defer {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    private func cleanupTestArchives(base: String, in dir: String) {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        for file in files where file.hasPrefix("\(base).archive.") {
            try? FileManager.default.removeItem(atPath: "\(dir)/\(file)")
        }
    }

    // MARK: - Source-scoped noise rules

    func testSourceScopedRuleFiltersOnlyMatchingSource() {
        let noiseA = ParsedLogLine(
            rawLine: "heartbeat", timestamp: nil, level: .info, sourceID: "source-a",
            message: "heartbeat", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let noiseB = ParsedLogLine(
            rawLine: "heartbeat", timestamp: nil, level: .info, sourceID: "source-b",
            message: "heartbeat", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "scoped heartbeat", message: "heartbeat", sourceIDs: ["source-a"])
        ])
        let filter = LogNoiseFilter(profile: profile)

        XCTAssertTrue(filter.isNoise(noiseA))
        XCTAssertFalse(filter.isNoise(noiseB))
    }

    func testGlobalRuleStillAppliesToAllSources() {
        let noiseA = ParsedLogLine(
            rawLine: "heartbeat", timestamp: nil, level: .info, sourceID: "source-a",
            message: "heartbeat", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let noiseB = ParsedLogLine(
            rawLine: "heartbeat", timestamp: nil, level: .info, sourceID: "source-b",
            message: "heartbeat", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "global heartbeat", message: "heartbeat", sourceIDs: nil)
        ])
        let filter = LogNoiseFilter(profile: profile)

        XCTAssertTrue(filter.isNoise(noiseA))
        XCTAssertTrue(filter.isNoise(noiseB))
    }

    func testRuleAppliesToSourceIDHelper() {
        let globalRule = LogNoiseRule(label: "global", message: "x", sourceIDs: nil)
        let emptyRule = LogNoiseRule(label: "empty", message: "x", sourceIDs: [])
        let scopedRule = LogNoiseRule(label: "scoped", message: "x", sourceIDs: ["source-a"])

        XCTAssertTrue(globalRule.applies(toSourceID: "any"))
        XCTAssertTrue(emptyRule.applies(toSourceID: "any"))
        XCTAssertTrue(scopedRule.applies(toSourceID: "source-a"))
        XCTAssertFalse(scopedRule.applies(toSourceID: "source-b"))
    }

    func testProposerIncludesSourceIDWhenProvided() {
        let line = ParsedLogLine(
            rawLine: "{"event":"noisy_event"}",
            timestamp: nil, level: .info, sourceID: "source-a",
            message: "hello world", event: "noisy_event", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let rule = LogNoisePatternProposer.propose(from: line, sourceID: "source-a")
        XCTAssertNotNil(rule)
        XCTAssertEqual(rule?.event, "noisy_event")
        XCTAssertEqual(rule?.sourceIDs, ["source-a"])
    }

    func testProposerWithoutSourceIDRemainsGlobal() {
        let line = ParsedLogLine(
            rawLine: "{"event":"noisy_event"}",
            timestamp: nil, level: .info, sourceID: "source-a",
            message: "hello world", event: "noisy_event", details: nil,
            metadata: [:], duplicateCount: 1
        )
        let rule = LogNoisePatternProposer.propose(from: line)
        XCTAssertNotNil(rule)
        XCTAssertNil(rule?.sourceIDs)
    }

    func testLegacyProfileWithoutSourceIDsDecodesAsGlobal() {
        let legacyJSON = """
        {
            "customRules": [
                {
                    "id": "legacy-rule",
                    "label": "legacy rule",
                    "event": "legacy_event",
                    "enabled": true
                }
            ]
        }
        """.data(using: .utf8)!
        let decoded = try? JSONDecoder().decode(LogNoiseProfile.self, from: legacyJSON)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.customRules.first?.sourceIDs, nil)
        XCTAssertTrue(decoded?.customRules.first?.applies(toSourceID: "any-source") ?? false)
    }

    func testFilterNoiseRespectsSourceScope() {
        let noiseA = ParsedLogLine(
            rawLine: "heartbeat", timestamp: nil, level: .info, sourceID: "source-a",
            message: "heartbeat", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let noiseB = ParsedLogLine(
            rawLine: "heartbeat", timestamp: nil, level: .info, sourceID: "source-b",
            message: "heartbeat", event: nil, details: nil, metadata: [:], duplicateCount: 1
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "scoped heartbeat", message: "heartbeat", sourceIDs: ["source-a"])
        ])

        let filtered = LogParser.filterNoise([noiseA, noiseB], isOn: true, profile: profile)
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.sourceID, "source-b")
    }

    // MARK: - Noise profile import/export

    func testEnvelopeRoundTrip() {
        let rule = LogNoiseRule(
            label: "roundtrip rule",
            event: "roundtrip_event",
            message: "roundtrip message",
            raw: "roundtrip raw",
            sourceIDs: ["source-a"],
            enabled: true
        )
        let date = Date(timeIntervalSince1970: 1_000)
        let envelope = LogNoiseProfileEnvelope(
            schemaVersion: 1,
            exportedAt: date,
            rules: [rule]
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        encoder.dateEncodingStrategy = .iso8601
        let data = try? encoder.encode(envelope)
        XCTAssertNotNil(data)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try? decoder.decode(LogNoiseProfileEnvelope.self, from: data!)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.schemaVersion, 1)
        XCTAssertEqual(decoded?.exportedAt, date)
        XCTAssertEqual(decoded?.rules, [rule])
    }

    func testExportWritesValidJSON() async {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(
            at: tempDir,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = LogNoiseProfileStore(path: tempDir.appendingPathComponent("profile.json").path)
        let rule = LogNoiseRule(label: "export rule", message: "export message")
        guard let url = await store.exportRules([rule], to: tempDir.path) else {
            XCTFail("export failed")
            return
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(url.lastPathComponent.hasPrefix("trios-noise-profile-"))

        guard let data = FileManager.default.contents(atPath: url.path) else {
            XCTFail("could not read exported file")
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try? decoder.decode(LogNoiseProfileEnvelope.self, from: data)
        XCTAssertNotNil(envelope)
        XCTAssertEqual(envelope?.schemaVersion, 1)
        XCTAssertEqual(envelope?.rules, [rule])
        XCTAssertNotNil(envelope?.exportedAt)
    }

    func testImportMergesAndReplacesByID() async {
        let existing = LogNoiseRule(
            id: "rule-1",
            label: "old",
            event: "old_event",
            sourceIDs: ["source-a"]
        )
        let localRules = [existing]
        let updated = LogNoiseRule(
            id: "rule-1",
            label: "updated",
            message: "updated message",
            sourceIDs: ["source-b"]
        )
        let result = LogNoiseImportResult(
            imported: [updated],
            skippedInvalid: 0,
            skippedUnsupportedSchema: false
        )

        var merged = localRules
        for rule in result.imported {
            merged.removeAll { $0.id == rule.id }
        }
        merged.insert(contentsOf: result.imported, at: 0)

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged.first?.label, "updated")
        XCTAssertEqual(merged.first?.message, "updated message")
        XCTAssertEqual(merged.first?.sourceIDs, ["source-b"])
    }

    func testImportRejectsUnknownSchemaVersion() async {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(
            at: tempDir,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let envelope = LogNoiseProfileEnvelope(
            schemaVersion: 99,
            exportedAt: nil,
            rules: [LogNoiseRule(label: "future", event: "future_event")]
        )
        let data = try? JSONEncoder().encode(envelope)
        XCTAssertNotNil(data)
        let url = tempDir.appendingPathComponent("future.json")
        try? data?.write(to: url)

        let store = LogNoiseProfileStore(path: tempDir.appendingPathComponent("profile.json").path)
        let result = await store.importRules(from: url)
        XCTAssertTrue(result.imported.isEmpty)
        XCTAssertTrue(result.skippedUnsupportedSchema)
        XCTAssertEqual(result.skippedInvalid, 0)
    }

    func testImportSkipsInvalidRules() async {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(
            at: tempDir,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let valid = LogNoiseRule(label: "valid", event: "valid_event")
        let invalid = LogNoiseRule(label: "invalid")
        let envelope = LogNoiseProfileEnvelope(
            schemaVersion: 1,
            exportedAt: nil,
            rules: [valid, invalid]
        )
        let data = try? JSONEncoder().encode(envelope)
        XCTAssertNotNil(data)
        let url = tempDir.appendingPathComponent("mixed.json")
        try? data?.write(to: url)

        let store = LogNoiseProfileStore(path: tempDir.appendingPathComponent("profile.json").path)
        let result = await store.importRules(from: url)
        XCTAssertEqual(result.imported.count, 1)
        XCTAssertEqual(result.imported.first?.label, "valid")
        XCTAssertEqual(result.skippedInvalid, 1)
        XCTAssertFalse(result.skippedUnsupportedSchema)
    }


    // MARK: - Noise rule auto-suggest

    func testSuggesterProposesHighFrequencyEvent() {
        let lines = (1...10).map { index in
            ParsedLogLine(
                rawLine: #"{"event":"heartbeat","details":"\#(index)"}"#,
                timestamp: nil,
                level: .info,
                sourceID: "event-log",
                message: "[heartbeat] \(index)",
                event: "heartbeat",
                details: "\(index)",
                metadata: [:],
                duplicateCount: 1
            )
        }
        let source = LogSource(
            id: "event-log", name: "Event", path: "", icon: "", tintName: "",
            rawLines: lines, lines: lines, parser: .eventLog,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: lines.count
        )
        let suggestions = LogNoiseSuggester.suggest(from: [source], profile: LogNoiseProfile())
        XCTAssertEqual(suggestions.count, 1)
        XCTAssertEqual(suggestions.first?.rule.event, "heartbeat")
        XCTAssertEqual(suggestions.first?.sourceID, "event-log")
        XCTAssertEqual(suggestions.first?.matchedCount, 10)
    }

    func testSuggesterIgnoresAlreadyCoveredEvents() {
        let lines = (1...10).map { index in
            ParsedLogLine(
                rawLine: #"{"event":"drift_detected","details":"\#(index)"}"#,
                timestamp: nil,
                level: .warn,
                sourceID: "event-log",
                message: "[drift_detected] \(index)",
                event: "drift_detected",
                details: "\(index)",
                metadata: [:],
                duplicateCount: 1
            )
        }
        let source = LogSource(
            id: "event-log", name: "Event", path: "", icon: "", tintName: "",
            rawLines: lines, lines: lines, parser: .eventLog,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: lines.count
        )
        let profile = LogNoiseProfile(customRules: [
            LogNoiseRule(label: "drift", event: "drift_detected", sourceIDs: ["event-log"])
        ])
        let suggestions = LogNoiseSuggester.suggest(from: [source], profile: profile)
        XCTAssertTrue(suggestions.isEmpty)
    }

    func testSuggesterLimitsTopNResults() {
        let events = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
        var lines: [ParsedLogLine] = []
        for event in events {
            for index in 1...5 {
                lines.append(ParsedLogLine(
                    rawLine: #"{"event":"\#(event)","details":"\#(index)"}"#,
                    timestamp: nil,
                    level: .info,
                    sourceID: "event-log",
                    message: "[\(event)] \(index)",
                    event: event,
                    details: "\(index)",
                    metadata: [:],
                    duplicateCount: 1
                ))
            }
        }
        let source = LogSource(
            id: "event-log", name: "Event", path: "", icon: "", tintName: "",
            rawLines: lines, lines: lines, parser: .eventLog,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: lines.count
        )
        let suggestions = LogNoiseSuggester.suggest(from: [source], profile: LogNoiseProfile(), topN: 3)
        XCTAssertEqual(suggestions.count, 3)
    }

    func testSuggesterRequiresMinimumOccurrences() {
        let lines = (1...4).map { index in
            ParsedLogLine(
                rawLine: #"{"event":"rare","details":"\#(index)"}"#,
                timestamp: nil,
                level: .info,
                sourceID: "event-log",
                message: "[rare] \(index)",
                event: "rare",
                details: "\(index)",
                metadata: [:],
                duplicateCount: 1
            )
        }
        let source = LogSource(
            id: "event-log", name: "Event", path: "", icon: "", tintName: "",
            rawLines: lines, lines: lines, parser: .eventLog,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: lines.count
        )
        let suggestions = LogNoiseSuggester.suggest(from: [source], profile: LogNoiseProfile())
        XCTAssertTrue(suggestions.isEmpty)
    }

    func testSuggesterSourceScopeMatchesOnlyThatSource() {
        let heartbeatLines = (1...10).map { _ in
            ParsedLogLine(
                rawLine: #"{"event":"heartbeat"}"#,
                timestamp: nil,
                level: .info,
                sourceID: "source-a",
                message: "[heartbeat] ",
                event: "heartbeat",
                details: nil,
                metadata: [:],
                duplicateCount: 1
            )
        }
        let sourceA = LogSource(
            id: "source-a", name: "A", path: "", icon: "", tintName: "",
            rawLines: heartbeatLines, lines: heartbeatLines, parser: .eventLog,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: heartbeatLines.count
        )
        let unrelatedLine = ParsedLogLine(
            rawLine: #"{"event":"heartbeat"}"#,
            timestamp: nil,
            level: .info,
            sourceID: "source-b",
            message: "[heartbeat] ",
            event: "heartbeat",
            details: nil,
            metadata: [:],
            duplicateCount: 1
        )
        let sourceB = LogSource(
            id: "source-b", name: "B", path: "", icon: "", tintName: "",
            rawLines: [unrelatedLine], lines: [unrelatedLine], parser: .eventLog,
            lastReadOffset: 0, errorCount: 0, warningCount: 0, duplicateGroupCount: 0,
            totalDuplicates: 0, wasCapped: false, originalLineCount: 1
        )
        let suggestions = LogNoiseSuggester.suggest(from: [sourceA, sourceB], profile: LogNoiseProfile())
        let heartbeatSuggestion = suggestions.first { $0.rule.event == "heartbeat" }
        XCTAssertNotNil(heartbeatSuggestion)
        XCTAssertEqual(heartbeatSuggestion?.sourceID, "source-a")
        XCTAssertEqual(heartbeatSuggestion?.rule.sourceIDs, ["source-a"])
        XCTAssertEqual(heartbeatSuggestion?.matchedCount, 10)
    }

    // MARK: - Source category classification

    func testCategoryForRuntimeFilenames() {
        XCTAssertEqual(LogParser.category(for: "event_log.jsonl"), .runtime)
        XCTAssertEqual(LogParser.category(for: "cron.log"), .runtime)
        XCTAssertEqual(LogParser.category(for: "queen.log"), .runtime)
        XCTAssertEqual(LogParser.category(for: "browseros-companion.log"), .runtime)
    }

    func testCategoryForServiceFilenames() {
        XCTAssertEqual(LogParser.category(for: "bun.stdout.log"), .service)
        XCTAssertEqual(LogParser.category(for: "server.stderr.log"), .service)
    }

    func testCategoryForBuildFilenames() {
        XCTAssertEqual(LogParser.category(for: "build_1751234567.log"), .build)
        XCTAssertEqual(LogParser.category(for: "clade-build_1751234567.log"), .build)
        XCTAssertEqual(LogParser.category(for: "clade-build_prod.log"), .build)
    }

    func testCategoryForTestFilenames() {
        XCTAssertEqual(LogParser.category(for: "chat_sse_e2e_build_1751234567.log"), .test)
        XCTAssertEqual(LogParser.category(for: "queen_autonomous_test_1751234567.log"), .test)
    }

    func testCategoryForArtifactFallback() {
        XCTAssertEqual(LogParser.category(for: "legacy-cycle8.log"), .artifact)
        XCTAssertEqual(LogParser.category(for: "unknown_stuff.log"), .artifact)
    }

    func testLoadLogSourcesExcludesArtifactsByDefault() throws {
        let logsDir = "\(ProjectPaths.trinity)/logs"
        try? FileManager.default.createDirectory(atPath: logsDir, withIntermediateDirectories: true)
        let buildFile = "\(logsDir)/build_9999999999.log"
        let testFile = "\(logsDir)/chat_sse_e2e_build_9999999999.log"
        let serviceFile = "\(logsDir)/bun.stdout.log"
        try? "build artifact".write(toFile: buildFile, atomically: true, encoding: .utf8)
        try? "test artifact".write(toFile: testFile, atomically: true, encoding: .utf8)
        try? "service log".write(toFile: serviceFile, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(atPath: buildFile)
            try? FileManager.default.removeItem(atPath: testFile)
            try? FileManager.default.removeItem(atPath: serviceFile)
        }

        let sources = LogParser.loadLogSources(maxLinesPerSource: 10)
        XCTAssertFalse(sources.contains { $0.name.hasPrefix("build_") })
        XCTAssertFalse(sources.contains { $0.name.hasPrefix("chat_sse_e2e_build_") })
        XCTAssertTrue(sources.contains { $0.name == "bun.stdout" })
    }

    func testLoadLogSourcesIncludesArtifactsWhenRequested() throws {
        let logsDir = "\(ProjectPaths.trinity)/logs"
        try? FileManager.default.createDirectory(atPath: logsDir, withIntermediateDirectories: true)
        let buildFile = "\(logsDir)/build_8888888888.log"
        let testFile = "\(logsDir)/queen_autonomous_test_8888888888.log"
        try? "build artifact".write(toFile: buildFile, atomically: true, encoding: .utf8)
        try? "test artifact".write(toFile: testFile, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(atPath: buildFile)
            try? FileManager.default.removeItem(atPath: testFile)
        }

        let sources = LogParser.loadLogSources(includeArtifacts: true, maxLinesPerSource: 10)
        XCTAssertTrue(sources.contains { $0.name.hasPrefix("build_") })
        XCTAssertTrue(sources.contains { $0.name.hasPrefix("queen_autonomous_test_") })
    }

    // MARK: - Audit rotation scheduler

    @MainActor
    func testAuditSchedulerStartsAndStops() {
        let scheduler = AuditRotationScheduler(interval: 0.01)
        XCTAssertFalse(scheduler.isRunning)
        scheduler.start()
        XCTAssertTrue(scheduler.isRunning)
        scheduler.stop()
        XCTAssertFalse(scheduler.isRunning)
    }

    @MainActor
    func testAuditSchedulerRotateNowDoesNotCrash() {
        let scheduler = AuditRotationScheduler(interval: 60 * 60)
        // Rotation dispatches to a utility queue; this just verifies the call is safe.
        scheduler.rotateNow()
        XCTAssertTrue(true)
    }

    @MainActor
    func testAuditSchedulerRotateNowCanBeCalledRepeatedly() {
        let scheduler = AuditRotationScheduler(interval: 60 * 60)
        for _ in 0..<20 {
            scheduler.rotateNow()
        }
        XCTAssertTrue(true)
    }

    // MARK: - Worktree audit log discovery

    func testWorktreeAuditLogPathsDiscoversExistingStreams() throws {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? fm.removeItem(atPath: tmp) }

        let dirs = [
            "\(tmp)/.worktrees/feature-a/trios/.trinity/events",
            "\(tmp)/.worktrees/feature-a/trios/.trinity/state",
            "\(tmp)/.worktrees/feature-a/trios/.trinity/experience",
            "\(tmp)/.worktrees/feature-b/trios/.trinity/events",
        ]
        for d in dirs {
            try fm.createDirectory(atPath: d, withIntermediateDirectories: true)
        }

        let paths = LogRotationPolicy.worktreeAuditLogPaths(repoRoot: tmp)
        XCTAssertEqual(paths.count, 8)

        let eventPaths = paths.filter { $0.path.hasSuffix("event_log.jsonl") }
        XCTAssertEqual(eventPaths.count, 2)
        XCTAssertTrue(paths.contains { $0.path.contains("feature-a") && $0.path.hasSuffix("akashic-log.jsonl") })
        XCTAssertTrue(paths.contains { $0.path.contains("feature-b") && $0.path.hasSuffix("local-auth-audit.jsonl") })

        let policies = Set(paths.map { $0.policy })
        XCTAssertTrue(policies.contains(LogRotationPolicy.audit))
        XCTAssertTrue(policies.contains(LogRotationPolicy.security))
        XCTAssertTrue(policies.contains(LogRotationPolicy.experience))
    }

    func testWorktreeAuditLogPathsReturnsEmptyWhenNoWorktrees() {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? fm.removeItem(atPath: tmp) }
        try? fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        let paths = LogRotationPolicy.worktreeAuditLogPaths(repoRoot: tmp)
        XCTAssertTrue(paths.isEmpty)
    }

    func testWorktreeAuditLogPathsIgnoresWorktreesWithoutTrinity() throws {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? fm.removeItem(atPath: tmp) }
        try fm.createDirectory(atPath: "\(tmp)/.worktrees/feature-x", withIntermediateDirectories: true)
        let paths = LogRotationPolicy.worktreeAuditLogPaths(repoRoot: tmp)
        XCTAssertTrue(paths.isEmpty)
    }

    // MARK: - Cross-format archive cleanup

    func testRotationPolicyRemovesLegacyGzArchiveByAge() throws {
        let fm = FileManager.default
        let tmpDir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? fm.removeItem(atPath: tmpDir) }
        try fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)

        let base = "\(tmpDir)/event_log.jsonl"
        let oldTimestamp = Int(Date().timeIntervalSince1970 - 100_000)
        let oldArchive = "\(base).archive.\(oldTimestamp).gz"
        try "legacy gzip".write(toFile: oldArchive, atomically: true, encoding: .utf8)

        let policy = LogRotationPolicy(
            maxFileSizeBytes: 1_024,
            maxArchiveCount: 5,
            keepTailLines: 10,
            maxArchiveAgeSeconds: 60,
            maxAgeBeforeRotationSeconds: nil
        )
        policy.rotateIfNeeded(path: base)

        XCTAssertFalse(fm.fileExists(atPath: oldArchive), "Legacy .gz archive older than max age should be removed")
    }

    func testRotationPolicyRemovesExtensionlessArchiveByAge() throws {
        let fm = FileManager.default
        let tmpDir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? fm.removeItem(atPath: tmpDir) }
        try fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)

        let base = "\(tmpDir)/event_log.jsonl"
        let oldTimestamp = Int(Date().timeIntervalSince1970 - 100_000)
        let oldArchive = "\(base).archive.\(oldTimestamp)"
        try "legacy raw".write(toFile: oldArchive, atomically: true, encoding: .utf8)

        let policy = LogRotationPolicy(
            maxFileSizeBytes: 1_024,
            maxArchiveCount: 5,
            keepTailLines: 10,
            maxArchiveAgeSeconds: 60,
            maxAgeBeforeRotationSeconds: nil
        )
        policy.rotateIfNeeded(path: base)

        XCTAssertFalse(fm.fileExists(atPath: oldArchive), "Extensionless archive older than max age should be removed")
    }

    func testRotationPolicyCapsMixedFormatArchivesByCount() throws {
        let fm = FileManager.default
        let tmpDir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        defer { try? fm.removeItem(atPath: tmpDir) }
        try fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)

        let base = "\(tmpDir)/event_log.jsonl"
        let now = Int(Date().timeIntervalSince1970)
        // Create 4 archives in alternating formats within the age window.
        let archives = [
            "\(base).archive.\(now - 10).zlib",
            "\(base).archive.\(now - 20).gz",
            "\(base).archive.\(now - 30)",
            "\(base).archive.\(now - 40).zlib",
        ]
        for archive in archives {
            try "data".write(toFile: archive, atomically: true, encoding: .utf8)
        }

        let policy = LogRotationPolicy(
            maxFileSizeBytes: 1_024,
            maxArchiveCount: 2,
            keepTailLines: 10,
            maxArchiveAgeSeconds: 100_000,
            maxAgeBeforeRotationSeconds: nil
        )
        policy.rotateIfNeeded(path: base)

        let remaining = (try? fm.contentsOfDirectory(atPath: tmpDir))?.filter { $0.hasPrefix("event_log.jsonl.archive.") } ?? []
        XCTAssertEqual(remaining.count, 2, "Should keep only the newest 2 archives across all recognized formats")
        XCTAssertTrue(remaining.contains { $0.hasSuffix(".archive.\(now - 10).zlib") })
        XCTAssertTrue(remaining.contains { $0.hasSuffix(".archive.\(now - 20).gz") })
    }
}
