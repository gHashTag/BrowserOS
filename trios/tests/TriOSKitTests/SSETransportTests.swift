import XCTest
@testable import TriOSKit

/// URLProtocol subclass that intercepts requests and returns a canned response.
final class MockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    static var chunkHandler: ((URLRequest) throws -> (HTTPURLResponse, [Data]))?

    override class func canInit(with request: URLRequest) -> Bool {
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        if let chunkHandler = MockURLProtocol.chunkHandler {
            do {
                let (response, chunks) = try chunkHandler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                for chunk in chunks {
                    client?.urlProtocol(self, didLoad: chunk)
                }
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
            return
        }
        guard let handler = MockURLProtocol.requestHandler else {
            // Fail the REQUEST, never the process. requestHandler is a shared
            // static that other suites set and clear, so a request already in
            // flight can arrive here after somebody's tearDown has nilled it.
            // As a fatalError that killed the whole run: 121 tests became a
            // truncated log ending in signal 5, and everything scheduled after
            // SSETransportTests never executed. As an error it is one failing
            // test, in the suite that actually leaked the request.
            client?.urlProtocol(self, didFailWithError: NSError(
                domain: "MockURLProtocol", code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "requestHandler is not set: a request reached the mock "
                    + "after its handler was cleared - \(request.url?.absoluteString ?? "no url")"]
            ))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

extension URLSessionConfiguration {
    static func mockProtocolConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.protocolClasses = [MockURLProtocol.self]
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.httpShouldSetCookies = false
        return config
    }
}

/// Test-only local-auth provider that returns a fixed token synchronously.
actor MockLocalAuthProvider: LocalAuthProviding {
    let token: String?

    init(token: String?) {
        self.token = token
    }

    func validToken(forcingRefresh: Bool) async throws -> String? {
        token
    }
}

/// A provider that always throws, used to verify graceful degradation.
actor ThrowingLocalAuthProvider: LocalAuthProviding {
    func validToken(forcingRefresh: Bool) async throws -> String? {
        // fetchFailed carries the status that caused it; nil means the fetch
        // never reached a response, which is what this stub simulates.
        throw LocalAuthError.fetchFailed(statusCode: nil)
    }
}

/// Provider that returns different tokens depending on whether a refresh is
/// requested, so we can assert the retry path rebuilds the request.
actor RefreshingMockLocalAuthProvider: LocalAuthProviding {
    var cachedToken: String
    var refreshedToken: String
    private(set) var refreshCallCount = 0

    init(cachedToken: String, refreshedToken: String) {
        self.cachedToken = cachedToken
        self.refreshedToken = refreshedToken
    }

    func validToken(forcingRefresh: Bool) async throws -> String? {
        if forcingRefresh {
            refreshCallCount += 1
            return refreshedToken
        }
        return cachedToken
    }
}

final class SSETransportTests: XCTestCase {

    private let serverURL = URL(string: "http://127.0.0.1:9999/chat")!

    private func makeMockSession() -> URLSession {
        return URLSession(configuration: .mockProtocolConfiguration())
    }

    private func makeRetrier() -> NetworkRetrier {
        NetworkRetrier(policy: NetworkRetryPolicy(
            maxAttempts: 1,
            baseDelay: 0,
            maxDelay: 0,
            exponentialBackoff: false,
            retryableURLErrorCodes: [],
            extraShouldRetry: nil
        ))
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        MockURLProtocol.chunkHandler = nil
        super.tearDown()
    }

    // MARK: - cancel()

    func testCancelReplacesSession() async {
        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier()
        )

        // Capture the identity of the initial session.
        let firstSession = await transport.session
        let firstIdentity = ObjectIdentifier(firstSession)

        await transport.cancel()

        let secondSession = await transport.session
        let secondIdentity = ObjectIdentifier(secondSession)

        XCTAssertNotEqual(firstIdentity, secondIdentity)
    }

    // MARK: - non-2xx response

    func testSendMessageThrowsServerErrorForNon2xxResponse() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 503,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, "Service Unavailable".data(using: .utf8)!)
        }

        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier()
        )

        do {
            _ = try await transport.sendMessage(body: Data("{}".utf8))
            XCTFail("Expected TransportError.serverError to be thrown")
        } catch let error as TransportError {
            // serverError carries four values - status, body, url, retryAfter.
            // Matching three made the compiler fail to even describe the
            // mismatch, which is why this read as a compiler bug.
            if case .serverError(let statusCode, let bodySample, _, _) = error {
                XCTAssertEqual(statusCode, 503)
                XCTAssertEqual(bodySample, "Service Unavailable")
            } else {
                XCTFail("Expected serverError, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - 200 SSE stream

    func testSendMessageYieldsEventFromSSEStream() async throws {
        let eventLine = "data: {\"type\":\"text-start\",\"id\":\"msg-1\"}\n"
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, eventLine.data(using: .utf8)!)
        }

        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier()
        )

        let stream = try await transport.sendMessage(body: Data("{}".utf8))
        var events: [SSEEvent] = []
        for await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first, .textStart(id: "msg-1"))
    }

    // MARK: - partial chunk splitting

    func testSendMessageYieldsCompleteChunkFromSplitSSEData() async throws {
        let first = "data: {\"type\":\"text-delta\",\"id\":\"1\",\"delta\":\"hel"
        let second = "lo\"}\n\n"
        MockURLProtocol.chunkHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, [first.data(using: .utf8)!, second.data(using: .utf8)!])
        }

        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier()
        )

        let stream = try await transport.sendMessage(body: Data("{}".utf8))
        var events: [SSEEvent] = []
        for await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first, .textDelta(id: "1", delta: "hello"))
    }

    // MARK: - Local authorization header

    func testSendMessageAttachesLocalAuthToken() async throws {
        let eventLine = "data: {\"type\":\"text-start\",\"id\":\"msg-1\"}\n"
        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, eventLine.data(using: .utf8)!)
        }

        let provider = MockLocalAuthProvider(token: "test-token-abc")
        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier(),
            localAuthProvider: provider
        )

        _ = try await transport.sendMessage(body: Data("{}".utf8))

        XCTAssertEqual(
            capturedRequest?.value(forHTTPHeaderField: "X-TriOS-Local-Auth"),
            "test-token-abc"
        )
    }

    func testSendMessageOmitsLocalAuthHeaderWithoutProvider() async throws {
        let eventLine = "data: {\"type\":\"text-start\",\"id\":\"msg-1\"}\n"
        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, eventLine.data(using: .utf8)!)
        }

        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier()
        )

        _ = try await transport.sendMessage(body: Data("{}".utf8))

        XCTAssertNil(capturedRequest?.value(forHTTPHeaderField: "X-TriOS-Local-Auth"))
    }

    func testSendMessageProceedsWhenTokenFetchFails() async throws {
        let eventLine = "data: {\"type\":\"text-start\",\"id\":\"msg-1\"}\n"
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, eventLine.data(using: .utf8)!)
        }

        let provider = ThrowingLocalAuthProvider()
        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier(),
            localAuthProvider: provider
        )

        let stream = try await transport.sendMessage(body: Data("{}".utf8))
        var events: [SSEEvent] = []
        for await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
    }

    // MARK: - 403 local-auth refresh

    func testSendMessageRetriesOn403WithRefreshedToken() async throws {
        let eventLine = "data: {\"type\":\"text-start\",\"id\":\"msg-1\"}\n"
        var requests: [URLRequest] = []
        var callCount = 0
        MockURLProtocol.requestHandler = { request in
            requests.append(request)
            callCount += 1
            if callCount == 1 {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 403,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, "Forbidden".data(using: .utf8)!)
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            return (response, eventLine.data(using: .utf8)!)
        }

        let provider = RefreshingMockLocalAuthProvider(
            cachedToken: "stale-token",
            refreshedToken: "fresh-token"
        )
        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier(),
            localAuthProvider: provider
        )

        let stream = try await transport.sendMessage(body: Data("{}".utf8))
        var events: [SSEEvent] = []
        for await event in stream {
            events.append(event)
        }

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests.first?.value(forHTTPHeaderField: "X-TriOS-Local-Auth"),
            "stale-token"
        )
        XCTAssertEqual(
            requests.last?.value(forHTTPHeaderField: "X-TriOS-Local-Auth"),
            "fresh-token"
        )

        let refreshCount = await provider.refreshCallCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testSendMessageFailsWhen403PersistsAfterRefresh() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 403,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, "Forbidden".data(using: .utf8)!)
        }

        let provider = RefreshingMockLocalAuthProvider(
            cachedToken: "stale-token",
            refreshedToken: "also-stale"
        )
        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier(),
            localAuthProvider: provider
        )

        do {
            _ = try await transport.sendMessage(body: Data("{}".utf8))
            XCTFail("Expected TransportError.serverError(403)")
        } catch let error as TransportError {
            if case .serverError(let statusCode, _, _, _) = error {
                XCTAssertEqual(statusCode, 403)
            } else {
                XCTFail("Expected serverError, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        let refreshCount = await provider.refreshCallCount
        XCTAssertEqual(refreshCount, 1)
    }

    func testSendMessageDoesNotRefreshOn503() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 503,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, "Service Unavailable".data(using: .utf8)!)
        }

        let provider = RefreshingMockLocalAuthProvider(
            cachedToken: "token",
            refreshedToken: "refreshed"
        )
        let transport = SSETransport(
            serverURL: serverURL,
            session: makeMockSession(),
            retrier: makeRetrier(),
            localAuthProvider: provider
        )

        do {
            _ = try await transport.sendMessage(body: Data("{}".utf8))
            XCTFail("Expected TransportError.serverError(503)")
        } catch let error as TransportError {
            if case .serverError(let statusCode, _, _, _) = error {
                XCTAssertEqual(statusCode, 503)
            } else {
                XCTFail("Expected serverError, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        let refreshCount = await provider.refreshCallCount
        XCTAssertEqual(refreshCount, 0)
    }
}
