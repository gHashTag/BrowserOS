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
        theDeclarationRule()
        theFixCase()
        theCreateCase()
        theUnmeasuredCase()
        theEmptyCases()
        identifierExtraction()

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

    /// The other half of the same decision, and it had no check at all until
    /// today: which names in an issue's criteria the Queen treats as
    /// identifiers. It decides what she works on.
    static func identifierExtraction() {
        scenario("what counts as a name the criteria mention")

        let found = Set(QueenEvidencePolicy.namedIdentifiers(
            in: "The message names the shape via `fetchPullRequest`, and "
                + "requestReviewerVerdicts must still answer."
        ))
        check(
            found.contains("fetchPullRequest"),
            "a backticked identifier is taken (#1178)"
        )
        check(
            found.contains("requestReviewerVerdicts"),
            "and a bare word with an interior capital is taken from prose (#1179)"
        )

        // The narrowing's contract: a path's stem IS what to search the file
        // for, and #1172's drill pins the count it yields.
        let forNarrowing = Set(QueenEvidencePolicy.namedIdentifiers(
            in: "Boundary: `rings/SR-02/ChatViewModel.swift`."
        ))
        check(
            forNarrowing.contains("ChatViewModel"),
            "narrowing still mines a path's stem - that is what it searches the file for"
        )

        let paths = Set(QueenEvidencePolicy.evidenceIdentifiers(
            in: "Boundary: `docs/par-a.md` and `rings/SR-02/ChatViewModel.swift`."
        ))
        check(
            !paths.contains("docs/par-a.md"),
            "a path is not an identifier - a slash disqualifies it"
        )
        check(
            !paths.contains("rings/SR-02/ChatViewModel.swift"),
            "and neither is a path with a file extension, however identifier-shaped its tail"
        )
        check(
            !paths.contains("ChatViewModel"),
            "but EVIDENCE may not: the stem is in that file by construction, so it would argue for itself"
        )
        check(
            paths.isEmpty,
            "so criteria naming only files yield nothing to argue with"
        )

        let noise = Set(QueenEvidencePolicy.evidenceIdentifiers(
            in: "The worker must `return` a value and `guard` against nil; see ChatViewModel."
        ))
        check(
            !noise.contains("return") && !noise.contains("guard"),
            "Swift keywords are not evidence of anything"
        )
        check(
            noise.contains("ChatViewModel"),
            "while a real type name in the same sentence still counts"
        )
        check(
            QueenEvidencePolicy.evidenceIdentifiers(in: "The file is short.").isEmpty,
            "ordinary prose names nothing - the case where the heuristic must stay silent"
        )
        check(
            QueenEvidencePolicy.evidenceIdentifiers(in: "`abcde`").isEmpty,
            "five characters is under the floor, so a short word cannot carry a verdict"
        )
    }

    static func theDeclarationRule() {
        scenario("a name is evidence only where the file DECLARES it")

        // The live case, 2026-08-28. QueenLocalisation.swift names these three
        // in its own narrative header and measurement table - as the inputs
        // the narrowing logic is tested against - and declares none of them.
        let prose = """
        /// | #1158 | 6263-6439 `acceptanceBlockReasonDistinguishingEmptyAnswers`
        ///   `autoAcceptIfUnambiguous`'s body contains 4 identifiers
        //  #1156 still yields handleWorkerFinished
        let cases = ["autoAcceptIfUnambiguous", "chooseNextOpenIssue"]
        """
        check(
            !QueenEvidencePolicy.declaresIdentifier("handleWorkerFinished", in: prose),
            "a name in a comment is not a declaration"
        )
        check(
            !QueenEvidencePolicy.declaresIdentifier("chooseNextOpenIssue", in: prose),
            "a name inside a string literal array is not a declaration"
        )
        check(
            QueenEvidencePolicy.undeclaredIdentifiers(
                ["handleWorkerFinished", "chooseNextOpenIssue"], in: prose
            ).count == 2,
            "both names are reported undeclared, which is what unblocks the issue"
        )

        scenario("real declarations are still evidence")

        for (kw, src) in [
            ("func", "    private func handleWorkerFinished(_ t: Task) {"),
            ("var", "    var chooseNextOpenIssue: Int = 0"),
            ("let", "let autoAcceptIfUnambiguous = true"),
            ("case", "        case requestReviewerVerdicts"),
            ("struct", "struct SomeIdentifier {"),
            ("enum", "enum AnotherIdentifier {"),
        ] {
            let name = src.split(separator: " ").last.map {
                String($0).trimmingCharacters(in: CharacterSet(charactersIn: "({:=0 truefalse"))
            } ?? ""
            _ = name
            check(
                QueenEvidencePolicy.declaresIdentifier(
                    kw == "func" ? "handleWorkerFinished"
                        : kw == "var" ? "chooseNextOpenIssue"
                        : kw == "let" ? "autoAcceptIfUnambiguous"
                        : kw == "case" ? "requestReviewerVerdicts"
                        : kw == "struct" ? "SomeIdentifier" : "AnotherIdentifier",
                    in: src
                ),
                "\(kw) declares its name"
            )
        }

        scenario("the boundary is checked on both sides")

        check(
            !QueenEvidencePolicy.declaresIdentifier(
                "handleWorkerFinished", in: "func handleWorkerFinishedLater() {"
            ),
            "a longer name does not answer for a shorter one"
        )
        check(
            !QueenEvidencePolicy.declaresIdentifier(
                "handleWorkerFinished", in: "func prefixHandleWorkerFinished() {"
            ),
            "a name embedded after a prefix is not a declaration of it"
        )
        check(
            QueenEvidencePolicy.declaresIdentifier("done", in: "let done: Bool"),
            "a declaration followed by a colon still counts"
        )
        check(
            QueenEvidencePolicy.declaresIdentifier("done", in: "let done"),
            "a declaration at end of line still counts"
        )
        check(
            !QueenEvidencePolicy.declaresIdentifier("", in: "func x() {}"),
            "an empty identifier is never declared"
        )
        check(
            QueenEvidencePolicy.undeclaredIdentifiers([], in: "anything").isEmpty,
            "no identifiers means nothing undeclared"
        )
    }
}
