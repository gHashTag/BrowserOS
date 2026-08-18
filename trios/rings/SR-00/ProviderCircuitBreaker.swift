import Foundation

/// A concrete (provider, baseURL, model) tuple used for per-endpoint unhealthy
/// tracking. Model names alone are ambiguous across providers.
struct ModelEndpointTuple: Hashable, Sendable, Equatable {
    let provider: ModelProvider
    let baseURL: String
    let model: String
}

/// A concrete (provider, baseURL) endpoint for provider-level circuit breaker
/// state. A single endpoint may host many models; provider-wide failures
/// (auth, balance, rate-limit storms) affect the endpoint, not a single model.
struct ProviderEndpointKey: Hashable, Sendable, Equatable {
    let provider: ModelProvider
    let baseURL: String

    /// A hash that is the same in every process, unlike `hashValue`.
    ///
    /// Swift seeds `Hashable` with a per-process random value, so `hashValue`
    /// is stable only for the lifetime of one launch. The cooldown jitter was
    /// derived from it under a comment promising a ratio "stable for the same
    /// endpoint" - true within a run, false across restarts. Two consequences,
    /// one operational and one that hid the other:
    ///
    ///   - a client that restarts draws a fresh jitter for the same endpoint,
    ///     which is precisely the desynchronisation this was meant to give
    ///     across CLIENTS, not across restarts of one client;
    ///   - and no test of it could reproduce, so a real floor violation
    ///     (below) read as a flaky test for as long as it existed.
    ///
    /// FNV-1a over the same bytes the key is made of. Not a security hash and
    /// not required to be: it needs to be spread and it needs to be the same
    /// tomorrow.
    var stableHash: UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in "\(provider.rawValue)|\(baseURL)".utf8 {
            hash ^= UInt64(byte)
            hash &*= 0x0000_0100_0000_01b3
        }
        return hash
    }
}

/// Classified failure kinds used to drive circuit-breaker cooldown policy.
///
/// Distinguishing rate-limit from auth/balance/gateway failures lets TriOS apply
/// kind-specific cooldowns and surface meaningful provider status in the UI.
enum ProviderCircuitBreakerFailureKind: String, Sendable, CaseIterable, Identifiable {
    case rateLimit
    case auth
    case balance
    case gateway
    case connection
    case timeout
    case modelUnavailable
    case contextLength
    case unknown

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .rateLimit: return "Rate limited"
        case .auth: return "Authentication failed"
        case .balance: return "Insufficient balance"
        case .gateway: return "Provider gateway error"
        case .connection: return "Connection failed"
        case .timeout: return "Request timed out"
        case .modelUnavailable: return "Model unavailable"
        case .contextLength: return "Context length exceeded"
        case .unknown: return "Unknown error"
        }
    }

    /// Whether this kind is likely transient on a short timescale and should
    /// recover after a brief cooldown.
    var isTransient: Bool {
        switch self {
        case .rateLimit, .gateway, .connection, .timeout, .modelUnavailable:
            return true
        case .auth, .balance, .contextLength, .unknown:
            return false
        }
    }

    /// A weight for volatility learning: lower values mean the failure shrinks
    /// cache TTL and refresh intervals more aggressively because retrying the
    /// same provider/model is unlikely to help.
    var volatilityWeight: Double {
        switch self {
        case .auth, .balance, .contextLength:
            return 0.0
        case .rateLimit, .gateway, .connection, .timeout:
            return 0.5
        case .modelUnavailable, .unknown:
            return 0.75
        }
    }
}

/// Tri-state for a provider endpoint circuit breaker.
///
/// - closed: traffic allowed; failures count toward the trip threshold.
/// - open: traffic blocked until `nextAllowedAt`; only a probe may pass.
/// - halfOpen: a single probe is allowed to test recovery.
enum ProviderCircuitBreakerState: String, Sendable, Equatable, Identifiable {
    case closed
    case open
    case halfOpen

    var id: String { rawValue }
}

