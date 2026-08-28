// Standalone unit tests for QueenT27Acceptance - the rule that decides whether
// work which touched a `.t27` spec may be accepted.
//
// The architecture document's gap table carries a P0 row, "Queen/T27 bridge -
// Queen emits and reviews T27 mission/spec deltas". Measured in the live
// registry on 2026-08-28: 10 of 59 delegated tasks own a `.t27` path, and
// #1280 on rings/T27-00/queen_core.t27 reached `accepted` on the evidence that
// one file was committed. Acceptance read the file count, never the spec.
//
// It could not have read the spec usefully either, because "it still parses"
// proves nothing: t27c recovers from a statement it cannot parse by skipping
// it, then exits 0 with empty stderr (gHashTag/t27#2508). What proves something
// is counting - functions declared against functions emitted, emptied bodies,
// the artifact against a fresh generation, and rustc on the result.
//
// The two rules that needed the most care are here in full: the compile ratchet
// (a gate that refuses work for a defect the work did not cause gets switched
// off, and then it protects nothing) and the declared backend shortfall
// (auto_config.t27 loses two functions to C by design and must stay
// acceptable).
//
// Run (from trios root):
//   DEVELOPER_DIR=/Library/Developer/CommandLineTools xcrun swiftc \
//     tests/swift/queen_t27_acceptance_test.swift \
//     rings/SR-00/QueenT27Acceptance.swift \
//     -o /tmp/bridge-t27-acceptance/probe \
//     && /tmp/bridge-t27-acceptance/probe

import Foundation

