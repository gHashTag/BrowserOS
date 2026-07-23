import XCTest
@testable import TriOSKit

final class SSEEventParserTests: XCTestCase {
    func testSnakeCaseUsageEvent() {
        let line = #"data: {"type":"usage","usage":{"prompt_tokens":120,"completion_tokens":45,"total_tokens":165}}"#
        let event = SSEEventParser.parse(line: line)
        XCTAssertEqual(event, .usage(inputTokens: 120, outputTokens: 45, totalTokens: 165))
    }

    func testCamelCaseUsageEvent() {
        let camelLine = #"data: {"type":"usage","inputTokens":10,"outputTokens":5,"totalTokens":15}"#
        let event = SSEEventParser.parse(line: camelLine)
        XCTAssertEqual(event, .usage(inputTokens: 10, outputTokens: 5, totalTokens: 15))
    }

    func textNonDataLineReturnsNil() {
        XCTAssertNil(SSEEventParser.parse(line: "event: usage"))
    }
}
