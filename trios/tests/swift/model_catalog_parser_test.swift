import Foundation

@main
struct ModelCatalogParserTest {
    static func main() {
        let openAI = Data(#"{"data":[{"id":"gpt-z"},{"id":"gpt-a"},{"id":"gpt-a"}]}"#.utf8)
        expect(
            ModelCatalogParser.parse(data: openAI, provider: .openai) == ["gpt-a", "gpt-z"],
            "OpenAI-style catalog"
        )

        let anthropic = Data(#"{"data":[{"id":"claude-b"},{"id":"claude-a"}]}"#.utf8)
        expect(
            ModelCatalogParser.parse(data: anthropic, provider: .anthropic) == ["claude-a", "claude-b"],
            "Anthropic catalog"
        )

        let openRouter = Data(#"{"data":[{"id":"openai/gpt"},{"id":"anthropic/claude"}]}"#.utf8)
        expect(
            ModelCatalogParser.parse(data: openRouter, provider: .openrouter) == ["anthropic/claude", "openai/gpt"],
            "OpenRouter catalog"
        )

        let ollama = Data(#"{"models":[{"name":"llama3.1"},{"model":"qwen3"}]}"#.utf8)
        expect(
            ModelCatalogParser.parse(data: ollama, provider: .ollama) == ["llama3.1", "qwen3"],
            "Ollama catalog"
        )

        print("All ModelCatalogParser tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
