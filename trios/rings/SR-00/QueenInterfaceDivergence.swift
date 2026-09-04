// Decides whether parallel lanes diverge by interface: one changed a public
// declaration inside its own boundary, and another owns a call still written
// against the old shape.
//
// Measured on #1110/#1109 (2026-08): two bees ran side by side with disjoint
// boundaries. #1110 owned `rings/SR-02/QueenBranchCommitter.swift` and made
// `baseBranch()` return `String?` - exactly what its criterion asked for. The
// call site lived in `rings/SR-02/ChatViewModel.swift`, which belongs to
// #1109. Both bees honoured the one-owner-per-path rule; neither wrote one
// byte outside its boundary; the build still broke:
//
//     rings/SR-02/ChatViewModel.swift:4142: error: value of optional type
//     'String?' must be unwrapped to a value of type 'String'
//
// The boundary rule protects against a conflict of WRITES. It says nothing
// about a conflict of INTERFACES: a signature changed in one file breaks a
// different file, and the only instrument that can see that is a build of the
// two states TOGETHER - which no bee in the loop runs, because each builds
// its own branch alone.
//
// What already exists (#1128): `runInterfaceDivergenceWatchdog` in
// `ChatViewModel` compiles the combined state before any acceptance, and
// `transitionToAccepted` takes the proof as a parameter, so no acceptance
// path can skip it. That closes the acceptance side. What it does not give is
// the decision itself: the watchdog is a compiler run - minutes long, and out
// of reach of any suite - so nothing could answer, cheaply and in words,
// "do these lanes diverge?". That decision is this rule, pure and alone:
//
//   - it takes the interface FACTS of each lane (which declarations changed
//     shape, which calls expect which shape), not source text and not a
//     compiler;
//   - it overlays the lanes the same way `verifyCombinedBuild` overlays
//     branches, and asks the compiler's question about the result: does any
//     call still expect a shape that no longer exists?
//   - it answers in findings that name both sides - who changed what, and
//     who still calls the old shape - because a refusal that does not name
//     its subject sends the reader hunting for the wrong problem.
//
// The rule assumes what the parallel loop already guarantees: every lane
// builds alone against the base. It therefore judges what that guarantee
// cannot see - what happens when the lanes are put together. A stale call
// inside the lane that made the change cannot occur under the precondition
// (that lane would not build alone); if the facts carry one anyway, the rule
// reports it, because the combined tree breaks just the same.
//
// It lives in SR-00 as a separate file because there it needs nothing but
// the Swift standard library - not even Foundation - and is provable by a
// single-file suite, which rides in the same file behind
// `QUEEN_INTERFACE_DIVERGENCE_SELFTEST` (see the bottom). Nothing here may
// depend on `ChatViewModel` or any app type: those files are owned by other
// tasks, and a rule that cannot be compiled alone cannot be checked alone.

/// The pure decision: given the interface facts of the parallel lanes, do
/// they diverge - would the overlaid tree still satisfy every call?
public enum QueenInterfaceDivergence {

    // MARK: - facts

    /// The part of a declaration a caller can see and a change can break:
    /// its parameters and its return type, as canonical text.
    ///
    /// Whoever extracts the facts canonicalises (one spelling per parameter,
    /// default values dropped - they do not change what a caller may pass);
    /// this rule only compares, so two spellings of one parameter list must
    /// be normalised before they reach it. `text` is the form findings quote.
    public struct Signature: Equatable, Hashable {
        public let parameters: [String]
        public let returns: String

        public init(parameters: [String], returns: String) {
            self.parameters = parameters
            self.returns = returns
        }

        /// The form a finding names the shape by.
        public var text: String {
            "(" + parameters.joined(separator: ", ") + ") -> " + returns
        }
    }

    /// One public declaration one lane changed, in a file that lane owns.
    /// `path` is project-relative, the form boundaries are written in.
    public struct DeclarationChange: Equatable {
        public let symbol: String
        public let path: String
        public let before: Signature
        public let after: Signature

