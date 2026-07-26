import CryptoKit
import XCTest
@testable import TriOSKit

final class TriOSEncryptionTests: XCTestCase {
    private var temporaryKeyURL: URL!

    override func setUp() {
        super.setUp()
        let fm = FileManager.default
        temporaryKeyURL = fm.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("key")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: temporaryKeyURL)
        super.tearDown()
    }

    func testRoundTrip() throws {
        let encryption = TriOSEncryption(keyURL: temporaryKeyURL)
        let plaintext = Data("hello, trios encryption".utf8)
        let sealed = try encryption.encrypt(plaintext)
        XCTAssertNotEqual(sealed, plaintext)
        let opened = try encryption.decrypt(sealed)
        XCTAssertEqual(opened, plaintext)
    }

    func testTamperDetection() throws {
        let encryption = TriOSEncryption(keyURL: temporaryKeyURL)
        let plaintext = Data("sensitive telemetry".utf8)
        var sealed = try encryption.encrypt(plaintext)
        sealed[sealed.count - 1] ^= 0xFF
        XCTAssertThrowsError(try encryption.decrypt(sealed)) { error in
            XCTAssertTrue(error is TriOSEncryptionError)
        }
    }

    func testKeyPersistsAcrossInstances() throws {
        let first = TriOSEncryption(keyURL: temporaryKeyURL)
        let plaintext = Data("cross-instance key".utf8)
        let sealed = try first.encrypt(plaintext)

        let second = TriOSEncryption(keyURL: temporaryKeyURL)
        let opened = try second.decrypt(sealed)
        XCTAssertEqual(opened, plaintext)
    }

    func testDifferentKeysProduceDifferentCiphertext() throws {
        let keyA = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("key")
        let keyB = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("key")
        defer {
            try? FileManager.default.removeItem(at: keyA)
            try? FileManager.default.removeItem(at: keyB)
        }

        let encryptionA = TriOSEncryption(keyURL: keyA)
        let encryptionB = TriOSEncryption(keyURL: keyB)
        let plaintext = Data("same plaintext".utf8)
        let sealedA = try encryptionA.encrypt(plaintext)
        let sealedB = try encryptionB.encrypt(plaintext)
        XCTAssertNotEqual(sealedA, sealedB)
    }

    func testNamedKeyCreatesKeyFile() throws {
        let keyName = "test-\(UUID().uuidString)"
        let encryption = TriOSEncryption(keyName: keyName)
        let plaintext = Data("named key test".utf8)
        _ = try encryption.encrypt(plaintext)

        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let keyURL = appSupport
            .appendingPathComponent("trios/keys", isDirectory: true)
            .appendingPathComponent("\(keyName).key")
        // Named keys now live in the macOS Keychain; legacy files should not remain.
        XCTAssertFalse(fm.fileExists(atPath: keyURL.path))
        try? fm.removeItem(at: keyURL)
    }

    func testNamedKeyRoundTripUsesKeychain() throws {
        let keyName = "test-keychain-roundtrip-\(UUID().uuidString)"
        defer {
            try? KeychainSymmetricKeyStore.delete(keyName: keyName)
        }

        let first = TriOSEncryption(keyName: keyName)
        let plaintext = Data("keychain backed encryption".utf8)
        let sealed = try first.encrypt(plaintext)

        let second = TriOSEncryption(keyName: keyName)
        let opened = try second.decrypt(sealed)
        XCTAssertEqual(opened, plaintext)
    }

    func testNamedKeyMigratesLegacyFile() throws {
        let keyName = "test-keychain-migration-\(UUID().uuidString)"
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let keyDir = appSupport.appendingPathComponent("trios/keys", isDirectory: true)
        try? fm.createDirectory(at: keyDir, withIntermediateDirectories: true)
        let legacyURL = keyDir.appendingPathComponent("\(keyName).key")
        defer {
            try? KeychainSymmetricKeyStore.delete(keyName: keyName)
            try? fm.removeItem(at: legacyURL)
        }

        let legacyKey = SymmetricKey(size: .bits256)
        let legacyBytes = legacyKey.withUnsafeBytes { Data($0) }
        try legacyBytes.write(to: legacyURL)

        let encryption = TriOSEncryption(keyName: keyName)
        let plaintext = Data("migrated legacy key".utf8)
        let sealed = try encryption.encrypt(plaintext)

        let second = TriOSEncryption(keyName: keyName)
        let opened = try second.decrypt(sealed)
        XCTAssertEqual(opened, plaintext)
        XCTAssertFalse(fm.fileExists(atPath: legacyURL.path))
    }
}
