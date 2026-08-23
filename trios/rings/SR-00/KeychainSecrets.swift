import Foundation
import Security

/// Errors raised by KeychainSecrets.
enum KeychainSecretsError: LocalizedError {
    case itemNotFound(service: String, account: String)
    case invalidItemType
    case osStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .itemNotFound(let service, let account):
            return "Keychain item not found for \(service)/\(account)"
        case .invalidItemType:
            return "Keychain item has an invalid value type"
        case .osStatus(let status):
            let message = SecCopyErrorMessageString(status, nil) as String?
            return "macOS Keychain error \(status): \(message ?? "unknown error")"
        }
    }
}

/// Minimal Keychain wrapper for storing and retrieving small secrets such as
/// API tokens. Secrets are scoped by (service, account) and stored in the
/// generic-password class. macOS Keychain is the canonical trust boundary for
/// TriOS credentials; env-variable fallbacks are intentionally absent.
enum KeychainSecrets {
    // Bounded-wait machinery for keychain reads, mirroring the pattern in
    // TriOSEncryption.symmetricKey(). At most one background read is allowed
    // at a time, globally; a read that does not answer within the timeout arms
    // a 60-second cooldown so blocked calls don't pile up.
    private static let readLock = NSLock()
    private static var readInFlight: Bool = false

    /// Reads dispatched for an item that have NOT settled yet, oldest first.
    ///
    /// `readInFlight` is a boolean and cannot answer the question that decides
    /// whether to dispatch again: is an earlier read still running, and how
    /// old is it? The timeout path clears the boolean on purpose - a read
    /// blocked forever would otherwise latch it and blind the app for the life
    /// of the process, which is the 2026-08-21 defect. But clearing it means
    /// every cooldown expiry dispatches ANOTHER read into the same blocked
    /// queue.
    ///
    /// Measured 2026-08-23T07:10, release log: five reads of
    /// com.browseros.trios.model-keys were dispatched roughly 69s apart - one
    /// per cooldown expiry - and ALL FIVE settled at the same instant, +299.4s,
    /// with elapsed 294.4 / 239.1 / 170.2 / 101.3 / 32.5. They were never slow
    /// individually; they queued behind one block and returned together. The
    /// cooldown's own comment says it stops callers piling up. It does not: it
    /// paces the pile-up to one every sixty seconds.
    private static var outstandingReads: [String: [Date]] = [:]

    /// How long an unsettled read is still considered worth waiting for. Past
    /// this it is treated as abandoned and a fresh dispatch is allowed, which
    /// keeps the escape hatch the timeout path was written to provide.
    static let outstandingReadPatience: TimeInterval = 600
    /// Ties each in-flight read to the flag it raised. The timeout path and
    /// the orphaned block BOTH clear `readInFlight`; without the generation a
    /// stalled read that settles late clears the flag a newer reader armed,
    /// breaking single-flight and letting two SecItemCopyMatching calls run
    /// at once.
    private static var readGeneration: UInt64 = 0
    /// The deadline the current slot holder was given, so a waiter can decide
    /// how long the slot is worth waiting for. Meaningful only while
    /// `readInFlight` is raised.
    private static var readHolderDeadline: TimeInterval = 2.0

    /// A flag the caller raises AFTER handing it to the background block, so
    /// the block knows its settlement went unobserved and is worth logging.
    /// A reference type on purpose - a captured local would be a value the
    /// sendable closure never sees change. All access under `readLock`.
    private final class GaveUpFlag: @unchecked Sendable {
        var raised = false
    }

    /// Values from stalled calls that settled successfully AFTER their caller
    /// gave up. One-shot, keyed like the cooldowns, served to the next caller
    /// instead of a refusal.
    ///
    /// Measured 2026-08-21 by keychain.read.settled: the "orphaned" calls this
    /// process had written off as never-returning settle with OSStatus 0 in
    /// 9.8-12.6 seconds - securityd is slow here, not broken. Before this
    /// cache, a slow success armed a 60s cooldown and every caller inside it
    /// was told "nothing there" about a value the process was already holding.
    /// A successful settlement also clears the key's cooldown: the condition
    /// the cooldown guards against is disproven by the answer arriving.
    private static var lateSettledData: [String: Data] = [:]
    private static var lateSettledLists: [String: [[String: Any]]] = [:]
    /// Cooldowns, keyed by what actually stalled.
    ///
    /// This was one global date, so a single slow item disabled the Keychain
    /// for every other item for a minute - the same "one inattentive caller
    /// blinds the whole process" shape as the interaction default. The
    /// provider key was refused for sixty seconds at a time because something
    /// else had been slow, and the warm-up's 65-second cadence walked straight
    /// back into the next window.
    private static var readUnavailableUntil: [String: Date] = [:]