/// Per-provider-endpoint circuit breaker with kind-aware cooldowns.
///
/// Cycle 19 adds this actor so that cross-provider failover does not blindly
/// switch to a provider that is currently rate-limited, out of quota, or
/// recently auth-failed. Cycle 20 adds a single-probe lock in half-open state
/// and jittered recovery to prevent synchronized retry storms.
/// It is intentionally in-memory only; persistence can be layered later via
/// the encrypted MemoryStore if needed.
actor ProviderCircuitBreaker: Sendable {
    struct Entry: Sendable, Equatable {
        var state: ProviderCircuitBreakerState
        var failureStreak: Int
        var lastFailureKind: ProviderCircuitBreakerFailureKind
        var lastFailureAt: Date
        var nextAllowedAt: Date
        var successCount: Int
        /// True while a single half-open probe is in flight.
        var isProbing: Bool
        /// When the current half-open probe started, used to time out stuck probes.
        var probeStartedAt: Date?
    }

    private var entries: [ProviderEndpointKey: Entry] = [:]
    private var probingKeys: Set<ProviderEndpointKey> = []
    private let failureThreshold: Int
    private let baseCooldown: TimeInterval
    private let maxCooldown: TimeInterval
    private let halfOpenProbeTimeout: TimeInterval
    private let transientBackoffMultiplier: Double
    private let persistentBackoffMultiplier: Double
    private let jitterFactor: Double
    private let clock: () -> Date

    init(
        failureThreshold: Int = 2,
        baseCooldown: TimeInterval = 30,
        maxCooldown: TimeInterval = 300,
        halfOpenProbeTimeout: TimeInterval = 60,
        transientBackoffMultiplier: Double = 2.0,
        persistentBackoffMultiplier: Double = 4.0,
        jitterFactor: Double = 0.1,
        clock: @escaping () -> Date = Date.init
    ) {
        self.failureThreshold = max(1, failureThreshold)
        self.baseCooldown = max(1, baseCooldown)
        self.maxCooldown = max(baseCooldown, maxCooldown)
        self.halfOpenProbeTimeout = max(10, halfOpenProbeTimeout)
        self.transientBackoffMultiplier = max(1, transientBackoffMultiplier)
        self.persistentBackoffMultiplier = max(1, persistentBackoffMultiplier)
        self.jitterFactor = max(0, min(1, jitterFactor))
        self.clock = clock
    }

    // MARK: - Public queries

    func state(for key: ProviderEndpointKey) -> ProviderCircuitBreakerState {
        entry(for: key, now: clock()).state
    }

    /// Returns true when the endpoint is allowed to receive traffic. In
    /// half-open state only one concurrent probe is permitted; subsequent callers
    /// must wait until that probe resolves. A probe that exceeds
    /// `halfOpenProbeTimeout` is auto-released so recovery is not blocked by a
    /// stuck caller.
    func canSend(to key: ProviderEndpointKey) -> Bool {
        let now = clock()
        releaseStuckProbeIfNeeded(key, now: now)
        let entry = entry(for: key, now: now)
        switch entry.state {
        case .closed:
            return true
        case .halfOpen:
            return !probingKeys.contains(key)
        case .open:
            return now >= entry.nextAllowedAt
        }
    }

    /// Returns true when a single caller may start a half-open probe. The caller
    /// MUST call `endProbe(_:success:)` when the probe finishes so the next
    /// caller can attempt recovery.
    func beginProbe(_ key: ProviderEndpointKey) -> Bool {
        let now = clock()
        releaseStuckProbeIfNeeded(key, now: now)
        let entry = entry(for: key, now: now)
        guard entry.state == .halfOpen || (entry.state == .open && now >= entry.nextAllowedAt) else {
            return false
        }
        guard !probingKeys.contains(key) else { return false }
        probingKeys.insert(key)
        if var existing = entries[key] {
            existing.isProbing = true
            existing.probeStartedAt = now
            entries[key] = existing
        }
        return true
    }

    /// Ends a half-open probe and updates breaker state. Callers MUST balance
    /// every successful `beginProbe` with `endProbe`.
    func endProbe(_ key: ProviderEndpointKey, success: Bool) {
        probingKeys.remove(key)
        guard entries[key] != nil else { return }
        if success {
            recordSuccess(key)
        } else {
            // Re-trip immediately: a failed probe keeps the breaker open with a
            // fresh cooldown computed from the previous failure kind.
            let kind = entries[key]?.lastFailureKind ?? .unknown
            recordFailure(key, kind: kind)
        }
    }

    func nextRetryAt(for key: ProviderEndpointKey) -> Date? {
        let now = clock()
        let entry = entry(for: key, now: now)
        guard entry.state == .open else { return nil }
        return entry.nextAllowedAt
    }

    func lastFailureKind(for key: ProviderEndpointKey) -> ProviderCircuitBreakerFailureKind? {
        entries[key].map { $0.lastFailureKind }
    }

    func failureStreak(for key: ProviderEndpointKey) -> Int {
        entries[key]?.failureStreak ?? 0
    }

    // MARK: - Mutations

    /// Records a failure and trips the breaker to open when the threshold is met.
    /// `retryAfter` overrides the computed cooldown when the provider sends one
    /// (e.g., a 429 `Retry-After` header).
    func recordFailure(
        _ key: ProviderEndpointKey,
        kind: ProviderCircuitBreakerFailureKind,
        retryAfter: TimeInterval? = nil
    ) {
        let now = clock()
        let old = entry(for: key, now: now)
        let newStreak = old.state == .open ? old.failureStreak : old.failureStreak + 1
        let cooldown = computeCooldown(
            key: key,
            kind: kind,
            streak: newStreak,
            retryAfter: retryAfter,
            previousNextAllowedAt: old.nextAllowedAt
        )
        let nextAllowedAt = max(now.addingTimeInterval(cooldown), old.nextAllowedAt)
        entries[key] = Entry(
            state: newStreak >= failureThreshold ? .open : old.state,
            failureStreak: newStreak,
            lastFailureKind: kind,
            lastFailureAt: now,
            nextAllowedAt: nextAllowedAt,
            successCount: old.successCount,
            isProbing: false,
            probeStartedAt: nil
        )
    }

    /// Records a success. In half-open state this closes the breaker; in open
    /// state it transitions to half-open so the next request becomes a probe.
    func recordSuccess(_ key: ProviderEndpointKey) {
        let now = clock()
        guard let old = entries[key] else { return }
        probingKeys.remove(key)
        switch old.state {
        case .closed:
            entries[key] = Entry(
                state: .closed,
                failureStreak: 0,
                lastFailureKind: old.lastFailureKind,
                lastFailureAt: old.lastFailureAt,
                nextAllowedAt: now,
                successCount: old.successCount + 1,
                isProbing: false,
                probeStartedAt: nil
            )
        case .halfOpen, .open:
            entries[key] = Entry(
                state: .closed,
                failureStreak: 0,
                lastFailureKind: old.lastFailureKind,
                lastFailureAt: old.lastFailureAt,
                nextAllowedAt: now,
                successCount: old.successCount + 1,
                isProbing: false,
                probeStartedAt: nil
            )
        }
    }

    /// Manually resets an endpoint to closed, e.g. after the user edits a key.
    func reset(_ key: ProviderEndpointKey) {
        entries.removeValue(forKey: key)
    }

    // MARK: - Private helpers

    private func entry(for key: ProviderEndpointKey, now: Date) -> Entry {
        if let existing = entries[key] {
            // If the open window has passed and no probe has run yet, transition
            // to half-open so the next allowed request becomes a probe.
            if existing.state == .open, now >= existing.nextAllowedAt {
                let halfOpen = Entry(
                    state: .halfOpen,
                    failureStreak: existing.failureStreak,
                    lastFailureKind: existing.lastFailureKind,
                    lastFailureAt: existing.lastFailureAt,
                    nextAllowedAt: now,
                    successCount: existing.successCount,
                    isProbing: existing.isProbing,
                    probeStartedAt: existing.probeStartedAt
                )
                entries[key] = halfOpen
                return halfOpen
            }
            return existing
        }
        return Entry(
            state: .closed,
            failureStreak: 0,
            lastFailureKind: .unknown,
            lastFailureAt: .distantPast,
            nextAllowedAt: now,
            successCount: 0,
            isProbing: false,
            probeStartedAt: nil
        )
    }

    private func computeCooldown(
        key: ProviderEndpointKey,
        kind: ProviderCircuitBreakerFailureKind,
        streak: Int,
        retryAfter: TimeInterval?,
        previousNextAllowedAt: Date
    ) -> TimeInterval {
        if let retryAfter = retryAfter, retryAfter > 0 {
            return retryAfter
        }
        let multiplier = kind.isTransient ? transientBackoffMultiplier : persistentBackoffMultiplier
        let exponent = max(0, streak - failureThreshold)
        let base = baseCooldown * pow(multiplier, Double(exponent))
        // The kind-specific minimum. Named, because it is the thing jitter must
        // not be allowed to undercut - a floor that jitter can push through is
        // not a floor, and `balance` was landing at 111 s under a stated
        // minimum of 120 s.
        let floor: TimeInterval
        switch kind {
        case .auth:
            // Auth issues usually need human intervention; use the maximum
            // cooldown quickly but still allow occasional probes.
            floor = baseCooldown * 2
        case .balance:
            // Balance issues require a top-up and should not be retried aggressively.
            floor = baseCooldown * 4
        case .contextLength:
            // Context-length failures are prompt-specific; keep them out of the
            // warmup cache long enough to discourage repeated doomed sends.
            floor = baseCooldown * 2
        case .rateLimit, .gateway, .connection, .timeout, .modelUnavailable, .unknown:
            floor = 0
        }
        let cooldown = min(maxCooldown, max(base, floor))
        guard jitterFactor > 0 else { return cooldown }
        // Add +/-jitterFactor to desynchronize recovery probes across clients
        // and avoid thundering-herd retries. `stableHash`, not `hashValue`: see
        // the note on ProviderEndpointKey for why the latter is not stable
        // across processes despite the comment that used to be here.
        let ratio = Double(key.stableHash % 1_000_000) / 1_000_000.0
        let jitter = cooldown * jitterFactor * (ratio * 2 - 1)
        // Clamped back to the floor, and never above maxCooldown either: the
        // jitter is there to spread retries, not to overrule the policy it is
        // spreading.
        return min(maxCooldown, max(floor, max(0, cooldown + jitter)))
    }

    /// If a half-open probe has been in flight longer than the probe timeout,
    /// release the lock so another caller can attempt recovery.
    private func releaseStuckProbeIfNeeded(_ key: ProviderEndpointKey, now: Date) {
        guard probingKeys.contains(key),
              let entry = entries[key],
              entry.isProbing,
              let startedAt = entry.probeStartedAt,
              now.timeIntervalSince(startedAt) >= halfOpenProbeTimeout else { return }
        probingKeys.remove(key)
        if var existing = entries[key] {
            existing.isProbing = false
            existing.probeStartedAt = nil
            entries[key] = existing
        }
    }
}

extension TransportError {
    /// Maps a transport error to a circuit-breaker failure kind.
    var circuitBreakerFailureKind: ProviderCircuitBreakerFailureKind {
        if isContextLengthError { return .contextLength }
        if isRateLimitError { return .rateLimit }
        if isAuthError { return .auth }
        if isBalanceError { return .balance }
        if isModelUnavailableError { return .gateway }
        if isInvalidModelError { return .modelUnavailable }
        switch self {
        case .connectionFailed: return .connection
        case .requestTimedOut: return .timeout
        default: return .unknown
        }
    }
}
