import XCTest
@testable import TriOSKit

final class LocalAuthMonitorTests: XCTestCase {

    private var monitor: LocalAuthMonitor!

    override func setUp() {
        super.setUp()
        monitor = LocalAuthMonitor()
    }

    override func tearDown() {
        monitor = nil
        super.tearDown()
    }

    func testInitialStatusIsUnknownAndHealthy() async {
        let (state, meta) = await monitor.status()
        XCTAssertEqual(state, .unknown)
        XCTAssertTrue(meta.isHealthy)
        XCTAssertNil(meta.fetchedAt)
        XCTAssertEqual(meta.refreshCount, 0)
        XCTAssertEqual(meta.retry403Count, 0)
    }

    func testRecordFetchSuccessUpdatesMetadata() async {
        await monitor.recordFetchSuccess()

        let (state, meta) = await monitor.status()
        XCTAssertEqual(state, .cached)
        XCTAssertTrue(meta.isHealthy)
        XCTAssertEqual(meta.refreshCount, 1)
        XCTAssertNotNil(meta.fetchedAt)
    }

    func testRecordFailureMarksUnhealthyAndStoresReason() async {
        await monitor.recordFailure(reason: "http_503")

        let (state, meta) = await monitor.status()
        XCTAssertEqual(state, .failed)
        XCTAssertFalse(meta.isHealthy)
        XCTAssertEqual(meta.lastFailureReason, "http_503")
        XCTAssertNotNil(meta.lastFailureAt)
    }

    func testRecord403RetryIncrementsCounter() async {
        await monitor.record403Retry()
        await monitor.record403Retry()

        let (_, meta) = await monitor.status()
        XCTAssertEqual(meta.retry403Count, 2)
    }

    func testRecordResetClearsAllMetadata() async {
        await monitor.recordFetchSuccess()
        await monitor.record403Retry()
        await monitor.recordFailure(reason: "http_503")

        await monitor.recordReset()

        let (state, meta) = await monitor.status()
        XCTAssertEqual(state, .unknown)
        XCTAssertTrue(meta.isHealthy)
        XCTAssertNil(meta.fetchedAt)
        XCTAssertNil(meta.lastFailureAt)
        XCTAssertNil(meta.lastFailureReason)
        XCTAssertEqual(meta.refreshCount, 0)
        XCTAssertEqual(meta.retry403Count, 0)
    }

    func testRecordFamilyRevokedMarksUnhealthyAndLogsEvent() async throws {
        await monitor.recordFamilyRevoked()

        let (state, meta) = await monitor.status()
        XCTAssertEqual(state, .failed)
        XCTAssertFalse(meta.isHealthy)
        XCTAssertEqual(meta.lastFailureReason, "refresh_family_revoked")
        XCTAssertNotNil(meta.lastFailureAt)

        let auditURL = URL(fileURLWithPath: "\(ProjectPaths.trinity)/state/local-auth-audit.jsonl")
        defer {
            try? FileManager.default.removeItem(at: auditURL)
        }
        let content = try String(contentsOf: auditURL, encoding: .utf8)
        XCTAssertTrue(content.contains("family.revoked"))
    }

    func testShouldProactivelyRefreshWhenNeverFetched() async {
        let shouldRefresh = await monitor.shouldProactivelyRefresh(maxAge: 300)
        XCTAssertTrue(shouldRefresh)
    }

    func testShouldProactivelyRefreshWhenStale() async {
        await monitor.recordFetchSuccess()
        // Back-date fetchedAt so the token appears stale.
        let shouldRefresh = await monitor.shouldProactivelyRefresh(maxAge: -1)
        XCTAssertTrue(shouldRefresh)
    }

    func testShouldNotProactivelyRefreshWhenFresh() async {
        await monitor.recordFetchSuccess()
        let shouldRefresh = await monitor.shouldProactivelyRefresh(maxAge: 600)
        XCTAssertFalse(shouldRefresh)
    }

    func testAuditLogDoesNotContainTokenValue() async throws {
        let monitor = LocalAuthMonitor()
        await monitor.recordFetchSuccess()

        let auditURL = URL(fileURLWithPath: "\(ProjectPaths.trinity)/state/local-auth-audit.jsonl")
        defer {
            try? FileManager.default.removeItem(at: auditURL)
        }

        let content = try String(contentsOf: auditURL, encoding: .utf8)
        XCTAssertFalse(content.isEmpty)
        XCTAssertFalse(content.contains("secret-token"))
        XCTAssertTrue(content.contains("fetch.success"))
    }
}
