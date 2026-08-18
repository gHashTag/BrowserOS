// Local authorization token provider for BrowserOS loopback endpoints.
// High-impact routes (agent/skill creation, A2A messaging, chat, shutdown,
// soul updates) require the token issued by LocalAuthService.
// AGENT-V-WAIVER: CYCLE-24-REFRESH-ROTATION
// Reason: hand-edited ring canon file to add refresh-token rotation,
//         family-invalidation fallback, and dual-keychain storage.
import Foundation

/// Server-issued local-auth token metadata. The `refreshToken` is present
/// when bootstrapping from `/auth/local-token`; it is absent from the nested
/// `info` object returned by `/auth/refresh`, so it is optional.
struct LocalAuthTokenInfo: Sendable, Codable {
    let token: String
    let refreshToken: String?
    let issuedAt: Date
    let expiresAt: Date
    let expiresInSeconds: TimeInterval
    let ttlSeconds: TimeInterval
}

/// Response from `POST /auth/refresh`: a new access+refresh pair plus metadata.
struct LocalAuthRefreshResponse: Sendable, Codable {
    let accessToken: String
    let refreshToken: String
    let info: LocalAuthTokenInfo
}

/// Abstracts the fetching and caching of the server-issued local auth token.
/// Conforming types must be Sendable because they are shared between actors.
protocol LocalAuthProviding: Sendable {
    /// Returns a valid local-auth token, fetching, refreshing, or caching it as
    /// needed. When `forcingRefresh` is true, the provider discards the cached
    /// token and performs a full bootstrap from `/auth/local-token`.
    func validToken(forcingRefresh: Bool) async throws -> String?
}

/// Abstracts durable storage for the BrowserOS local-auth access and refresh
/// tokens. Conforming types must be Sendable because they are shared between
/// actors.
protocol LocalAuthTokenStore: Sendable {
    /// Read the stored access token, or nil if no token is stored.
    func read() async throws -> String?
    /// Persist the access token durably. Overwrites any existing stored token.
    func write(_ token: String) async throws
    /// Remove the stored access token.
    func delete() async throws
    /// Read the stored refresh token, or nil if no refresh token is stored.
    func readRefreshToken() async throws -> String?
    /// Persist the refresh token durably. Overwrites any existing stored token.
    func writeRefreshToken(_ token: String) async throws
    /// Remove the stored refresh token.
    func deleteRefreshToken() async throws
}

/// Actor-backed Keychain store for the local-auth access and refresh tokens.
actor KeychainLocalAuthTokenStore: LocalAuthTokenStore {
    static let service = "com.browseros.trios.local-auth"
    static let account = "browseros-local-token"
    static let refreshAccount = "browseros-local-refresh-token"

    // These tokens are a cache: both are re-issued by the unauthenticated
    // GET /auth/local-token. Reading them is therefore never worth a password
    // prompt - if macOS wants approval we report "absent" and the provider
    // bootstraps a fresh pair. That is what keeps chat and A2A working after a
    // rebuild changes the app's code identity.
    func read() async throws -> String? {
        do {
            return try KeychainSecrets.read(
                service: Self.service,
                account: Self.account,
                allowsInteraction: false
            )
        } catch KeychainSecretsError.itemNotFound {
            return nil
        }
    }

    func write(_ token: String) async throws {
        try KeychainSecrets.write(
            service: Self.service,
            account: Self.account,
            secret: token
        )
    }

    func delete() async throws {
        try KeychainSecrets.delete(service: Self.service, account: Self.account)
    }

    func readRefreshToken() async throws -> String? {
        do {
            return try KeychainSecrets.read(
                service: Self.service,
                account: Self.refreshAccount,
                allowsInteraction: false
            )
        } catch KeychainSecretsError.itemNotFound {
            return nil
        }
    }

    func writeRefreshToken(_ token: String) async throws {
        try KeychainSecrets.write(
            service: Self.service,
            account: Self.refreshAccount,
            secret: token
        )
    }

    func deleteRefreshToken() async throws {
        try KeychainSecrets.delete(service: Self.service, account: Self.refreshAccount)
    }
}

