import Foundation
#if canImport(TriOSKit)
@testable import TriOSKit
#endif
import XCTest

final class MemoryStoreEncryptionTests: XCTestCase {
    private let fileManager = FileManager.default
    private var directory: URL!
    private var databaseURL: URL!
    private var encryptedURL: URL!

    override func setUp() {
        super.setUp()
        directory = fileManager.temporaryDirectory
            .appendingPathComponent("trios-sqlcipher-memory-\(UUID().uuidString)", isDirectory: true)
        databaseURL = directory.appendingPathComponent("agent-memory.sqlite3")
        encryptedURL = directory.appendingPathComponent("agent-memory.sqlite3.enc")
        try? fileManager.removeItem(at: directory)
    }

    override func tearDown() {
        super.tearDown()
        try? fileManager.removeItem(at: directory)
    }

    func testSQLCipherDatabaseIsNotPlaintext() async throws {
        let store = try MemoryStore(databaseURL: databaseURL, encryptedURL: encryptedURL)
        let record = AgentMemoryRecord(
            id: UUID(),
            conversationId: UUID(),
            sourceMessageId: UUID(),
            body: "Recall: encryptionprobe\nGoal: verify SQLCipher encrypted memory storage",
            createdAt: Date(timeIntervalSince1970: 100)
        )
        try await store.saveMemory(record)
        await store.close()

        XCTAssertTrue(fileManager.fileExists(atPath: databaseURL.path))
        let header = try Data(contentsOf: databaseURL, options: .mappedIfSafe)
        XCTAssertFalse(
            header.starts(with: "SQLite format 3".data(using: .utf8)!),
            "SQLCipher database must not begin with the plaintext SQLite magic header"
        )
        let text = String(data: header, encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("encryptionprobe"), "encrypted file must not contain plaintext token")
    }

    func testSQLCipherRoundTrip() async throws {
        let conversationId = UUID()
        let record = AgentMemoryRecord(
            id: UUID(),
            conversationId: conversationId,
            sourceMessageId: UUID(),
            body: "Recall: roundtripprobe\nGoal: memory survives SQLCipher close and reopen",
            createdAt: Date(timeIntervalSince1970: 200)
        )

        let store = try MemoryStore(databaseURL: databaseURL, encryptedURL: encryptedURL)
        try await store.saveMemory(record)
        await store.close()

        let reloaded = try MemoryStore(databaseURL: databaseURL, encryptedURL: encryptedURL)
        let candidates = try await reloaded.memoryCandidates(for: "roundtripprobe", limit: 10)
        XCTAssertTrue(candidates.contains { $0.id == record.id })
        await reloaded.close()
    }

    func testLegacyEncryptedSnapshotMigratesToSQLCipher() async throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacy = try createLegacyPlaintextDatabase(at: databaseURL)
        sqlite3_close(legacy)

        // Produce the Cycle 12 encrypted snapshot and remove the plaintext file.
        let plaintext = try Data(contentsOf: databaseURL)
        let snapshot = try TriOSEncryption.memory.encrypt(plaintext)
        try snapshot.write(to: encryptedURL, options: .atomic)
        try fileManager.removeItem(at: databaseURL)

        let store = try MemoryStore(databaseURL: databaseURL, encryptedURL: encryptedURL)
        let candidates = try await store.memoryCandidates(for: "legacyprobe", limit: 10)
        XCTAssertTrue(candidates.contains { $0.body.contains("legacy value") })
        await store.close()

        XCTAssertTrue(fileManager.fileExists(atPath: databaseURL.path))
        let header = try Data(contentsOf: databaseURL, options: .mappedIfSafe)
        XCTAssertFalse(header.starts(with: "SQLite format 3".data(using: .utf8)!))
        XCTAssertFalse(fileManager.fileExists(atPath: encryptedURL.path), "legacy .enc snapshot should be removed after migration")
    }

    func testSQLCipherRejectsWrongKey() async throws {
        let store = try MemoryStore(databaseURL: databaseURL, encryptedURL: encryptedURL)
        let record = AgentMemoryRecord(
            id: UUID(),
            conversationId: UUID(),
            sourceMessageId: UUID(),
            body: "Recall: wrongkeyprobe\nGoal: wrong key must not decrypt",
            createdAt: Date(timeIntervalSince1970: 300)
        )
        try await store.saveMemory(record)
        await store.close()

        let wrongKey = String(repeating: "ab", count: 32)
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        let openResult = sqlite3_open_v2(databaseURL.path, &handle, flags, nil)
        XCTAssertEqual(openResult, SQLITE_OK, "open should succeed before keying")
        defer { if let handle { sqlite3_close_v2(handle) } }

        let keyPragma = "PRAGMA key = \"x'\(wrongKey)'\""
        var errorPointer: UnsafeMutablePointer<CChar>?
        let keyResult = sqlite3_exec(handle, keyPragma, nil, nil, &errorPointer)
        sqlite3_free(errorPointer)
        XCTAssertEqual(keyResult, SQLITE_OK, "setting a wrong key should not fail immediately")

        var verifyStmt: OpaquePointer?
        let verifySQL = "SELECT count(*) FROM sqlite_master"
        let prepareResult = sqlite3_prepare_v2(handle, verifySQL, -1, &verifyStmt, nil)
        if prepareResult == SQLITE_OK, let verifyStmt {
            let stepResult = sqlite3_step(verifyStmt)
            sqlite3_finalize(verifyStmt)
            XCTAssertNotEqual(stepResult, SQLITE_ROW, "reading with wrong key should not succeed")
        }
    }

    private func createLegacyPlaintextDatabase(at url: URL) throws -> OpaquePointer {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        let result = sqlite3_open_v2(url.path, &handle, flags, nil)
        guard result == SQLITE_OK, let handle else {
            throw NSError(domain: "MemoryStoreEncryptionTests", code: 1)
        }
        var errorPointer: UnsafeMutablePointer<CChar>?
        let schema = """
            CREATE TABLE memories (
                id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                source_message_id TEXT NOT NULL UNIQUE,
                body TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            PRAGMA user_version = 1;
            INSERT INTO memories (id, conversation_id, source_message_id, body, created_at)
            VALUES ('\(UUID().uuidString)', '\(UUID().uuidString)', '\(UUID().uuidString)',
                    'Recall: legacyprobe\nGoal: legacy value', 1.0);
            """
        let exec = sqlite3_exec(handle, schema, nil, nil, &errorPointer)
        guard exec == SQLITE_OK else {
            sqlite3_close_v2(handle)
            throw NSError(domain: "MemoryStoreEncryptionTests", code: 2)
        }
        return handle
    }

}
