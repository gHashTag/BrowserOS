// AGENT-V-WAIVER: Emergency retry + detailed error surfacing for chat SSE.
import Foundation

actor SSETransport: ChatTransportProtocol {
    private let serverURL: URL
    private(set) var session: URLSession
    private let retrier: NetworkRetrier
    private let localAuthProvider: LocalAuthProviding?
    /// Writes a cassette while a real stream runs, so any surprising run can
    /// become a permanent regression test. Opt-in: a transport that always
    /// writes to disk is a transport that fills it.
    private let recorder: CassetteRecorder?

    /// `resourceTimeout` caps the whole stream, not the gap between events.
    /// Ten minutes suits an interactive turn a person is watching; a delegated
    /// worker grinding through a repository routinely runs longer, and the
    /// default silently killed one after seventeen successful tool calls. Such
    /// callers pass their own ceiling rather than inheriting a chat's patience.
    init(
        serverURL: URL = URL(string: "\(ProjectPaths.mcpBaseURL)/chat") ?? URL(fileURLWithPath: "/dev/null"),
        localAuthProvider: LocalAuthProviding? = nil,
        resourceTimeout: TimeInterval = 600
    ) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = resourceTimeout
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config)
        let retrier: NetworkRetrier = NetworkRetrier(policy: NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 1,
            maxDelay: 30,
            exponentialBackoff: true,
            retryableURLErrorCodes: NetworkRetryPolicy.default.retryableURLErrorCodes,
            extraShouldRetry: { error in
                if case let TransportError.serverError(statusCode, _, _, _) = error {
                    // Do not burn retries on fatal provider/account errors.
                    return (502...504).contains(statusCode) || statusCode == 429
                }
                return false
            }
        ))
        self.init(serverURL: serverURL, session: session, retrier: retrier, localAuthProvider: localAuthProvider)
    }

    /// Test-only initializer allowing an injected URLSession and retrier.
    init(serverURL: URL, session: URLSession, retrier: NetworkRetrier, localAuthProvider: LocalAuthProviding? = nil) {
        self.serverURL = serverURL
        self.session = session
        self.retrier = retrier
        self.localAuthProvider = localAuthProvider
        let path = ProcessInfo.processInfo.environment["TRIOS_RECORD_CASSETTE"] ?? ""
        recorder = path.isEmpty ? nil : CassetteRecorder(path: path)
    }

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        let request = await buildRequest(body: body, forceRefresh: false)
        do {
            return try await performMessageStream(request: request, body: body)
        } catch TransportError.serverError(403, _, _, _) {
            // The local-auth token may be stale (e.g. BrowserOS restarted).
            // Refresh once and retry the same request.
            await LocalAuthMonitor.shared.record403Retry()
            guard localAuthProvider != nil else { throw TransportError.connectionFailed }
            let refreshedRequest = await buildRequest(body: body, forceRefresh: true)
            return try await performMessageStream(request: refreshedRequest, body: body)
        }
    }

    private func buildRequest(body: Data, forceRefresh: Bool) async -> URLRequest {
        var request = URLRequest(url: serverURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = body
        request.timeoutInterval = 120

        if let token = try? await localAuthProvider?.validToken(forcingRefresh: forceRefresh) {
            request.setValue(token, forHTTPHeaderField: LocalAuthProvider.headerName)
        }
        return request
    }

    private func performMessageStream(request: URLRequest, body: Data) async throws -> AsyncStream<SSEEvent> {
        NSLog("[SSETransport] POST \(serverURL.absoluteString), body size: \(body.count)")
        let session = self.session
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await retrier.execute(
                url: serverURL,
                description: "SSE POST \(serverURL.absoluteString)"
            ) {
                try await session.bytes(for: request)
            }
        } catch is URLError {
            throw TransportError.connectionFailed
        } catch let retryError as RetryError {
            if case .attemptsExhausted(_, _, let lastError) = retryError,
               lastError is URLError {
                throw TransportError.connectionFailed
            }
            throw retryError
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            NSLog("[SSETransport] non-HTTP response")
            throw TransportError.invalidResponse(url: serverURL)
        }
        NSLog("[SSETransport] HTTP status: \(httpResponse.statusCode)")
        guard (200...299).contains(httpResponse.statusCode) else {
            // Capture a sample of the response body to diagnose non-2xx failures.
            var sampleData = Data()
            for try await byte in bytes {
                sampleData.append(byte)
                if sampleData.count > 500 { break }
            }
            let bodySample = String(data: sampleData, encoding: .utf8) ?? String(describing: sampleData)
            NSLog("[SSETransport] non-2xx response: \(httpResponse.statusCode), body: \(bodySample)")
            let retryAfter = httpResponse.value(forHTTPHeaderField: "Retry-After")
                .flatMap { Self.parseRetryAfter($0) }
            throw TransportError.serverError(
                statusCode: httpResponse.statusCode,
                bodySample: bodySample,
                url: serverURL,
                retryAfter: retryAfter
            )
        }

        return AsyncStream { continuation in
            let readTask = Task {
                do {
                    var buffer = Data()
                    for try await chunk in bytes {
                        buffer.append(chunk)

                        // Parse complete lines from buffer
                        while let newlineIndex = buffer.firstIndex(of: UInt8(10)) {
                            let lineData = buffer.prefix(upTo: newlineIndex)
                            buffer = Data(buffer.suffix(from: newlineIndex + 1))

                            guard let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                                  !line.isEmpty else {
                                // Empty line = SSE event boundary; try to flush any pending event
                                continue
                            }

                            if line.hasPrefix("data: ") {
                                let json = String(line.dropFirst(6))
                                NSLog("[SSETransport] raw SSE line: \(json.prefix(100))")
                                // Capture the wire bytes, not the decoded event:
                                // a cassette of decoded events would replay
                                // around the parser instead of through it.
                                await recorder?.record(json)
                                if let event = SSEEventParser.parse(line: line) {
                                    continuation.yield(event)
                                    if shouldFinish(event) {
                                        await recorder?.flush()
                                        continuation.finish()
                                        return
                                    }
                                }
                            } else if line.hasPrefix(":") {
                                // SSE comment — ignore
                                continue
                            }
                        }
                    }

                    // Flush remaining buffer after stream ends. Use lossy UTF-8
                    // decoding so a trailing incomplete multi-byte sequence does not
                    // silently drop the final event.
                    let remaining = String(decoding: buffer, as: UTF8.self)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if remaining.hasPrefix("data: "),
                       let event = SSEEventParser.parse(line: remaining) {
                        continuation.yield(event)
                    }

                    await recorder?.flush()
                    continuation.finish()
                } catch {
                    NSLog("[SSETransport] stream error: \(error.localizedDescription)")
                    continuation.yield(.error(id: "", message: error.localizedDescription))
                    continuation.finish()
                }
            }

            continuation.onTermination = { _ in
                readTask.cancel()
            }
        }
    }

    func cancel() async {
        session.invalidateAndCancel()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.httpShouldSetCookies = false
        session = URLSession(configuration: config)
    }

    private func shouldFinish(_ event: SSEEvent) -> Bool {
        switch event {
        case .finish, .abort, .error:
            return true
        default:
            return false
        }
    }

    /// Parses a `Retry-After` header value as either a numeric seconds value
    /// or an HTTP-date (RFC 7231 §7.1.1.2). Returns the positive interval, if
    /// any, relative to the current time.
    static func parseRetryAfter(_ value: String) -> TimeInterval? {
        if let seconds = TimeInterval(value), seconds > 0 {
            return seconds
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        guard let date = formatter.date(from: value) else { return nil }
        let interval = date.timeIntervalSince(Date())
        return interval > 0 ? interval : nil
    }
}