/// Actor that fetches the BrowserOS local-auth tokens from `/auth/local-token`,
/// caches them in memory, persists them via an injected `LocalAuthTokenStore`,
/// rotates them via `/auth/refresh`, and reports lifecycle events to a
/// `LocalAuthMonitor`. Concurrent refresh requests are deduplicated into a
/// single fetch or refresh operation.
actor LocalAuthProvider: LocalAuthProviding {
    static let headerName = "X-TriOS-Local-Auth"
    static let keychainService = KeychainLocalAuthTokenStore.service
    static let keychainAccount = KeychainLocalAuthTokenStore.account
    static let keychainRefreshAccount = KeychainLocalAuthTokenStore.refreshAccount

    /// Default proactive-refresh margin before server-side expiry.
    static let expiryRefreshMargin: TimeInterval = 60

    private let baseURL: URL
    private let session: URLSession
    private let tokenStore: LocalAuthTokenStore
    private let monitor: LocalAuthMonitor
    private let fallbackMaxAge: TimeInterval
    private var cachedToken: String?
    private var cachedRefreshToken: String?
    private var cachedInfo: LocalAuthTokenInfo?
    private var refreshTask: Task<String?, Error>?

    init(
        baseURL: URL,
        session: URLSession = .shared,
        tokenStore: LocalAuthTokenStore = KeychainLocalAuthTokenStore(),
        monitor: LocalAuthMonitor = .shared,
        fallbackMaxAge: TimeInterval = LocalAuthMonitor.proactiveRefreshInterval
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenStore = tokenStore
        self.monitor = monitor
        self.fallbackMaxAge = fallbackMaxAge
    }

    func validToken(forcingRefresh: Bool = false) async throws -> String? {
        if !forcingRefresh, let token = cachedToken {
            if await shouldRefreshPrecisely() {
                return try await refreshTokensIfNeeded()
            }
            return token
        }
        if !forcingRefresh, let token = try? await tokenStore.read() {
            cachedToken = token
            cachedRefreshToken = try? await tokenStore.readRefreshToken()
            // Adopting a stored token starts the age clock. Without this the
            // heuristic has no reference point at all: the monitor's metadata
            // is in-memory and the store is durable, so every launch asked "how
            // long since I fetched" about a process that never had, got
            // "forever", and threw a good token away. Recording adoption rather
            // than special-casing the answer keeps the NEXT question - has it
            // been in use longer than fallbackMaxAge - meaningful.
            await monitor.recordAdoptedStoredToken()
            if await shouldRefreshPrecisely(holdingStoredToken: true) {
                return try await refreshTokensIfNeeded()
            }
            return token
        }
        return try await refreshTokensIfNeeded(forceBootstrap: true)
    }

    /// Returns the most recently fetched access-token metadata, if any.
    func currentTokenInfo() -> LocalAuthTokenInfo? {
        cachedInfo
    }

    /// Clears the in-memory cache and the durable token store, then records
    /// the reset so the UI can guide the user to re-establish local auth.
    func resetLocalAuth() async {
        cachedToken = nil
        cachedRefreshToken = nil
        cachedInfo = nil
        try? await tokenStore.delete()
        try? await tokenStore.deleteRefreshToken()
        await monitor.recordReset()
    }

    /// True if we have server-side TTL info and it is within the refresh
    /// margin, or if we lack TTL info and the age-based heuristic says stale.
    ///
    /// `holdingStoredToken` is the case this used to get wrong. The monitor's
    /// `shouldProactivelyRefresh` answers "have I fetched recently", and for a
    /// monitor that has never fetched the answer is yes, refresh - correct, and
    /// a deliberate contract of its own. But the monitor's metadata lives only
    /// in memory while the token store is durable, so after every launch the
    /// provider held a perfectly good stored token, asked a question about the
    /// monitor's history, got "stale", and bootstrapped a new family. The store
    /// could never be used. The log shows the result: page after page of
    /// "Token refresh failed; bootstrapping a new local-auth family".
    ///
    /// A token of unknown age is not a token known to be expired. The authority
    /// on whether it still works is the server rejecting it, and the 401 path
    /// already recovers - so an unknown age is used, not discarded. Without a
    /// token in hand the old answer stands: nothing to lose, go and fetch.
    private func shouldRefreshPrecisely(holdingStoredToken: Bool = false) async -> Bool {
        if let info = cachedInfo {
            return Date().addingTimeInterval(Self.expiryRefreshMargin) >= info.expiresAt
        }
        if holdingStoredToken, await monitor.hasNeverFetched {
            return false
        }
        return await monitor.shouldProactivelyRefresh(maxAge: fallbackMaxAge)
    }

    /// Refreshes the access token using the stored refresh token when possible,
    /// otherwise bootstraps a new family from `/auth/local-token`. If refresh
    /// reports the family was revoked (401), this falls back to bootstrap once.
    private func refreshTokensIfNeeded(forceBootstrap: Bool = false) async throws -> String? {
        if let existing = refreshTask {
            return try await existing.value
        }
        let task = Task { () -> String? in
            await monitor.recordRefreshing()
            defer { refreshTask = nil }
            do {
                let (access, refresh, info, wasRefresh) = try await performRefreshOrBootstrap(
                    forceBootstrap: forceBootstrap
                )
                // Cache before persisting. Persistence is a convenience: these
                // tokens are re-issued by the unauthenticated /auth/local-token,
                // so a Keychain write that fails (ACL mismatch after a rebuild)
                // must not throw away a token we just successfully obtained.
                // Doing the write first is what left chat and A2A stuck on
                // HTTP 403 "Local authorization required" with a valid token in
                // hand.
                cachedToken = access
                cachedRefreshToken = refresh
                cachedInfo = info
                do {
                    try await tokenStore.write(access)
                    try await tokenStore.writeRefreshToken(refresh)
                } catch {
                    TriosLogBus.shared.warn(
                        .security,
                        "localauth.persist.failed",
                        "Could not save the local-auth token; continuing in memory",
                        ["error": String(describing: error)]
                    )
                }
                if wasRefresh {
                    await monitor.recordRefreshSuccess(
                        issuedAt: info.issuedAt,
                        expiresAt: info.expiresAt,
                        ttlSeconds: info.ttlSeconds
                    )
                } else {
                    await monitor.recordFetchSuccess(
                        issuedAt: info.issuedAt,
                        expiresAt: info.expiresAt,
                        ttlSeconds: info.ttlSeconds
                    )
                }
                return access
            } catch {
                await monitor.recordFailure(reason: "\(error)")
                throw error
            }
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    /// Performs either a refresh-token rotation or a full bootstrap. Returns
    /// the new access token, refresh token, metadata, and a flag indicating
    /// whether the refresh endpoint was used.
    private func performRefreshOrBootstrap(
        forceBootstrap: Bool
    ) async throws -> (String, String, LocalAuthTokenInfo, Bool) {
        if !forceBootstrap {
            var refreshToken = cachedRefreshToken
            if refreshToken == nil {
                refreshToken = try? await tokenStore.readRefreshToken()
            }
            if let refreshToken {
                do {
                    let result = try await callRefreshEndpoint(refreshToken: refreshToken)
                    return (result.accessToken, result.refreshToken, result.info, true)
                } catch {
                    // Any failed refresh falls through to a full bootstrap.
                    //
                    // Previously only HTTP 401 did, so a server restart that
                    // dropped the token family (or any 4xx/5xx/network blip)
                    // left the client stranded on a stale access token: every
                    // A2A call then answered 403 "Local authorization required"
                    // and registration failed after five attempts, even though
                    // GET /auth/local-token was ready to issue a working token.
                    // Bootstrap is unauthenticated and idempotent, so retrying
                    // it costs one request and recovers the session.
                    if case LocalAuthError.refreshFailed(statusCode: 401) = error {
                        await monitor.recordFamilyRevoked()
                    }
                    TriosLogBus.shared.warn(
                        .security,
                        "localauth.refresh.fallback_bootstrap",
                        "Token refresh failed; bootstrapping a new local-auth family",
                        ["error": String(describing: error)]
                    )
                }
            }
        }
        let result = try await callLocalTokenEndpoint()
        guard let refreshToken = result.refreshToken else {
            // Server did not issue a refresh token; treat as bootstrap without
            // rotation support. This preserves compatibility.
            return (result.token, "", result, false)
        }
        return (result.token, refreshToken, result, false)
    }

    /// POST `/auth/refresh` with the stored refresh token.
    private func callRefreshEndpoint(refreshToken: String) async throws -> LocalAuthRefreshResponse {
        guard let url = URL(string: "\(baseURL.absoluteString)/auth/refresh") else {
            throw LocalAuthError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["refreshToken": refreshToken])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw LocalAuthError.refreshFailed(statusCode: nil)
        }
        guard http.statusCode == 200 else {
            throw LocalAuthError.refreshFailed(statusCode: http.statusCode)
        }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(LocalAuthRefreshResponse.self, from: data)
        } catch {
            throw LocalAuthError.refreshFailed(statusCode: nil)
        }
    }

    /// GET `/auth/local-token` for a full bootstrap.
    private func callLocalTokenEndpoint() async throws -> LocalAuthTokenInfo {
        guard let url = URL(string: "\(baseURL.absoluteString)/auth/local-token") else {
            throw LocalAuthError.invalidURL
        }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw LocalAuthError.fetchFailed(statusCode: nil)
        }
        guard http.statusCode == 200 else {
            throw LocalAuthError.fetchFailed(statusCode: http.statusCode)
        }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(LocalAuthTokenInfo.self, from: data)
        } catch {
            throw LocalAuthError.fetchFailed(statusCode: nil)
        }
    }
}

enum LocalAuthError: Error, Equatable {
    case invalidURL
    case fetchFailed(statusCode: Int?)
    case refreshFailed(statusCode: Int?)
    case keychainWriteFailed
}
