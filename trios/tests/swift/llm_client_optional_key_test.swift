import Foundation

@main
struct LLMClientOptionalKeyTest {
    static func main() async {
        let client = LLMClient(apiKey: "")
        expect(!client.isConfigured, "empty paid-provider key stays unconfigured")

        do {
            _ = try await client.complete(messages: [])
            fail("unconfigured client must reject paid-provider requests")
        } catch LLMError.missingAPIKey {
            print("LLMClient optional-key test passed.")
        } catch {
            fail("unexpected error: \(error)")
        }
    }

    private static func expect(
        _ condition: @autoclosure () -> Bool,
        _ message: String
    ) {
        if !condition() {
            fail(message)
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}
