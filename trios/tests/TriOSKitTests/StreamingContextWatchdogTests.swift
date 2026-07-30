import XCTest
@testable import TriOSKit

final class StreamingContextWatchdogTests: XCTestCase {
    private func makeWatchdog(
        warningOutput: Double = 0.80,
        pauseOutput: Double = 0.95,
        warningTotal: Double = 0.90,
        pauseTotal: Double = 0.98
    ) -> StreamingContextWatchdog {
        StreamingContextWatchdog(
            warningOutputRatio: warningOutput,
            pauseOutputRatio: pauseOutput,
            warningTotalRatio: warningTotal,
            pauseTotalRatio: pauseTotal
        )
    }

    private func profile(output: Int, context: Int) -> ModelContextProfile {
        ModelContextProfile(maxContextTokens: context, maxOutputTokens: output)
    }

    func testOkWhileWellWithinBudget() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        let decision = await watchdog.append(deltaText: String(repeating: "a", count: 100))
        XCTAssertEqual(decision, .ok)
        await watchdog.endStream()
    }

    func testApproachingOutputLimitWarning() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        // 850 estimated output tokens -> 85% of output limit -> warning.
        let decision = await watchdog.append(deltaText: String(repeating: "a", count: 850 * 4))
        guard case .approachingLimit(let remaining, let kind) = decision else {
            XCTFail("Expected approachingLimit, got \(String(describing: decision))")
            return
        }
        XCTAssertEqual(kind, .outputTokens)
        XCTAssertGreaterThanOrEqual(remaining, 0)
        await watchdog.endStream()
    }

    func testPauseAtOutputLimit() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        // 960 estimated output tokens -> 96% of output limit -> pause.
        let decision = await watchdog.append(deltaText: String(repeating: "a", count: 960 * 4))
        guard case .limitReached(let partial, _) = decision else {
            XCTFail("Expected limitReached, got \(String(describing: decision))")
            return
        }
        XCTAssertEqual(partial, String(repeating: "a", count: 960 * 4))
        await watchdog.endStream()
    }

    func testPauseAtTotalContextLimit() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 10000, context: 4000),
            estimatedInputTokens: 3500,
            margin: 0.85
        )
        // input 3500 + output 400 = 3900 -> 3900 / (4000*0.85=3400) = 1.14 -> pause.
        let decision = await watchdog.append(deltaText: String(repeating: "a", count: 400 * 4))
        guard case .limitReached(let partial, let suggestion) = decision else {
            XCTFail("Expected limitReached, got \(String(describing: decision))")
            return
        }
        // This used to bind the second value as `kind` and compare it to
        // .totalContext, which is a case of a different enum. `limitReached`
        // reports what to do, not why the limit was hit - the reason lives on
        // `approachingLimit`. So the test was asking a question this case has
        // never answered.
        //
        // Running out of total context cannot be solved by writing less, so the
        // watchdog offers to summarise when almost no output budget is left and
        // to stop otherwise. Either is a correct answer here; what would be
        // wrong is offering a larger model, which is the remedy for an output
        // limit rather than a context one.
        XCTAssertNotEqual(
            suggestion,
            .continueOnLargerModel(
                CrossProviderModelCandidate(provider: .openai, baseURL: "", model: "")
            ),
            "a full context is not fixed by a bigger output allowance"
        )
        XCTAssertTrue(
            suggestion == .summarizeSoFar || suggestion == .stopHere,
            "a full context is answered by summarising or stopping, got \(suggestion)"
        )
        XCTAssertFalse(partial.isEmpty)
        await watchdog.endStream()
    }

    func testHasPausedStaysPaused() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        _ = await watchdog.append(deltaText: String(repeating: "a", count: 960 * 4))
        let second = await watchdog.append(deltaText: "x")
        guard case .limitReached = second else {
            XCTFail("Expected limitReached after pause, got \(String(describing: second))")
            return
        }
        await watchdog.endStream()
    }

    func testEndStreamResetsState() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        _ = await watchdog.append(deltaText: String(repeating: "a", count: 960 * 4))
        await watchdog.endStream()

        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        let decision = await watchdog.append(deltaText: "short")
        XCTAssertEqual(decision, .ok)
        await watchdog.endStream()
    }

    func testRatiosAreClamped() async {
        let watchdog = StreamingContextWatchdog(
            warningOutputRatio: -0.5,
            pauseOutputRatio: 1.5,
            warningTotalRatio: -0.2,
            pauseTotalRatio: 2.0
        )
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        // At exactly 95% output, should pause because pause ratio clamped to 1.0.
        let decision = await watchdog.append(deltaText: String(repeating: "a", count: 950 * 4))
        guard case .limitReached = decision else {
            XCTFail("Expected limitReached after ratio clamping, got \(String(describing: decision))")
            return
        }
        await watchdog.endStream()
    }

    func testOutputLimitDefaultActionIsContinueOnLargerModel() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 100,
            margin: 0.85
        )
        let decision = await watchdog.append(deltaText: String(repeating: "a", count: 960 * 4))
        guard case .limitReached(_, let action) = decision else {
            XCTFail("Expected limitReached, got \(String(describing: decision))")
            return
        }
        if case .continueOnLargerModel = action {
            // expected
        } else {
            XCTFail("Expected continueOnLargerModel for output-token limit, got \(String(describing: action))")
        }
        await watchdog.endStream()
    }

    func testEstimatedTokens() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 200,
            margin: 0.85
        )
        _ = await watchdog.append(deltaText: String(repeating: "a", count: 100 * 4))
        let tokens = await watchdog.estimatedTokens()
        XCTAssertEqual(tokens.input, 200)
        XCTAssertGreaterThanOrEqual(tokens.output, 100)
        await watchdog.endStream()
    }

    func testBudgetRatiosNilBeforeStream() async {
        let watchdog = makeWatchdog()
        let observed1 = await watchdog.budgetRatios()
        XCTAssertNil(observed1)
    }

    func testBudgetRatiosReflectsOutputAndTotal() async {
        let watchdog = makeWatchdog()
        await watchdog.beginStream(
            modelProfile: profile(output: 1000, context: 4000),
            estimatedInputTokens: 200,
            margin: 0.85
        )
        _ = await watchdog.append(deltaText: String(repeating: "a", count: 300 * 4))
        guard let ratios = await watchdog.budgetRatios() else {
            XCTFail("Expected ratios after stream started")
            return
        }
        XCTAssertEqual(ratios.outputCeiling, 1000)
        XCTAssertEqual(ratios.totalCeiling, 3400)
        XCTAssertEqual(ratios.totalUsed, 200 + ratios.outputUsed)
        XCTAssertGreaterThanOrEqual(ratios.outputRatio, 0.25)
        XCTAssertLessThanOrEqual(ratios.outputRatio, 0.35)
        XCTAssertGreaterThanOrEqual(ratios.totalRatio, ratios.outputRatio)
        await watchdog.endStream()
    }
}
