import Foundation

// Types extracted to ModelHealthTypes.swift:
// ProviderQuotaStatus, ModelHealthResult, ModelHealth, APIKeyValidationResult,
// ModelHealthServiceProtocol

/// Lightweight, cached model health probe.
///
/// Uses a tiny paid completion (max_tokens: 1) as the final liveness signal for
/// cloud providers, and Ollama's free `/api/tags` list for local models. Results
/// are cached with a TTL and require two consecutive failures before a model is
/// marked `.unavailable`, reducing false positives from transient blips.
actor ModelHealthService: ModelHealthServiceProtocol {
    struct CacheEntry: Equatable {
        let result: ModelHealthResult
        let timestamp: Date
        let failureStreak: Int

        init(result: ModelHealthResult, timestamp: Date, failureStreak: Int) {
            self.result = result
            self.timestamp = timestamp
            self.failureStreak = failureStreak
        }
    }

    private var cache: [String: CacheEntry] = [:]
    private let ttl: TimeInterval
    private let failureThreshold: Int
    private let session: URLSession
    private let statusService: (any ProviderStatusServiceProtocol)?

    init(
        ttl: TimeInterval = 60,
        failureThreshold: Int = 2,
        session: URLSession = URLSession.shared,
        statusService: (any ProviderStatusServiceProtocol)? = nil
    ) {
        self.ttl = ttl
        self.failureThreshold = max(1, failureThreshold)
        self.session = session
        self.statusService = statusService
    }

    /// Probes the given model and returns its health plus probe latency. Cached
    /// results are returned when the entry is younger than `ttl`.
    func probe(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult {
        let key = cacheKey(model: model, provider: provider, baseURL: baseURL)
        if let entry = cache[key], Date().timeIntervalSince(entry.timestamp) < ttl {
            return entry.result
        }

        // Fast, free provider-native catalog check first. For Ollama the health
        // probe already performs the equivalent /api/tags lookup, so we skip the
        // status pre-check there to avoid duplicate work.
        if let statusService, provider != .ollama {
            let status = await statusService.status(
                for: model,
                provider: provider,
                baseURL: baseURL,
                apiKey: apiKey
            )
            switch status {
            case .disabled:
                let result = ModelHealthResult(
                    health: .unavailable(reason: "Model disabled by provider catalog"),
                    latencyMs: nil
                )
                cache[key] = CacheEntry(result: result, timestamp: Date(), failureStreak: 0)
                return result
            case .missing:
                let result = ModelHealthResult(
                    health: .unavailable(reason: "Model not in provider catalog"),
                    latencyMs: nil
                )
                cache[key] = CacheEntry(result: result, timestamp: Date(), failureStreak: 0)
                return result
            case .unknown:
                // Catalog fetch failed (auth, network). Fall through to live probe
                // but do not cache a definitive result from the catalog signal.
                break
            case .present:
                break
            }
        }

        let start = Date()
        let probeResult: ModelHealthResult
        switch provider {
        case .ollama:
            let health = await probeOllama(model: model, baseURL: baseURL)
            probeResult = ModelHealthResult(health: health, latencyMs: nil)
        default:
            probeResult = await probeCloud(
                model: model,
                provider: provider,
                baseURL: baseURL,
                apiKey: apiKey
            )
        }
        let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))

        let previousStreak = cache[key]?.failureStreak ?? 0
        let newStreak: Int
        switch probeResult.health {
        case .healthy:
            newStreak = 0
        case .unavailable, .unknown:
            newStreak = previousStreak + 1
        }

        let storedHealth: ModelHealth
        if case .unavailable = probeResult.health, newStreak < failureThreshold {
            // Degrade to unknown until the failure threshold is crossed.
            storedHealth = .unknown(error: "Transient failure (\(newStreak)/\(failureThreshold))")
        } else {
            storedHealth = probeResult.health
        }

        let result = ModelHealthResult(
            health: storedHealth,
            latencyMs: latencyMs,
            quota: probeResult.quota
        )
        cache[key] = CacheEntry(result: result, timestamp: Date(), failureStreak: newStreak)
        return result
    }

    /// Clears all cached health entries. Useful when the user changes the endpoint
    /// or API key.
    func invalidate() async {
        cache.removeAll()
    }

    /// Validates an API key using a cheap or free provider-specific endpoint.
    /// Never spends tokens: OpenRouter uses `/auth/key`, OpenAI/Anthropic/ZAI
    /// use the model list endpoint, and Ollama simply lists local tags.
    func validateKey(
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> APIKeyValidationResult {
        let start = Date()
        let trimmedBase = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if provider == .ollama {
            return await validateOllamaKey(baseURL: trimmedBase, start: start)
        }

        guard !trimmedKey.isEmpty else {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            return APIKeyValidationResult.invalid(
                provider: provider,
                baseURL: trimmedBase,
                endpointURL: trimmedBase,
                httpMethod: "GET",
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "No API key to test.",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: ["Provider \(provider.displayName) requires an API key, but none was supplied."]
            )
        }

        guard let endpoint = validationEndpoint(for: provider) else {
            return await fallbackValidation(
                provider: provider,
                baseURL: trimmedBase,
                apiKey: trimmedKey,
                start: start
            )
        }

        let url: URL
        do {
            url = try makeURL(baseURL: trimmedBase, path: endpoint.path)
        } catch {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            return APIKeyValidationResult.invalid(
                provider: provider,
                baseURL: trimmedBase,
                endpointURL: trimmedBase + endpoint.path,
                httpMethod: endpoint.method,
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "Invalid base URL: \(error.localizedDescription)",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: ["Invalid base URL: \(trimmedBase)"]
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        var requestHeaders: [String: String] = [:]
        if provider == .anthropic {
            request.setValue(trimmedKey, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            requestHeaders["x-api-key"] = maskedKey(trimmedKey)
            requestHeaders["anthropic-version"] = "2023-06-01"
        } else {
            request.setValue("Bearer \(trimmedKey)", forHTTPHeaderField: "Authorization")
            requestHeaders["Authorization"] = "Bearer \(maskedKey(trimmedKey))"
        }
        for (header, value) in endpoint.extraHeaders {
            request.setValue(value, forHTTPHeaderField: header)
            requestHeaders[header] = value
        }

        let keyHint = maskedKey(trimmedKey)
        var logs: [String] = [
            "Testing \(provider.displayName) key \(keyHint) against \(endpoint.method) \(url.absoluteString)",
            "Request headers: \(requestHeaders)"
        ]

        do {
            let (data, response) = try await session.data(for: request)
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            guard let http = response as? HTTPURLResponse else {
                logs.append("Response: non-HTTP URL response")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: nil,
                    latencyMs: latencyMs,
                    message: "Non-HTTP response from provider.",
                    responseBody: "",
                    responseHeaders: [:],
                    quota: .unknown,
                    logs: logs
                )
            }

            let status = http.statusCode
            let bodyString = String(data: data, encoding: .utf8) ?? "<non-UTF8 body>"
            let preview = String(bodyString.prefix(2048))
            let responseHeaders = stringHeaders(from: http)
            logs.append("Response HTTP \(status) in \(latencyMs) ms")
            logs.append("Response headers: \(responseHeaders)")
            logs.append("Response body: \(preview)")

            let quota = quotaStatus(from: http)

            switch status {
            case 200...299:
                var message = validationSuccessMessage(provider: provider, bodyString: bodyString)
                var effectiveQuota = quota
                var balanceWarning: String?
                if provider == .openrouter, let credits = OpenRouterCreditsParser.parse(bodyString) {
                    message = credits.message
                    balanceWarning = credits.warning
                    if credits.isDepleted {
                        effectiveQuota = .depleted(reason: "No OpenRouter credits remaining")
                        logs.append(
                            "Key authenticates, but the OpenRouter credit balance is exhausted."
                        )
                    }
                }
                if provider == .zai {
                    // /models answers 200 for any key that authenticates, spent
                    // balance included. Only a real completion reveals code 1113,
                    // so spend one minimal token rather than report a false green.
                    let probe = await zaiBalanceProbe(baseURL: trimmedBase, apiKey: apiKey)
                    logs.append(contentsOf: probe.logs)
                    if let zaiError = probe.error, zaiError.isBalanceExhausted {
                        message = ZAIErrorParser.summary(for: zaiError)
                        balanceWarning = ZAIErrorParser.depletedWarning
                        effectiveQuota = .depleted(reason: zaiError.message)
                        TriosLogBus.shared.warn(
                            .health,
                            "health.key.balance_exhausted",
                            "Key authenticates but the account balance is spent",
                            ["provider": provider.rawValue, "code": zaiError.code]
                        )
                    }
                }
                return APIKeyValidationResult(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    isValid: true,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: message,
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: effectiveQuota,
                    logs: logs,
                    balanceWarning: balanceWarning
                )
            case 401, 403:
                logs.append("Key rejected (auth error).")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Invalid API key or insufficient permissions (HTTP \(status))",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: quota,
                    logs: logs
                )
            case 402:
                logs.append("Provider reported insufficient balance.")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Insufficient balance (HTTP 402). Add credits to this provider account.",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: .depleted(reason: "Insufficient balance"),
                    logs: logs
                )
            case 404:
                logs.append("Validation endpoint not found — check the base URL.")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Validation endpoint not found (HTTP 404). Check the base URL.",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: quota,
                    logs: logs
                )
            case 429:
                logs.append("Rate limited.")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Rate limited (HTTP 429). Retry after the provider's cooldown.",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: quota,
                    logs: logs
                )
            case 502, 503, 504:
                logs.append("Provider gateway error.")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Provider gateway error (HTTP \(status)). Try again shortly.",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: quota,
                    logs: logs
                )
            default:
                logs.append("Provider returned HTTP \(status).")
                return APIKeyValidationResult.invalid(
                    provider: provider,
                    baseURL: trimmedBase,
                    endpointURL: url.absoluteString,
                    httpMethod: endpoint.method,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Provider error (HTTP \(status)).",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: quota,
                    logs: logs
                )
            }
        } catch let urlError as URLError {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            logs.append("Network error: \(urlError.localizedDescription)")
            return APIKeyValidationResult.invalid(
                provider: provider,
                baseURL: trimmedBase,
                endpointURL: url.absoluteString,
                httpMethod: endpoint.method,
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "Network error: \(urlError.localizedDescription)",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: logs
            )
        } catch {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            logs.append("Validation failed: \(error.localizedDescription)")
            return APIKeyValidationResult.invalid(
                provider: provider,
                baseURL: trimmedBase,
                endpointURL: url.absoluteString,
                httpMethod: endpoint.method,
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "Validation failed: \(error.localizedDescription)",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: logs
            )
        }
    }

    /// Fallback for providers without a known free key endpoint: performs the
    /// original tiny paid completion probe and converts the outcome into a
    /// validation result. Avoids calling back through the protocol requirement.
    private func fallbackValidation(
        provider: ModelProvider,
        baseURL: String,
        apiKey: String,
        start: Date
    ) async -> APIKeyValidationResult {
        let probe = await probe(
            model: provider.defaultModel,
            provider: provider,
            baseURL: baseURL,
            apiKey: apiKey
        )
        let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
        var logs = ["No free key endpoint known for \(provider.displayName); using tiny paid probe."]
        switch probe.health {
        case .healthy:
            logs.append("Probe succeeded.")
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
            logs.append("Probe unavailable: \(reason)")
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
            logs.append("Probe failed: \(error)")
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

    private func validationEndpoint(for provider: ModelProvider) -> (method: String, path: String, extraHeaders: [String: String])? {
        switch provider {
        case .openrouter:
            return (method: "GET", path: "/auth/key", extraHeaders: [:])
        case .openai, .zai:
            return (method: "GET", path: "/models", extraHeaders: [:])
        case .anthropic:
            return (method: "GET", path: "/models", extraHeaders: [:])
        case .ollama:
            return nil
        }
    }

    private func validateOllamaKey(baseURL: String, start: Date) async -> APIKeyValidationResult {
        let url: URL
        do {
            url = try makeURL(baseURL: baseURL, path: "/api/tags")
        } catch {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            return APIKeyValidationResult.invalid(
                provider: .ollama,
                baseURL: baseURL,
                endpointURL: baseURL + "/api/tags",
                httpMethod: "GET",
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "Invalid Ollama base URL: \(error.localizedDescription)",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: ["Invalid Ollama base URL: \(baseURL)"]
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        var logs: [String] = [
            "Testing Ollama reachability via GET \(url.absoluteString)"
        ]

        do {
            let (data, response) = try await session.data(for: request)
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            guard let http = response as? HTTPURLResponse else {
                logs.append("Response: non-HTTP URL response")
                return APIKeyValidationResult.invalid(
                    provider: .ollama,
                    baseURL: baseURL,
                    endpointURL: url.absoluteString,
                    httpMethod: "GET",
                    httpStatus: nil,
                    latencyMs: latencyMs,
                    message: "Non-HTTP response from Ollama.",
                    responseBody: "",
                    responseHeaders: [:],
                    quota: .unknown,
                    logs: logs
                )
            }

            let status = http.statusCode
            let bodyString = String(data: data, encoding: .utf8) ?? "<non-UTF8 body>"
            let preview = String(bodyString.prefix(2048))
            let responseHeaders = stringHeaders(from: http)
            logs.append("Response HTTP \(status) in \(latencyMs) ms")
            logs.append("Response headers: \(responseHeaders)")
            logs.append("Response body: \(preview)")

            guard (200...299).contains(status) else {
                return APIKeyValidationResult.invalid(
                    provider: .ollama,
                    baseURL: baseURL,
                    endpointURL: url.absoluteString,
                    httpMethod: "GET",
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Ollama unreachable (HTTP \(status)).",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: .unknown,
                    logs: logs
                )
            }

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = json["models"] as? [[String: Any]] else {
                return APIKeyValidationResult(
                    provider: .ollama,
                    baseURL: baseURL,
                    endpointURL: url.absoluteString,
                    httpMethod: "GET",
                    isValid: true,
                    httpStatus: status,
                    latencyMs: latencyMs,
                    message: "Ollama responded, but the tag list was unexpected.",
                    responseBody: preview,
                    responseHeaders: responseHeaders,
                    quota: .unknown,
                    logs: logs
                )
            }

            let names = models.compactMap { $0["name"] as? String }
            return APIKeyValidationResult(
                provider: .ollama,
                baseURL: baseURL,
                endpointURL: url.absoluteString,
                httpMethod: "GET",
                isValid: true,
                httpStatus: status,
                latencyMs: latencyMs,
                message: "Ollama reachable — \(names.count) model(s) listed.",
                responseBody: preview,
                responseHeaders: responseHeaders,
                quota: .unknown,
                logs: logs
            )
        } catch let urlError as URLError {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            logs.append("Ollama connection failed: \(urlError.localizedDescription)")
            return APIKeyValidationResult.invalid(
                provider: .ollama,
                baseURL: baseURL,
                endpointURL: url.absoluteString,
                httpMethod: "GET",
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "Ollama connection failed: \(urlError.localizedDescription)",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: logs
            )
        } catch {
            let latencyMs = Int(max(0, Date().timeIntervalSince(start) * 1000))
            logs.append("Ollama probe failed: \(error.localizedDescription)")
            return APIKeyValidationResult.invalid(
                provider: .ollama,
                baseURL: baseURL,
                endpointURL: url.absoluteString,
                httpMethod: "GET",
                httpStatus: nil,
                latencyMs: latencyMs,
                message: "Ollama probe failed: \(error.localizedDescription)",
                responseBody: "",
                responseHeaders: [:],
                quota: .unknown,
                logs: logs
            )
        }
    }

    /// Sends the cheapest possible Z.AI completion to learn whether the account
    /// can actually pay. Any transport failure is reported as "unknown" rather
    /// than as an exhausted balance, so a flaky network never mislabels a key.
    private func zaiBalanceProbe(
        baseURL: String,
        apiKey: String?
    ) async -> (error: ZAIError?, logs: [String]) {
        let url: URL
        do {
            url = try makeChatURL(baseURL: baseURL, provider: .zai)
        } catch {
            return (nil, ["Balance probe skipped: invalid base URL."])
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        if let apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = [
            "model": ModelProvider.zai.defaultModel,
            "messages": [["role": "user", "content": "ping"]],
            "max_tokens": 1
        ]
        guard let encoded = try? JSONSerialization.data(withJSONObject: body) else {
            return (nil, ["Balance probe skipped: failed to encode body."])
        }
        request.httpBody = encoded

        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let bodyString = String(data: data, encoding: .utf8) ?? ""
            var logs = ["Balance probe POST \(url.absoluteString) -> HTTP \(status)"]
            if let zaiError = ZAIErrorParser.parse(bodyString) {
                logs.append("Balance probe error code \(zaiError.code): \(zaiError.message)")
                return (zaiError, logs)
            }
            logs.append("Balance probe succeeded; the account can pay for requests.")
            return (nil, logs)
        } catch {
            return (nil, ["Balance probe inconclusive: \(error.localizedDescription)"])
        }
    }

    private func validationSuccessMessage(provider: ModelProvider, bodyString: String) -> String {
        if provider == .openrouter {
            return OpenRouterCreditsParser.parse(bodyString)?.message
                ?? "Key valid — OpenRouter accepted the auth check."
        }
        return "Key valid — endpoint accepted the request (HTTP 200)."
    }


    private func maskedKey(_ key: String) -> String {
        guard key.count > 8 else { return "<short key>" }
        let prefix = String(key.prefix(4))
        let suffix = String(key.suffix(4))
        return "\(prefix)...\(suffix)"
    }

    private func stringHeaders(from http: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            headers["\(key)"] = "\(value)"
        }
        return headers
    }

    /// Probes a cloud provider by sending a tiny chat completion request.
    private func probeCloud(
        model: String,
        provider: ModelProvider,
        baseURL: String,
        apiKey: String?
    ) async -> ModelHealthResult {
        let url: URL
        do {
            url = try makeChatURL(baseURL: baseURL, provider: provider)
        } catch {
            return ModelHealthResult(
                health: .unknown(error: "Invalid base URL: \(error.localizedDescription)"),
                latencyMs: nil
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        if let apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        let body: [String: Any] = [
            "model": model,
            "messages": [["role": "user", "content": "ping"]],
            "max_tokens": 1
        ]
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            return ModelHealthResult(health: .unknown(error: "Failed to encode probe body"), latencyMs: nil)
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return ModelHealthResult(health: .unknown(error: "Non-HTTP response"), latencyMs: nil)
            }
            let bodyString = String(data: data, encoding: .utf8) ?? ""
            let retryAfter = http.value(forHTTPHeaderField: "Retry-After")
                .flatMap { SSETransport.parseRetryAfter($0) }
            switch http.statusCode {
            case 200...299:
                let quota = quotaStatus(from: http)
                return ModelHealthResult(health: .healthy, latencyMs: nil, quota: quota)
            case 401, 403:
                return ModelHealthResult(
                    health: .unavailable(reason: "Auth error \(http.statusCode)"),
                    latencyMs: nil,
                    failureKind: .auth,
                    retryAfter: retryAfter
                )
            case 402:
                return ModelHealthResult(
                    health: .unavailable(reason: "Insufficient balance (\(http.statusCode))"),
                    latencyMs: nil,
                    quota: .depleted(reason: "Insufficient balance"),
                    failureKind: .balance,
                    retryAfter: retryAfter
                )
            case 404, 422:
                return ModelHealthResult(
                    health: .unavailable(reason: "Model not found or invalid (\(http.statusCode))"),
                    latencyMs: nil,
                    failureKind: .modelUnavailable,
                    retryAfter: retryAfter
                )
            case 413:
                return ModelHealthResult(
                    health: .unavailable(reason: "Context length exceeded (\(http.statusCode))"),
                    latencyMs: nil,
                    failureKind: .contextLength,
                    retryAfter: retryAfter
                )
            case 429:
                // Z.AI reports an exhausted balance as HTTP 429 with business
                // code 1113. Treating that as a rate limit made the client retry
                // a request that can never succeed, tripling the failure noise.
                if let zaiError = ZAIErrorParser.parse(bodyString), zaiError.isBalanceExhausted {
                    return ModelHealthResult(
                        health: .unavailable(reason: ZAIErrorParser.summary(for: zaiError)),
                        latencyMs: nil,
                        quota: .depleted(reason: zaiError.message),
                        failureKind: .balance,
                        retryAfter: nil
                    )
                }
                return ModelHealthResult(
                    health: .unavailable(reason: "Rate limited (\(http.statusCode))"),
                    latencyMs: nil,
                    quota: quotaStatus(from: http),
                    failureKind: .rateLimit,
                    retryAfter: retryAfter
                )
            case 502, 503, 504:
                return ModelHealthResult(
                    health: .unavailable(reason: "Provider gateway error (\(http.statusCode))"),
                    latencyMs: nil,
                    failureKind: .gateway,
                    retryAfter: retryAfter
                )
            default:
                return ModelHealthResult(
                    health: .unavailable(reason: "Provider error \(http.statusCode)"),
                    latencyMs: nil,
                    retryAfter: retryAfter
                )
            }
        } catch let urlError as URLError {
            return ModelHealthResult(
                health: .unavailable(reason: "Network error: \(urlError.localizedDescription)"),
                latencyMs: nil,
                failureKind: urlError.code == .timedOut ? .timeout : .connection
            )
        } catch {
            return ModelHealthResult(
                health: .unknown(error: "Probe failed: \(error.localizedDescription)"),
                latencyMs: nil
            )
        }
    }

    /// Parses common rate-limit and quota headers into a quota status.
    private func quotaStatus(from http: HTTPURLResponse) -> ProviderQuotaStatus {
        let headers = http.allHeaderFields
        let remainingRequests = intHeader(
            keys: [
                "x-ratelimit-remaining-requests",
                "x-ratelimit-remaining",
                "x-request-limit-remaining"
            ],
            in: headers
        )
        let limitRequests = intHeader(
            keys: [
                "x-ratelimit-limit-requests",
                "x-ratelimit-limit",
                "x-request-limit"
            ],
            in: headers
        )
        let remainingTokens = intHeader(
            keys: [
                "x-ratelimit-remaining-tokens",
                "x-token-limit-remaining"
            ],
            in: headers
        )

        guard remainingRequests != nil || remainingTokens != nil || limitRequests != nil else {
            return .unknown
        }

        let requestsLow = isLow(remaining: remainingRequests, limit: limitRequests)
        if remainingRequests == 0 || remainingTokens == 0 {
            return .depleted(reason: "Quota exhausted")
        }
        if requestsLow {
            return .low(remainingRequests: remainingRequests, remainingTokens: remainingTokens)
        }
        return .healthy(remainingRequests: remainingRequests, remainingTokens: remainingTokens)
    }

    private func intHeader(keys: [String], in headers: [AnyHashable: Any]) -> Int? {
        for key in keys {
            if let value = headers[key] as? String, let int = Int(value) {
                return int
            }
            if let value = headers[key] as? Int {
                return value
            }
        }
        return nil
    }

    private func isLow(remaining: Int?, limit: Int?) -> Bool {
        guard let remaining else { return false }
        if remaining <= 5 { return true }
        if let limit, limit > 0, Double(remaining) / Double(limit) <= 0.10 { return true }
        return false
    }

    /// Probes Ollama by listing local models via `/api/tags`.
    private func probeOllama(model: String, baseURL: String) async -> ModelHealth {
        let tagsURL: URL
        do {
            tagsURL = try makeURL(baseURL: baseURL, path: "/api/tags")
        } catch {
            return .unknown(error: "Invalid Ollama base URL: \(error.localizedDescription)")
        }

        var request = URLRequest(url: tagsURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return .unavailable(reason: "Ollama unreachable")
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = json["models"] as? [[String: Any]] else {
                return .unknown(error: "Unexpected Ollama tags response")
            }
            let names = models.compactMap { $0["name"] as? String }
            if names.contains(model) || names.contains("\(model):latest") {
                return .healthy
            }
            return .unavailable(reason: "Model not loaded in Ollama")
        } catch let urlError as URLError {
            return .unavailable(reason: "Ollama connection failed: \(urlError.localizedDescription)")
        } catch {
            return .unknown(error: "Ollama probe failed: \(error.localizedDescription)")
        }
    }

    private func makeChatURL(baseURL: String, provider: ModelProvider) throws -> URL {
        switch provider {
        case .openai, .zai:
            // Z.AI's base URL already carries the API version (.../api/paas/v4),
            // so appending /v1 produced /v4/v1/chat/completions -> HTTP 404 and
            // every Z.AI health probe failed regardless of key or balance.
            return try makeURL(baseURL: baseURL, path: "/chat/completions")
        case .anthropic:
            return try makeURL(baseURL: baseURL, path: "/v1/messages")
        case .openrouter:
            return try makeURL(baseURL: baseURL, path: "/v1/chat/completions")
        case .ollama:
            return try makeURL(baseURL: baseURL, path: "/v1/chat/completions")
        }
    }

    private func makeURL(baseURL: String, path: String) throws -> URL {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else {
            throw URLError(.badURL)
        }
        return url.appendingPathComponent(path)
    }

    private func cacheKey(model: String, provider: ModelProvider, baseURL: String) -> String {
        "\(provider.rawValue)|\(baseURL)|\(model)"
    }
}