    private static func cooledDown(_ key: String) -> Bool {
        guard let until = readUnavailableUntil[key] else { return false }
        if Date() < until { return true }
        readUnavailableUntil[key] = nil
        return false
    }

    // Bounded-wait machinery for keychain writes, mirroring the read pattern.
    // At most one background write is allowed at a time, globally; a write
    // that does not answer within the timeout arms a 60-second cooldown so
    // blocked calls don't pile up.
    //
    // Keyed per item like the read cooldown: one stalled write used to refuse
    // every write for a minute - the same "one slow item blinds the process"
    // shape the read side already had removed.
    private static let writeLock = NSLock()
    private static var writeInFlight: Bool = false
    private static var writeUnavailableUntil: [String: Date] = [:]

    /// True while the app is still coming up. While raised, every keychain
    /// operation returns immediately without touching the Security framework:
    /// reads throw the ordinary not-found result, writes report failure.
    /// Lowered once by ``clearLaunchGate()`` after bootstrap completes.
    static var isLaunching: Bool = true

    /// The stacking decision for this item. Call with `readLock` HELD.
    ///
    /// The branch logic lives in `KeychainReadStacking` so it can be proved by
    /// a suite instead of waited for: across five launches after this guard was
    /// written, no read stayed unsettled long enough to trigger it, so the
    /// running binary carried an unexercised branch. This wrapper does the
    /// dictionary bookkeeping the decision cannot see.
    private static func stackingDecisionLocked(_ key: String) -> KeychainReadStacking.Decision {
        let oldest = outstandingReads[key]?.min()
        let decision = KeychainReadStacking.decide(
            oldestOutstanding: oldest,
            now: Date(),
            patience: outstandingReadPatience
        )
        if case .dispatchAbandoning = decision {
            // Forget the abandoned read so it cannot refuse anyone again.
            outstandingReads[key] = nil
        }
        return decision
    }

    /// Records a dispatch. Call with `readLock` HELD.
    private static func noteDispatchLocked(_ key: String, at when: Date) {
        outstandingReads[key, default: []].append(when)
    }

    /// Records that a dispatch settled, however it settled. Call with
    /// `readLock` HELD.
    private static func noteSettledLocked(_ key: String, at when: Date) {
        guard var dates = outstandingReads[key] else { return }
        if let idx = dates.firstIndex(of: when) { dates.remove(at: idx) }
        outstandingReads[key] = dates.isEmpty ? nil : dates
    }

    /// Lower the launch gate. After this call keychain operations proceed
    /// normally.
    static func clearLaunchGate() {
        isLaunching = false
    }

