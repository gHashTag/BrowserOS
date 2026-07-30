import Foundation

/// Reconciles a configured model against what the provider actually offers.
///
/// `ModelProvider.suggestedModels` is a static guess. For a hosted API that is
/// fine, but Ollama serves whatever the user pulled - and a fresh profile that
/// selects `llama3.1` on a machine without it fails every send with
/// "model 'llama3.1' not found". The static default is a starting point, not a
/// fact, so it has to be checked against the live catalog.
///
/// Pure and dependency-free so the choice is unit-testable without a server.
enum ModelCatalogReconciler {
    /// Whether a configured model can actually be used.
    ///
    /// An empty catalog means "unknown", not "missing": a provider that has not
    /// answered yet must not cause a switch away from a perfectly good model.
    static func isUsable(model: String, catalog: [String]) -> Bool {
        guard !catalog.isEmpty else { return true }
        return catalog.contains(model)
    }

    /// Picks a replacement when the configured model is absent.
    ///
    /// Preference order:
    /// 1. a suggested model that the catalog actually has, so the curated
    ///    ordering still counts;
    /// 2. otherwise the first catalog entry, because any working model beats a
    ///    guaranteed failure;
    /// 3. nil when the catalog is empty - there is nothing honest to pick.
    static func replacement(
        for model: String,
        catalog: [String],
        suggested: [String]
    ) -> String? {
        guard !catalog.isEmpty else { return nil }
        if catalog.contains(model) { return nil }
        if let preferred = suggested.first(where: { catalog.contains($0) }) {
            return preferred
        }
        return catalog.first
    }

    /// Human-readable note for the switch, so the user learns why the model
    /// changed rather than finding a different one selected silently.
    static func switchNote(from old: String, to new: String, provider: String) -> String {
        "\(provider) does not have `\(old)`; using `\(new)` instead."
    }

    /// Matches a model against a catalog tolerating the `:latest` suffix Ollama
    /// adds, so `qwen3.5` and `qwen3.5:latest` are not treated as different.
    static func normalize(_ model: String) -> String {
        model.hasSuffix(":latest") ? String(model.dropLast(7)) : model
    }

    /// Catalog-aware match that applies the same normalisation to both sides.
    static func catalogContains(_ model: String, catalog: [String]) -> Bool {
        let wanted = normalize(model)
        return catalog.contains { normalize($0) == wanted }
    }
}
