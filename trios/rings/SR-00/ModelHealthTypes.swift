import Foundation

/// Quota/balance signal extracted from provider response headers.
enum ProviderQuotaStatus: Equatable, Sendable {
    /// No quota information was available.
    case unknown
    /// Provider reported healthy quota margins.
    case healthy(remainingRequests: Int?, remainingTokens: Int?)
    /// Provider reported low remaining quota; routing may soon degrade.
    case low(remainingRequests: Int?, remainingTokens: Int?)
    /// Provider explicitly reported insufficient balance or zero quota.
    case depleted(reason: String)

    /// True when the provider should not receive new traffic.
    var isDepleted: Bool {
        if case .depleted = self { return true }
        return false
    }

    /// True when quota is known to be low or depleted.
    var isLowOrDepleted: Bool {
        switch self {
        case .low, .depleted:
            return true
        case .unknown, .healthy:
            return false
        }
    }
}

/// Result of a lightweight model health probe, including measured latency and
/// optional provider quota metadata.
struct ModelHealthResult: Equatable, Sendable {
    let health: ModelHealth
    /// Total probe duration in milliseconds, if measured.
    let latencyMs: Int?
    /// Quota/balance status parsed from response headers, when available.
    let quota: ProviderQuotaStatus
    /// Classified failure kind for breaker and volatility learning.
    let failureKind: ProviderCircuitBreakerFailureKind?
    /// Provider `Retry-After` value in seconds, when given.
    let retryAfter: TimeInterval?

    init(
        health: ModelHealth,
        latencyMs: Int?,
        quota: ProviderQuotaStatus = .unknown,
        failureKind: ProviderCircuitBreakerFailureKind? = nil,
        retryAfter: TimeInterval? = nil
    ) {
        self.health = health
        self.latencyMs = latencyMs
        self.quota = quota
        self.failureKind = failureKind
        self.retryAfter = retryAfter
    }
}

/// Result of a lightweight model health probe.
enum ModelHealth: Equatable, Sendable {
    case healthy
    case unavailable(reason: String)
    case unknown(error: String)
}

/// Result of a provider-specific API-key validation attempt.
///
/// Unlike the generic health probe, this uses cheap or free endpoints (e.g.
/// OpenRouter `/auth/key`, OpenAI `/models`) so it never spends tokens just to
/// check whether a key is accepted. All HTTP details are exposed so the user
/// can diagnose auth, balance, network, or configuration problems.
struct APIKeyValidationResult: Equatable, Sendable {
    let provider: ModelProvider
    let baseURL: String
    let endpointURL: String
    let httpMethod: String
    let isValid: Bool
    let httpStatus: Int?
    let latencyMs: Int
    let message: String
    let responseBody: String
    let responseHeaders: [String: String]
    let quota: ProviderQuotaStatus
    let logs: [String]
    /// Set when the key authenticates but the account cannot actually pay for
    /// requests (e.g. OpenRouter credits exhausted). The UI renders this as an
    /// amber warning instead of a plain green "valid".
    var balanceWarning: String?

    static func invalid(
        provider: ModelProvider,
        baseURL: String,
        endpointURL: String,
        httpMethod: String,
        httpStatus: Int?,
        latencyMs: Int,
        message: String,
        responseBody: String,
        responseHeaders: [String: String],
        quota: ProviderQuotaStatus,
        logs: [String]
    ) -> APIKeyValidationResult {
        APIKeyValidationResult(
            provider: provider,
            baseURL: baseURL,
            endpointURL: endpointURL,
            httpMethod: httpMethod,
            isValid: false,
            httpStatus: httpStatus,
            latencyMs: latencyMs,
            message: message,
            responseBody: responseBody,
            responseHeaders: responseHeaders,
            quota: quota,
            logs: logs
        )
    }
}

/// Abstract health probe that can be injected for testing.
protocol ModelHealthServiceProtocol: Sendable {
    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult

    func validateKey(
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> APIKeyValidationResult

    func invalidate() async
}

extension ModelHealthServiceProtocol {
    /// Default fallback for mocks: performs a tiny paid probe and converts the
    /// outcome into a validation-shaped result. Production code should override
    /// this with provider-specific free endpoints.
    func validateKey(
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> APIKeyValidationResult {
        let start = Date()
        let probe = await probe(
            model: provider.defaultModel,
            provider: provider,
            baseURL: baseURL,
            apiKey: apiKey
        )
        let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
        let logs = ["Falling back to generic paid probe (no free key endpoint)."]
        switch probe.health {
        case .healthy:
            return APIKeyValidationResult(
                provider: provider,
                baseURL: baseURL,
                endpointURL: "",
                httpMethod: "POST",
                isValid: true,
                httpStatus: 200,
                latencyMs: latencyMs,
                message: "Key accepted — \(provider.defaultModel) responded.",
                responseBody: "",
                responseHeaders: [:],
                quota: probe.quota,
                logs: logs
            )
        case .unavailable(let reason):
            return APIKeyValidationResult.invalid(
                provider: provider,
                baseURL: baseURL,
                endpointURL: "",
                httpMethod: "POST",
                httpStatus: nil,
                latencyMs: latencyMs,
                message: reason,
                responseBody: "",
                responseHeaders: [:],
                quota: probe.quota,
                logs: logs
            )
        case .unknown(let error):
            return APIKeyValidationResult.invalid(
                provider: provider,
                baseURL: baseURL,
                endpointURL: "",
                httpMethod: "POST",
                httpStatus: nil,
                latencyMs: latencyMs,
                message: error,
                responseBody: "",
                responseHeaders: [:],
                quota: probe.quota,
                logs: logs
            )
        }
    }
}
