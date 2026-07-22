// T27-CANON: clade_guard_test.swift
// Domain: Kernel
// Task: CLADEGUARD-001
// Claim: claim-CLADEGUARD-001
// Issue: #T27-EPIC-001
// Spec: trios/.trinity/specs/clade-guard.md
// Status: test
//
// Standalone unit tests for CladeGuard.verifyChecksum.
//
// Run (from trios root), consistent with the no-SPM / TDD-inside-build model:
//   swiftc tests/swift/clade_guard_test.swift BR-OUTPUT/CladeGuard.swift -o /tmp/clade_guard_test && /tmp/clade_guard_test
//
// Exits non-zero on the first failed assertion.

import Foundation

// MARK: - Test-only minimal stubs for standalone compilation
//
// This test exercises verifyChecksum in isolation. The real dependency graph
// (ProjectPaths, HealthCheckTransport, ChatProtocols, etc.) is deliberately
// stubbed here so the spec's exact two-file compile command succeeds without
// dragging in the entire Swift module tree.

enum ProjectPaths {
    static var trinity: String {
        FileManager.default.currentDirectoryPath + "/.trinity"
    }
    static var browserOSHealthURL: String {
        "http://127.0.0.1:0/health"
    }
    static var canaryHealthURL: String {
        "http://127.0.0.1:0/health"
    }
    static var triosBinary: String {
        FileManager.default.currentDirectoryPath + "/trios_app"
    }
    static var appBundle: String {
        FileManager.default.currentDirectoryPath + "/trios.app"
    }
}

actor HealthCheckTransport {
    private let healthURL: URL
    init(healthURL: URL = URL(string: ProjectPaths.browserOSHealthURL)!) {
        self.healthURL = healthURL
    }
    func check() async -> Bool {
        false
    }
}

// MARK: - Tests

@main
enum CladeGuardTests {
    static var failures = 0

    static func check(_ cond: Bool, _ name: String) {
        if cond {
            print("ok   - \(name)")
        } else {
            print("FAIL - \(name)")
            failures += 1
        }
    }

    @MainActor
    static func main() {
        testMissingSidecarReturnsFalse()
        testMismatchReturnsFalse()
        testMatchingHashReturnsTrue()

        if failures == 0 {
            print("\nAll CladeGuard tests passed.")
            exit(0)
        } else {
            print("\n\(failures) test(s) failed.")
            exit(1)
        }
    }

    @MainActor
    static func testMissingSidecarReturnsFalse() {
        let tmp = makeTempDir()
        defer { cleanup(tmp) }
        let snapshot = "\(tmp)/snapshot.bin"
        writeFile(snapshot, data: "missing sidecar".data(using: .utf8)!)
        let cg = CladeGuard(
            sovereignHealthURL: deadHealthURL(),
            canaryHealthURL: deadHealthURL(),
            snapshotDir: tmp
        )
        check(!cg.verifyChecksum(snapshot), "verifyChecksum missing sidecar returns false")
    }

    @MainActor
    static func testMismatchReturnsFalse() {
        let tmp = makeTempDir()
        defer { cleanup(tmp) }
        let snapshot = "\(tmp)/snapshot.bin"
        let data = "mismatch".data(using: .utf8)!
        writeFile(snapshot, data: data)
        let bogusHash = String(repeating: "0", count: 64)
        writeFile("\(snapshot).sha256", data: bogusHash.data(using: .utf8)!)
        let cg = CladeGuard(
            sovereignHealthURL: deadHealthURL(),
            canaryHealthURL: deadHealthURL(),
            snapshotDir: tmp
        )
        check(!cg.verifyChecksum(snapshot), "verifyChecksum mismatch returns false")
    }

    @MainActor
    static func testMatchingHashReturnsTrue() {
        let tmp = makeTempDir()
        defer { cleanup(tmp) }
        let snapshot = "\(tmp)/snapshot.bin"
        let data = "matching hash".data(using: .utf8)!
        writeFile(snapshot, data: data)
        // SHA-256 of "matching hash" computed out-of-band.
        let hash = "5e29fd98ba40d255992bb4e107df8f39f11178cbc8d317c38fa115ebf9cfda23"
        writeFile("\(snapshot).sha256", data: hash.data(using: .utf8)!)
        let cg = CladeGuard(
            sovereignHealthURL: deadHealthURL(),
            canaryHealthURL: deadHealthURL(),
            snapshotDir: tmp
        )
        check(cg.verifyChecksum(snapshot), "verifyChecksum matching hash returns true")
    }

    static func makeTempDir() -> String {
        let tmp = NSTemporaryDirectory() + "trios_clade_guard_\(getpid())_\(Date().timeIntervalSince1970)"
        try! FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        return tmp
    }

    static func cleanup(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    static func writeFile(_ path: String, data: Data) {
        try! data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    static func deadHealthURL() -> URL {
        URL(string: "http://127.0.0.1:0/health")!
    }
}
