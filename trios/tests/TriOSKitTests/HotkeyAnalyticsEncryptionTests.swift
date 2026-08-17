import XCTest
import Foundation
@testable import TriOSKit

/// Cycle 10 -- these tests were written to prove that hotkey analytics flushes
/// are encrypted at rest. They have never once made that claim, and they cannot
/// make it now. The subject is gone and the assertion cannot be restored, so
/// they skip loudly instead of being quietly rewritten into something passable.
///
/// What happened, in order:
///
///   1. `HotkeyAnalyticsViewModel` lived in `BR-OUTPUT/HotkeyAnalytics.swift`.
///      This file was added alongside it and named it directly.
///   2. The XCTest target never compiled, so neither did this file. The
///      assertions below were never executed and never reported a verdict.
///   3. 2026-07-31, commit 939028c91 ("remove 16 non-whitelisted BR-OUTPUT
///      prototypes") deleted `HotkeyAnalytics.swift` and moved it to
///      `.archive/BR-OUTPUT-prototypes/HotkeyAnalytics.swift`. Nothing in the
///      product references hotkey analytics today; only the `hotkeyAnalytics`
///      UI label survives, in `i18nManager.swift`.
///
/// The verdict these tests would have delivered, recovered by reading the
/// subject instead of running it: THEY WOULD HAVE FAILED. Every revision of
/// `HotkeyAnalytics.swift` that ever existed (851f97d45, 0ffca73e1, 5ca201c44,
/// a9c59ecea, 939028c91) wrote its flush like this:
///
///     let fileURL = analyticsDirectory
///         .appendingPathComponent("usage_\(Date().timeIntervalSince1970).json")
///     let data = try encoder.encode(usageBuffer)
///     try data.write(to: fileURL)
///
/// Plaintext JSON, extension `.json`, no encryption on any code path. Cycle 10
/// encrypted the other at-rest surfaces and missed this one, and the only check
/// that would have said so could not be built. The exposure is moot now only
/// because the feature was deleted, not because it was ever fixed.
///
/// What should happen to this file, rather than leaving it to rot as a skip:
///
///   - If hotkey analytics is NOT coming back: delete this file. Nothing is
///     lost that this comment does not already record.
///   - If it IS coming back: restore the subject, encrypt `flushBuffer()` with
///     the same helper the rest of Cycle 10 uses, restore the two bodies
///     preserved verbatim below, and delete this skip. Expect the first run to
///     be red -- that is the bug this file was written to catch.
///
/// This is deliberately a skip and not a pass. A skipped test is visible in
/// every run; a test rewritten until it compiles would report success for a
/// guarantee that was never true.
@MainActor
final class HotkeyAnalyticsEncryptionTests: XCTestCase {

    private static let subjectDeleted = """
    HotkeyAnalyticsViewModel was deleted in 939028c91 (moved to \
    .archive/BR-OUTPUT-prototypes/HotkeyAnalytics.swift). This test asserted \
    hotkey analytics are encrypted at rest; no revision of the subject ever \
    encrypted them, so the assertion cannot be restored against live code. \
    See the file comment before deleting or reviving this.
    """

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
        throw XCTSkip(Self.subjectDeleted)

        // Preserved verbatim. Restore with the subject; do not weaken.
        //
        //   let vm = HotkeyAnalyticsViewModel()
        //   for i in 0..<10 {
        //       vm.recordUsage(hotkey: "cmd-\(i)", action: "test-action-\(i)", context: "test")
        //   }
        //
        //   let files = try FileManager.default.contentsOfDirectory(at: analyticsDir, includingPropertiesForKeys: nil)
        //   let encFiles = files.filter { $0.pathExtension == "enc" }
        //   XCTAssertEqual(encFiles.count, 1, "Expected exactly one encrypted analytics flush file")
        //
        //   let data = try Data(contentsOf: encFiles.first!)
        //   // Encrypted bytes must not begin with JSON plaintext.
        //   let prefix = String(data: data.prefix(4), encoding: .utf8)
        //   XCTAssertNotEqual(prefix, "[\n  ", "Analytics flush must not be plaintext JSON")
        //   XCTAssertFalse(data.isEmpty, "Encrypted flush must not be empty")
    }

    func testLoadDecryptsEncryptedAnalytics() throws {
        throw XCTSkip(Self.subjectDeleted)

        // Preserved verbatim. Restore with the subject; do not weaken.
        //
        //   let firstVM = HotkeyAnalyticsViewModel()
        //   for i in 0..<10 {
        //       firstVM.recordUsage(hotkey: "cmd-\(i)", action: "test-action-\(i)", context: "test")
        //   }
        //   XCTAssertEqual(firstVM.usageHistory.count, 10, "First view model should load the 10 recorded usages")
        //
        //   // A second instance reloads from the encrypted files on disk.
        //   let secondVM = HotkeyAnalyticsViewModel()
        //   XCTAssertGreaterThanOrEqual(secondVM.usageHistory.count, 10, "Reloaded view model should decrypt persisted usage")
    }
}
