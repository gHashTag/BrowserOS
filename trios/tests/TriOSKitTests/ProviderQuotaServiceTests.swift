import XCTest
@testable import TriOSKit

final class ProviderQuotaServiceTests: XCTestCase {
    private var service: ProviderQuotaService!

    override func setUp() async throws {
        service = ProviderQuotaService()
    }

    func testUnknownWhenNoSnapshot() async {
        let status = await service.status(for: .anthropic, baseURL: "https://api.anthropic.com")
        XCTAssertEqual(status, .unknown)
    }

    func testRecordsAndReturnsQuota() async {
        await service.record(
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            quota: .healthy(remainingRequests: 10, remainingTokens: 5000)
        )
        let status = await service.status(for: .anthropic, baseURL: "https://api.anthropic.com")
        guard case .healthy(let requests, let tokens) = status else {
            XCTFail("Expected healthy quota")
            return
        }
        XCTAssertEqual(requests, 10)
        XCTAssertEqual(tokens, 5000)
    }

    func testEndpointsAreIsolated() async {
        await service.record(
            provider: .openai,
            baseURL: "https://api.openai.com",
            quota: .depleted(reason: "Quota exhausted")
        )
        let other = await service.status(for: .openai, baseURL: "https://proxy.example.com/v1")
        XCTAssertEqual(other, .unknown)
    }

    func testInvalidateClearsAllSnapshots() async {
        await service.record(
            provider: .zai,
            baseURL: "https://api.z.ai/api/paas/v4",
            quota: .low(remainingRequests: 2, remainingTokens: nil)
        )
        await service.invalidate()
        let status = await service.status(for: .zai, baseURL: "https://api.z.ai/api/paas/v4")
        XCTAssertEqual(status, .unknown)
    }
}