enum TransportError: Error, CustomStringConvertible {
    case invalidResponse(url: URL?)
    case connectionFailed
    case serverError(statusCode: Int, bodySample: String, url: URL?, retryAfter: TimeInterval? = nil)
    case requestTimedOut(URL, TimeInterval)

    var description: String {
        switch self {
        case .invalidResponse(let url):
            let urlString = url?.absoluteString ?? "unknown"
            return "Invalid server response from \(urlString)"
        case .connectionFailed:
            return "Connection failed"
        case .serverError(let statusCode, let bodySample, let url, let retryAfter):
            let urlString = url?.absoluteString ?? "unknown"
            let retryInfo = retryAfter.map { " (Retry-After: \($0)s)" } ?? ""
            return "Server error \(statusCode) at \(urlString). Response: \(bodySample)\(retryInfo)"
        case .requestTimedOut(let url, let interval):
            return "Request to \(url.absoluteString) timed out after \(interval.rounded(toPlaces: 1))s"
        }
    }

    var localizedDescription: String { description }
}

extension TransportError {
    /// Extracts a human-readable provider message from the response body sample.
    /// Supports OpenRouter-style `{ error: { message: ... } }` and plain `message` fields.
    var providerErrorMessage: String? {
        switch self {
        case .serverError(_, let bodySample, _, _):
            guard !bodySample.isEmpty else { return nil }
            if let data = bodySample.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let errorDict = json["error"] as? [String: Any],
                   let message = errorDict["message"] as? String, !message.isEmpty {
                    return message
                }
                if let message = json["message"] as? String, !message.isEmpty {
                    return message
                }
            }
            return bodySample
        default:
            return nil
        }
    }

    var isBalanceError: Bool {
        switch self {
        case .serverError(402, _, _, _): return true
        case .serverError(let status, let body, _, _):
            guard status == 400 || status == 403 else { return false }
            let lower = body.lowercased()
            return lower.contains("insufficient balance")
                || lower.contains("balance")
                || lower.contains("out of funds")
        default: return false
        }
    }

    var isAuthError: Bool {
        switch self {
        case .serverError(401, _, _, _): return true
        case .serverError(403, let body, _, _):
            guard !isBalanceError else { return false }
            let lower = body.lowercased()
            return lower.contains("auth")
                || lower.contains("unauthorized")
                || lower.contains("api key")
                || lower.contains("incorrect key")
                || lower.contains("invalid key")
        default: return false
        }
    }

    var isRateLimitError: Bool { statusCode == 429 }

    var isContextLengthError: Bool {
        switch self {
        case .serverError(413, _, _, _): return true
        case .serverError(let status, let body, _, _):
            guard status == 400 || status == 429 || status == 413 else { return false }
            let lower = body.lowercased()
            return lower.contains("context_length_exceeded")
                || lower.contains("maximum context length")
                || lower.contains("context length")
                || lower.contains("context_length")
                || lower.contains("too many tokens")
                || lower.contains("token limit")
        default: return false
        }
    }

    var isInvalidModelError: Bool {
        switch self {
        case .serverError(let status, let body, _, _):
            guard status == 400 || status == 404 || status == 422 else { return false }
            guard !isContextLengthError else { return false }
            let lower = body.lowercased()
            return lower.contains("model") || lower.contains("not available")
        default: return false
        }
    }

    var isModelUnavailableError: Bool {
        switch self {
        case .serverError(502, _, _, _), .serverError(503, _, _, _), .serverError(504, _, _, _):
            return true
        case .serverError(let status, let body, _, _):
            return status >= 500
                && body.localizedCaseInsensitiveContains("no available model provider")
        default: return false
        }
    }

    var isRetryableServerError: Bool {
        switch self {
        case .serverError(429, _, _, _), .serverError(502, _, _, _), .serverError(503, _, _, _), .serverError(504, _, _, _):
            return true
        default: return false
        }
    }

    /// Errors where trying another provider is likely to help: model-level issues,
    /// provider gateway errors, rate limits, auth/balance failures, timeouts, and
    /// connection failures. Context-length failures are excluded because another
    /// provider will usually reject the same long prompt.
    var isEligibleForCrossProviderFailover: Bool {
        guard !isContextLengthError else { return false }
        switch self {
        case .connectionFailed, .requestTimedOut:
            return true
        case .serverError:
            return isModelUnavailableError
                || isInvalidModelError
                || isRateLimitError
                || isAuthError
                || isBalanceError
                || isRetryableServerError
        default:
            return false
        }
    }

    var retryAfter: TimeInterval? {
        switch self {
        case .serverError(_, _, _, let retryAfter): return retryAfter
        default: return nil
        }
    }

    private var statusCode: Int? {
        switch self {
        case .serverError(let status, _, _, _): return status
        default: return nil
        }
    }
}
