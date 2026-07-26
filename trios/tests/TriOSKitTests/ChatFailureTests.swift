import XCTest
@testable import TriOSKit

final class ChatFailureTests: XCTestCase {
    // MARK: - TransportError classification

    func testBalanceErrorDetectedFrom402() {
        let error = TransportError.serverError(
            statusCode: 402,
            bodySample: "{\"error\":{\"message\":\"Insufficient balance\"}}",
            url: nil
        )
        XCTAssertTrue(error.isBalanceError)
        XCTAssertFalse(error.isAuthError)
        XCTAssertEqual(error.providerErrorMessage, "Insufficient balance")
    }

    func testBalanceBodyFallback() {
        let error = TransportError.serverError(
            statusCode: 400,
            bodySample: "Insufficient balance or no resource package. Please recharge.",
            url: nil
        )
        XCTAssertTrue(error.isBalanceError)
        XCTAssertEqual(error.providerErrorMessage, "Insufficient balance or no resource package. Please recharge.")
    }

    func testAuthErrorDetectedFrom401() {
        let error = TransportError.serverError(
            statusCode: 401,
            bodySample: "Unauthorized",
            url: nil
        )
        XCTAssertTrue(error.isAuthError)
        XCTAssertFalse(error.isBalanceError)
    }

    func testInvalidModelErrorDetected() {
        let error = TransportError.serverError(
            statusCode: 400,
            bodySample: "Model 'claude-opus-4-6' is not available.",
            url: nil
        )
        XCTAssertTrue(error.isInvalidModelError)
        XCTAssertFalse(error.isRetryableServerError)
    }

    func testRateLimitIsRetryable() {
        let error = TransportError.serverError(
            statusCode: 429,
            bodySample: "Rate limit exceeded",
            url: nil
        )
        XCTAssertTrue(error.isRateLimitError)
        XCTAssertTrue(error.isRetryableServerError)
    }

    func testModelUnavailableIsRetryable() {
        let error = TransportError.serverError(
            statusCode: 503,
            bodySample: "Service Unavailable",
            url: nil
        )
        XCTAssertTrue(error.isModelUnavailableError)
        XCTAssertTrue(error.isRetryableServerError)
    }

    func testFatalServerErrorsAreNotRetryable() {
        for status in [400, 401, 402, 403, 404, 422] {
            let error = TransportError.serverError(
                statusCode: status,
                bodySample: "nope",
                url: nil
            )
            XCTAssertFalse(error.isRetryableServerError, "status \(status) should not be retryable")
        }
    }

    // MARK: - Model fallback helpers

    func testFallbackModelsExcludeCurrent() {
        let defaults = UserDefaults(suiteName: "test-fallback")!
        defer { defaults.removePersistentDomain(forName: "test-fallback") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        XCTAssertTrue(store.fallbackModels.contains("claude-opus-4-5"))
        XCTAssertFalse(store.fallbackModels.contains("claude-sonnet-4-5"))
        XCTAssertFalse(store.fallbackSuggestion.isEmpty)
    }

    func testSelectNextModelAdvancesList() {
        let defaults = UserDefaults(suiteName: "test-next-model")!
        defer { defaults.removePersistentDomain(forName: "test-next-model") }
        let store = ModelConfigurationStore(defaults: defaults)
        store.selectProvider(.anthropic)
        store.selectModel("claude-sonnet-4-5")

        let next = store.selectNextModel()
        XCTAssertNotNil(next)
        XCTAssertNotEqual(next, "claude-sonnet-4-5")
        XCTAssertEqual(store.selectedModel, next)
    }

    // MARK: - Queen command parsing

    func testDoctorWithoutModel() {
        let cmd = QueenCommandParser.parse("/doctor")
        if case .doctor(let model) = cmd {
            XCTAssertNil(model)
        } else {
            XCTFail("Expected .doctor(nil), got \(cmd)")
        }
    }

    func testDoctorWithModelFlag() {
        let cmd = QueenCommandParser.parse("/doctor --model claude-sonnet-4-6")
        if case .doctor(let model) = cmd {
            XCTAssertEqual(model, "claude-sonnet-4-6")
        } else {
            XCTFail("Expected .doctor with model, got \(cmd)")
        }
    }

    func testDoctorWithModelFlagRejectedWhenEmpty() {
        let cmd = QueenCommandParser.parse("/doctor --model")
        XCTAssertEqual(cmd, .unknown("/doctor --model"))
    }
}
