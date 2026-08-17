import XCTest
@testable import TriOSKit

final class AgentMemoryServiceRedactionTests: XCTestCase {

    func testRedactsPrivateKeyBlock() {
        let text = """
        Here is the key:
        -----BEGIN RSA PRIVATE KEY-----
        MIIEpAIBAAKCAQEAx...
        -----END RSA PRIVATE KEY-----
        Use it carefully.
        """
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("MIIEpAIBAAKCAQEAx"))
    }

    func testRedactsBearerToken() {
        let text = "Use Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token"
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("Bearer eyJ"))
    }

    func testRedactsBasicAuth() {
        let text = "Authorization: Basic dXNlcjpwYXNzd29yZA=="
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("dXNlcjpwYXNzd29yZA=="))
    }

    func testRedactsJWT() {
        let text = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMe"
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("eyJhbGciOiJIUzI1Ni"))
    }

    func testRedactsQueryToken() {
        let text = "GET /api?access_token=supersecrettoken123&user=foo HTTP/1.1"
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("supersecrettoken123"))
    }

    func testRedactsGitHubToken() {
        let text = "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd"
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("ghp_"))
    }

    func testRedactsURLCredentials() {
        let text = "Connect to https://user:password@example.com/repo.git"
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        XCTAssertTrue(redactedValue.contains("[REDACTED]"))
        XCTAssertFalse(redacted!.contains("user:password@"))
    }

    func testInnocuousTextSurvives() {
        let text = "Fix the login button color and add a unit test."
        let redacted = AgentMemoryService.redacted(text)
        XCTAssertEqual(redacted, text)
    }

    func testRedactedMultipleSecrets() {
        let text = """
        bearer abcdef1234567890 and
        api_key:anothersecretvalue
        """
        let redacted = AgentMemoryService.redacted(text)
        // A failed XCTAssertNotNil followed by `redacted!` kills the whole
        // process, so every test scheduled after it never runs. Guard
        // instead: one failing test, and the run continues.
        guard let redactedValue = redacted else {
            XCTFail("redacted was nil")
            return
        }
        let matches = redactedValue.matches(for: "\\[REDACTED\\]")
        XCTAssertGreaterThanOrEqual(matches.count, 2)
    }
}

private extension String {
    func matches(for pattern: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(self.startIndex..., in: self)
        return regex.matches(in: self, range: range).map {
            String(self[Range($0.range, in: self)!])
        }
    }
}
