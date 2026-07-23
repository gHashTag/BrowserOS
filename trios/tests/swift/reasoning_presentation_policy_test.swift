import Foundation

@main
struct ReasoningPresentationPolicyTest {
    static func main() {
        expect(!ReasoningPresentationPolicy.showsStandaloneHeader(segmentCount: 2), "no duplicate header")
        expect(ReasoningPresentationPolicy.showsCards(segmentCount: 2), "cards remain visible")
        expect(!ReasoningPresentationPolicy.showsStandaloneHeader(segmentCount: 0), "no empty header")
        print("All ReasoningPresentationPolicy tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
