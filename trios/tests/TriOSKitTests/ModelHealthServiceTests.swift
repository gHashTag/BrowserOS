import XCTest
@testable import TriOSKit

final class ModelHealthServiceTests: XCTestCase {
    private let baseURL = "https://api.example.com/v1"
    private let model = "claude-test"

    override func setUp() {
        super.setUp()
        MockURLProtocol.requestHandler = nil
        MockURLProtocol.chunkHandler = nil
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        MockURLProtocol.chunkHandler = nil
        super.tearDown()
    }

    private func makeMockSession() -> URLSession {
        URLSession(configuration: .mockProtocolConfiguration())
    }

    func testHealthyProbeReturnsLatency() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertEqual(result.health, .healthy)
        XCTAssertNotNil(result.latencyMs)
        XCTAssertGreaterThan(result.latencyMs ?? 0, 0)
    }

    func testUnavailableProbeRecordsLatency() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        guard case .unavailable = result.health else {
            XCTFail("Expected unavailable health")
            return
        }
        XCTAssertNotNil(result.latencyMs)
        XCTAssertGreaterThan(result.latencyMs ?? 0, 0)
    }

    func testCachedResultReturnsSameLatency() async {
        var requestCount = 0
        MockURLProtocol.requestHandler = { request in
            requestCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let first = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )
        let second = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertEqual(first.health, .healthy)
        XCTAssertEqual(second.health, .healthy)
        XCTAssertEqual(first.latencyMs, second.latencyMs)
        XCTAssertEqual(requestCount, 1, "Second probe should be served from cache")
    }

    func testOllamaProbeLatency() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let body = [
                "models": [
                    ["name": "llama3.1"],
                    ["name": "qwen3"]
                ]
            ] as [String: Any]
            let data = try! JSONSerialization.data(withJSONObject: body)
            return (response, data)
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: "llama3.1",
            provider: .ollama,
            baseURL: "http://127.0.0.1:11434",
            apiKey: nil
        )

        XCTAssertEqual(result.health, .healthy)
        XCTAssertNotNil(result.latencyMs)
        XCTAssertGreaterThan(result.latencyMs ?? 0, 0)
    }

    func testHealthyQuotaHeadersParsed() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "x-ratelimit-remaining-requests": "42",
                    "x-ratelimit-remaining-tokens": "9000"
                ]
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertEqual(result.health, .healthy)
        guard case .healthy(let requests, let tokens) = result.quota else {
            XCTFail("Expected healthy quota")
            return
        }
        XCTAssertEqual(requests, 42)
        XCTAssertEqual(tokens, 9000)
    }

    func testLowQuotaHeadersParsed() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "x-ratelimit-remaining-requests": "3",
                    "x-ratelimit-limit-requests": "100"
                ]
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        guard case .low(let requests, _) = result.quota else {
            XCTFail("Expected low quota")
            return
        }
        XCTAssertEqual(requests, 3)
    }

    func testDepletedQuotaHeaderParsed() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "x-ratelimit-remaining-requests": "0"
                ]
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertTrue(result.quota.isDepleted)
        guard case .depleted(let reason) = result.quota else {
            XCTFail("Expected depleted quota")
            return
        }
        XCTAssertEqual(reason, "Quota exhausted")
    }

    func testInsufficientBalance402MapsToDepleted() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 402,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .openrouter,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        guard case .unavailable(let reason) = result.health else {
            XCTFail("Expected unavailable health")
            return
        }
        XCTAssertTrue(reason.contains("402"))
        XCTAssertTrue(result.quota.isDepleted)
    }

    func testRateLimit429CarriesQuota() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 429,
                httpVersion: nil,
                headerFields: [
                    "x-ratelimit-remaining-requests": "2",
                    "x-ratelimit-limit-requests": "20"
                ]
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        guard case .unavailable = result.health else {
            XCTFail("Expected unavailable health")
            return
        }
        guard case .low = result.quota else {
            XCTFail("Expected low quota from 429 headers")
            return
        }
    }

    func test429RetryAfterNumericParsed() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 429,
                httpVersion: nil,
                headerFields: ["Retry-After": "90"]
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertEqual(result.failureKind, .rateLimit)
        XCTAssertEqual(result.retryAfter, 90)
    }

    func test401ReturnsAuthFailureKind() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 401,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertEqual(result.failureKind, .auth)
    }

    func test413ReturnsContextLengthFailureKind() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 413,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }
        let service = ModelHealthService(session: makeMockSession(), statusService: nil)

        let result = await service.probe(
            model: model,
            provider: .anthropic,
            baseURL: baseURL,
            apiKey: "test-key"
        )

        XCTAssertEqual(result.failureKind, .contextLength)
    }
}
