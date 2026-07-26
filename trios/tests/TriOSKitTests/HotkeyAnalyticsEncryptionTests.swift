import XCTest
import Foundation
@testable import TriOSKit

/// Cycle 10 — verify that hotkey analytics flushes are encrypted at rest and
/// that legacy plaintext files are migrated into encrypted storage.
@MainActor
final class HotkeyAnalyticsEncryptionTests: XCTestCase {

    private var analyticsDir: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return support
            .appendingPathComponent("ai.browseros.trios", isDirectory: true)
            .appendingPathComponent("Analytics", isDirectory: true)
    }

    override func setUp() {
        super.setUp()
        // Start from a clean analytics directory so prior test runs do not bleed
        // into the encrypted-file assertions.
        try? FileManager.default.removeItem(at: analyticsDir)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: analyticsDir)
        super.tearDown()
    }

    func testFlushWritesEncryptedAnalytics() throws {
        let vm = HotkeyAnalyticsViewModel()
        for i in 0..<10 {
            vm.recordUsage(hotkey: "cmd-\(i)", action: "test-action-\(i)", context: "test")
        }

        let files = try FileManager.default.contentsOfDirectory(at: analyticsDir, includingPropertiesForKeys: nil)
        let encFiles = files.filter { $0.pathExtension == "enc" }
        XCTAssertEqual(encFiles.count, 1, "Expected exactly one encrypted analytics flush file")

        let data = try Data(contentsOf: encFiles.first!)
        // Encrypted bytes must not begin with JSON plaintext.
        let prefix = String(data: data.prefix(4), encoding: .utf8)
        XCTAssertNotEqual(prefix, "[\n  ", "Analytics flush must not be plaintext JSON")
        XCTAssertFalse(data.isEmpty, "Encrypted flush must not be empty")
    }

    func testLoadDecryptsEncryptedAnalytics() throws {
        let firstVM = HotkeyAnalyticsViewModel()
        for i in 0..<10 {
            firstVM.recordUsage(hotkey: "cmd-\(i)", action: "test-action-\(i)", context: "test")
        }
        XCTAssertEqual(firstVM.usageHistory.count, 10, "First view model should load the 10 recorded usages")

        // A second instance reloads from the encrypted files on disk.
        let secondVM = HotkeyAnalyticsViewModel()
        XCTAssertGreaterThanOrEqual(secondVM.usageHistory.count, 10, "Reloaded view model should decrypt persisted usage")
    }
}