    /// Read an existing generic-password secret as raw bytes.
    /// Reads a secret.
    ///
    /// `allowsInteraction: false` makes macOS fail fast with
    /// `errSecInteractionNotAllowed` instead of putting up a "enter your login
    /// keychain password" dialog. Callers that can regenerate the secret should
    /// use it: a re-fetchable token is not worth a modal prompt, and blocking on
    /// one froze the app at launch.
    ///
    /// The `SecItemCopyMatching` call runs on a background queue and the caller
    /// waits about two seconds. When the read does not answer in time we throw
    /// the ordinary not-found result rather than hanging the main thread, and
    /// arm a 60-second cooldown.
    /// `allowsInteraction` defaults to FALSE, and that is the important word.
    ///
    /// It defaulted to true, so every caller that did not think about it could
    /// raise a login-keychain dialog. This app is ad-hoc signed and its items
    /// live in the legacy file keychain, so macOS treats each rebuild as a new
    /// application and the dialog is asked for constantly - with nobody there
    /// to answer it in a background path. The read then blocks on securityd,
    /// hits the two-second deadline, and arms a sixty-second cooldown that
    /// makes every OTHER keychain read answer "nothing there".
    ///
    /// One inattentive caller therefore disabled the Keychain for the whole
    /// process, and the provider key looked absent while sitting in plain view
    /// of `security find-generic-password`. A caller that genuinely wants to
    /// prompt - a settings screen with a person in front of it - says so.
    static func readData(
        service: String,
        account: String,
        allowsInteraction: Bool = false,
        deadline: TimeInterval = 2.0
    ) throws -> Data {
        // Dev builds never touch the Keychain; see DevSecretStore.
        if ProjectPaths.usesFileSecretStore {
            guard let data = DevSecretStore.read(service: service, account: account) else {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            return data
        }

        if isLaunching {
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }

        readLock.lock()
        // A stalled call that settled successfully is an answer in hand;
        // serve it before the cooldown can refuse. One-shot: the next read
        // goes to the Keychain again.
        if let settled = lateSettledData.removeValue(forKey: "\(service)/\(account)") {
            readLock.unlock()
            TriosLogBus.shared.info(
                .security, "keychain.read.served_late",
                "\(service) / \(account) answered from the settlement of an "
                    + "earlier stalled call",
                ["service": service, "account": account]
            )
            return settled
        }
        if cooledDown("\(service)/\(account)") {
            readLock.unlock()
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }
        if readInFlight {
            readLock.unlock()
            // Same reasoning as the enumeration: a collision is not an absence,
            // and throwing `itemNotFound` here told every caller the credential
            // did not exist because another read happened to be in flight.
            guard waitForReadSlot() else {
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
            readLock.lock()
            // Re-check the cooldown, not just the slot: measured twice on
            // 2026-08-21, a waiter that passed the check before the holder
            // stalled acquired the freed slot ~20ms after the cooldown armed
            // for exactly this key, and dove into a fresh full-length stall
            // on the same item.
            if readInFlight || cooledDown("\(service)/\(account)") {
                readLock.unlock()
                throw KeychainSecretsError.itemNotFound(service: service, account: account)
            }
        }
        // A read of THIS item that has not settled is not a reason to start
        // another one. The boolean above was already cleared by that read's
        // timeout path (deliberately - see outstandingReads), so without this
        // check every cooldown expiry adds one more call to a queue that is
        // demonstrably blocked.
        let stacking = stackingDecisionLocked("\(service)/\(account)")
        if case let .refuseOutstanding(age) = stacking {
            readLock.unlock()
            TriosLogBus.shared.info(
                .security, "keychain.read.not_restacked",
                "\(service) / \(account) already has a read that has not "
                    + "settled after " + String(format: "%.1f", age)
                    + "s; refusing rather than dispatching a second one into "
                    + "the same queue",
                ["service": service, "account": account,
                 "outstanding_age": String(format: "%.1f", age)]
            )
            throw KeychainSecretsError.itemNotFound(service: service, account: account)
        }
        readInFlight = true
        readGeneration += 1
        readHolderDeadline = deadline
        let generation = readGeneration
        let dispatchStamp = Date()
        noteDispatchLocked("\(service)/\(account)", at: dispatchStamp)
        readLock.unlock()

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if !allowsInteraction {
            query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        }

        // Perform the keychain read on a background queue. The caller waits
        // with a bounded timeout (~2 s). When the read answers in time the
        // data is returned; when it does not, we throw the ordinary not-found
        // result and arm the cooldown.
        let semaphore = DispatchSemaphore(value: 0)
        var result: AnyObject?
        var status: OSStatus = errSecSuccess
        // Raised by the timeout path under readLock, read by the background
        // block once the call settles: when raised, the block reports the
        // settlement the caller could not wait for.
        let callerGaveUp = GaveUpFlag()

        // Measured: how long until the block even STARTS. A saturated global
        // queue looks exactly like a slow Keychain from the caller's side, and
        // the same query from an idle process returns in milliseconds.
        let dispatchedAt = Date()
        DispatchQueue.global(qos: .utility).async {
            let waited = Date().timeIntervalSince(dispatchedAt)
            if waited > 0.2 {
                TriosLogBus.shared.warn(
                    .security, "keychain.queue.starved",
                    "the keychain call waited "
                        + String(format: "%.2f", waited)
                        + "s for a queue slot before it could start",
                    [:]
                )
            }
            status = SecItemCopyMatching(query as CFDictionary, &result)
            let elapsed = Date().timeIntervalSince(dispatchedAt)
            KeychainSecrets.readLock.lock()
            // Settled is settled, whatever the status: this dispatch is no
            // longer outstanding and must stop blocking the next one. Cleared
            // unconditionally, unlike the generation-guarded flag below, because
            // it records THIS call rather than who holds the slot.
            KeychainSecrets.noteSettledLocked("\(service)/\(account)", at: dispatchStamp)
            // Only the generation that armed the flag may clear it; a late
            // settlement must not release a slot a newer reader now holds.
            if KeychainSecrets.readGeneration == generation {
                KeychainSecrets.readInFlight = false
            }
            let orphaned = callerGaveUp.raised
            // A slow SUCCESS is an answer in hand: cache it for the next
            // caller and clear this key's cooldown - the condition it guards
            // against (a call that never returns) is disproven by returning.
            if orphaned, status == errSecSuccess, let data = result as? Data {
                KeychainSecrets.lateSettledData["\(service)/\(account)"] = data
                KeychainSecrets.readUnavailableUntil["\(service)/\(account)"] = nil
            }
            KeychainSecrets.readLock.unlock()
            if orphaned {
                // The missing measurement of 2026-08-21: twelve stalls, and
                // whether any of those calls EVER returned - and with what -
                // was unknowable, because the orphan discarded its status.
                TriosLogBus.shared.info(
                    .security, "keychain.read.settled",
                    "\(service) / \(account) settled after "
                        + String(format: "%.1f", elapsed)
                        + "s with OSStatus \(status), after its caller had given up",
                    [
                        "service": service, "account": account,
                        "status": String(status),
                        "elapsed": String(format: "%.1f", elapsed),
                    ]
                )
            }
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + deadline) == .success {
            guard status == errSecSuccess else {
                if status == errSecItemNotFound {
                    throw KeychainSecretsError.itemNotFound(service: service, account: account)
                }
                // Treat "we would have to ask the user" as absent, so the
                // caller bootstraps a fresh secret rather than failing.
                if status == errSecInteractionNotAllowed || status == errSecAuthFailed {
                    throw KeychainSecretsError.itemNotFound(service: service, account: account)
                }
                throw KeychainSecretsError.osStatus(status)
            }
            guard let data = result as? Data else {
                throw KeychainSecretsError.invalidItemType
            }
            return data
        }

        // Timed out: the background read is still in flight. Arm the cooldown
        // so repeated callers don't pile up blocked reads, and return the
        // ordinary not-found result rather than hanging the main thread.
        // Release the in-flight flag as well as arming the cooldown.
        //
        // The background block clears it when the call returns - and a read
        // blocked on securityd waiting for an ACL approval nobody can give
        // never returns, so the flag stayed raised for the life of the process.
        // Every later enumeration then answered "another read held the slot",
        // which the store reported as "no entries listed" and the Queen read as
        // "there is no key". One stuck read at launch, and the app never
        // touched the Keychain again.
        //
        // The flag exists to stop callers piling up, not to latch. The
        // generation check keeps the orphan's own late clear from releasing
        // a slot a newer reader holds.
        readLock.lock()
        readUnavailableUntil["\(service)/\(account)"] = Date().addingTimeInterval(60)
        // Generation-guarded for the same reason as the block's clear: if the
        // orphan settled in the gap after our wait timed out, a newer reader
        // may already hold the slot this path would otherwise release.
        if readGeneration == generation {
            readInFlight = false
        }
        callerGaveUp.raised = true
        readLock.unlock()
        // Name the read that stalled, with the numbers this call measured:
        // the message used to hardcode "2s" while callers pass their own
        // deadline (8s in ModelConfigurationStore), and claimed "every
        // keychain read is refused" a day after the cooldown went per-item.
        TriosLogBus.shared.warn(
            .security,
            "keychain.read.stalled",
            "\(service) / \(account) did not answer in "
                + String(format: "%.0f", deadline)
                + "s (interaction \(allowsInteraction ? "allowed" : "skipped")); "
                + "reads of this item are refused for 60s",
            ["service": service, "account": account]
        )
        throw KeychainSecretsError.itemNotFound(service: service, account: account)
    }

    /// Read an existing generic-password secret as a UTF-8 string.
    static func read(
        service: String,
        account: String,
        allowsInteraction: Bool = false
    ) throws -> String {
        let data = try readData(
            service: service,
            account: account,
            allowsInteraction: allowsInteraction
        )
        guard let value = String(data: data, encoding: .utf8) else {
            throw KeychainSecretsError.invalidItemType
        }
        return value
    }

    /// List all generic-password items for a service, returning their
    /// attributes without secret data.
    ///
    /// Shares the same read guard as ``readData``: at most one read in
    /// flight globally, a 60-second cooldown after a timeout, empty array
    /// on expiry.
    /// Waits for an in-flight Keychain read to finish, briefly.
    ///
    /// `readInFlight` is a global single-flight lock, and both readers used to
    /// answer "empty" the moment they found it taken. Empty is indistinguishable
    /// from "no such item", so a *collision* was reported as an *absence* - and
    /// this app reads the Keychain from several places at once: the key warm-up,
    /// the timeline token, the issue fetcher and the credential resolve. Whoever
    /// lost the race was told the key did not exist, refused the dispatch, and
    /// left the swarm idle with "store: no entries listed".
    ///
    /// A single-flight lock is supposed to serialise callers, not fail them.
    /// Bounded because the reason all of this is defensive is that a blocking
    /// Keychain read once froze the app at launch: after the deadline the old
    /// behaviour stands.
    /// The wait must outlast the holder's own deadline.
    ///
    /// At 1.5 seconds against a 2-second read deadline the waiter gave up
    /// half a second before the holder was obliged to finish, so it lost every
    /// contested race - and reported the loss as "no entries listed", which the
    /// Queen read as "there is no key" and refused to dispatch. The whole swarm
    /// idled on half a second of arithmetic.
    private static func waitForReadSlot(deadline: TimeInterval? = nil) -> Bool {
        // The wait must outlast the CURRENT holder's deadline, whatever it
        // is. The fixed 2.6s answered 2s holders and then silently lost every
        // race again when ModelConfigurationStore began passing deadline: 8.0
        // - the exact defect the comment above records being fixed once.
        readLock.lock()
        let holder = readHolderDeadline
        readLock.unlock()
        let bound = deadline ?? max(2.6, holder + 0.6)
        let limit = Date().addingTimeInterval(bound)
        while Date() < limit {
            readLock.lock()
            let busy = readInFlight
            readLock.unlock()
            if !busy { return true }
            usleep(25_000)
        }
        readLock.lock()
        let stillBusy = readInFlight
        readLock.unlock()
        return !stillBusy
    }

    /// Why the last enumeration returned nothing. Read by the credential
    /// diagnosis, because "no entries listed" has five different causes and
    /// four of them are not "there are no entries".
    private(set) nonisolated(unsafe) static var lastEnumerationOutcome = "not attempted"

    /// `deadline` is how long the CALLER waits, not how long the Keychain is
    /// given. Two seconds protects an interactive path; a background warm-up
    /// has no responsiveness to protect and must not be told the key does not
    /// exist because securityd took two and a half seconds.
    ///
    /// Measured here: the dispatched block starts immediately - there is no
    /// queue starvation - and `SecItemCopyMatching` itself exceeds two seconds
    /// inside the app, while the identical query from an idle process returns
    /// in milliseconds. The app is ad-hoc signed and these items live in the
    /// legacy file keychain, so its identity does not match the ACL recorded
    /// when they were written.
    static func readAllAttributes(
        service: String,
        deadline: TimeInterval = 2.0
    ) -> [[String: Any]] {
        if isLaunching {
            lastEnumerationOutcome = "refused: still inside the launch gate"
            return []
        }

        readLock.lock()
        // Serve the settlement of an earlier stalled listing before the
        // cooldown can refuse; one-shot, same as the read path.
        if let settled = lateSettledLists.removeValue(forKey: "list/\(service)") {
            readLock.unlock()
            lastEnumerationOutcome =
                "\(settled.count) item(s), served from the settlement of an "
                + "earlier stalled call"
            TriosLogBus.shared.info(
                .security, "keychain.read.served_late",
                "listing \(service) answered from the settlement of an "
                    + "earlier stalled call",
                ["service": service]
            )
            return settled
        }
        if cooledDown("list/\(service)") {
            readLock.unlock()
            lastEnumerationOutcome = "refused: cooldown armed after an earlier stall "
                + "on this service"
            return []
        }
        if readInFlight {
            readLock.unlock()
            // Busy is not absent. Wait for the slot instead of reporting that
            // the item does not exist.
            guard waitForReadSlot() else {
                lastEnumerationOutcome = "refused: another read held the slot"
                return []
            }
            readLock.lock()
            // Same re-check as readData: the slot freeing and the cooldown
            // arming are one event when the holder stalls, and a waiter that
            // only re-checks the slot walks into a fresh stall on the same
            // service.
            if readInFlight || cooledDown("list/\(service)") {
                readLock.unlock()
                lastEnumerationOutcome = "refused: the slot freed into a cooldown "
                    + "armed by the stalled holder"
                return []
            }
        }
        readInFlight = true
        readGeneration += 1
        readHolderDeadline = deadline
        let generation = readGeneration
        readLock.unlock()

        // Attributes only, and never a dialog.
        //
        // These items live in the legacy file keychain, where the ACL names the
        // application that created them - and this app is ad-hoc signed, so a
        // rebuilt binary is a different application to macOS. Without the skip,
        // the enumeration blocks on securityd waiting for an approval nobody is
        // there to give, hits the two-second deadline, arms the sixty-second
        // cooldown, and returns empty. The warm-up then retries every 65
        // seconds - straight back into the same trap.
        //
        // Reported to the caller as "no entries listed", which is why the swarm
        // sat idle claiming the key did not exist while `security
        // find-generic-password` found it from a terminal in one go.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip
        ]

        let semaphore = DispatchSemaphore(value: 0)
        var result: CFTypeRef?
        var status: OSStatus = errSecSuccess
        let callerGaveUp = GaveUpFlag()

        // Measured: how long until the block even STARTS. A saturated global
        // queue looks exactly like a slow Keychain from the caller's side, and
        // the same query from an idle process returns in milliseconds.
        let dispatchedAt = Date()
        DispatchQueue.global(qos: .utility).async {
            let waited = Date().timeIntervalSince(dispatchedAt)
            if waited > 0.2 {
                TriosLogBus.shared.warn(
                    .security, "keychain.queue.starved",
                    "the keychain call waited "
                        + String(format: "%.2f", waited)
                        + "s for a queue slot before it could start",
                    [:]
                )
            }
            status = SecItemCopyMatching(query as CFDictionary, &result)
            let elapsed = Date().timeIntervalSince(dispatchedAt)
            KeychainSecrets.readLock.lock()
            if KeychainSecrets.readGeneration == generation {
                KeychainSecrets.readInFlight = false
            }
            let orphaned = callerGaveUp.raised
            if orphaned, status == errSecSuccess,
               let items = result as? [[String: Any]] {
                KeychainSecrets.lateSettledLists["list/\(service)"] = items
                KeychainSecrets.readUnavailableUntil["list/\(service)"] = nil
            }
            KeychainSecrets.readLock.unlock()
            if orphaned {
                TriosLogBus.shared.info(
                    .security, "keychain.read.settled",
                    "listing \(service) settled after "
                        + String(format: "%.1f", elapsed)
                        + "s with OSStatus \(status), after its caller had given up",
                    [
                        "service": service,
                        "status": String(status),
                        "elapsed": String(format: "%.1f", elapsed),
                    ]
                )
            }
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + deadline) == .success {
            guard status == errSecSuccess else {
                lastEnumerationOutcome = "SecItemCopyMatching returned \(status)"
                return []
            }
            guard let items = result as? [[String: Any]] else {
                lastEnumerationOutcome = "the result could not be read as attributes"
                return []
            }
            lastEnumerationOutcome = "\(items.count) item(s)"
            return items
        }

        readLock.lock()
        readUnavailableUntil["list/\(service)"] = Date().addingTimeInterval(60)
        if readGeneration == generation {
            readInFlight = false
        }
        callerGaveUp.raised = true
        readLock.unlock()
        lastEnumerationOutcome = "timed out; cooldown armed for 60s on this service"
        // The message carries the deadline this call was given (the "2s" it
        // used to print was false for every 8-second enumeration measured on
        // 2026-08-21) and the per-service scope the cooldown actually has.
        TriosLogBus.shared.warn(
            .security,
            "keychain.enumeration.stalled",
            "listing \(service) did not answer in "
                + String(format: "%.0f", deadline)
                + "s; listings of this service are refused for 60s",
            ["service": service]
        )
        return []
    }

    /// Store or overwrite raw generic-password data. Replaces an existing item
    /// with the same (service, account) pair.
    ///
    /// The `SecItemAdd` / `SecItemUpdate` call runs on a background queue and
    /// the caller waits about two seconds. When the write does not answer in
    /// time we report failure rather than hanging the main thread, and arm a
    /// 60-second cooldown.
    static func writeData(service: String, account: String, data: Data) throws {
        if ProjectPaths.usesFileSecretStore {
            guard DevSecretStore.write(service: service, account: account, data: data) else {
                throw KeychainSecretsError.invalidItemType
            }
            return
        }

        if isLaunching {
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }

        // After a timeout, refuse writes of THIS item for 60 seconds.
        // At most one write in flight at a time.
        // -4093 == errSecTimeout (not bridged to Swift).
        writeLock.lock()
        if let until = writeUnavailableUntil["\(service)/\(account)"] {
            if Date() < until {
                writeLock.unlock()
                throw KeychainSecretsError.osStatus(OSStatus(-4093))
            }
            writeUnavailableUntil["\(service)/\(account)"] = nil
        }
        if writeInFlight {
            writeLock.unlock()
            throw KeychainSecretsError.osStatus(OSStatus(-4093))
        }
        writeInFlight = true
        writeLock.unlock()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String:
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]

        // Perform the keychain write on a background queue. The caller waits
        // with a bounded timeout (~2 s). When the write answers in time the
        // status is checked normally; when it does not, we report failure and
        // arm the cooldown.
        let semaphore = DispatchSemaphore(value: 0)
        var status: OSStatus = errSecSuccess

        DispatchQueue.global(qos: .utility).async {
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            if addStatus == errSecDuplicateItem {
                let update: [String: Any] = [
                    kSecValueData as String: data,
                ]
                status = SecItemUpdate(
                    [
                        kSecClass as String: kSecClassGenericPassword,
                        kSecAttrService as String: service,
                        kSecAttrAccount as String: account,
                    ] as CFDictionary,
                    update as CFDictionary
                )
            } else {
                status = addStatus
            }
            KeychainSecrets.writeLock.lock()
            KeychainSecrets.writeInFlight = false
            KeychainSecrets.writeLock.unlock()
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 2.0) == .success {
            if status == errSecSuccess {
                return
            }
            throw KeychainSecretsError.osStatus(status)
        }

        // Timed out: the background write is still in flight. Arm the cooldown
        // for this item so repeated callers don't pile up blocked writes, and
        // report failure rather than hanging the main thread.
        writeLock.lock()
        writeUnavailableUntil["\(service)/\(account)"] = Date().addingTimeInterval(60)
        writeLock.unlock()
        throw KeychainSecretsError.osStatus(OSStatus(-4093))
    }

    /// Store or overwrite a generic-password secret string.
    static func write(service: String, account: String, secret: String) throws {
        guard let data = secret.data(using: .utf8) else {
            throw KeychainSecretsError.invalidItemType
        }
        try writeData(service: service, account: account, data: data)
    }

    /// Delete a stored secret.
    static func delete(service: String, account: String) throws {
        if ProjectPaths.usesFileSecretStore {
            DevSecretStore.delete(service: service, account: account)
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSecretsError.osStatus(status)
        }
    }
}
