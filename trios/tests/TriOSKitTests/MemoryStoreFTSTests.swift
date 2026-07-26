import XCTest
@testable import TriOSKit

final class MemoryStoreFTSTests: XCTestCase {
    func testFtsMatchExpressionNormalQuery() {
        let expression = MemoryStore.ftsMatchExpression(for: "Find my previous notes")
        XCTAssertEqual(expression, "\"find\"* OR \"my\"* OR \"previous\"* OR \"notes\"*")
    }

    func testFtsMatchExpressionIgnoresFts5Operators() {
        // Operators should be tokenized into harmless alphanumeric tokens or dropped.
        let expression = MemoryStore.ftsMatchExpression(for: "NEAR NOT ^ * \" quoted \"")
        // "quoted" survives as alphanumeric; the rest become too short or empty.
        XCTAssertEqual(expression, "\"quoted\"*")
    }

    func testFtsMatchExpressionEmptyAfterCleaningReturnsNil() {
        XCTAssertNil(MemoryStore.ftsMatchExpression(for: "!@#$%"))
        XCTAssertNil(MemoryStore.ftsMatchExpression(for: ""))
        XCTAssertNil(MemoryStore.ftsMatchExpression(for: "a"))
    }

    func testFtsMatchExpressionTokenLengthAndCountCaps() {
        let longToken = String(repeating: "a", count: 100)
        let expression = MemoryStore.ftsMatchExpression(for: longToken)
        XCTAssertEqual(expression, "\"\(String(repeating: \"a\", count: 40))\"*")

        let manyTokens = (1...20).map { "token\($0)" }.joined(separator: " ")
        let capped = MemoryStore.ftsMatchExpression(for: manyTokens)
        let count = capped?.components(separatedBy: " OR ").count ?? 0
        XCTAssertLessThanOrEqual(count, 12)
    }

    func testFtsMatchExpressionUnicodeAndMixedInput() {
        let expression = MemoryStore.ftsMatchExpression(for: "hello-world 日本語 test@example.com")
        // Hyphens and email punctuation are stripped; "hello", "world", "test", "example", "com" survive.
        XCTAssertEqual(expression, "\"hello\"* OR \"world\"* OR \"test\"* OR \"example\"* OR \"com\"*")
    }
}
