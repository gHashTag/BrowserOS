import Combine
import Foundation

@MainActor
final class TriNetRepositoryStatusStore: ObservableObject {
    static let shared = TriNetRepositoryStatusStore()

    @Published private(set) var snapshot = TriNetRepositorySnapshot.verifiedFallback
    @Published private(set) var isLoading = false
    @Published private(set) var lastError: String?

    private var lastRefresh: Date?

    func refreshIfNeeded(maxAge: TimeInterval = 60) {
        if let lastRefresh, Date().timeIntervalSince(lastRefresh) < maxAge {
            return
        }
        Task { await refresh() }
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            snapshot = try await GitHubAPIClient.shared.fetchTriNetSnapshot()
            lastRefresh = Date()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}
