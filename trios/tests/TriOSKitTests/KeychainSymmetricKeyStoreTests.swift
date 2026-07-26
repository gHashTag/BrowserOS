import CryptoKit
import Foundation
#if canImport(TriOSKit)
@testable import TriOSKit
#endif
import XCTest

final class KeychainSymmetricKeyStoreTests: XCTestCase {
    private let testKeyName = "trios-test-keychain-key-\(UUID().uuidString)"

    override func setUp() {
        super.setUp()
        try? KeychainSymmetricKeyStore.delete(keyName: testKeyName)
    }

    override func tearDown() {
        try? KeychainSymmetricKeyStore.delete(keyName: testKeyName)
        super.tearDown()
    }

    func testRoundTrip() throws {
        let key = SymmetricKey(size: .bits256)
        try KeychainSymmetricKeyStore.write(keyName: testKeyName, key: key)
        let read = try KeychainSymmetricKeyStore.read(keyName: testKeyName)
        XCTAssertNotNil(read)
        let readBytes = read!.withUnsafeBytes { Data($0) }
        let originalBytes = key.withUnsafeBytes { Data($0) }
        XCTAssertEqual(readBytes, originalBytes)
    }

    func testKeyPersistsAcrossInstances() throws {
        let key = SymmetricKey(size: .bits256)
        try KeychainSymmetricKeyStore.write(keyName: testKeyName, key: key)

        let first = try KeychainSymmetricKeyStore.read(keyName: testKeyName)
        let second = try KeychainSymmetricKeyStore.read(keyName: testKeyName)
        XCTAssertNotNil(first)
        XCTAssertNotNil(second)
        XCTAssertEqual(
            first!.withUnsafeBytes { Data($0) },
            second!.withUnsafeBytes { Data($0) }
        )
    }

    func testMissingKeyReturnsNil() throws {
        let read = try KeychainSymmetricKeyStore.read(keyName: testKeyName)
        XCTAssertNil(read)
    }

    func testDeleteRemovesKey() throws {
        let key = SymmetricKey(size: .bits256)
        try KeychainSymmetricKeyStore.write(keyName: testKeyName, key: key)
        XCTAssertNotNil(try KeychainSymmetricKeyStore.read(keyName: testKeyName))

        try KeychainSymmetricKeyStore.delete(keyName: testKeyName)
        XCTAssertNil(try KeychainSymmetricKeyStore.read(keyName: testKeyName))
    }

    func testLegacyFileMigration() throws {
        let fm = FileManager.default
        let directory = fm.temporaryDirectory
            .appendingPathComponent("trios-keychain-migration-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: directory) }

        let legacyKey = SymmetricKey(size: .bits256)
        let legacyURL = directory.appendingPathComponent("test.key")
        let legacyBytes = legacyKey.withUnsafeBytes { Data($0) }
        try legacyBytes.write(to: legacyURL)

        let migrated = try KeychainSymmetricKeyStore.migrateLegacyKeyIfNeeded(
            keyName: testKeyName,
            fileURL: legacyURL
        )
        XCTAssertNotNil(migrated)
        XCTAssertEqual(
            migrated!.withUnsafeBytes { Data($0) },
            legacyBytes
        )

        let fromKeychain = try KeychainSymmetricKeyStore.read(keyName: testKeyName)
        XCTAssertNotNil(fromKeychain)
        XCTAssertEqual(
            fromKeychain!.withUnsafeBytes { Data($0) },
            legacyBytes
        )
        XCTAssertFalse(fm.fileExists(atPath: legacyURL.path))
    }

    func testLegacyFileIgnoredWhenKeychainAlreadyExists() throws {
        let key = SymmetricKey(size: .bits256)
        try KeychainSymmetricKeyStore.write(keyName: testKeyName, key: key)

        let fm = FileManager.default
        let directory = fm.temporaryDirectory
            .appendingPathComponent("trios-keychain-migration-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: directory) }

        let differentLegacyKey = SymmetricKey(size: .bits256)
        let legacyURL = directory.appendingPathComponent("test.key")
        let differentBytes = differentLegacyKey.withUnsafeBytes { Data($0) }
        try differentBytes.write(to: legacyURL)

        let migrated = try KeychainSymmetricKeyStore.migrateLegacyKeyIfNeeded(
            keyName: testKeyName,
            fileURL: legacyURL
        )
        let originalBytes = key.withUnsafeBytes { Data($0) }
        XCTAssertEqual(
            migrated!.withUnsafeBytes { Data($0) },
            originalBytes
        )

        XCTAssertFalse(fm.fileExists(atPath: legacyURL.path))
    }
}
