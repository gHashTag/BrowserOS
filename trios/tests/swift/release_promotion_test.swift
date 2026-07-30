// Standalone unit tests for ReleasePromotionPolicy - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/release_promotion_test.swift rings/SR-00/ReleasePromotionPolicy.swift \
//     -o /tmp/trios_release_promotion_test && /tmp/trios_release_promotion_test

import Foundation

@main
enum ReleasePromotionTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func green() -> PromotionEvidence {
        PromotionEvidence(
            devBuildExists: true,
            suitesPassed: 14,
            suitesTotal: 14,
            chatEndToEndPassed: true,
            compileErrors: 0,
            dirtyFiles: 3,
            devAppHealthy: true
        )
    }

    static func main() {
        greenPromotes()
        eachGateBlocks()
        noEvidenceIsNotSuccess()
        verdictReadsWell()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All ReleasePromotion tests passed.")
    }

    static func greenPromotes() {
        scenario("a fully green dev build promotes")

        check(ReleasePromotionPolicy.mayPromote(green()), "everything green promotes")
        check(ReleasePromotionPolicy.blockers(for: green()).isEmpty, "no blockers are reported")
    }

    /// Each gate must block on its own, or a gate is decorative.
    static func eachGateBlocks() {
        scenario("every gate blocks independently")

        var noBuild = green(); noBuild.devBuildExists = false
        check(!ReleasePromotionPolicy.mayPromote(noBuild), "a missing dev build blocks")

        var errors = green(); errors.compileErrors = 1
        check(!ReleasePromotionPolicy.mayPromote(errors), "a single compile error blocks")

        var suites = green(); suites.suitesPassed = 13
        check(!ReleasePromotionPolicy.mayPromote(suites), "one failing suite blocks")
        check(
            ReleasePromotionPolicy.blockers(for: suites).first?.message.contains("1 of 14") == true,
            "the blocker says how many failed"
        )

        var chat = green(); chat.chatEndToEndPassed = false
        check(!ReleasePromotionPolicy.mayPromote(chat), "a failing chat e2e blocks")

        var unhealthy = green(); unhealthy.devAppHealthy = false
        check(!ReleasePromotionPolicy.mayPromote(unhealthy), "a dev app that never launched blocks")

        var dirty = green(); dirty.dirtyFiles = ReleasePromotionPolicy.maximumDirtyFiles + 1
        check(!ReleasePromotionPolicy.mayPromote(dirty), "an excessively dirty tree blocks")

        var justClean = green(); justClean.dirtyFiles = ReleasePromotionPolicy.maximumDirtyFiles
        check(ReleasePromotionPolicy.mayPromote(justClean), "exactly at the dirt limit is allowed")
    }

    /// The trap worth guarding: zero suites run is not zero suites failed.
    static func noEvidenceIsNotSuccess() {
        scenario("no evidence is refused rather than treated as green")

        var none = green()
        none.suitesPassed = 0
        none.suitesTotal = 0
        check(
            !ReleasePromotionPolicy.mayPromote(none),
            "a run with no suites is blocked, not silently promoted"
        )
        check(
            ReleasePromotionPolicy.blockers(for: none).contains { $0.id == "no-suites" },
            "the blocker names the missing evidence"
        )
    }

    static func verdictReadsWell() {
        scenario("the verdict states the reason")

        check(
            ReleasePromotionPolicy.verdict(for: green()).contains("Ready to promote"),
            "a green verdict says so"
        )
        check(
            ReleasePromotionPolicy.verdict(for: green()).contains("14/14"),
            "a green verdict cites the evidence"
        )
        var broken = green()
        broken.chatEndToEndPassed = false
        broken.compileErrors = 2
        let verdict = ReleasePromotionPolicy.verdict(for: broken)
        check(verdict.hasPrefix("Blocked (2)"), "a blocked verdict counts the reasons")
        check(verdict.contains("compile error"), "a blocked verdict names each reason")
    }
}
