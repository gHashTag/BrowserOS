import XCTest
@testable import TriOSKit

@MainActor
final class CladeGuardTests: XCTestCase {
    private var tempDir: String!

    override func setUp() {
        super.setUp()
        let pid = ProcessInfo.processInfo.processIdentifier
        let ts = Date().timeIntervalSince1970
        tempDir = NSTemporaryDirectory() + "trios_clade_guard_\(pid)_\(ts)"
        try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        if let tempDir {
            try? FileManager.default.removeItem(atPath: tempDir)
        }
        tempDir = nil
        super.tearDown()
    }

    func testVerifyChecksumMissingSidecarReturnsFalse() {
        let snapshot = "\(tempDir!)/snapshot.bin"
        writeFile(snapshot, data: Data("missing sidecar".utf8))
        let guard_ = CladeGuard(
            sovereignHealthURL: deadHealthURL(),
            canaryHealthURL: deadHealthURL(),
            snapshotDir: tempDir
        )
        XCTAssertFalse(guard_.verifyChecksum(snapshot))
    }

    func testVerifyChecksumMismatchReturnsFalse() {
        let snapshot = "\(tempDir!)/snapshot.bin"
        writeFile(snapshot, data: Data("mismatch".utf8))
        let bogusHash = String(repeating: "0", count: 64)
        writeFile("\(snapshot).sha256", data: Data(bogusHash.utf8))
        let guard_ = CladeGuard(
            sovereignHealthURL: deadHealthURL(),
            canaryHealthURL: deadHealthURL(),
            snapshotDir: tempDir
        )
        XCTAssertFalse(guard_.verifyChecksum(snapshot))
    }

    func testVerifyChecksumMatchingHashReturnsTrue() {
        let snapshot = "\(tempDir!)/snapshot.bin"
        let data = Data("matching hash".utf8)
        writeFile(snapshot, data: data)
        // SHA-256 of "matching hash" computed out-of-band.
        let hash = "5e29fd98ba40d255992bb4e107df8f39f11178cbc8d317c38fa115ebf9cfda23"
        writeFile("\(snapshot).sha256", data: Data(hash.utf8))
        let guard_ = CladeGuard(
            sovereignHealthURL: deadHealthURL(),
            canaryHealthURL: deadHealthURL(),
            snapshotDir: tempDir
        )
        XCTAssertTrue(guard_.verifyChecksum(snapshot))
    }

    private func writeFile(_ path: String, data: Data) {
        do {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            XCTFail("Failed to write test file: \(error)")
        }
    }

    private func deadHealthURL() -> URL {
        URL(string: "http://127.0.0.1:0/health") ?? URL(fileURLWithPath: "/dev/null")
    }
}
