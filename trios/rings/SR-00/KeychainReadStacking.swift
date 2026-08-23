import Foundation

/// Whether to dispatch another Keychain read for an item that already has one
/// outstanding.
///
/// This is a pure decision, separated from `KeychainSecrets` so it can be
/// proved rather than waited for. The condition it governs - a read that has
/// not settled when the cooldown expires - did not occur in any of the five
/// launches after the guard was written, so the guard sat in the running binary
/// unexercised. A branch nobody can trigger on demand is a branch nobody has
/// checked, and "it never fired" is not the same as "it works".
///
/// The decision exists because `readInFlight` is a boolean and the timeout path
/// clears it deliberately: a read blocked forever would otherwise latch it and
/// blind the app for the life of the process. That left the opposite failure -
/// measured 2026-08-23T07:10, five reads of one item dispatched ~69s apart, one
/// per cooldown expiry, all settling at the same instant. The boolean cannot
/// tell those apart. An age can.
enum KeychainReadStacking {
    enum Decision: Equatable {
        /// Nothing outstanding for this item; make the call.
        case dispatch
        /// A read is still running and young enough to be worth waiting for.
        /// Refuse rather than adding another call to a queue already blocked.
        case refuseOutstanding(ageSeconds: Double)
        /// A read is still running but has exceeded patience. Treat it as
        /// abandoned and dispatch, so this guard cannot become the latch it
        /// replaced.
        case dispatchAbandoning(ageSeconds: Double)
    }

    /// - Parameters:
    ///   - oldestOutstanding: when the oldest unsettled read for this item was
    ///     dispatched, or nil if none is outstanding.
    ///   - now: the clock, injected so the decision is testable.
    ///   - patience: how long an unsettled read is still worth waiting for.
    static func decide(
        oldestOutstanding: Date?,
        now: Date,
        patience: TimeInterval
    ) -> Decision {
        guard let oldest = oldestOutstanding else { return .dispatch }
        let age = now.timeIntervalSince(oldest)
        // A dispatch stamped in the future is a clock that moved backwards, not
        // a read from the future. Treating a negative age as "young" would
        // refuse every caller until the clock caught up, so it is clamped to
        // zero and handled by the ordinary young-read branch.
        let settled = max(age, 0)
        if settled > patience {
            return .dispatchAbandoning(ageSeconds: settled)
        }
        return .refuseOutstanding(ageSeconds: settled)
    }

    /// Whether a call that hit its deadline was starved of a GCD slot rather
    /// than stalled by the Keychain.
    ///
    /// The caller's deadline is two seconds. Measured across 59 starvation
    /// events on 2026-08-23: median slot wait 0.41s, max 7.05s, and five longer
    /// than the whole deadline. For those five, SecItemCopyMatching was never
    /// reached - so calling it "did not answer in 2s" blamed the Keychain for a
    /// queue this process saturated, and armed sixty seconds of refusals over a
    /// query that had not been made.
    ///
    /// - Parameter slotWait: how long the block waited to start, or nil if it
    ///   never started at all. nil is NOT starvation: a block that never ran
    ///   recorded nothing, and inventing a cause for it is the defect this
    ///   whole module exists to avoid.
    static func wasStarvedOut(slotWait: Double?, deadline: TimeInterval) -> Bool {
        guard let waited = slotWait else { return false }
        return waited >= deadline
    }
}
