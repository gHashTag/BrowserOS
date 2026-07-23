// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: mesh auth helper added during P1 hardening cycle; triage before T27 seal.
// Expires: 2026-12-31
// Triage: cycle 8 extension; env fallback removed, Keychain-only. Seal or remove in cycle 9.
import Foundation

/// Loads the shared `clade-meshd` API token used for `Authorization: Bearer`.
///
/// The token is read exclusively from the macOS Keychain. There is no env
/// fallback, so the secret never lives in the app's environment block.
enum MeshAuth {
    private static let keychainService = "ai.browseros.trios"
    private static let keychainAccount = "mesh-api-token"

    /// Non-empty token from the Keychain. State-changing mesh HTTP endpoints
    /// return 401 if this is empty.
    static var token: String {
        do {
            return try KeychainSecrets.read(
                service: keychainService,
                account: keychainAccount
            )
            .filter { !$0.isWhitespace }
        } catch {
            return ""
        }
    }

    static var hasToken: Bool { !token.isEmpty }

    /// Store or replace the mesh API token in the Keychain.
    static func storeToken(_ value: String) throws {
        try KeychainSecrets.write(
            service: keychainService,
            account: keychainAccount,
            secret: value
        )
    }

    /// Remove the mesh API token from the Keychain.
    static func deleteToken() throws {
        try KeychainSecrets.delete(
            service: keychainService,
            account: keychainAccount
        )
    }
}
