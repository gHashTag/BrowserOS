import Foundation
import XCTest
@testable import TriOSKit

final class VolatilityHistoryStoreTests: XCTestCase {
    private var store: VolatilityHistoryStore!
    private var fileURL: URL!
    private var keyURL: URL!

    override func setUp() async throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("warmup-volatility.json.enc")
        keyURL = dir.appendingPathComponent("test.key")
        store = VolatilityHistoryStore(
            encryption: TriOSEncryption(keyURL: keyURL),
            fileURL: fileURL
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    func testLoadReturnsNilWhenFileMissing() async {
        let records = await store.load()
        XCTAssertNil(records)
    }

    func testSaveAndLoadRoundTrip() async {
        let candidate = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let records: [String: WarmupVolatilityRecord] = [
            candidate.stableKey: WarmupVolatilityRecord(
                outcomes: [true, false, true],
                windowSize: 10,
                updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
            )
        ]

        await store.save(records)
        let loaded = await store.load()

        XCTAssertEqual(loaded?.count, 1)
        XCTAssertEqual(loaded?[candidate.stableKey]?.outcomes, [true, false, true])
        XCTAssertEqual(loaded?[candidate.stableKey]?.windowSize, 10)
    }

    func testSavedFileIsEncrypted() async throws {
        let candidate = CrossProviderModelCandidate(
            provider: .openai,
            baseURL: "https://api.openai.com",
            model: "gpt-4o-mini"
        )
        let records: [String: WarmupVolatilityRecord] = [
            candidate.stableKey: WarmupVolatilityRecord(
                outcomes: [false, true],
                windowSize: 10,
                updatedAt: Date()
            )
        ]

        await store.save(records)

        let data = try Data(contentsOf: fileURL)
        let plaintextPrefix = Data("{".utf8)
        XCTAssertFalse(data.starts(with: plaintextPrefix))
    }

    func testResetDeletesFile() async {
        let candidate = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let records: [String: WarmupVolatilityRecord] = [
            candidate.stableKey: WarmupVolatilityRecord(
                outcomes: [true],
                windowSize: 10,
                updatedAt: Date()
            )
        ]

        await store.save(records)
        await store.reset()

        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        let loaded = await store.load()
        XCTAssertNil(loaded)
    }

    func testLoadDiscardsCorruptCiphertext() async throws {
        let corrupt = Data("not encrypted".utf8)
        try corrupt.write(to: fileURL)

        let loaded = await store.load()
        XCTAssertNil(loaded)
    }

    func testSaveOverwritesPreviousData() async {
        let candidate = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )

        await store.save([
            candidate.stableKey: WarmupVolatilityRecord(
                outcomes: [true],
                windowSize: 10,
                updatedAt: Date()
            )
        ])
        await store.save([
            candidate.stableKey: WarmupVolatilityRecord(
                outcomes: [false, false],
                windowSize: 10,
                updatedAt: Date()
            )
        ])

        let loaded = await store.load()
        XCTAssertEqual(loaded?[candidate.stableKey]?.outcomes, [false, false])
    }

    func testKindAwareRecordRoundTrip() async {
        let candidate = CrossProviderModelCandidate(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            model: "claude-sonnet-4-5"
        )
        let records: [String: WarmupVolatilityRecord] = [
            candidate.stableKey: WarmupVolatilityRecord(
                successes: 3,
                failures: 2,
                failureKinds: [
                    .rateLimit: 1,
                    .auth: 1
                ],
                windowSize: 10,
                updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
            )
        ]

        await store.save(records)
        let loaded = await store.load()

        XCTAssertEqual(loaded?.count, 1)
        XCTAssertEqual(loaded?[candidate.stableKey]?.successes, 3)
        XCTAssertEqual(loaded?[candidate.stableKey]?.failures, 2)
        XCTAssertEqual(loaded?[candidate.stableKey]?.failureKinds?["rateLimit"], 1)
        XCTAssertEqual(loaded?[candidate.stableKey]?.failureKinds?["auth"], 1)
    }
}
