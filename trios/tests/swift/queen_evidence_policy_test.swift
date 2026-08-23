// Standalone unit tests for QueenEvidencePolicy - when a name being present
// is evidence that work was done, and when it is only evidence that the work
// has a subject.
//
// Measured 2026-08-23: the Queen skipped eight of seventeen candidates as
// "looks already done" because every identifier their criteria named was
// present in their boundary files. For a fix, those identifiers are present
// BECAUSE the defect is - #1288's criteria name fetchPullRequest because that
// function loses the HTTP status - so the heuristic dismissed the work before
// anyone could do it, including two issues filed that same hour.
//
// Run (from trios root):
//   swiftc tests/swift/queen_evidence_policy_test.swift \
//     rings/SR-00/QueenEvidencePolicy.swift \
//     -o /tmp/trios_queen_evidence_policy_test \
//     && /tmp/trios_queen_evidence_policy_test

import Foundation

@main
enum QueenEvidencePolicyTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        theFixCase()
        theCreateCase()
        theUnmeasuredCase()
        theEmptyCases()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All QueenEvidencePolicy tests passed.")
    }

    static func theFixCase() {
        scenario("names that were already there prove nothing")

        check(
            !QueenEvidencePolicy.presenceIsEvidence(
                symbols: ["fetchPullRequest"],
                contentsWhenFiled: "func fetchPullRequest(repo: String, number: Int) async throws"
            ),
            "an identifier present when the issue was filed is the defect's own vocabulary (#1288)"
        )
        check(
            !QueenEvidencePolicy.presenceIsEvidence(
                symbols: ["decodeFailure", "fetchPullRequest"],
                contentsWhenFiled: "func fetchPullRequest() {}\nfunc decodeFailure() {}"
            ),
            "and all of them being old is the same answer"
        )
    }

    static func theCreateCase() {
        scenario("a name that arrived after the issue is evidence")

        check(
            QueenEvidencePolicy.presenceIsEvidence(
                symbols: ["decodeFailure"],
                contentsWhenFiled: "func fetchPullRequest() {}"
            ),
            "an identifier absent when the issue was filed and present now is what done looks like"
        )
        check(
            QueenEvidencePolicy.presenceIsEvidence(
                symbols: ["fetchPullRequest", "decodeFailure"],
                contentsWhenFiled: "func fetchPullRequest() {}"
            ),
            "ONE new name among old ones is enough - the criteria asked for something that did not exist"
        )
    }

    static func theUnmeasuredCase() {
        scenario("a question git could not answer may not dismiss work")

        check(
            !QueenEvidencePolicy.presenceIsEvidence(
                symbols: ["anything"], contentsWhenFiled: nil
            ),
            "nil - an unresolvable revision, a file that did not exist yet - is NOT evidence"
        )
        check(
            !QueenEvidencePolicy.presenceIsEvidence(
                symbols: ["neverAppears"], contentsWhenFiled: nil
            ),
            "and stays not-evidence even when the name would obviously be new, because nothing was measured"
        )
    }

    static func theEmptyCases() {
        scenario("nothing named is nothing proved")

        check(
            !QueenEvidencePolicy.presenceIsEvidence(symbols: [], contentsWhenFiled: "anything"),
            "criteria that name no identifier cannot support an already-done verdict"
        )
        check(
            !QueenEvidencePolicy.presenceIsEvidence(symbols: [], contentsWhenFiled: nil),
            "and the same with nothing measured either"
        )
        check(
            QueenEvidencePolicy.presenceIsEvidence(symbols: ["x"], contentsWhenFiled: ""),
            "an empty file at filing time makes every present name new - the create case at its cleanest"
        )
    }
}
