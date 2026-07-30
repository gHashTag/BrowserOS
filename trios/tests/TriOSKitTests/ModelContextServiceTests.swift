import Foundation
import XCTest
@testable import TriOSKit

@MainActor
final class ModelContextServiceTests: XCTestCase {
    private var service: ModelContextService!

    override func setUp() {
        service = ModelContextService()
    }

    func testOpenAIProfile() async {
        let profile = await service.profile(for: "gpt-5", provider: .openai, baseURL: "https://api.openai.com")
        XCTAssertEqual(profile.maxContextTokens, 128_000)
        XCTAssertEqual(profile.maxOutputTokens, 16_384)
    }

    func testAnthropicProfile() async {
        let profile = await service.profile(for: "claude-sonnet-4-5", provider: .anthropic, baseURL: "https://api.anthropic.com")
        XCTAssertEqual(profile.maxContextTokens, 200_000)
        XCTAssertEqual(profile.maxOutputTokens, 8_192)
    }

    func testZAIProfile() async {
        let profile = await service.profile(for: "glm-5.1", provider: .zai, baseURL: "https://z.ai")
        XCTAssertEqual(profile.maxContextTokens, 128_000)
        XCTAssertEqual(profile.maxOutputTokens, 4_096)
    }

    func testOllamaDefault() async {
        let profile = await service.profile(for: "llama3.1", provider: .ollama, baseURL: "http://localhost:11434")
        XCTAssertEqual(profile.maxContextTokens, 128_000)
    }

    func testOpenRouterStripsPrefix() async {
        let profile = await service.profile(for: "openai/gpt-5", provider: .openrouter, baseURL: "https://openrouter.ai/api/v1")
        XCTAssertEqual(profile.maxContextTokens, 128_000)
    }

    func testUnknownModelIsConservative() async {
        let profile = await service.profile(for: "unknown-model", provider: .openai, baseURL: "https://api.openai.com")
        XCTAssertEqual(profile.maxContextTokens, 4_096)
        XCTAssertEqual(profile.maxOutputTokens, 1_024)
    }

    func testFitsWithMargin() async {
        let profile = ModelContextProfile(maxContextTokens: 100_000, maxOutputTokens: 4_096)
        XCTAssertTrue(await service.fits(10_000, profile: profile, outputTokens: 2_000, margin: 0.85))
        XCTAssertFalse(await service.fits(90_000, profile: profile, outputTokens: 10_000, margin: 0.85))
    }

    func testLargerContextCandidatesOrdering() async {
        let current = CrossProviderModelCandidate(provider: .zai, baseURL: "https://z.ai", model: "glm-5")
        let candidates = [
            CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5"),
            CrossProviderModelCandidate(provider: .anthropic, baseURL: "https://api.anthropic.com", model: "claude-sonnet-4-5")
        ]
        let larger = await service.largerContextCandidates(
            estimatedInput: 50_000,
            outputTokens: 1_000,
            current: current,
            candidates: candidates,
            margin: 0.85
        )
        XCTAssertEqual(larger.count, 2)
        XCTAssertEqual(larger.first?.model, "claude-sonnet-4-5")
    }

    func testLargerContextCandidatesFiltersSmallerWindows() async {
        let current = CrossProviderModelCandidate(provider: .openai, baseURL: "https://api.openai.com", model: "gpt-5")
        let candidates = [
            CrossProviderModelCandidate(provider: .zai, baseURL: "https://z.ai", model: "glm-5")
        ]
        let larger = await service.largerContextCandidates(
            estimatedInput: 1_000,
            outputTokens: 1_000,
            current: current,
            candidates: candidates,
            margin: 0.85
        )
        XCTAssertTrue(larger.isEmpty)
    }
}
