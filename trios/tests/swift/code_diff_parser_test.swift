import Foundation

@main
struct CodeDiffParserTest {
    static func main() {
        testUnifiedDiffAndLineNumbers()
        testApplyPatchPayload()
        testOrdinaryTextIsRejected()
        testBeforeAfterComparison()
        testStructuredEditExtraction()
        testVisualToneContract()
        print("All CodeDiffParser tests passed.")
    }

    private static func testUnifiedDiffAndLineNumbers() {
        let source = """
        diff --git a/Sample.swift b/Sample.swift
        --- a/Sample.swift
        +++ b/Sample.swift
        @@ -2,3 +2,4 @@
         let stable = true
        -let color = .gray
        +let color = .green
        +let visible = true
        """

        guard let document = CodeDiffParser.parse(source) else {
            fail("unified diff is detected")
        }
        expect(document.displayPath == "Sample.swift", "display path")
        expect(document.additionCount == 2, "addition count")
        expect(document.deletionCount == 1, "deletion count")

        let context = firstLine(.context, in: document)
        expect(context.oldLineNumber == 2 && context.newLineNumber == 2, "context line numbers")
        let deletion = firstLine(.deletion, in: document)
        expect(deletion.oldLineNumber == 3 && deletion.newLineNumber == nil, "deletion line numbers")
        let additions = document.lines.filter { $0.kind == .addition }
        expect(additions.map(\.newLineNumber) == [3, 4], "addition line numbers")
    }

    private static func testApplyPatchPayload() {
        let source = """
        *** Begin Patch
        *** Update File: Sources/Panel.swift
        @@
        -Text("Gray")
        +Text("Black")
        *** End Patch
        """

        guard let document = CodeDiffParser.parse(source) else {
            fail("apply-patch payload is detected")
        }
        expect(document.displayPath == "Sources/Panel.swift", "apply-patch path")
        expect(document.additionCount == 1, "apply-patch addition")
        expect(document.deletionCount == 1, "apply-patch deletion")
    }

    private static func testOrdinaryTextIsRejected() {
        let source = "let total = left + right\nlet next = total - 1"
        expect(CodeDiffParser.parse(source) == nil, "ordinary code is not a diff")
    }

    private static func testBeforeAfterComparison() {
        let document = CodeDiffParser.compare(
            old: "one\nsame\nold",
            new: "one\nsame\nnew",
            filePath: "Example.txt"
        )
        expect(document.displayPath == "Example.txt", "comparison path")
        expect(document.lines.filter { $0.kind == .context }.map(\.text) == ["one", "same"], "shared context")
        expect(firstLine(.deletion, in: document).text == "old", "old line")
        expect(firstLine(.addition, in: document).text == "new", "new line")
    }

    private static func testStructuredEditExtraction() {
        let node = StructuredDetailParser.parse(
            #"{"path":"Sources/View.swift","old_string":"Color.gray","new_string":"Color.black"}"#
        )
        let documents = StructuredCodeDiffExtractor.documents(from: node)
        expect(documents.count == 1, "one structured diff")
        expect(documents[0].displayPath == "Sources/View.swift", "structured path")
        expect(documents[0].additionCount == 1, "structured addition")
        expect(documents[0].deletionCount == 1, "structured deletion")
    }

    private static func testVisualToneContract() {
        expect(CodeDiffLineKind.addition.visualTone == .green, "additions are green")
        expect(CodeDiffLineKind.deletion.visualTone == .red, "deletions are red")
        expect(CodeDiffLineKind.hunkHeader.visualTone == .accent, "hunks are accented")
        expect(CodeDiffLineKind.context.visualTone == .neutral, "context is neutral")
    }

    private static func firstLine(_ kind: CodeDiffLineKind, in document: CodeDiffDocument) -> CodeDiffLine {
        guard let line = document.lines.first(where: { $0.kind == kind }) else {
            fail("missing \(kind) line")
        }
        return line
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() { fail("Expectation failed: \(label)") }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}
