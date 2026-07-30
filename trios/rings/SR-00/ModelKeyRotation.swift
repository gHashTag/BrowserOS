import Foundation

/// Why a key is currently unusable.
enum ModelKeyCooldownReason: String, Codable, Equatable, Sendable {
    /// Provider answered 429 / rate limit. Recovers on its own.
    case rateLimited
    /// Balance or resource package exhausted (e.g. Z.AI code 1113). Does not
    /// recover without the user topping up, so the key is parked indefinitely.
    case depleted
    /// Key was rejected (401/403). Parked until the user fixes it.
    case rejected

    var isTerminal: Bool {
        switch self {
        case .rateLimited: return false
        case .depleted, .rejected: return true
        }
    }

    var displayName: String {
        switch self {
        case .rateLimited: return "Cooling down"
        case .depleted: return "Out of credits"
        case .rejected: return "Rejected"
        }
    }
}

/// Rotation state for one stored key.
struct ModelKeyState: Codable, Equatable, Sendable {
    let entryID: String
    var lastUsedAt: Date?
    var cooldownUntil: Date?
    var cooldownReason: ModelKeyCooldownReason?
    var successCount: Int
    var failureCount: Int

    init(
        entryID: String,
        lastUsedAt: Date? = nil,
        cooldownUntil: Date? = nil,
        cooldownReason: ModelKeyCooldownReason? = nil,
        successCount: Int = 0,
        failureCount: Int = 0
    ) {
        self.entryID = entryID
        self.lastUsedAt = lastUsedAt
        self.cooldownUntil = cooldownUntil
        self.cooldownReason = cooldownReason
        self.successCount = successCount
        self.failureCount = failureCount
    }

    /// A terminal reason has no expiry; a rate limit expires with its deadline.
    func isAvailable(at now: Date) -> Bool {
        guard let reason = cooldownReason else { return true }
        if reason.isTerminal { return false }
        guard let until = cooldownUntil else { return true }
        return now >= until
    }
}

/// Chooses which stored API key to use next.
///
/// Least-recently-used rather than strict round-robin: LRU keeps working after
/// keys are added or removed mid-session, where an index-based rotation would
/// silently skip or repeat entries. Keys in cooldown are passed over, so one
/// rate-limited key cannot stall the provider while others are idle.
///
/// Pure and dependency-free so it can be unit-tested with a single-file
/// `swiftc` invocation, like the other SR-00 policy helpers.
enum ModelKeyRotation {
    /// Default pause after a rate limit when the provider sends no Retry-After.
    static let defaultRateLimitCooldown: TimeInterval = 60

    /// Picks the next key to use.
    ///
    /// Order of preference:
    /// 1. never-used keys, so a freshly added key is exercised promptly;
    /// 2. otherwise the least recently used available key.
    ///
    /// Returns nil only when every key is parked. Callers should surface that
    /// rather than silently sending without credentials.
    static func nextKey(
        entryIDs: [String],
        states: [String: ModelKeyState],
        now: Date
    ) -> String? {
        let available = entryIDs.filter { id in
            states[id]?.isAvailable(at: now) ?? true
        }
        guard !available.isEmpty else { return nil }

        let neverUsed = available.filter { states[$0]?.lastUsedAt == nil }
        if let first = neverUsed.first {
            return first
        }

        return available.min { lhs, rhs in
            let l = states[lhs]?.lastUsedAt ?? .distantPast
            let r = states[rhs]?.lastUsedAt ?? .distantPast
            if l == r { return lhs < rhs }
            return l < r
        }
    }

    /// Records a successful request and clears any non-terminal cooldown.
    static func recordSuccess(
        entryID: String,
        states: inout [String: ModelKeyState],
        now: Date
    ) {
        var state = states[entryID] ?? ModelKeyState(entryID: entryID)
        state.lastUsedAt = now
        state.successCount += 1
        // A terminal park is not cleared by a success elsewhere; but a success
        // on this very key proves it works again.
        state.cooldownUntil = nil
        state.cooldownReason = nil
        states[entryID] = state
    }

    /// Parks a key after a failure.
    ///
    /// `retryAfter` honours the provider's own advice when present; otherwise a
    /// rate limit uses `defaultRateLimitCooldown`. Terminal reasons ignore it.
    static func recordFailure(
        entryID: String,
        reason: ModelKeyCooldownReason,
        retryAfter: TimeInterval?,
        states: inout [String: ModelKeyState],
        now: Date
    ) {
        var state = states[entryID] ?? ModelKeyState(entryID: entryID)
        state.lastUsedAt = now
        state.failureCount += 1
        state.cooldownReason = reason
        if reason.isTerminal {
            state.cooldownUntil = nil
        } else {
            state.cooldownUntil = now.addingTimeInterval(
                max(1, retryAfter ?? defaultRateLimitCooldown)
            )
        }
        states[entryID] = state
    }

    /// Clears a park so the user can retry a key after topping it up.
    static func reset(entryID: String, states: inout [String: ModelKeyState]) {
        guard var state = states[entryID] else { return }
        state.cooldownUntil = nil
        state.cooldownReason = nil
        states[entryID] = state
    }

    /// Keys currently usable, for display.
    static func availableCount(
        entryIDs: [String],
        states: [String: ModelKeyState],
        now: Date
    ) -> Int {
        entryIDs.filter { states[$0]?.isAvailable(at: now) ?? true }.count
    }

    /// Maps a provider response onto a cooldown reason. Returns nil when the
    /// outcome is not a credential problem and rotation should not react.
    static func reason(
        forHTTPStatus status: Int,
        providerErrorCode: String?
    ) -> ModelKeyCooldownReason? {
        if let providerErrorCode, providerErrorCode == ZAIErrorParser.insufficientBalanceCode {
            return .depleted
        }
        switch status {
        case 401, 403:
            return .rejected
        case 402:
            return .depleted
        case 429:
            return .rateLimited
        default:
            return nil
        }
    }
}
