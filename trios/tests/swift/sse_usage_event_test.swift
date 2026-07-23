import Foundation

@main
struct SSEUsageEventTest {
    static func main() {
        let line = #"data: {"type":"usage","usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165}}"#
        expect(
            SSEEventParser.parse(line: line) == .usage(inputTokens: 120, outputTokens: 45, totalTokens: 165),
            "snake-case provider usage"
        )

        let camelLine = #"data: {"type":"usage","inputTokens":10,"outputTokens":5,"totalTokens":15}"#
        expect(
            SSEEventParser.parse(line: camelLine) == .usage(inputTokens: 10, outputTokens: 5, totalTokens: 15),
            "camel-case stream usage"
        )

        print("All SSEUsageEvent tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
