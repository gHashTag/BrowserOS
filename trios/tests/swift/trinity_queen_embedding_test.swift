import Foundation

@main
struct TrinityQueenEmbeddingTest {
    static func main() {
        let embedding = TrinityQueenEmbedding(projectRoot: "/Users/playra/trinity/")

        expect(embedding.projectRoot == "/Users/playra/trinity", "normalizes the Trinity project root")
        expect(embedding.packageRoot == "/Users/playra/trinity/apps/queen", "resolves the Queen package")
        expect(embedding.stateRoot == "/Users/playra/trinity/.trinity", "resolves live Trinity state")
        expect(embedding.moduleName == "QueenUILib", "uses the canonical Queen module")
        expect(embedding.libraryProduct == "QueenUILib", "uses the canonical Queen product")
        expect(embedding.canonicalPetalCount == 27, "preserves all 27 triangle destinations")
        expect(embedding.kingdomCount == 3, "preserves the three kingdoms")
        expect(embedding.petalsPerKingdom == 9, "preserves nine petals per kingdom")
        expect(embedding.hasCanonicalSourceLayout, "finds the canonical Queen source layout")

        print("All TrinityQueenEmbedding tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
