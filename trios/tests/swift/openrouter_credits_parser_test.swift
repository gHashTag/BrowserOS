// Standalone unit tests for OpenRouterCreditsParser — Foundation only.
//
// Run (from trios root), consistent with the no-SPM / TDD-inside-build model:
//   swiftc tests/swift/openrouter_credits_parser_test.swift \
//     rings/SR-00/OpenRouterCreditsParser.swift \
//     -o /tmp/openrouter_credits_parser_test && /tmp/openrouter_credits_parser_test
//
// Exits non-zero on the first failed assertion.

import Foundation

@main
enum OpenRouterCreditsParserTests {
    static var failures = 0

    static func check(_ cond: Bool, _ name: String) {
        if cond {
            print("ok   - \(name)")
        } else {
            print("FAIL - \(name)")
            failures += 1
        }
    }

    static func main() {
        // --- Shape guards: anything that is not {"data": {...}} must yield nil,
        // so the caller falls back to a generic message instead of inventing numbers.
        check(OpenRouterCreditsParser.parse("") == nil,
              "empty body returns nil")
        check(OpenRouterCreditsParser.parse("not json at all") == nil,
              "non-JSON body returns nil")
        check(OpenRouterCreditsParser.parse(#"{"error":{"message":"no auth"}}"#) == nil,
              "payload without data key returns nil")
        check(OpenRouterCreditsParser.parse(#"{"data":[]}"#) == nil,
              "data of the wrong type returns nil")

        // --- Healthy paid key: credits left, no warning.
        let healthy = OpenRouterCreditsParser.parse(
            #"{"data":{"is_free_tier":false,"usage":2.5,"limit":10.0}}"#
        )
        check(healthy != nil, "healthy paid key parses")
        check(healthy?.isDepleted == false, "healthy paid key is not depleted")
        check(healthy?.warning == nil, "healthy paid key has no warning")
        check(healthy?.message.contains("paid tier") == true,
              "healthy paid key reports the tier")
        check(healthy?.message.contains("remaining $7.5000") == true,
              "remaining is derived from limit minus usage")

        // --- Exhausted key: this is the case that used to render as a green
        // "Key valid" while every chat request kept failing with HTTP 402.
        let spent = OpenRouterCreditsParser.parse(
            #"{"data":{"is_free_tier":false,"usage":10.0,"limit":10.0}}"#
        )
        check(spent?.isDepleted == true, "usage equal to limit is depleted")
        check(spent?.warning != nil, "depleted key carries a warning")
        check(spent?.warning?.contains("402") == true,
              "warning names the HTTP status the user will actually hit")
        check(spent?.message.contains("remaining $0.0000") == true,
              "depleted key reports zero remaining")

        // --- limit_remaining is authoritative when OpenRouter supplies it,
        // even if limit-minus-usage would suggest otherwise.
        let explicitRemaining = OpenRouterCreditsParser.parse(
            #"{"data":{"usage":1.0,"limit":10.0,"limit_remaining":0}}"#
        )
        check(explicitRemaining?.isDepleted == true,
              "limit_remaining 0 wins over limit minus usage")

        let explicitPositive = OpenRouterCreditsParser.parse(
            #"{"data":{"usage":10.0,"limit":10.0,"limit_remaining":3.25}}"#
        )
        check(explicitPositive?.isDepleted == false,
              "positive limit_remaining wins over limit minus usage")
        check(explicitPositive?.message.contains("remaining $3.2500") == true,
              "explicit limit_remaining is the reported figure")

        // --- Uncapped key: a null limit means no spend cap, which must never be
        // mistaken for an exhausted balance.
        let uncapped = OpenRouterCreditsParser.parse(
            #"{"data":{"is_free_tier":true,"usage":0,"limit":null}}"#
        )
        check(uncapped != nil, "uncapped key parses")
        check(uncapped?.isDepleted == false, "null limit is not depleted")
        check(uncapped?.warning == nil, "uncapped key has no warning")
        check(uncapped?.message.contains("no spend limit") == true,
              "uncapped key says so explicitly")
        check(uncapped?.message.contains("free tier") == true,
              "free tier is surfaced")

        // --- Negative remaining (overdraft) counts as depleted.
        let overdrawn = OpenRouterCreditsParser.parse(
            #"{"data":{"usage":12.0,"limit":10.0,"limit_remaining":-2.0}}"#
        )
        check(overdrawn?.isDepleted == true, "negative limit_remaining is depleted")

        // --- Formatting is fixed at four decimals so small balances stay visible.
        check(OpenRouterCreditsParser.formatCredits(0) == "$0.0000",
              "formatCredits pads zero")
        check(OpenRouterCreditsParser.formatCredits(1.5) == "$1.5000",
              "formatCredits pads to four decimals")
        check(OpenRouterCreditsParser.formatCredits(0.00012) == "$0.0001",
              "formatCredits keeps sub-cent balances visible")

        if failures == 0 {
            print("\nAll OpenRouterCreditsParser tests passed.")
        } else {
            print("\n\(failures) test(s) failed.")
            exit(1)
        }
    }
}