@main
enum QueenT27AcceptanceTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func refuses(_ reason: String?, contains needles: [String], _ name: String) {
        checks += 1
        guard let reason else {
            failures += 1
            print("FAIL - \(name)\n         got:  nil (accepted)")
            return
        }
        let missing = needles.filter { !reason.contains($0) }
        if missing.isEmpty {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)\n         missing: \(missing)\n         reason:  \(reason)")
        }
    }

    static func accepts(_ reason: String?, _ name: String) {
        checks += 1
        if reason == nil {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)\n         refused: \(reason ?? "")")
        }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    typealias Acceptance = QueenT27Acceptance
    typealias Spec = QueenT27Acceptance.SpecMeasurement
    typealias Backend = QueenT27Acceptance.BackendEmission
    typealias Artifact = QueenT27Acceptance.Artifact
    typealias Work = QueenT27Acceptance.Work

    /// The real #1280 spec as it measures today: 7 declared, 7 emitted by
    /// gen-rust and by gen, no stubs, no committed artifact, and the generated
    /// Rust compiles under `rustc --edition 2021 --crate-type lib`. Every
    /// scenario below is this, with exactly one thing changed.
    static let queenCorePath = "rings/T27-00/queen_core.t27"

    static func queenCore(
        rust: Int = 7,
        zig: Int = 7,
        stubs: Int = 0,
        artifacts: [Artifact] = [],
        compiles: Bool = true,
        compiledBefore: Bool? = true
    ) -> Spec {
        Spec(
            path: queenCorePath,
            declaredFunctions: 7,
            backends: [
                Backend(backend: "rust", emitted: rust),
                Backend(backend: "zig", emitted: zig),
            ],
            stubbedBodies: stubs,
            artifacts: artifacts,
            generatedRustCompiles: compiles,
            compiledBeforeChange: compiledBefore
        )
    }

    static func work(_ specs: [Spec], touched: [String]? = nil, now: Int? = nil) -> Work {
        Work(
            touchedPaths: touched ?? specs.map { $0.path },
            specs: specs,
            nocompileBaseline: 11,
            nocompileNow: now
        )
    }

    // MARK: - the policy knows when it has nothing to say

    static func outOfScope() {
        scenario("a task that touched no T27 spec is not this policy's business")

        accepts(
            Acceptance.refusal(for: Work(
                touchedPaths: [], specs: [], nocompileBaseline: 11
            )),
            "a task that touched nothing is accepted"
        )

        accepts(
            Acceptance.refusal(for: Work(
                touchedPaths: [
                    "rings/SR-00/QueenDelegation.swift",
                    "tests/swift/queen_delegation_test.swift",
                    "docs/par-a.md",
                ],
                specs: [],
                nocompileBaseline: 11
            )),
            "a Swift and docs change is accepted without any T27 measurement"
        )

        // The corpus rule must not fire on a task with no T27 involvement at
        // all: eleven files not compiling is the standing state of the tree,
        // and a Swift change is not answerable for it.
        accepts(
            Acceptance.refusal(for: Work(
                touchedPaths: ["rings/SR-00/QueenObserver.swift"],
                specs: [],
                nocompileBaseline: 11,
                nocompileNow: 12
            )),
            "a Swift-only change is not answerable for the corpus count"
        )

        check(
            Acceptance.isSpecPath("rings/T27-00/queen_core.t27")
                && Acceptance.isSpecPath("./rings/T27-01/A2A.T27")
                && !Acceptance.isSpecPath("rings/SR-00/Queen.swift")
                && !Acceptance.isSpecPath("docs/t27-notes.md"),
            "a spec is recognised by extension, case-insensitively"
        )

        check(
            Acceptance.touchedSpecs(in: [
                "rings/SR-00/Queen.swift", queenCorePath, "gen/queen_core.rs",
            ]) == [queenCorePath],
            "touchedSpecs picks out the spec and leaves the artifact and the Swift"
        )
    }

    // MARK: - silent deletion, the defect the bridge exists for

    static func functionShortfall() {
        scenario("a spec that emits fewer functions than it declares is refused")

        accepts(
            Acceptance.refusal(for: work([queenCore()])),
            "queen_core.t27 as it measures today, 7 declared and 7 emitted, is accepted"
        )

        refuses(
            Acceptance.refusal(for: work([queenCore(rust: 5)])),
            contains: [queenCorePath, "7", "5", "rust", "2508"],
            "5 emitted of 7 declared is refused, naming the spec, both counts and the bug"
        )

        refuses(
            Acceptance.refusal(for: work([queenCore(zig: 6)])),
            contains: ["zig", "6"],
            "the refusal names WHICH backend lost the function"
        )

        // trust_manager.t27, the measurement that caused `make t27-lowering` to
        // be written: 21 declared, 12 emitted, nine gone for as long as the
        // spec had existed.
        refuses(
            Acceptance.structuralRefusal(spec: Spec(
                path: "rings/T27-02/trust_manager.t27",
                declaredFunctions: 21,
                backends: [Backend(backend: "rust", emitted: 12)]
            )),
            contains: ["21", "12", "9 were dropped"],
            "trust_manager.t27's 21-against-12 is refused and says nine were dropped"
        )

        // Backends that emit MORE than the spec declares do it by design: the
        // Verilog backend adds a wrapper, the C backend emits the spec's test
        // blocks. Refusing that would refuse correct work.
        accepts(
            Acceptance.structuralRefusal(spec: Spec(
                path: queenCorePath,
                declaredFunctions: 7,
                backends: [
                    Backend(backend: "verilog", emitted: 8),
                    Backend(backend: "c", emitted: 11),
                ]
            )),
            "a backend emitting more than declared is not silent deletion"
        )

        // auto_config.t27: 19 declared, C emits 17, because create_backup and
        // create_default_config return [u32; MAX_PARAMS] by value and C cannot
        // return an array by value. Declared in T27_LOWERING_EXCEPT.
        accepts(
            Acceptance.structuralRefusal(spec: Spec(
                path: "rings/T27-03/auto_config.t27",
                declaredFunctions: 19,
                backends: [
                    Backend(backend: "rust", emitted: 19),
                    Backend(backend: "zig", emitted: 19),
                    Backend(backend: "c", emitted: 17, declaredShortfall: 2),
                ]
            )),
            "a declared backend limitation does not refuse the task that touched it"
        )

        refuses(
            Acceptance.structuralRefusal(spec: Spec(
                path: "rings/T27-03/auto_config.t27",
                declaredFunctions: 19,
                backends: [Backend(backend: "c", emitted: 16, declaredShortfall: 2)]
            )),
            contains: ["T27_LOWERING_EXCEPT", "2 of that shortfall", "1 is not"],
            "one function past the declared allowance is refused as undeclared"
        )
    }

    // MARK: - the emptied body the count cannot see

    static func emptiedBodies() {
        scenario("any unimplemented!() is refused")

        refuses(
            Acceptance.refusal(for: work([queenCore(stubs: 1)])),
            contains: [queenCorePath, "unimplemented!()", "empty-body fallback"],
            "one emptied body is refused and named as the fallback, not a stub"
        )

        // The whole reason this is a separate rule: the counts agree. A spec
        // can keep every function and lose every body.
        check(
            Acceptance.shortfallRefusal(spec: queenCore(stubs: 3)) == nil
                && Acceptance.stubRefusal(spec: queenCore(stubs: 3)) != nil,
            "a spec with full counts and emptied bodies passes the count and fails here"
        )

        refuses(
            Acceptance.stubRefusal(spec: queenCore(stubs: 3)),
            contains: ["3 `unimplemented!()` bodies"],
            "the count of emptied bodies is in the message, pluralised"
        )

        accepts(
            Acceptance.stubRefusal(spec: queenCore(stubs: 0)),
            "no stubs is no refusal"
        )
    }

    // MARK: - the artifact that is not what the spec generates

    static func artifactDrift() {
        scenario("a committed artifact that differs from a fresh generation is refused")

        refuses(
            Acceptance.refusal(for: work([queenCore(artifacts: [
                Artifact(path: "rings/T27-00/gen/queen_core.rs", matchesFreshGeneration: false),
            ])])),
            contains: ["rings/T27-00/gen/queen_core.rs", queenCorePath, "L0"],
            "an artifact that is not a fresh generation is refused, naming both files"
        )

        accepts(
            Acceptance.refusal(for: work([queenCore(artifacts: [
                Artifact(path: "rings/T27-00/gen/queen_core.rs", matchesFreshGeneration: true),
                Artifact(path: "rings/T27-00/gen/queen_core.zig", matchesFreshGeneration: true),
            ])])),
            "artifacts that match a fresh generation are accepted"
        )

        accepts(
            Acceptance.refusal(for: work([queenCore()])),
            "a ring that commits no artifact - T27-00 today - has no drift to report"
        )

        // The L0 case with no spec in the diff at all: a generated file was
        // hand-edited and its `.t27` was left alone, so `touchedPaths` holds no
        // spec. Returning nil here would be the hole this rule exists to close.
        refuses(
            Acceptance.refusal(for: Work(
                touchedPaths: ["rings/T27-00/gen/queen_core.rs"],
                specs: [queenCore(artifacts: [
                    Artifact(
                        path: "rings/T27-00/gen/queen_core.rs",
                        matchesFreshGeneration: false
                    ),
                ])],
                nocompileBaseline: 11
            )),
            contains: ["gen/queen_core.rs", "hand edit"],
            "editing a generated file without its spec is still refused"
        )
    }

    // MARK: - the ratchet, written narrowly on purpose

    static func compileRatchet() {
        scenario("the compile rule is a ratchet: it refuses regressions, not inheritances")

        // The rule that decides whether this gate survives contact with the
        // corpus. Eleven of seventy generated Rust files do not compile today,
        // chiefly because gen-rust never emits `mut` on a function parameter -
        // upstream of this repository entirely.
        accepts(
            Acceptance.refusal(for: work([
                queenCore(compiles: false, compiledBefore: false),
            ])),
            "a spec that did not compile before and does not now is accepted unchanged"
        )

        refuses(
            Acceptance.refusal(for: work([
                queenCore(compiles: false, compiledBefore: true),
            ])),
            contains: [queenCorePath, "did before this change", "--crate-type lib"],
            "a spec that compiled before and does not now is refused as a regression"
        )

        refuses(
            Acceptance.refusal(for: work([
                queenCore(compiles: false, compiledBefore: nil),
            ])),
            contains: ["is new", "11"],
            "a new spec whose Rust does not compile is refused against the baseline"
        )

        accepts(
            Acceptance.refusal(for: work([queenCore(compiles: true, compiledBefore: nil)])),
            "a new spec that compiles is accepted"
        )

        accepts(
            Acceptance.refusal(for: work([queenCore(compiles: true, compiledBefore: false)])),
            "repairing a spec that did not compile is accepted, obviously"
        )

        // A dropped function usually causes the compile failure and is always
        // the more actionable sentence, so it is reported first.
        refuses(
            Acceptance.refusal(for: work([
                queenCore(rust: 4, compiles: false, compiledBefore: true),
            ])),
            contains: ["were dropped"],
            "when a spec both drops functions and stops compiling, the drop is named"
        )

        scenario("the corpus half of the ratchet")

        accepts(
            Acceptance.refusal(for: work([queenCore()], now: 11)),
            "leaving the corpus count at the baseline is accepted, baseline not being zero"
        )

        accepts(
            Acceptance.refusal(for: work([queenCore()], now: 9)),
            "lowering the corpus count is accepted"
        )

        refuses(
            Acceptance.refusal(for: work([queenCore()], now: 13)),
            contains: ["13", "11", "ratchet", "which 2 are new"],
            "raising the corpus count is refused, naming both numbers and the difference"
        )

        // The case the per-spec rule cannot see: every touched spec is fine and
        // the count still went up, because the change regenerated artifacts for
        // specs it never named - tri-net 2257dea moved eighteen in one commit.
        refuses(
            Acceptance.refusal(for: work([queenCore()], now: 12)),
            contains: ["12", "above the recorded baseline"],
            "a corpus rise is refused even when every touched spec compiles"
        )

        accepts(
            Acceptance.refusal(for: work([queenCore()], now: nil)),
            "an unmeasured corpus skips only the corpus rule"
        )

        check(
            Acceptance.corpusRefusal(now: 0, baseline: 0) == nil
                && Acceptance.corpusRefusal(now: 1, baseline: 0) != nil,
            "a zero baseline is honoured rather than treated as absent"
        )
    }

    // MARK: - nothing measured is not nothing wrong

    static func unmeasured() {
        scenario("a touched spec with no measurement is refused, not waved through")

        refuses(
            Acceptance.refusal(for: Work(
                touchedPaths: [queenCorePath],
                specs: [],
                nocompileBaseline: 11
            )),
            contains: [queenCorePath, "make t27-lowering", "exits 0"],
            "a spec nobody measured is refused and told which command measures it"
        )

        refuses(
            Acceptance.refusal(for: Work(
                touchedPaths: [queenCorePath, "rings/T27-01/a2a.t27"],
                specs: [queenCore()],
                nocompileBaseline: 11
            )),
            contains: ["rings/T27-01/a2a.t27"],
            "the unmeasured spec is named, not the measured one beside it"
        )

        // Touched paths reach here from git or from a worker's tool calls and
        // may still carry a worktree prefix; the measurements are keyed by the
        // path the generator was pointed at. rings/ holds 70 specs and no two
        // share a basename (2026-08-28), so one name matches one measurement.
        accepts(
            Acceptance.refusal(for: Work(
                touchedPaths: [
                    "/Users/playra/BrowserOS/trios/.worktrees/prod/queen-1280/trios/"
                        + "rings/T27-00/queen_core.t27",
                ],
                specs: [queenCore()],
                nocompileBaseline: 11
            )),
            "an unreduced worktree path still finds its measurement by basename"
        )

        check(
            Acceptance.measurement(for: "./" + queenCorePath, among: [queenCore()]) != nil
                && Acceptance.measurement(
                    for: "rings/T27-09/other.t27", among: [queenCore()]
                ) == nil,
            "matching ignores a leading ./ and does not match a different spec"
        )

        // Two measurements sharing a basename is a guess, and a guess would
        // either excuse an unmeasured spec or refuse a sound one.
        check(
            Acceptance.measurement(
                for: "some/other/queen_core.t27",
                among: [queenCore(), Spec(
                    path: "rings/T27-09/queen_core.t27",
                    declaredFunctions: 1,
                    backends: [Backend(backend: "rust", emitted: 1)]
                )]
            ) == nil,
            "an ambiguous basename is not matched at all"
        )
    }

    // MARK: - the first refusal names the file that stopped it

    static func firstRefusalWins() {
        scenario("one refusal at a time, naming the spec that caused it")

        refuses(
            Acceptance.refusal(for: work([
                queenCore(),
                Spec(
                    path: "rings/T27-01/a2a.t27",
                    declaredFunctions: 12,
                    backends: [Backend(backend: "rust", emitted: 9)]
                ),
            ])),
            contains: ["rings/T27-01/a2a.t27", "12", "9"],
            "a good spec beside a broken one does not hide the broken one"
        )

        accepts(
            Acceptance.refusal(for: work([
                queenCore(),
                Spec(
                    path: "rings/T27-01/a2a.t27",
                    declaredFunctions: 12,
                    backends: [
                        Backend(backend: "rust", emitted: 12),
                        Backend(backend: "zig", emitted: 12),
                    ],
                    compiledBeforeChange: false
                ),
                ], now: 11)),
            "two sound specs and a corpus at the baseline is an acceptance"
        )
    }

    static func main() {
        outOfScope()
        functionShortfall()
        emptiedBodies()
        artifactDrift()
        compileRatchet()
        unmeasured()
        firstRefusalWins()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
    }
}