        public init(symbol: String, path: String, before: Signature, after: Signature) {
            self.symbol = symbol
            self.path = path
            self.before = before
            self.after = after
        }

        /// False when only the body changed: the shape a caller sees is the
        /// same, so no caller can be broken by it.
        public var changedShape: Bool { before != after }
    }

    /// One use of a public declaration, as written in a lane's own file,
    /// with the shape that use was written against.
    public struct Reference: Equatable {
        public let symbol: String
        public let path: String
        public let expects: Signature

        public init(symbol: String, path: String, expects: Signature) {
            self.symbol = symbol
            self.path = path
            self.expects = expects
        }
    }

    /// One parallel lane: its identity plus the interface facts of its
    /// state. No owned-path list, deliberately: boundaries decide who may
    /// WRITE, and the write rule already had its say; the divergence this
    /// rule judges lives in the facts themselves.
    public struct Lane: Equatable {
        public let id: String
        public let changes: [DeclarationChange]
        public let references: [Reference]

        public init(id: String, changes: [DeclarationChange] = [], references: [Reference] = []) {
            self.id = id
            self.changes = changes
            self.references = references
        }
    }

    // MARK: - the verdict

    /// A named divergence. Both sides are carried, because a refusal that
    /// does not name its subject sends the reader hunting for the wrong
    /// problem.
    public enum Finding: Equatable {
        /// A call still expects the shape the declaration no longer has.
        /// This is the incident of #1110/#1109: each lane alone is
        /// consistent; overlaid, this one call does not compile.
        case staleCall(
            symbol: String,
            changedBy: String,
            declaredIn: String,
            calledBy: String,
            calledFrom: String,
            expected: Signature,
            found: Signature
        )

        /// Two lanes each changed the same declaration to different shapes.
        /// One declaration cannot carry both; the overlay has no winner.
        /// (Two lanes changing one file is the boundary rule's business;
        /// the same SYMBOL reachable from two files is this one's.)
        case twoLanesChangedOneDeclaration(
            symbol: String,
            path: String,
            firstChangedBy: String,
            secondChangedBy: String,
            firstShape: Signature,
            secondShape: Signature
        )

        /// The symbol the finding is about, so findings can be ordered.
        public var symbol: String {
            switch self {
            case let .staleCall(symbol, _, _, _, _, _, _): return symbol
            case let .twoLanesChangedOneDeclaration(symbol, _, _, _, _, _): return symbol
            }
        }

        /// One sentence a review can act on, naming both sides.
        public var summary: String {
            switch self {
            case let .staleCall(symbol, changedBy, declaredIn, calledBy, calledFrom,
                                expected, found):
                return "\(symbol): \(changedBy) changed its declaration in "
                    + "\(declaredIn) to \(found.text), while \(calledBy) still "
                    + "calls it from \(calledFrom) expecting \(expected.text). "
                    + "Each lane builds alone; overlaid, this call does not "
                    + "compile."
            case let .twoLanesChangedOneDeclaration(symbol, path, first, second,
                                                    firstShape, secondShape):
                return "\(symbol): changed by both \(first) and \(second) in "
                    + "\(path), to \(firstShape.text) and \(secondShape.text). "
                    + "One declaration cannot carry both shapes."
            }
        }
    }

    public enum Verdict: Equatable {
        /// Overlaid, every call still matches the declaration it calls.
        case clear
        /// The lanes do not compose. Each finding names one divergence.
        case divergent(findings: [Finding])

        public var isDivergent: Bool {
            if case .divergent = self { return true }
            return false
        }
    }

    // MARK: - the decision

