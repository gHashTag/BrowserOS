// AGENT-V-WAIVER: Emergency network resilience patch for request timeout and
// detailed error surfacing. Adds a generic retry wrapper used by SSETransport,
// A2ARegistryClient and TriosMCPClient.
import Foundation

/// Decides whether a network failure should be retried.
struct NetworkRetryPolicy: Sendable {
    let maxAttempts: Int
    let baseDelay: TimeInterval
    let maxDelay: TimeInterval
    let exponentialBackoff: Bool
    let retryableURLErrorCodes: Set<URLError.Code>
    let extraShouldRetry: (@Sendable (Error) -> Bool)?

    static let `default` = NetworkRetryPolicy(
        maxAttempts: 3,
        baseDelay: 1,
        maxDelay: 30,
        exponentialBackoff: true,
        retryableURLErrorCodes: [
            .timedOut,
            .cannotFindHost,
            .cannotConnectToHost,
            .networkConnectionLost,
            .notConnectedToInternet,
            .dnsLookupFailed,
            .resourceUnavailable,
            .badServerResponse,
            .httpTooManyRedirects,
        ],
        extraShouldRetry: nil
    )

    static let none = NetworkRetryPolicy(
        maxAttempts: 1,
        baseDelay: 0,
        maxDelay: 0,
        exponentialBackoff: false,
        retryableURLErrorCodes: [],
        extraShouldRetry: nil
    )

    func shouldRetry(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return retryableURLErrorCodes.contains(urlError.code)
        }
        if let extra = extraShouldRetry, extra(error) {
            return true
        }
        return false
    }

    func delay(for attempt: Int) -> TimeInterval {
        guard attempt > 0 else { return 0 }
        let raw = exponentialBackoff
            ? baseDelay * pow(2.0, Double(attempt - 1))
            : baseDelay
        return min(raw, maxDelay)
    }
}

/// Thrown when every retry attempt failed.
enum RetryError: Error, CustomStringConvertible {
    case attemptsExhausted(url: URL?, attempts: Int, lastError: Error)

    var description: String {
        switch self {
        case .attemptsExhausted(let url, let attempts, let lastError):
            var parts: [String] = []
            if let url = url {
                parts.append("URL: \(url.absoluteString)")
            }
            parts.append("failed after \(attempts) attempt(s)")
            parts.append("last error: \(lastError.localizedDescription)")
            return "Request " + parts.joined(separator: ", ")
        }
    }

    var localizedDescription: String { description }
}

/// Lightweight retry wrapper with exponential backoff.
struct NetworkRetrier: Sendable {
    let policy: NetworkRetryPolicy

    init(policy: NetworkRetryPolicy = .default) {
        self.policy = policy
    }

    func execute<T: Sendable>(
        url: URL? = nil,
        description: String,
        operation: @Sendable () async throws -> T
    ) async throws -> T {
        var lastError: Error?
        for attempt in 1...policy.maxAttempts {
            do {
                return try await operation()
            } catch {
                lastError = error
                let remaining = policy.maxAttempts - attempt
                guard remaining > 0, policy.shouldRetry(error) else {
                    throw error
                }
                let delay = policy.delay(for: attempt)
                NSLog(
                    "[NetworkRetrier] \(description) failed (attempt \(attempt)/\(policy.maxAttempts)): \(error.localizedDescription). Retrying in \(delay.rounded(toPlaces: 2))s..."
                )
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
        throw lastError ?? RetryError.attemptsExhausted(
            url: url,
            attempts: policy.maxAttempts,
            lastError: lastError ?? TransportError.connectionFailed
        )
    }

    /// Retry wrapper that maps the final exhausted URLError to a typed A2AError.
    func execute<T: Sendable>(
        task: @Sendable () async throws -> T
    ) async throws -> T {
        do {
            return try await execute(description: "task", operation: task)
        } catch let urlError as URLError {
            throw A2AError.transport(urlError)
        } catch let retryError as RetryError {
            if case .attemptsExhausted(_, _, let lastError) = retryError,
               let urlError = lastError as? URLError {
                throw A2AError.transport(urlError)
            }
            throw retryError
        }
    }
}

extension TimeInterval {
    func rounded(toPlaces places: Int) -> Double {
        let divisor = pow(10.0, Double(places))
        return (self * divisor).rounded() / divisor
    }
}
