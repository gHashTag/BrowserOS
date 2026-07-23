import Foundation

@main
struct TokenUsageTest {
    static func main() {
        var actual = TokenUsageLedger()
        actual.record(inputTokens: 900, outputTokens: 300, source: .provider)
        expect(actual.inputTokens == 900, "actual input tokens")
        expect(actual.outputTokens == 300, "actual output tokens")
        expect(actual.totalTokens == 1_200, "actual total tokens")
        expect(!actual.includesEstimate, "provider usage is authoritative")
        expect(actual.compactTotal == "1.2K", "compact thousands")
        expect(actual.compactBreakdown == "900 in / 300 out", "compact status breakdown")

        var estimated = TokenUsageLedger()
        estimated.record(inputTokens: 800, outputTokens: 250, source: .estimate)
        expect(estimated.includesEstimate, "fallback is marked estimated")
        expect(estimated.compactTotal == "~1.1K", "estimated compact total")
        expect(estimated.compactBreakdown == "~800 in / ~250 out", "estimated status breakdown")
        expect(estimated.detailText.contains("input"), "detail includes input")
        expect(estimated.detailText.contains("output"), "detail includes output")

        expect(TokenEstimator.estimate("12345678") == 2, "four-character fallback estimate")

        print("All TokenUsage tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
