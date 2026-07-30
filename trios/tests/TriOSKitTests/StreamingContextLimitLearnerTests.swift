import XCTest
@testable import TriOSKit

@MainActor
final class StreamingContextLimitLearnerTests: XCTestCase {
    private var learner: StreamingContextLimitLearner!

    override func setUp() {
        learner = StreamingContextLimitLearner(emaAlpha: 0.3, minObservations: 3, safetyBuffer: 0.95)
    }

    func testAdvertisedProfileUsedWithoutObservations() async {
        let advertised = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 8_192)
        let profile = await learner.learnedProfile(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            advertised: advertised
        )
        XCTAssertEqual(profile, advertised)
    }

    func testOutputLengthTightensEffectiveOutput() async {
        let advertised = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 8_192)
        for _ in 0..<3 {
            let outcome = ModelOutcome(
                model: "claude-sonnet-4-5",
                provider: .anthropic,
                baseURL: "https://api.anthropic.com",
                success: true,
                observedOutputTokens: 8_000,
                finishReason: "length"
            )
            await learner.recordOutcome(outcome)
        }

        let profile = await learner.learnedProfile(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            advertised: advertised
        )
        XCTAssertLessThan(profile.maxOutputTokens, advertised.maxOutputTokens)
        XCTAssertEqual(profile.maxOutputTokens, Int(floor(8_000 * 0.95)))
    }

    func testContextLimitTightensEffectiveContext() async {
        let advertised = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 8_192)
        for _ in 0..<3 {
            let outcome = ModelOutcome(
                model: "claude-sonnet-4-5",
                provider: .anthropic,
                baseURL: "https://api.anthropic.com",
                success: false,
                reason: "context limit",
                observedTotalTokens: 120_000
            )
            await learner.recordOutcome(outcome)
        }

        let profile = await learner.learnedProfile(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            advertised: advertised
        )
        XCTAssertLessThan(profile.maxContextTokens, advertised.maxContextTokens)
        XCTAssertEqual(profile.maxContextTokens, Int(floor(120_000 * 0.95)))
    }

    func testNormalStopDoesNotTightenOutput() async {
        let advertised = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 8_192)
        for _ in 0..<3 {
            let outcome = ModelOutcome(
                model: "claude-sonnet-4-5",
                provider: .anthropic,
                baseURL: "https://api.anthropic.com",
                success: true,
                observedOutputTokens: 500,
                finishReason: "stop"
            )
            await learner.recordOutcome(outcome)
        }

        let profile = await learner.learnedProfile(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            advertised: advertised
        )
        XCTAssertEqual(profile.maxOutputTokens, advertised.maxOutputTokens)
    }

    func testResetClearsLearnedLimits() async {
        let advertised = ModelContextProfile(maxContextTokens: 128_000, maxOutputTokens: 8_192)
        for _ in 0..<3 {
            let outcome = ModelOutcome(
                model: "claude-sonnet-4-5",
                provider: .anthropic,
                baseURL: "https://api.anthropic.com",
                success: true,
                observedOutputTokens: 8_000,
                finishReason: "length"
            )
            await learner.recordOutcome(outcome)
        }
        await learner.reset(
            model: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com"
        )
        let profile = await learner.learnedProfile(
            for: "claude-sonnet-4-5",
            provider: .anthropic,
            baseURL: "https://api.anthropic.com",
            advertised: advertised
        )
        XCTAssertEqual(profile, advertised)
    }
}
