// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: mesh auth helper added during P1 hardening cycle; triage before T27 seal.
// Expires: 2026-07-28
import Foundation

/// Loads the shared `clade-meshd` API token used for `Authorization: Bearer`.
///
/// The token must be supplied by the daemon launcher via the environment.
/// In a future hardening pass this will read from the macOS Keychain so the
/// secret never lives in the app's environment block.
enum MeshAuth {
    /// Non-empty token from `TRIOS_MESH_API_TOKEN`. State-changing mesh HTTP
    /// endpoints will return 401 if this is empty.
    static var token: String {
        ProcessInfo.processInfo.environment["TRIOS_MESH_API_TOKEN"] ?? ""
    }

    static var hasToken: Bool { !token.isEmpty }
}