    /// Decides whether the lanes diverge by interface.
    ///
    /// The overlay mirrors `verifyCombinedBuild`: every lane's changes land
    /// on the shared base, one shape per symbol. A reference is then checked
    /// against the overlaid shape of the symbol it names - from ANY lane,
    /// because the combined tree breaks the same whether the stale call sits
    /// in the changer's own files or in another lane's. References to
    /// symbols nobody changed are not checked: each lane builds alone
    /// against the base, so those already agree with it.
    ///
    /// Symbols two lanes changed to DIFFERENT shapes have no overlay: the
    /// finding says so and the verdict is divergent regardless of callers.
    public static func verdict(between lanes: [Lane]) -> Verdict {
        // One claim per lane per changed shape: who changed what, where.
        struct Claim: Equatable {
            let lane: String
            let change: DeclarationChange
        }
        var claimsBySymbol: [String: [Claim]] = [:]
        for lane in lanes {
            for change in lane.changes where change.changedShape {
                claimsBySymbol[change.symbol, default: []]
                    .append(Claim(lane: lane.id, change: change))
            }
        }

        var findings: [Finding] = []
        var overlay: [String: (shape: Signature, by: String, in: String)] = [:]
        for (symbol, claims) in claimsBySymbol {
            let shapes = Set(claims.map { $0.change.after })
            if shapes.count > 1 {
                findings.append(.twoLanesChangedOneDeclaration(
                    symbol: symbol,
                    path: claims[0].change.path,
                    firstChangedBy: claims[0].lane,
                    secondChangedBy: claims[1].lane,
                    firstShape: claims[0].change.after,
                    secondShape: claims[1].change.after
                ))
                // No shape wins the overlay for this symbol; the verdict is
                // already divergent and callers of it have nothing to be
                // compared against.
                continue
            }
            let first = claims[0]
            overlay[symbol] = (
                shape: first.change.after,
                by: claims.map { $0.lane }.joined(separator: " & "),
                in: first.change.path
            )
        }

        for lane in lanes {
            for reference in lane.references {
                guard let landed = overlay[reference.symbol] else { continue }
                if reference.expects != landed.shape {
                    findings.append(.staleCall(
                        symbol: reference.symbol,
                        changedBy: landed.by,
                        declaredIn: landed.in,
                        calledBy: lane.id,
                        calledFrom: reference.path,
                        expected: reference.expects,
                        found: landed.shape
                    ))
                }
            }
        }

        if findings.isEmpty { return .clear }
        // Deterministic order, so a suite and a review read the same list.
        findings.sort { ($0.symbol, $0.summary) < ($1.symbol, $1.summary) }
        return .divergent(findings: findings)
    }

    /// `true` when the lanes diverge and must not be accepted in parallel
    /// without reconciliation.
    public static func isDivergent(between lanes: [Lane]) -> Bool {
        verdict(between: lanes).isDivergent
    }
}

// MARK: - the single-file suite
//
// The proof rides in the same file, behind a condition the app build never
// defines, so the rule needs no second file to be checked - and no reviewer
// has to take the rule's word for itself. The suite block contains
// declarations only, deliberately: `-emit-module` (which the app build runs)
// typechecks even INACTIVE `#if` branches, measured on this container, so a
// top-level entry here would break the app build the day the flag is off.
// The entry is a one-line driver instead.
//
// Run the suite, interpreted (no linker needed; this is how it runs on the
// Linux container):
//
//     cd trios && ( cat rings/SR-00/QueenInterfaceDivergence.swift; \
//         echo 'QueenInterfaceDivergenceTests.main()' ) > /tmp/qid_suite.swift \
//         && swift -D QUEEN_INTERFACE_DIVERGENCE_SELFTEST /tmp/qid_suite.swift
//
// or compiled, where a toolchain can link, from the same generated file:
//
//     swiftc -D QUEEN_INTERFACE_DIVERGENCE_SELFTEST /tmp/qid_suite.swift \
//         -o /tmp/trios_queen_interface_divergence_test \
//         && /tmp/trios_queen_interface_divergence_test
//
// A failing check ends in `fatalError`, which is loud and non-zero on every
// platform without reaching for a C library; the suite imports nothing and
// uses only the Swift standard library, so it runs anywhere the interpreter
// does.
#if QUEEN_INTERFACE_DIVERGENCE_SELFTEST

enum QueenInterfaceDivergenceTests {
    static var failures = 0
    static var checks = 0

