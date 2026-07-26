import XCTest
@testable import TriOSKit

final class NetworkRetryPolicyTests: XCTestCase {

    // MARK: - shouldRetry

    func testDefaultPolicyRetriesTransientURLErrors() {
        let policy = NetworkRetryPolicy.default
        let retryableCodes: [URLError.Code] = [
            .timedOut,
            .notConnectedToInternet,
            .cannotFindHost,
            .networkConnectionLost,
        ]
        for code in retryableCodes {
            let error = URLError(code)
            XCTAssertTrue(policy.shouldRetry(error), "Expected retry for \(code)")
        }
    }

    func testDefaultPolicyDoesNotRetryCancelledErrors() {
        let policy = NetworkRetryPolicy.default
        let nonRetryableCodes: [URLError.Code] = [
            .cancelled,
            .userCancelledAuthentication,
        ]
        for code in nonRetryableCodes {
            let error = URLError(code)
            XCTAssertFalse(policy.shouldRetry(error), "Expected no retry for \(code)")
        }
    }

    func testNonePolicyDoesNotRetryAnyURLError() {
        let policy = NetworkRetryPolicy.none
        let allCodes: [URLError.Code] = [
            .timedOut,
            .notConnectedToInternet,
            .cannotFindHost,
            .networkConnectionLost,
            .cancelled,
            .userCancelledAuthentication,
        ]
        for code in allCodes {
            let error = URLError(code)
            XCTAssertFalse(policy.shouldRetry(error), "Expected no retry for \(code) under .none")
        }
    }

    // MARK: - delay(for:)

    func testDelayStartsAtZeroForFirstAttempt() {
        let policy = NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 0.001,
            maxDelay: 1.0,
            exponentialBackoff: true,
            retryableURLErrorCodes: NetworkRetryPolicy.default.retryableURLErrorCodes,
            extraShouldRetry: nil
        )
        XCTAssertEqual(policy.delay(for: 0), 0)
    }

    func testDelayDoublesEachAttempt() {
        let policy = NetworkRetryPolicy(
            maxAttempts: 5,
            baseDelay: 0.001,
            maxDelay: 1.0,
            exponentialBackoff: true,
            retryableURLErrorCodes: NetworkRetryPolicy.default.retryableURLErrorCodes,
            extraShouldRetry: nil
        )
        XCTAssertEqual(policy.delay(for: 1), 0.001, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(for: 2), 0.002, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(for: 3), 0.004, accuracy: 0.0001)
    }

    func testDelayIsCappedByMaxDelay() {
        let policy = NetworkRetryPolicy(
            maxAttempts: 10,
            baseDelay: 0.001,
            maxDelay: 0.008,
            exponentialBackoff: true,
            retryableURLErrorCodes: NetworkRetryPolicy.default.retryableURLErrorCodes,
            extraShouldRetry: nil
        )
        XCTAssertEqual(policy.delay(for: 4), 0.008, accuracy: 0.0001)
        XCTAssertEqual(policy.delay(for: 10), 0.008, accuracy: 0.0001)
    }

    // MARK: - NetworkRetrier.execute

    func testRetrierSucceedsOnFirstAttempt() async throws {
        let retrier = NetworkRetrier(policy: .none)
        let result = try await retrier.execute(description: "first-try") {
            return 42
        }
        XCTAssertEqual(result, 42)
    }

    func testRetrierSucceedsOnRetryAfterTransientError() async throws {
        let policy = NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 0.001,
            maxDelay: 0.01,
            exponentialBackoff: true,
            retryableURLErrorCodes: [.timedOut],
            extraShouldRetry: nil
        )
        let retrier = NetworkRetrier(policy: policy)
        var attempts = 0
        let result = try await retrier.execute(description: "retry-success") {
            attempts += 1
            if attempts < 2 {
                throw URLError(.timedOut)
            }
            return "ok"
        }
        XCTAssertEqual(result, "ok")
        XCTAssertEqual(attempts, 2)
    }

    func testRetrierThrowsLastErrorAfterExhaustingAttempts() async {
        let policy = NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 0.001,
            maxDelay: 0.01,
            exponentialBackoff: true,
            retryableURLErrorCodes: [.timedOut],
            extraShouldRetry: nil
        )
        let retrier = NetworkRetrier(policy: policy)
        var attempts = 0
        do {
            try await retrier.execute(description: "exhaust") {
                attempts += 1
                throw URLError(.timedOut)
            }
            XCTFail("Expected error to be thrown")
        } catch {
            let urlError = error as? URLError
            XCTAssertEqual(urlError?.code, .timedOut)
            XCTAssertEqual(attempts, 3)
        }
    }

    func testExecuteTaskWrapsExhaustedURLErrorInA2ATransport() async {
        let policy = NetworkRetryPolicy(
            maxAttempts: 3,
            baseDelay: 0.001,
            maxDelay: 0.01,
            exponentialBackoff: true,
            retryableURLErrorCodes: [.timedOut],
            extraShouldRetry: nil
        )
        let retrier = NetworkRetrier(policy: policy)
        var attempts = 0
        do {
            try await retrier.execute(task: {
                attempts += 1
                throw URLError(.timedOut)
            })
            XCTFail("Expected error to be thrown")
        } catch let a2aError as A2AError {
            guard case .transport(let urlError) = a2aError else {
                XCTFail("Expected A2AError.transport, got \(a2aError)")
                return
            }
            XCTAssertEqual(urlError.code, .timedOut)
            XCTAssertEqual(attempts, 3)
        } catch {
            XCTFail("Expected A2AError, got \(error)")
        }
    }
}
