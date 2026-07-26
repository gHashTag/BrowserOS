import XCTest
@testable import TriOSKit

/// In-memory token store for testing LocalAuthProvider persistence and refresh
/// behavior without touching the macOS Keychain.
actor MockLocalAuthTokenStore: LocalAuthTokenStore {
    var storedToken: String?
    var storedRefreshToken: String?
    private(set) var readCount = 0
    private(set) var writeCount = 0
    private(set) var refreshReadCount = 0
    private(set) var refreshWriteCount = 0
    nonisolated var shouldFailRead = false
    nonisolated var shouldFailWrite = false
    nonisolated var shouldFailRefreshRead = false
    nonisolated var shouldFailRefreshWrite = false

    func read() async throws -> String? {
        readCount += 1
        if shouldFailRead { throw LocalAuthError.fetchFailed(statusCode: nil) }
        return storedToken
    }

    func write(_ token: String) async throws {
        writeCount += 1
        if shouldFailWrite { throw LocalAuthError.keychainWriteFailed }
        storedToken = token
    }

    func delete() async throws {
        storedToken = nil
    }

    func readRefreshToken() async throws -> String? {
        refreshReadCount += 1
        if shouldFailRefreshRead { throw LocalAuthError.fetchFailed(statusCode: nil) }
        return storedRefreshToken
    }

    func writeRefreshToken(_ token: String) async throws {
        refreshWriteCount += 1
        if shouldFailRefreshWrite { throw LocalAuthError.keychainWriteFailed }
        storedRefreshToken = token
    }

    func deleteRefreshToken() async throws {
        storedRefreshToken = nil
    }
}

final class LocalAuthProviderTests: XCTestCase {

    private let baseURL = URL(string: "http://127.0.0.1:9999")!

    private func makeMockSession() -> URLSession {
        return URLSession(configuration: .mockProtocolConfiguration())
    }

