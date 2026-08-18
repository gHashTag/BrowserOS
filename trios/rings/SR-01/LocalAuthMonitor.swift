// Local auth lifecycle monitor: tracks token fetch/refresh/403-retry/failure
// events and writes a token-free audit log for operability and incident review.
// AGENT-V-WAIVER: CYCLE-22-LOCAL-AUTH-OBSERVABILITY
// Reason: hand-edited ring canon file to add telemetry and recovery UI.
import Foundation

/// High-level local-auth health state exposed to observers and UI.
enum LocalAuthState: String, Sendable, Codable {
    case unknown   // No fetch/refresh has completed yet this process.
    case cached    // A token is available and considered healthy.
    case refreshing // A fetch/refresh is in flight.
    case failed    // The last fetch/refresh failed and no token is available.
    case missing   // No token is stored and the server did not return one.
}

/// Token-free metadata about the local-auth lifecycle.
struct LocalAuthMetadata: Sendable, Codable {
    var fetchedAt: Date?
    var issuedAt: Date?
    var expiresAt: Date?
    var ttlSeconds: TimeInterval?
    var refreshCount: Int
    var retry403Count: Int
    var lastFailureAt: Date?
    var lastFailureReason: String?
    var isHealthy: Bool
}

/// Actor that records local-auth lifecycle events and persists a token-free
/// audit log under `.trinity/state/local-auth-audit.jsonl`.
actor LocalAuthMonitor: Sendable {
    static let shared = LocalAuthMonitor()
    static let proactiveRefreshInterval: TimeInterval = 300 // 5 minutes heuristic

    private var metadata = LocalAuthMetadata(
        fetchedAt: nil,
        issuedAt: nil,
        expiresAt: nil,
        ttlSeconds: nil,
        refreshCount: 0,
        retry403Count: 0,
        lastFailureAt: nil,
        lastFailureReason: nil,
        isHealthy: true
    )
    private var currentState: LocalAuthState = .unknown

    init() {}

    // MARK: - Lifecycle events

    func recordFetchSuccess(issuedAt: Date? = nil, expiresAt: Date? = nil, ttlSeconds: TimeInterval? = nil) {
        metadata.fetchedAt = Date()
        metadata.issuedAt = issuedAt
        metadata.expiresAt = expiresAt
        metadata.ttlSeconds = ttlSeconds
        metadata.refreshCount += 1
        metadata.lastFailureAt = nil
        metadata.lastFailureReason = nil
        metadata.isHealthy = true
        currentState = .cached
        Task {
            await appendAudit(event: "fetch.success")
        }
    }

    func recordRefreshSuccess(issuedAt: Date? = nil, expiresAt: Date? = nil, ttlSeconds: TimeInterval? = nil) {
        metadata.fetchedAt = Date()
        metadata.issuedAt = issuedAt
        metadata.expiresAt = expiresAt
        metadata.ttlSeconds = ttlSeconds
        metadata.refreshCount += 1
        metadata.lastFailureAt = nil
        metadata.lastFailureReason = nil
        metadata.isHealthy = true
        currentState = .cached
        Task {
            await appendAudit(event: "refresh.success")
        }
    }

    func record403Retry() {
        metadata.retry403Count += 1
        Task {
            await appendAudit(event: "403.retry")
        }
    }

    func recordFailure(reason: String) {
        metadata.lastFailureAt = Date()
        metadata.lastFailureReason = reason
        metadata.isHealthy = false
        currentState = .failed
        Task {
            await appendAudit(event: "failure", reason: reason)
        }
    }

    func recordMissing() {
        metadata.isHealthy = false
        currentState = .missing
        Task {
            await appendAudit(event: "missing")
        }
    }

    func recordReset() {
        metadata = LocalAuthMetadata(
            fetchedAt: nil,
            issuedAt: nil,
            expiresAt: nil,
            ttlSeconds: nil,
            refreshCount: 0,
            retry403Count: 0,
            lastFailureAt: nil,
            lastFailureReason: nil,
            isHealthy: true
        )
        currentState = .unknown
        Task {
            await appendAudit(event: "reset")
        }
    }

    func recordRefreshing() {
        currentState = .refreshing
    }

    func recordFamilyRevoked() {
        metadata.isHealthy = false
        metadata.lastFailureAt = Date()
        metadata.lastFailureReason = "refresh_family_revoked"
        currentState = .failed
        Task {
            await appendAudit(event: "family.revoked")
        }
    }

    // MARK: - Queries

    func status() -> (state: LocalAuthState, metadata: LocalAuthMetadata) {
        (currentState, metadata)
    }

    /// Whether this monitor has ever recorded a successful fetch.
    ///
    /// Separate from `shouldProactivelyRefresh` because the two questions have
    /// the same answer only when there is no durable token store. This metadata
    /// is in-memory, so "never fetched" means "not in THIS process" - which
    /// says nothing about a token loaded from disk.
    var hasNeverFetched: Bool { metadata.fetchedAt == nil }

    /// Starts the age clock for a token adopted from the durable store.
    ///
    /// Deliberately not `recordFetchSuccess`: nothing was fetched, and the
    /// audit trail should not say it was. All this sets is the reference point
    /// the age heuristic needs - "in use since now" - so the token is trusted
    /// once and then aged normally.
    func recordAdoptedStoredToken() {
        guard metadata.fetchedAt == nil else { return }
        metadata.fetchedAt = Date()
    }

    func shouldProactivelyRefresh(maxAge: TimeInterval = proactiveRefreshInterval) -> Bool {
        guard let fetchedAt = metadata.fetchedAt else { return true }
        return Date().timeIntervalSince(fetchedAt) >= maxAge
    }

    // MARK: - Audit log

    private func appendAudit(event: String, reason: String? = nil) async {
        let entry: [String: Any] = [
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "event": event,
            "reason": reason ?? NSNull(),
            "state": currentState.rawValue,
            "refreshCount": metadata.refreshCount,
            "retry403Count": metadata.retry403Count
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: entry, options: []),
              let line = String(data: data, encoding: .utf8) else {
            return
        }
        let url = auditURL()
        do {
            let stateDir = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
            var existing = ""
            if FileManager.default.fileExists(atPath: url.path),
               let current = try? String(contentsOf: url, encoding: .utf8) {
                existing = current
            }
            let updated = existing + line + "\n"
            try updated.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            NSLog("[LocalAuthMonitor] failed to write audit log: \(error)")
        }
    }

    private func auditURL() -> URL {
        URL(fileURLWithPath: "\(ProjectPaths.trinity)/state/local-auth-audit.jsonl")
    }
}
