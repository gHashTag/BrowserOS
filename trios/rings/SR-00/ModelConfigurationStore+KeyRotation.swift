import Foundation

/// Key rotation logic extracted from ModelConfigurationStore.
///
/// Multi-key rotation: spreads requests across stored keys so no single key
/// absorbs the whole rate limit. Parks keys that return credential failures
/// (401, 403, balance-exhausted) and brings them back on cooldown reset.
extension ModelConfigurationStore {

    // MARK: - Rotation state persistence

    static var rotationEnabledKey: String { "trios.model.keyRotationEnabled" }
    static var rotationStatePrefix: String { "trios.model.keyRotationState." }

    var isKeyRotationEnabled: Bool {
        get { defaults.bool(forKey: Self.rotationEnabledKey) }
        set {
            defaults.set(newValue, forKey: Self.rotationEnabledKey)
            objectWillChange.send()
            TriosLogBus.shared.info(
                .models,
                "models.rotation.toggled",
                newValue ? "Key rotation enabled" : "Key rotation disabled"
            )
        }
    }

    func keyStates(for provider: ModelProvider) -> [String: ModelKeyState] {
        guard let data = defaults.data(forKey: Self.rotationStatePrefix + provider.rawValue),
              let decoded = try? JSONDecoder().decode([String: ModelKeyState].self, from: data) else {
            return [:]
        }
        return decoded
    }

    func saveKeyStates(_ states: [String: ModelKeyState], for provider: ModelProvider) {
        guard let data = try? JSONEncoder().encode(states) else { return }
        defaults.set(data, forKey: Self.rotationStatePrefix + provider.rawValue)
        objectWillChange.send()
    }

    // MARK: - Rotation logic

    /// Next key id to use, skipping any that are rate limited or exhausted.
    func nextRotatedEntryID(for provider: ModelProvider) -> String? {
        let ids = ModelCredentialStore.list(for: provider).map(\.id)
        guard ids.count > 1 else { return ids.first }
        return ModelKeyRotation.nextKey(entryIDs: ids, states: keyStates(for: provider), now: Date())
    }

    /// Number of keys currently usable, for the Models tab badge.
    func availableKeyCount(for provider: ModelProvider) -> Int {
        let ids = ModelCredentialStore.list(for: provider).map(\.id)
        return ModelKeyRotation.availableCount(entryIDs: ids, states: keyStates(for: provider), now: Date())
    }

    /// Feeds a provider response back into rotation. A non-credential failure
    /// (5xx, network) deliberately parks nothing.
    func recordKeyOutcome(
        provider: ModelProvider,
        httpStatus: Int,
        providerErrorCode: String? = nil,
        retryAfter: TimeInterval? = nil,
        entryID: String? = nil
    ) {
        guard let id = entryID ?? lastRotatedEntryID[provider] ?? ModelCredentialStore.activeEntryID(for: provider) else {
            return
        }
        var states = keyStates(for: provider)
        let now = Date()
        if (200...299).contains(httpStatus) {
            ModelKeyRotation.recordSuccess(entryID: id, states: &states, now: now)
        } else if let reason = ModelKeyRotation.reason(
            forHTTPStatus: httpStatus,
            providerErrorCode: providerErrorCode
        ) {
            ModelKeyRotation.recordFailure(
                entryID: id,
                reason: reason,
                retryAfter: retryAfter,
                states: &states,
                now: now
            )
            TriosLogBus.shared.warn(
                .models,
                "models.rotation.parked",
                "Parked a key after \(reason.displayName.lowercased())",
                [
                    "provider": provider.rawValue,
                    "entry": id,
                    "http_status": String(httpStatus),
                    "provider_code": providerErrorCode ?? "-"
                ]
            )
        } else {
            return
        }
        saveKeyStates(states, for: provider)
    }

    /// Brings a parked key back, e.g. after the user tops it up.
    func resetKeyCooldown(entryID: String, for provider: ModelProvider) {
        var states = keyStates(for: provider)
        ModelKeyRotation.reset(entryID: entryID, states: &states)
        saveKeyStates(states, for: provider)
    }
}
