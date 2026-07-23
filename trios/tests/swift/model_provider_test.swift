import Foundation

@main
struct ModelProviderTest {
    static func main() {
        for provider in ModelProvider.allCases {
            expect(!provider.displayName.isEmpty, "provider display name")
            expect(!provider.defaultModel.isEmpty, "provider default model")
            expect(URL(string: provider.defaultBaseURL) != nil, "provider default base URL")
            expect(!provider.suggestedModels.isEmpty, "provider fallback catalog")
        }

        expect(!ModelProvider.ollama.requiresAPIKey, "Ollama works without a key")
        expect(ModelProvider.openai.requiresAPIKey, "OpenAI requires a key")
        expect(ModelProvider.anthropic.requiresAPIKey, "Anthropic requires a key")
        expect(ModelProvider.openrouter.requiresAPIKey, "OpenRouter requires a key")
        expect(ModelProvider.zai.requiresAPIKey, "Z.AI requires a key")

        let runtime = ModelRuntimeConfiguration(
            provider: .openai,
            model: "gpt-test",
            baseURL: "https://example.test/v1",
            apiKey: "secret-test-key"
        )
        var body: [String: Any] = [:]
        runtime.apply(to: &body)
        expect(body["provider"] as? String == "openai", "request provider")
        expect(body["model"] as? String == "gpt-test", "request model")
        expect(body["baseUrl"] as? String == "https://example.test/v1", "request base URL")
        expect(body["apiKey"] as? String == "secret-test-key", "request API key")

        print("All ModelProvider tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
