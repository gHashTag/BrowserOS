import Foundation

@main
struct MarkdownBlockParserTest {
    static func main() {
        testTable()
        testPipeEscapes()
        testStructuralBlocks()
        testStableIdentity()
        testIncompleteTable()
        print("All MarkdownBlockParser tests passed.")
    }

    private static func testTable() {
        let source = """
        | Component | Status | Count |
        | :--- | :---: | ---: |
        | TriOS | **Ready** | 3 |
        | Agent | `cdp|ok` | 6 |
        """
        let blocks = MarkdownBlockParser.parse(source)
        guard blocks.count == 1, case .table(let table) = blocks[0].kind else {
            fail("Expected one table block")
        }
        expect(table.headers == ["Component", "Status", "Count"], "table headers")
        expect(table.alignments == [.leading, .center, .trailing], "table alignments")
        expect(table.rows.count == 2, "table rows")
        expect(table.rows[0] == ["TriOS", "**Ready**", "3"], "table first row")
        expect(table.rows[1][1] == "`cdp|ok`", "inline code pipe")
    }

    private static func testPipeEscapes() {
        let cells = MarkdownBlockParser.splitTableRow("| a \\| b | `x|y` | z |")
        expect(cells == ["a | b", "`x|y`", "z"], "escaped and code pipes")
    }

    private static func testStructuralBlocks() {
        let source = """
        Before
        second line

        ---

        > quoted
        > continuation

        1. first
        2. second

        - alpha
        - beta
        """
        let blocks = MarkdownBlockParser.parse(source)
        expect(blocks.count == 5, "structural block count")
        guard case .paragraph(let paragraph) = blocks[0].kind else { fail("paragraph") }
        expect(paragraph == "Before\nsecond line", "paragraph newlines")
        guard case .thematicBreak = blocks[1].kind else { fail("thematic break") }
        guard case .quote(let quote) = blocks[2].kind else { fail("quote") }
        expect(quote == "quoted\ncontinuation", "quote content")
        guard case .list(let ordered, let items) = blocks[3].kind else { fail("ordered list") }
        expect(ordered && items == ["first", "second"], "ordered list content")
        guard case .list(let unordered, let unorderedItems) = blocks[4].kind else { fail("unordered list") }
        expect(!unordered && unorderedItems == ["alpha", "beta"], "unordered list content")
    }

    private static func testStableIdentity() {
        let source = "# Title\n\nText"
        let first = MarkdownBlockParser.parse(source).map(\.id)
        let second = MarkdownBlockParser.parse(source).map(\.id)
        expect(first == second, "stable block IDs")
    }

    private static func testIncompleteTable() {
        let blocks = MarkdownBlockParser.parse("| Component | Status |")
        guard blocks.count == 1, case .paragraph(let text) = blocks[0].kind else {
            fail("incomplete table fallback")
        }
        expect(text == "| Component | Status |", "incomplete table readable")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() { fail("Expectation failed: \(label)") }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}
