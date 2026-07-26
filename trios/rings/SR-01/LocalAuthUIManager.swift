// MainActor-bound UI manager for local-auth recovery actions.
// Holds the process-local auth provider reference configured in main.swift
// so Queen status UI can refresh or reset the token safely.
// AGENT-V-WAIVER: CYCLE-22-LOCAL-AUTH-OBSERVABILITY
// Reason: hand-edited ring canon file to wire recovery actions into UI.
import Foundation

@MainActor
final class LocalAuthUIManager: @unchecked Sendable {
    static let shared = LocalAuthUIManager()
    private var provider: LocalAuthProviding?

    private init() {}

    /// Called once from the composition root with the shared provider.
    func configure(provider: LocalAuthProviding) {
        self.provider = provider
    }

    /// Forces a fresh fetch of the local-auth token. Returns true if a token
    /// was obtained, false if the refresh failed.
    @discardableResult
    func refreshLocalAuth() async -> Bool {
        guard let provider = provider else { return false }
        do {
            _ = try await provider.validToken(forcingRefresh: true)
            return true
        } catch {
            return false
        }
    }

    /// Clears the cached/stored token and telemetry. If the configured provider
    /// is a `LocalAuthProvider`, it also deletes the Keychain item.
    func resetLocalAuth() async {
        if let localProvider = provider as? LocalAuthProvider {
            await localProvider.resetLocalAuth()
        } else {
            await LocalAuthMonitor.shared.recordReset()
        }
    }
}
