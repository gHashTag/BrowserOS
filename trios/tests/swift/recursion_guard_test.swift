// T27-CANON: recursion_guard_test.swift
// Domain: Kernel
// Task: RECURSION-001
// Issue: #T27-EPIC-001
// Spec: trios/.trinity/specs/recursion-guard.md
// Status: test
//
// Standalone unit tests for RecursionGuard singleton primitives.
//
// Run (from trios root), consistent with the no-SPM / TDD-inside-build model:
//   swiftc tests/swift/recursion_guard_test.swift BR-OUTPUT/ProjectPaths.swift -o /tmp/recursion_guard_test && /tmp/recursion_guard_test
//
// Exits non-zero on the first failed assertion.
//
// Note: cross-process crash-safety (INV-4) is covered by the spec integration
// tests T-3/T-4 and the clade-monitor watchdog ring; this file unit-tests the
// lock primitives and ProjectPaths reconciliation that RecursionGuard relies on.

import Foundation

@main
enum RecursionGuardTests {
    static var failures = 0

    static func check(_ cond: Bool, _ name: String) {
        if cond {
            print("ok   - \(name)")
        } else {
            print("FAIL - \(name)")
            failures += 1
        }
    }

    static func main() {
        testProjectPaths()
        testLockFileLifecycle()
        testStaleLockRecovery()

        if failures == 0 {
            print("\nAll RecursionGuard tests passed.")
            exit(0)
        } else {
            print("\n\(failures) test(s) failed.")
            exit(1)
        }
    }

    // MARK: - Path reconciliation tests

    static func testProjectPaths() {
        check(ProjectPaths.singletonLockFile.hasSuffix(".trinity/run/trios_singleton.lock"),
              "singletonLockFile is resolved under .trinity/run")
        check(ProjectPaths.singletonPIDFile.hasSuffix(".trinity/run/trios_singleton.pid"),
              "singletonPIDFile is resolved under .trinity/run")
        check(!ProjectPaths.singletonLockFile.contains("/tmp/"),
              "singletonLockFile is not hardcoded under /tmp")
        check(!ProjectPaths.singletonPIDFile.contains("/tmp/"),
              "singletonPIDFile is not hardcoded under /tmp")
        check(ProjectPaths.bundleIdentifier == "com.browseros.trios",
              "bundleIdentifier matches spec")
    }

    // MARK: - POSIX advisory lock lifecycle tests

    /// Verifies the lock helper creates the file, acquires the lock, and releases
    /// it when the descriptor is closed. This is the local-process component of
    /// INV-4 crash safety; the cross-process component is exercised by the spec
    /// integration tests and clade-monitor watchdog behavior.
    static func testLockFileLifecycle() {
        let lockPath = NSTemporaryDirectory() + "trios_recursion_guard_lifecycle_\(getpid()).lock"
        defer { try? FileManager.default.removeItem(atPath: lockPath) }

        // First acquisition must succeed and create the lock file.
        guard let fd1 = acquireLock(at: lockPath) else {
            check(false, "first lock acquisition succeeds")
            return
        }
        check(FileManager.default.fileExists(atPath: lockPath),
              "lock file is created on first acquisition")

        // Closing the descriptor releases the lock.
        close(fd1)

        // A subsequent acquisition on the now-free file must succeed.
        guard let fd2 = acquireLock(at: lockPath) else {
            check(false, "second lock acquisition succeeds after first release")
            return
        }
        close(fd2)
        check(true, "second lock acquisition succeeds after first release")
    }

    /// Simulates crash recovery: a lock file exists with no living holder, so a
    /// new trios launch must be able to acquire it.
    static func testStaleLockRecovery() {
        let lockPath = NSTemporaryDirectory() + "trios_recursion_guard_stale_\(getpid()).lock"
        defer { try? FileManager.default.removeItem(atPath: lockPath) }

        // Create an empty lock file (as if a crashed process left it behind).
        do {
            try Data().write(to: URL(fileURLWithPath: lockPath), options: .atomic)
        } catch {
            check(false, "created stale lock file")
            return
        }

        guard let fd = acquireLock(at: lockPath) else {
            check(false, "acquire lock on stale lock file")
            return
        }
        close(fd)
        check(true, "acquire lock on stale lock file")
    }

    // MARK: - Lock helper

    /// Attempts to acquire an exclusive POSIX advisory write lock on `path`.
    /// Returns the owning file descriptor on success, nil on failure.
    static func acquireLock(at path: String) -> Int32? {
        let fd = open(path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        var lock = flock()
        lock.l_type   = Int16(F_WRLCK)
        lock.l_whence = Int16(SEEK_SET)
        lock.l_start  = 0
        lock.l_len    = 0
        lock.l_pid    = 0
        if fcntl(fd, F_SETLK, &lock) == 0 {
            return fd
        }
        close(fd)
        return nil
    }
}
