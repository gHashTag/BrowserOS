// Standalone unit tests for QueenLanguagePolicy - the L3 measurement that
// stops an English document from being committed as a translation.
//
// The suite replays the measured incident (2026-08-22, issue #1138): a bee
// replaced trios/docs/parallel-two.md - 51 lines of English prose - with 14
// lines of Russian, and every gate downstream passed it because none of them
// measured language. It also pins the false positives that would make the
// guard unusable: Swift that quotes Russian issue text, a file already in
// Russian, and anything too short to judge.
//
// Run (from trios root):
//   swiftc tests/swift/queen_language_policy_test.swift \
//     rings/SR-00/QueenLanguagePolicy.swift \
//     -o /tmp/trios_queen_language_policy_test && /tmp/trios_queen_language_policy_test

import Foundation

@main
enum QueenLanguagePolicyTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    /// Roughly the shape of the document that was destroyed: English prose,
    /// comfortably past the size gate.
    static let englishDoc = """
    # Parallel Two - Acceptance

    This document defines what acceptance means for parallel worker tasks in
    the Trios project. Acceptance is the gate between a worker's output and
    the merged result: it is the moment the Queen reviews the completed work
    against the stated acceptance criteria and decides whether it lands.
    Every task dispatched to a worker carries explicit acceptance criteria,
    and those are the only things the Queen checks during review.
    """

    /// The shape of what replaced it.
    static let russianDoc = """
    # Параллель, пчела вторая: заметка о приёмке

    Приёмка — это стык между работой пчелы и результатом улья. Королева не
    переписывает текст и не додумывает замысел: она берёт критерии из
    постановки и сверяет с ними готовое. Всё, что не входит в критерии, на
    этом стыке не существует — ни в плюс, ни в минус.
    """

    /// Swift the way this tree actually writes it: ASCII code, Russian only
    /// where it quotes an issue.
    static let swiftWithRussianQuotes = """
    // The boundary section is parsed by name. Issues written before L3 was
    // extended carry it as `## Границы`, newer ones as `## Boundary`, and
    // both must be recognised or a legitimate task reads as having no
    // boundary at all and is skipped forever.
    static func boundaryHeadings() -> [String] {
        ["## Границы", "## Boundary"]
    }
    static func hasBoundary(_ body: String) -> Bool {
        boundaryHeadings().contains { body.contains($0) }
    }
    """

    static func main() {
        theMeasuredIncident()
        falsePositivesThatWouldMakeItUnusable()
        theSizeGate()
        ratioMath()
        theStagedSet()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All QueenLanguagePolicy tests passed.")
    }

    static func theMeasuredIncident() {
        scenario("the #1138 rewrite is refused, and the refusal shows both measurements")

        guard let reason = QueenLanguagePolicy.rewriteRefusal(
            path: "trios/docs/parallel-two.md", before: englishDoc, after: russianDoc
        ) else {
            check(false, "an English document replaced by Russian is refused")
            return
        }
        check(true, "an English document replaced by Russian is refused")
        check(
            reason.contains("trios/docs/parallel-two.md"),
            "the refusal names the file that stopped the commit"
        )
        check(
            reason.contains("0%") && reason.contains("%"),
            "the refusal carries the measured before and after shares, not an adjective"
        )
        check(
            reason.contains("still in the worktree"),
            "the refusal says where the work went, so a refusal is not a loss"
        )
    }

    static func falsePositivesThatWouldMakeItUnusable() {
        scenario("the three shapes that must never be refused")

        check(
            QueenLanguagePolicy.rewriteRefusal(
                path: "rings/SR-00/QueenLocalisation.swift",
                before: swiftWithRussianQuotes,
                after: swiftWithRussianQuotes + "\n// One more English line about parsing.\n"
            ) == nil,
            "Swift that quotes Russian issue text stays committable - ratio, not presence"
        )
        check(
            QueenLanguagePolicy.rewriteRefusal(
                path: "docs/already-russian.md",
                before: russianDoc + russianDoc,
                after: russianDoc + russianDoc + "\n\nЕщё один абзац о приёмке работы.\n"
            ) == nil,
            "a file that was ALREADY Russian is not this guard's business"
        )
        check(
            QueenLanguagePolicy.rewriteRefusal(
                path: "docs/parallel-two.md",
                before: englishDoc,
                after: englishDoc + "\n\nA further paragraph, in English, about scope.\n"
            ) == nil,
            "an English file edited in English is untouched by the guard"
        )
    }

    static func theSizeGate() {
        scenario("too little text to judge is not evidence of a rewrite")

        check(
            QueenLanguagePolicy.rewriteRefusal(
                path: "docs/stub.md", before: "# Title\n", after: "# Заголовок\n"
            ) == nil,
            "a stub below the letter gate is not judged"
        )
        check(
            QueenLanguagePolicy.rewriteRefusal(
                path: "docs/new.md", before: "", after: russianDoc
            ) == nil,
            "a file with no previous content has no previous language to depart from"
        )
        check(
            QueenLanguagePolicy.letterCount(englishDoc)
                >= QueenLanguagePolicy.minimumLettersToJudge,
            "the incident's own document is comfortably past the size gate"
        )
    }

    static func ratioMath() {
        scenario("letters are counted, everything else is language-neutral")

        check(
            QueenLanguagePolicy.nonASCIILetterRatio("") == 0,
            "empty text has no ratio to report, and reports 0 rather than dividing by zero"
        )
        check(
            QueenLanguagePolicy.nonASCIILetterRatio("### --- 12345 {}[]()") == 0,
            "punctuation, digits and markup alone never read as non-English"
        )
        check(
            QueenLanguagePolicy.nonASCIILetterRatio("abcd") == 0,
            "pure ASCII letters measure 0"
        )
        check(
            QueenLanguagePolicy.nonASCIILetterRatio("абвг") == 1,
            "pure Cyrillic letters measure 1"
        )
        let half = QueenLanguagePolicy.nonASCIILetterRatio("ab!!!,, вг")
        check(
            abs(half - 0.5) < 0.0001,
            "heavy punctuation cannot dilute the ratio: two of four letters is 0.5"
        )
    }

    static func theStagedSet() {
        scenario("one rewrite among good files stops the commit and names itself")

        let refusal = QueenLanguagePolicy.rewriteRefusal(stagedFiles: [
            ("rings/SR-00/Fine.swift", swiftWithRussianQuotes, swiftWithRussianQuotes + "\n"),
            ("docs/parallel-two.md", englishDoc, russianDoc),
            ("docs/other.md", englishDoc, englishDoc + "\nStill English.\n")
        ])
        check(refusal != nil, "a rewrite anywhere in the staged set stops the commit")
        check(
            refusal?.contains("docs/parallel-two.md") == true,
            "the offending file is named, not the count of files"
        )
        check(
            QueenLanguagePolicy.rewriteRefusal(stagedFiles: []) == nil,
            "an empty staged set is not a refusal"
        )
    }
}
