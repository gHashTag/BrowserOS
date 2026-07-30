// Standalone unit tests for ZAIErrorParser - Foundation only.
//
// Run (from trios root), consistent with the no-SPM / TDD-inside-build model:
//   swiftc tests/swift/zai_error_parser_test.swift \
//     rings/SR-00/ZAIErrorParser.swift \
//     -o /tmp/zai_error_parser_test && /tmp/zai_error_parser_test
//
// Exits non-zero when any assertion fails.

import Foundation

@main
enum ZAIErrorParserTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)")
        }
    }

    static func scenario(_ name: String) {
        print("\n# Scenario: \(name)")
    }

    static func main() {
        balanceExhaustion()
        wordingFallback()
        authFailures()
        transientErrors()
        nonErrorPayloads()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 {
            exit(1)
        }
        print("All ZAIErrorParser tests passed.")
    }

    // MARK: - Balance exhaustion

    static func balanceExhaustion() {
        scenario("exhausted balance is detected from the business code")

        let body = """
        {"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}
        """
        let parsed = ZAIErrorParser.parse(body)
        check(parsed != nil, "an error envelope parses")
        check(parsed?.code == "1113", "the business code is captured verbatim")
        check(parsed?.isBalanceExhausted == true, "code 1113 means the balance is exhausted")
        check(parsed?.isTerminal == true, "an exhausted balance is terminal, so retrying is pointless")
        check(
            parsed.map { ZAIErrorParser.summary(for: $0) }?.contains("balance is exhausted") == true,
            "the summary names the balance rather than a generic failure"
        )

        // Z.AI sends the code as a string today; a numeric code must still work.
        let numeric = """
        {"error":{"code":1113,"message":"Insufficient balance"}}
        """
        check(
            ZAIErrorParser.parse(numeric)?.isBalanceExhausted == true,
            "a numeric code is tolerated"
        )
    }

    // MARK: - Wording fallback

    static func wordingFallback() {
        scenario("wording still identifies exhaustion when the code changes")

        let renumbered = """
        {"error":{"code":"9999","message":"Insufficient balance or no resource package. Please recharge."}}
        """
        check(
            ZAIErrorParser.parse(renumbered)?.isBalanceExhausted == true,
            "an unknown code with balance wording is still exhaustion"
        )
        check(ZAIErrorParser.mentionsBalance("PLEASE RECHARGE"), "matching is case-insensitive")
        check(
            ZAIErrorParser.mentionsBalance("no resource package"),
            "the resource-package phrasing counts as exhaustion"
        )
        check(
            !ZAIErrorParser.mentionsBalance("model is overloaded, try again"),
            "unrelated wording is not exhaustion"
        )
    }

    // MARK: - Auth failures

    static func authFailures() {
        scenario("auth failures are terminal but not balance problems")

        let body = """
        {"error":{"code":"1000","message":"Authentication Failed"}}
        """
        let parsed = ZAIErrorParser.parse(body)
        check(parsed?.isBalanceExhausted == false, "a bad key is not an exhausted balance")
        check(parsed?.isTerminal == true, "a bad key cannot be fixed by retrying")
        check(
            parsed.map { ZAIErrorParser.summary(for: $0) } == "Z.AI error 1000: Authentication Failed",
            "the summary carries the provider code and message"
        )
    }

    // MARK: - Transient errors

    static func transientErrors() {
        scenario("transient errors stay retryable")

        let body = """
        {"error":{"code":"1302","message":"Concurrency limit reached, please try again later"}}
        """
        let parsed = ZAIErrorParser.parse(body)
        check(parsed?.isBalanceExhausted == false, "a concurrency limit is not a balance problem")
        check(parsed?.isTerminal == false, "a concurrency limit is worth retrying")
    }

    // MARK: - Non-error payloads

    static func nonErrorPayloads() {
        scenario("successful and malformed payloads are not misread as errors")

        let success = """
        {"id":"1","choices":[{"message":{"role":"assistant","content":"ok"}}]}
        """
        check(ZAIErrorParser.parse(success) == nil, "a completion response is not an error")
        check(ZAIErrorParser.parse("") == nil, "an empty body is not an error")
        check(ZAIErrorParser.parse("not json at all") == nil, "a non-JSON body is not an error")
        check(
            ZAIErrorParser.parse("{\"error\":\"flat string\"}") == nil,
            "a flat error field is ignored"
        )

        let noCode = """
        {"error":{"message":"Something went wrong"}}
        """
        let parsed = ZAIErrorParser.parse(noCode)
        check(parsed?.code == "", "a missing code yields an empty code rather than a crash")
        check(
            parsed?.isBalanceExhausted == false,
            "an unlabelled error is not assumed to be exhaustion"
        )
        check(parsed?.isTerminal == false, "an unlabelled error stays retryable")
        check(
            parsed.map { ZAIErrorParser.summary(for: $0) } == "Z.AI error: Something went wrong",
            "the summary omits an empty code"
        )
    }
}