    static func check(_ condition: Bool, _ name: String) {
        checks += 1
        if condition { print("ok   - \(name)") } else {
            failures += 1
            print("FAIL - \(name)")
        }
    }

    static func equal<T: Equatable>(_ got: T, _ want: T, _ name: String) {
        check(got == want, name)
        if got != want {
            print("         got:  \(got)")
            print("         want: \(want)")
        }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    // MARK: the incident, as it happened

    /// The facts of #1110/#1109, taken from the tree and the issue text:
    /// paths as they are, shapes as they were. #1110 changed the return of
    /// `baseBranch` and adapted the one call inside its own file (the
    /// `?? "HEAD"` fallback at QueenBranchCommitter.swift:282), so its lane
    /// built alone. #1109 owned `ChatViewModel.swift`, whose call was
    /// written against the old non-optional return, and owned
    /// `QueenReviewVerdictRequest.swift`, where it changed nothing that
    /// callers could see.
    static func incidentLanes() -> [QueenInterfaceDivergence.Lane] {
        typealias D = QueenInterfaceDivergence

        let returnsString = D.Signature(
            parameters: ["projectRoot: String"], returns: "String")
        let returnsOptional = D.Signature(
            parameters: ["projectRoot: String"], returns: "String?")
        let baseBranch = "QueenBranchCommitter.baseBranch(projectRoot:)"
        let committer = "rings/SR-02/QueenBranchCommitter.swift"
        let viewModel = "rings/SR-02/ChatViewModel.swift"
        let verdictRequest = "rings/SR-00/QueenReviewVerdictRequest.swift"

        // A body-only change in #1109's other file: real to the incident,
        // and invisible to the interface - callers see the same shape.
        let parseShape = D.Signature(parameters: ["body: String"], returns: "[String]")

        return [
            D.Lane(
                id: "queen-1110",
                changes: [
                    D.DeclarationChange(
                        symbol: baseBranch, path: committer,
                        before: returnsString, after: returnsOptional)
                ],
                references: [
                    // Its own file's call, already adapted on this branch.
                    D.Reference(symbol: baseBranch, path: committer,
                                expects: returnsOptional)
                ]
            ),
            D.Lane(
                id: "queen-1109",
                changes: [
                    D.DeclarationChange(
                        symbol: "QueenReviewVerdictRequest.parse(criteria:)",
                        path: verdictRequest,
                        before: parseShape, after: parseShape)
                ],
                references: [
                    // The call the build error pointed at.
                    D.Reference(symbol: baseBranch, path: viewModel,
                                expects: returnsString)
                ]
            )
        ]
    }

    static func theIncidentItself() {
        scenario("the incident itself: signature change in one lane, call in the other")

        let verdict = QueenInterfaceDivergence.verdict(between: incidentLanes())

        // Criterion 1's pure half: the decision refuses this pair. Honoured
        // by the loop (the acceptance-side watchdog compiles exactly this
        // overlay before any lane may land), the parallel run cannot leave
        // the tree unbuildable: it is either refused here, in words, or
        // refused there, by the compiler.
        check(
            verdict.isDivergent,
            "the incident pair is divergent, not clear"
        )

        guard case let .divergent(findings) = verdict else {
            check(false, "the verdict carries findings")
            return
        }
        equal(findings.count, 1, "exactly one finding, naming one crossing")

        guard case let .staleCall(symbol, changedBy, declaredIn, calledBy, calledFrom,
                                  expected, found) = findings[0] else {
            check(false, "the finding is a stale call")
            return
        }
        equal(symbol, "QueenBranchCommitter.baseBranch(projectRoot:)",
              "the finding names the symbol")
        equal(changedBy, "queen-1110", "the finding names the lane that changed it")
        equal(declaredIn, "rings/SR-02/QueenBranchCommitter.swift",
              "the finding names the declaring path")
        equal(calledBy, "queen-1109", "the finding names the lane that owns the call")
        equal(calledFrom, "rings/SR-02/ChatViewModel.swift",
              "the finding names the calling path")
        equal(expected.returns, "String", "the call expected the old return")
        equal(found.returns, "String?", "the declaration now returns the new one")

        let summary = findings[0].summary
        check(
            summary.contains("queen-1110")
                && summary.contains("queen-1109")
                && summary.contains("rings/SR-02/QueenBranchCommitter.swift")
                && summary.contains("rings/SR-02/ChatViewModel.swift"),
            "the summary names both lanes and both paths"
        )
    }

    static func oneOwnerUpdatedBothSides() {
        scenario("the same signature change with one owner of both sides is clear")

        typealias D = QueenInterfaceDivergence
        let before = D.Signature(parameters: [], returns: "String")
        let after = D.Signature(parameters: [], returns: "String?")

        // The rule does not refuse signature changes; it refuses the
        // CROSSING. A lane that owns both the declaration and the call and
        // moves them together leaves nothing stale behind.
        let lanes = [
            D.Lane(
                id: "queen-1",
                changes: [
                    D.DeclarationChange(symbol: "Lib.greet()", path: "Sources/Lib.swift",
                                        before: before, after: after)
                ],
                references: [
                    D.Reference(symbol: "Lib.greet()", path: "Sources/App.swift",
                                expects: after)
                ]
            )
        ]
        check(
            QueenInterfaceDivergence.verdict(between: lanes) == .clear,
            "a change and its call moved together is clear"
        )
    }

    static func bodyOnlyChangeIsClear() {
        scenario("a body-only change to a referenced symbol is clear")

        typealias D = QueenInterfaceDivergence
        let same = D.Signature(parameters: ["count: Int"], returns: "String")
        let lanes = [
            D.Lane(
                id: "queen-1",
                changes: [
                    D.DeclarationChange(symbol: "Lib.describe(count:)",
                                        path: "Sources/Lib.swift",
                                        before: same, after: same)
                ],
                references: []
            ),
            D.Lane(
                id: "queen-2",
                changes: [],
                references: [
                    D.Reference(symbol: "Lib.describe(count:)",
                                path: "Sources/App.swift", expects: same)
                ]
            )
        ]
        check(
            QueenInterfaceDivergence.verdict(between: lanes) == .clear,
            "no shape changed, so no call can be stale"
        )
    }

    static func newCallAgainstNewShapeIsClear() {
        scenario("a second lane's call written against the new shape is clear")

        typealias D = QueenInterfaceDivergence
        let after = D.Signature(parameters: ["name: String"], returns: "String?")
        let lanes = [
            D.Lane(
                id: "queen-1",
                changes: [
                    D.DeclarationChange(symbol: "Lib.greet(name:)",
                                        path: "Sources/Lib.swift",
                                        before: D.Signature(parameters: ["name: String"],
                                                            returns: "String"),
                                        after: after)
                ],
                references: []
            ),
            D.Lane(
                id: "queen-2",
                changes: [],
                references: [
                    D.Reference(symbol: "Lib.greet(name:)",
                                path: "Sources/Caller.swift", expects: after)
                ]
            )
        ]
        check(
            QueenInterfaceDivergence.verdict(between: lanes) == .clear,
            "the overlay matches the call; nothing is stale"
        )
    }

    static func twoLanesChangedOneDeclaration() {
        scenario("two lanes changing one declaration to different shapes")

        typealias D = QueenInterfaceDivergence
        let optionalReturn = D.Signature(parameters: [], returns: "String?")
        let arrayReturn = D.Signature(parameters: [], returns: "[String]")
        let lanes = [
            D.Lane(
                id: "queen-1",
                changes: [
                    D.DeclarationChange(symbol: "Lib.names()", path: "Sources/Lib.swift",
                                        before: D.Signature(parameters: [], returns: "String"),
                                        after: optionalReturn)
                ],
                references: []
            ),
            D.Lane(
                id: "queen-2",
                changes: [
                    D.DeclarationChange(symbol: "Lib.names()", path: "Sources/Lib.swift",
                                        before: D.Signature(parameters: [], returns: "String"),
                                        after: arrayReturn)
                ],
                references: []
            )
        ]
        let verdict = QueenInterfaceDivergence.verdict(between: lanes)
        check(verdict.isDivergent, "one declaration cannot carry both shapes")
        guard case let .divergent(findings) = verdict,
              case .twoLanesChangedOneDeclaration = findings[0] else {
            check(false, "the finding is the two-owners kind")
            return
        }
        check(
            findings[0].summary.contains("queen-1")
                && findings[0].summary.contains("queen-2"),
            "the finding names both changers"
        )
    }

    // MARK: the revert proof

    /// The pre-#1111 loop, restated on facts so the suite can run it: each
    /// lane judged ALONE - its references against the base overlaid with
    /// its OWN changes and nothing else. Nothing crosses a lane boundary,
    /// which is exactly how #1110 and #1109 each looked correct while the
    /// pair did not compose.
    ///
    /// This executable stand-in exists so the claim "the check breaks if
    /// the former behaviour returns" is demonstrated rather than asserted:
    /// the scenario below feeds the incident pair to BOTH decisions and
    /// they disagree. Revert `verdict(between:)` to the judgement below -
    /// the literal former behaviour - and the incident scenario above fails
    /// its first check. That failure is the break; this function is the
    /// proof the incident data is one the two decisions split on, which is
    /// what mutation would have to erase to pass unnoticed.
    static func formerIsolatedVerdict(
        between lanes: [QueenInterfaceDivergence.Lane]
    ) -> QueenInterfaceDivergence.Verdict {
        typealias D = QueenInterfaceDivergence
        var findings: [D.Finding] = []
        for lane in lanes {
            let ownOverlay = Dictionary(
                uniqueKeysWithValues: lane.changes.map { ($0.symbol, $0) })
            for reference in lane.references {
                guard let change = ownOverlay[reference.symbol],
                      change.changedShape else { continue }
                if reference.expects != change.after {
                    findings.append(.staleCall(
                        symbol: reference.symbol,
                        changedBy: lane.id,
                        declaredIn: change.path,
                        calledBy: lane.id,
                        calledFrom: reference.path,
                        expected: reference.expects,
                        found: change.after
                    ))
                }
            }
        }
        return findings.isEmpty ? .clear : .divergent(findings: findings)
    }

    static func theRevertProof() {
        scenario("returning the former behaviour breaks the check")

        // On the incident pair, the former behaviour says clear: every lane
        // is internally consistent, which is all it ever asked.
        check(
            formerIsolatedVerdict(between: incidentLanes()) == .clear,
            "the former behaviour (each lane alone) accepts the incident pair"
        )

        // And the rule says divergent. One pair of lanes, two decisions,
        // one disagreement - so the incident assertion cannot survive the
        // rule being reverted to the former judgement: with that judgement
        // in place, the check above it fails. The check breaks.
        check(
            QueenInterfaceDivergence.verdict(between: incidentLanes()).isDivergent,
            "the rule refuses the same pair the former behaviour accepted"
        )

        // The discrimination runs both ways: a rule that refused EVERYTHING
        // would also "catch" the incident, so the compatible cases above
        // (one owner, body-only, new call) are what keep that lie from
        // passing. They already ran; this note says why they are here.
    }

    // MARK: entry

    /// The driver's one call. Runs every scenario, prints the summary, and
    /// ends in `fatalError` when anything failed, so a red run is loud and
    /// non-zero on every platform.
    static func main() {
        theIncidentItself()
        oneOwnerUpdatedBothSides()
        bodyOnlyChangeIsClear()
        newCallAgainstNewShapeIsClear()
        twoLanesChangedOneDeclaration()
        theRevertProof()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 {
            fatalError(
                "SELFTEST FAILED: \(failures) of \(checks) checks failed - "
                    + "see the FAIL lines above"
            )
        }
        print("SELFTEST PASSED")
    }
}

#endif
