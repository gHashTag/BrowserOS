import Foundation

/// Bridges `AgentMemoryStoreProtocol` outcome methods to `ModelReliabilityStoreProtocol`.
///
/// This keeps `ModelReliabilityService` decoupled from the full memory store while
/// reusing the encrypted `agent-memory.sqlite3` database for persistence.
actor MemoryStoreReliabilityAdapter: ModelReliabilityStoreProtocol {
    private let store: any AgentMemoryStoreProtocol

    init(store: (any AgentMemoryStoreProtocol)? = nil) {
        if let store {
            self.store = store
        } else {
            do {
                self.store = try MemoryStore()
            } catch {
                NSLog("[ReliabilityAdapter] durable store unavailable: %@", error.localizedDescription)
                self.store = VolatileMemoryStore()
            }
        }
    }

    func saveOutcome(_ outcome: ModelOutcome) async throws {
        try await store.saveOutcome(outcome)
    }

    func outcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String,
        limit: Int
    ) async throws -> [ModelOutcome] {
        try await store.outcomes(
            for: model,
            provider: provider,
            baseURL: baseURL,
            limit: limit
        )
    }

    func deleteOutcomes(
        for model: String,
        provider: ModelProvider,
        baseURL: String
    ) async throws {
        try await store.deleteOutcomes(
            for: model,
            provider: provider,
            baseURL: baseURL
        )
    }
}