    private func makeTokenResponse(
        _ token: String,
        refreshToken: String = "refresh-\(token)",
        expiresInSeconds: TimeInterval = 900
    ) -> Data {
        let issuedAt = ISO8601DateFormatter().string(from: Date())
        let expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(expiresInSeconds))
        let json = """
        {
            "token": "\(token)",
            "refreshToken": "\(refreshToken)",
            "issuedAt": "\(issuedAt)",
            "expiresAt": "\(expiresAt)",
            "expiresInSeconds": \(Int(expiresInSeconds)),
            "ttlSeconds": 900
        }
        """
        return json.data(using: .utf8)!
    }

    private func makeRefreshResponse(
        accessToken: String,
        refreshToken: String = "refresh-\(accessToken)",
        expiresInSeconds: TimeInterval = 900
    ) -> Data {
        let issuedAt = ISO8601DateFormatter().string(from: Date())
        let expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(expiresInSeconds))
        let json = """
        {
            "accessToken": "\(accessToken)",
            "refreshToken": "\(refreshToken)",
            "info": {
                "token": "\(accessToken)",
                "issuedAt": "\(issuedAt)",
                "expiresAt": "\(expiresAt)",
                "expiresInSeconds": \(Int(expiresInSeconds)),
                "ttlSeconds": 900
            }
        }
        """
        return json.data(using: .utf8)!
    }

    private func makeProvider(
        store: MockLocalAuthTokenStore = MockLocalAuthTokenStore(),
        monitor: LocalAuthMonitor = LocalAuthMonitor(),
        proactiveRefreshMaxAge: TimeInterval = LocalAuthMonitor.proactiveRefreshInterval
    ) -> LocalAuthProvider {
        LocalAuthProvider(
            baseURL: baseURL,
            session: makeMockSession(),
            tokenStore: store,
            monitor: monitor,
            proactiveRefreshMaxAge: proactiveRefreshMaxAge
        )
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        MockURLProtocol.chunkHandler = nil
        super.tearDown()
    }

    func testValidTokenReturnsMemoryCacheWithoutStoreOrNetwork() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("cached-token")

        let provider = makeProvider(store: store)

        // Prime the in-memory cache by fetching once.
        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "cached-token")

        // Second call must not touch the store or the network.
        let second = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(second, "cached-token")

        let readCount = await store.readCount
        let writeCount = await store.writeCount
        XCTAssertEqual(readCount, 1)
        XCTAssertEqual(writeCount, 1)
    }

    func testValidTokenFallsBackToStoreWhenMemoryCacheEmpty() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("keychain-token")

        let provider = makeProvider(store: store)

        let token = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(token, "keychain-token")

        let readCount = await store.readCount
        XCTAssertEqual(readCount, 1)
    }

    func testValidTokenFetchesFromServerAndPersistsToStore() async throws {
        let store = MockLocalAuthTokenStore()
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "\(self.baseURL.absoluteString)/auth/local-token")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("fresh-token"))
        }

        let provider = makeProvider(store: store)

        let token = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(token, "fresh-token")

        let stored = await store.storedToken
        let writeCount = await store.writeCount
        XCTAssertEqual(stored, "fresh-token")
        XCTAssertEqual(writeCount, 1)
    }

    func testForcedRefreshFetchesNewTokenAndUpdatesStore() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("old-token")

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("new-token"))
        }

        let provider = makeProvider(store: store)

        // Prime cache with the old token.
        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "old-token")

        // Force refresh should hit the server and overwrite the store.
        let second = try await provider.validToken(forcingRefresh: true)
        XCTAssertEqual(second, "new-token")

        let stored = await store.storedToken
        let writeCount = await store.writeCount
        XCTAssertEqual(stored, "new-token")
        XCTAssertEqual(writeCount, 2)
    }

    func testConcurrentRefreshesAreDeduplicatedIntoSingleFetch() async throws {
        let store = MockLocalAuthTokenStore()
        var fetchCount = 0
        MockURLProtocol.requestHandler = { request in
            fetchCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("shared-token"))
        }

        let provider = makeProvider(store: store)

        async let a = provider.validToken(forcingRefresh: true)
        async let b = provider.validToken(forcingRefresh: true)
        async let c = provider.validToken(forcingRefresh: true)

        let results = try await [a, b, c]
        results.forEach { XCTAssertEqual($0, "shared-token") }

        XCTAssertEqual(fetchCount, 1)
        let writeCount = await store.writeCount
        XCTAssertEqual(writeCount, 1)
    }

    func testStoreReadFailureFallsThroughToNetworkFetch() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("ignored-token")
        store.shouldFailRead = true

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("network-token"))
        }

        let provider = makeProvider(store: store)

        let token = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(token, "network-token")
    }

    func testStoreWriteFailureStillReturnsFetchedToken() async throws {
        let store = MockLocalAuthTokenStore()
        store.shouldFailWrite = true

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("ephemeral-token"))
        }

        let provider = makeProvider(store: store)

        let token = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(token, "ephemeral-token")
    }

    func testNetworkFailureReportsStatusCodeInError() async {
        let store = MockLocalAuthTokenStore()
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 503,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let monitor = LocalAuthMonitor()
        let provider = makeProvider(store: store, monitor: monitor)

        do {
            _ = try await provider.validToken(forcingRefresh: false)
            XCTFail("Expected LocalAuthError.fetchFailed")
        } catch let error as LocalAuthError {
            XCTAssertEqual(error, .fetchFailed(statusCode: 503))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        let (_, meta) = await monitor.status()
        XCTAssertFalse(meta.isHealthy)
        XCTAssertEqual(meta.lastFailureReason, "http_503")
    }

    func testProactiveRefreshTriggersWhenTokenIsStale() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("stale-token")

        var fetchCount = 0
        MockURLProtocol.requestHandler = { request in
            fetchCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("fresh-token"))
        }

        let monitor = LocalAuthMonitor()
        // Prime the cache; then a threshold of 0 forces proactive refresh.
        let provider = makeProvider(store: store, monitor: monitor, proactiveRefreshMaxAge: 0)
        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "stale-token")

        let second = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(second, "fresh-token")
        XCTAssertEqual(fetchCount, 1)

        let (_, meta) = await monitor.status()
        XCTAssertEqual(meta.refreshCount, 1)
    }

    func testProactiveRefreshDoesNotTriggerForFreshToken() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("fresh-token")

        var fetchCount = 0
        MockURLProtocol.requestHandler = { request in
            fetchCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("other-token"))
        }

        let provider = makeProvider(store: store, proactiveRefreshMaxAge: 600)
        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "fresh-token")

        let second = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(second, "fresh-token")
        XCTAssertEqual(fetchCount, 0)
    }

    func testResetClearsCacheStoreAndMonitor() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("cached-token")
        await store.writeRefreshToken("cached-refresh")

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("refetched-token"))
        }

        let monitor = LocalAuthMonitor()
        let provider = makeProvider(store: store, monitor: monitor)

        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "cached-token")

        await provider.resetLocalAuth()

        let stored = await store.storedToken
        let storedRefresh = await store.storedRefreshToken
        XCTAssertNil(stored)
        XCTAssertNil(storedRefresh)

        let (state, meta) = await monitor.status()
        XCTAssertEqual(state, .unknown)
        XCTAssertEqual(meta.refreshCount, 0)
        XCTAssertNil(meta.fetchedAt)
    }

    func testBootstrapStoresRefreshToken() async throws {
        let store = MockLocalAuthTokenStore()
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "\(self.baseURL.absoluteString)/auth/local-token")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, self.makeTokenResponse("access", refreshToken: "refresh"))
        }

        let provider = makeProvider(store: store)
        let token = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(token, "access")

        let storedRefresh = await store.storedRefreshToken
        XCTAssertEqual(storedRefresh, "refresh")
        XCTAssertEqual(await store.refreshWriteCount, 1)
    }

    func testProactiveRefreshUsesRefreshEndpointWhenRefreshTokenStored() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("stale-access")
        await store.writeRefreshToken("stored-refresh")

        var requestPaths: [String] = []
        MockURLProtocol.requestHandler = { request in
            requestPaths.append(request.url?.absoluteString ?? "")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            if request.url?.path == "/auth/refresh" {
                return (response, self.makeRefreshResponse(accessToken: "fresh-access", refreshToken: "fresh-refresh"))
            }
            return (response, self.makeTokenResponse("fallback-access"))
        }

        let monitor = LocalAuthMonitor()
        let provider = makeProvider(store: store, monitor: monitor, proactiveRefreshMaxAge: 0)

        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "stale-access")

        let second = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(second, "fresh-access")

        XCTAssertEqual(requestPaths, ["\(baseURL.absoluteString)/auth/refresh"])

        let storedRefresh = await store.storedRefreshToken
        XCTAssertEqual(storedRefresh, "fresh-refresh")

        let (_, meta) = await monitor.status()
        XCTAssertEqual(meta.refreshCount, 1)
    }

    func testRefreshFamilyRevokedFallsBackToBootstrap() async throws {
        let store = MockLocalAuthTokenStore()
        await store.write("stale-access")
        await store.writeRefreshToken("stored-refresh")

        var requestPaths: [String] = []
        MockURLProtocol.requestHandler = { request in
            requestPaths.append(request.url?.absoluteString ?? "")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: request.url?.path == "/auth/refresh" ? 401 : 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            if request.url?.path == "/auth/refresh" {
                return (response, Data())
            }
            return (response, self.makeTokenResponse("bootstrapped-access", refreshToken: "bootstrapped-refresh"))
        }

        let monitor = LocalAuthMonitor()
        let provider = makeProvider(store: store, monitor: monitor, proactiveRefreshMaxAge: 0)

        let first = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(first, "stale-access")

        let second = try await provider.validToken(forcingRefresh: false)
        XCTAssertEqual(second, "bootstrapped-access")

        XCTAssertEqual(requestPaths.sorted(), ["\(baseURL.absoluteString)/auth/local-token", "\(baseURL.absoluteString)/auth/refresh"].sorted())

        let (_, meta) = await monitor.status()
        XCTAssertEqual(meta.lastFailureReason, "refresh_family_revoked")
    }
}
