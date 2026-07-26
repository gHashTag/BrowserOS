import Foundation
import XCTest
@testable import TriOSKit

final class SessionRecoveryPackageEncryptionTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("trios-recovery-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeRequest(
        activeConversationID: UUID = UUID(),
        redactionCount: Int = 0,
        logSources: [SessionRecoveryLogSource] = []
    ) -> SessionRecoveryPackageRequest {
        let message = SessionRecoveryMessage(
            id: UUID(),
            role: "user",
            content: "Test message content for Cycle 14 recovery encryption.",
            timestamp: Date(),
            isStreaming: false,
            segments: [],
            toolCalls: [],
            task: nil
        )
        let conversation = SessionRecoveryConversation(
            id: activeConversationID,
            title: "Cycle 14 Test Conversation",
            updatedAt: Date(),
            messages: [message]
        )
        let browserContext = SessionRecoveryBrowserContext(
            status: "idle",
            pageID: nil,
            messages: [],
            toolCalls: []
        )
        let runtimeContext = SessionRecoveryRuntimeContext(
            appName: "TriOS",
            appVersion: "1.0.0",
            buildVariant: "test",
            osVersion: "macOS 15",
            projectRoot: tempDir.path,
            activeConversationID: activeConversationID,
            provider: "test-provider",
            model: "test-model",
            baseURL: "http://127.0.0.1:9105",
            credentialStatus: "keychain",
            inputTokens: 10,
            outputTokens: 20,
            includesEstimate: false,
            triosServerReachable: true,
            browserOSConnected: true,
            cdpPort: "9222",
            draft: "",
            encryptionScheme: "local-aes256-gcm-v1",
            encryptionKeyPath: nil
        )
        return SessionRecoveryPackageRequest(
            activeConversationID: activeConversationID,
            conversations: [conversation],
            browserContext: browserContext,
            runtimeContext: runtimeContext,
            initialRedactionCount: redactionCount,
            logSources: logSources,
            includeSystemProcessLog: false
        )
    }

    // MARK: - Tests

    func testEncryptedRoundTrip() throws {
        let request = makeRequest()
        let writer = SessionRecoveryPackageWriter()
        let archiveURL = tempDir.appendingPathComponent("round-trip.triosrecovery")

        let result = try writer.write(request: request, to: archiveURL)
        XCTAssertEqual(result.archiveURL.pathExtension.lowercased(), "triosrecovery")
        XCTAssertGreaterThan(result.archiveSize, 0)

        let imported = try SessionRecoveryPackageReader.read(from: result.archiveURL)
        XCTAssertEqual(imported.packageID, request.packageID)
        XCTAssertEqual(imported.activeConversationID, request.activeConversationID)
        XCTAssertEqual(imported.conversations.count, 1)
        XCTAssertEqual(imported.conversations.first?.messages.first?.content, request.conversations.first?.messages.first?.content)
    }

    func testArchiveBytesAreNotPlaintextZIP() throws {
        let request = makeRequest()
        let writer = SessionRecoveryPackageWriter()
        let archiveURL = tempDir.appendingPathComponent("encrypted.triosrecovery")

        _ = try writer.write(request: request, to: archiveURL)
        let data = try Data(contentsOf: archiveURL)
        // A plaintext ZIP starts with the "PK" magic bytes.
        XCTAssertFalse(data.starts(with: [0x50, 0x4B]))
    }

    func testLegacyPlaintextZipIsStillReadable() throws {
        let request = makeRequest()
        let writer = SessionRecoveryPackageWriter()
        let encryptedURL = tempDir.appendingPathComponent("legacy-compat.triosrecovery")

        _ = try writer.write(request: request, to: encryptedURL)
        let encryptedData = try Data(contentsOf: encryptedURL)
        let plaintextData = try TriOSEncryption.recovery.decrypt(encryptedData)

        let legacyURL = tempDir.appendingPathComponent("legacy-compat.zip")
        try plaintextData.write(to: legacyURL, options: .atomic)

        let imported = try SessionRecoveryPackageReader.read(from: legacyURL)
        XCTAssertEqual(imported.packageID, request.packageID)
        XCTAssertEqual(imported.conversations.count, 1)
    }

    func testManifestIntegrityAfterEncryption() throws {
        let request = makeRequest(redactionCount: 3)
        let writer = SessionRecoveryPackageWriter()
        let archiveURL = tempDir.appendingPathComponent("manifest.triosrecovery")

        let result = try writer.write(request: request, to: archiveURL)
        let imported = try SessionRecoveryPackageReader.read(from: result.archiveURL)
        XCTAssertEqual(imported.packageID, request.packageID)
        XCTAssertEqual(imported.conversations.count, request.conversations.count)
    }

    func testTamperedEncryptedPackageFails() throws {
        let request = makeRequest()
        let writer = SessionRecoveryPackageWriter()
        let archiveURL = tempDir.appendingPathComponent("tampered.triosrecovery")

        _ = try writer.write(request: request, to: archiveURL)
        var data = try Data(contentsOf: archiveURL)
        // Corrupt a byte well inside the combined sealed box.
        let offset = min(data.count / 2, data.count - 1)
        data[offset] = data[offset] ^ 0xFF
        try data.write(to: archiveURL, options: .atomic)

        XCTAssertThrowsError(try SessionRecoveryPackageReader.read(from: archiveURL)) { error in
            guard let readerError = error as? SessionRecoveryPackageReaderError else {
                XCTFail("Expected SessionRecoveryPackageReaderError")
                return
            }
            switch readerError {
            case .decryptionFailed:
                break
            default:
                XCTFail("Expected decryptionFailed, got \(readerError)")
            }
        }
    }
}
