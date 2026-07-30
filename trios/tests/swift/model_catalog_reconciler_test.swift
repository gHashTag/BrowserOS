// Standalone unit tests for ModelCatalogReconciler - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/model_catalog_reconciler_test.swift \
//     rings/SR-00/ModelCatalogReconciler.swift \
//     -o /tmp/trios_model_catalog_reconciler_test && /tmp/trios_model_catalog_reconciler_test

import Foundation

@main
enum ModelCatalogReconcilerTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    /// What this machine actually had when a fresh profile picked llama3.1.
    static let realCatalog = [
        "kimi-k2.5:cloud", "minimax-m2.7:cloud", "deepseek-v3.2:cloud",
        "qwen3.5:cloud", "glm-5:cloud", "kimi-k2.6:cloud"
    ]
    static let ollamaSuggested = ["llama3.1", "qwen3", "gemma3"]

    static func main() {
        theRealFailure()
        emptyCatalogIsUnknown()
        preferenceOrder()
        latestSuffix()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All ModelCatalogReconciler tests passed.")
    }

    /// The exact situation the user hit: a fresh profile selects a model the
    /// machine does not have, and every send fails.
    static func theRealFailure() {
        scenario("a fresh profile does not strand itself on a missing model")

        check(
            !ModelCatalogReconciler.isUsable(model: "llama3.1", catalog: realCatalog),
            "llama3.1 is correctly seen as absent"
        )
        let picked = ModelCatalogReconciler.replacement(
            for: "llama3.1",
            catalog: realCatalog,
            suggested: ollamaSuggested
        )
        check(picked != nil, "a replacement is chosen rather than failing every send")
        check(picked != "llama3.1", "the replacement is not the missing model")
        check(
            picked.map { realCatalog.contains($0) } == true,
            "the replacement is something the machine actually has"
        )
        check(
            ModelCatalogReconciler.switchNote(
                from: "llama3.1", to: "qwen3.5:cloud", provider: "Ollama"
            ).contains("does not have"),
            "the user is told why the model changed"
        )
    }

    /// The trap: treating "no answer yet" as "model missing" would switch away
    /// from a working model every time the provider was slow.
    static func emptyCatalogIsUnknown() {
        scenario("an empty catalog means unknown, not missing")

        check(
            ModelCatalogReconciler.isUsable(model: "anything", catalog: []),
            "a model stays usable while the catalog is unknown"
        )
        check(
            ModelCatalogReconciler.replacement(for: "x", catalog: [], suggested: ["y"]) == nil,
            "no replacement is invented from an empty catalog"
        )
    }

    static func preferenceOrder() {
        scenario("the curated order still counts when it is available")

        let catalog = ["gemma3", "qwen3", "mistral"]
        check(
            ModelCatalogReconciler.replacement(
                for: "llama3.1", catalog: catalog, suggested: ollamaSuggested
            ) == "qwen3",
            "the highest-ranked suggested model present is chosen over catalog order"
        )
        check(
            ModelCatalogReconciler.replacement(
                for: "llama3.1", catalog: ["mistral"], suggested: ollamaSuggested
            ) == "mistral",
            "with no suggested match, any working model beats a guaranteed failure"
        )
        check(
            ModelCatalogReconciler.replacement(
                for: "qwen3", catalog: catalog, suggested: ollamaSuggested
            ) == nil,
            "a model that is present is left alone"
        )
    }

    static func latestSuffix() {
        scenario("Ollama's :latest suffix does not create phantom mismatches")

        check(
            ModelCatalogReconciler.catalogContains("qwen3.5", catalog: ["qwen3.5:latest"]),
            "a bare name matches the :latest entry"
        )
        check(
            ModelCatalogReconciler.catalogContains("qwen3.5:latest", catalog: ["qwen3.5"]),
            "a :latest name matches the bare entry"
        )
        check(
            !ModelCatalogReconciler.catalogContains("qwen3.5", catalog: ["qwen3.5:cloud"]),
            "a genuinely different tag is still a mismatch"
        )
        check(
            ModelCatalogReconciler.normalize("a:latest") == "a",
            "normalisation strips only the latest suffix"
        )
        check(
            ModelCatalogReconciler.normalize("a:cloud") == "a:cloud",
            "other tags are preserved"
        )
    }
}
