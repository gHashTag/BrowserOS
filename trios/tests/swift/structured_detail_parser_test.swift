import Foundation

@main
struct StructuredDetailParserTest {
    static func main() {
        testNestedObject()
        testArrayTypes()
        testEncodedJSON()
        testEscapedNewlines()
        testInvalidJSONFallback()
        print("All StructuredDetailParser tests passed.")
    }

    private static func testNestedObject() {
        let node = StructuredDetailParser.parse(#"{"request":{"path":"/tmp","limit":3}}"#)
        guard case .object(let fields) = node,
              let request = fields.first(where: { $0.key == "request" }),
              case .object(let requestFields) = request.value else {
            fail("nested object hierarchy")
        }
        expect(requestFields.map(\.key) == ["limit", "path"], "object keys are stable")
    }

    private static func testArrayTypes() {
        let node = StructuredDetailParser.parse(#"[true,2,null,"ok"]"#)
        guard case .array(let values) = node else { fail("array root") }
        expect(values.count == 4, "array count")
        guard case .boolean(true) = values[0] else { fail("boolean value") }
        guard case .number("2") = values[1] else { fail("number value") }
        guard case .null = values[2] else { fail("null value") }
        guard case .string("ok") = values[3] else { fail("string value") }
    }

    private static func testEncodedJSON() {
        let node = StructuredDetailParser.parse(#"{"payload":"{\"items\":[1,2]}"}"#)
        guard case .object(let fields) = node,
              let payload = fields.first(where: { $0.key == "payload" }),
              case .object(let payloadFields) = payload.value,
              case .array(let items) = payloadFields.first?.value else {
            fail("JSON encoded inside string")
        }
        expect(items.count == 2, "nested encoded array")
    }

    private static func testEscapedNewlines() {
        let node = StructuredDetailParser.parse(#"{"content":"line one\nline two"}"#)
        guard case .object(let fields) = node,
              case .string(let content) = fields.first?.value else {
            fail("multiline string")
        }
        expect(content == "line one\nline two", "escaped newline decoded")
    }

    private static func testInvalidJSONFallback() {
        let node = StructuredDetailParser.parse(#"first\nsecond"#)
        guard case .string(let content) = node else { fail("fallback string") }
        expect(content == "first\nsecond", "fallback escape decoding")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() { fail("Expectation failed: \(label)") }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}
