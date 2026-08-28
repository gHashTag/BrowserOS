// Standalone unit tests for QueenMissionContract - section 11.1's mission
// contract, and the validator that refuses one nothing can check.
//
// The plan document marks "Queen/T27 bridge" P0 and "[not demonstrated]".
// Measured in .trinity/state/queen_delegation.json on 2026-08-28 that is out of
// date: of 59 delegated tasks 10 carry a .t27 owned path, and #1280 on
// rings/T27-00/queen_core.t27 reached 'accepted'. The Queen already delegates
// spec work and already accepts it. What is missing is the contract - there is
// no .trinity/missions directory and nothing under rings/ holding one - so
// acceptance treats a .t27 spec exactly like a Swift file.
//
// The half worth testing is the refusal. t27c's parser answers
// `Err(_) => recover_to_stmt_boundary()` for anything it cannot parse, exit 0,
// empty stderr (gHashTag/t27#2508), so "the spec still parses" proves nothing;
// trust_manager.t27 declared 21 functions and emitted 12. A contract that names
// a backend nobody runs, or a spec `make t27-lowering` never finds, reads
// exactly like one that can be measured. These checks are the difference.
//
// Run (from trios root):
//   DEVELOPER_DIR=/Library/Developer/CommandLineTools xcrun swiftc \
//     tests/swift/queen_mission_contract_test.swift \
//     rings/SR-00/QueenMissionContract.swift \
//     -o /tmp/bridge-mission-contract/probe && /tmp/bridge-mission-contract/probe

import Foundation

@main
enum QueenMissionContractTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func equal(_ got: String, _ want: String, _ name: String) {
        checks += 1
        if got == want {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)\n         got:  \(got)\n         want: \(want)")
        }
    }

    static func equal(_ got: [String], _ want: [String], _ name: String) {
        equal(got.joined(separator: "|"), want.joined(separator: "|"), name)
    }

    static func equal(_ got: Int, _ want: Int, _ name: String) {
        equal(String(got), String(want), name)
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    /// True when `found` carries a refusal of the same kind as `want`,
    /// comparing the case and not the message.
    static func carries(
        _ found: [MissionContractRefusal],
        _ want: MissionContractRefusal
    ) -> Bool {
        found.contains { same($0, want) }
    }

    static func same(
        _ lhs: MissionContractRefusal,
        _ rhs: MissionContractRefusal
    ) -> Bool {
        switch (lhs, rhs) {
        case (.missingIdentifier, .missingIdentifier),
             (.missingObjective, .missingObjective),
             (.missingRepository, .missingRepository),
             (.noOwnedPaths, .noOwnedPaths),
             (.noSourceOfTruthSpec, .noSourceOfTruthSpec),
             (.noRequiredBackends, .noRequiredBackends),
             (.noAcceptanceCriteria, .noAcceptanceCriteria),
             (.sourceOfTruthIsNotASpec, .sourceOfTruthIsNotASpec),
             (.sourceOfTruthNotOwned, .sourceOfTruthNotOwned),
             (.sourceOfTruthOutsideLoweringGate, .sourceOfTruthOutsideLoweringGate),
             (.unrunnableBackend, .unrunnableBackend),
             (.unenforceableProhibition, .unenforceableProhibition),
             (.prohibitionOutOfReach, .prohibitionOutOfReach):
            return true
        default:
            return false
        }
    }

    // MARK: - Fixtures

    // Verbatim from .trinity/state/queen_delegation.json, the record for the
    // one T27 task that reached 'accepted'.
    static let issue1280 = 1280
    static let title1280 = "RING-00: the decision core in T27, generating valid Rust"
    static let ownedPaths1280 = ["rings/T27-00/queen_core.t27"]
    static let acceptance1280 = [
        "`t27c gen-rust rings/T27-00/queen_core.t27` produces Rust that compiles under `rustc --crate-type lib` with no errors.",
        "The module is named: generated Verilog is called `queen_core`, not `unknown`.",
        "Four decisions are covered: retry, review, merge gate, capacity.",
        "No floating point anywhere in the ring."
    ]

    static func lifted1280() -> MissionContract {
        QueenMissionContract.lift(
            issue: issue1280,
            title: title1280,
            repository: "gHashTag/trios",
            ownedPaths: ownedPaths1280,
            acceptanceCriteria: acceptance1280
        )
    }

    // MARK: - Lifting a delegation that exists

    static func liftingTheAcceptedTask() {
        scenario("#1280 lifts into a contract with nothing invented")

        let contract = lifted1280()

        equal(contract.id, "Q-1280", "the id is the issue number, not a second serial")
        equal(contract.issue, 1280, "the issue is carried as a field, not parsed back out of the id")
        equal(contract.objective, title1280, "the objective is the issue title, unchanged")
        equal(contract.repository, "gHashTag/trios", "the repository is carried through")
        equal(
            contract.sourceOfTruth.spec, "rings/T27-00/queen_core.t27",
            "the one .t27 among the owned paths is the source of truth"
        )
        equal(
            contract.requiredBackends, ["rust", "verilog"],
            "the backends are read out of the criteria that name them, and no others"
        )
        equal(contract.acceptance.count, 4, "every acceptance criterion survives")
        equal(contract.invariants, [], "invariants are prose the Queen does not have, so none are invented")
        equal(contract.ownedPaths, ownedPaths1280, "the boundary is carried through")

        check(
            contract.prohibited.contains("hand-edit generated files"),
            "L0 is transcribed into the contract: generated files are artifacts"
        )
        check(
            contract.prohibited.contains("change golden outputs without semantic approval"),
            "queen_core.t27 is the spec make chain has a twin for, so the golden clause applies"
        )
        check(
            QueenMissionContract.isCheckable(contract),
            "the lifted contract can be checked end to end"
        )
        check(
            QueenMissionContract.refusalReport(contract) == nil,
            "a checkable contract produces no refusal report"
        )
        equal(
            QueenMissionContract.fileName(for: contract), "Q-1280.json",
            "the contract is written beside its task under its id"
        )
    }

    static func liftInventsNothing() {
        scenario("the lift refuses to guess what the delegation does not say")

        // 49 of the 59 registry tasks look like this: Swift work, no spec.
        let swiftOnly = QueenMissionContract.lift(
            issue: 1286,
            title: "The boundary check compares a worktree path with a project path",
            repository: "gHashTag/trios",
            ownedPaths: ["rings/SR-00/QueenBoundaryPaths.swift"],
            acceptanceCriteria: ["The strays list is empty for a write inside the boundary."]
        )
        equal(
            swiftOnly.sourceOfTruth.spec, "",
            "a delegation with no .t27 gets no source of truth invented for it"
        )
        check(
            carries(QueenMissionContract.refusals(swiftOnly), .noSourceOfTruthSpec(ownedPaths: [])),
            "and is refused: a delegation is not a mission"
        )

        let twoSpecs = QueenMissionContract.lift(
            issue: 1284,
            title: "RING-01: the A2A protocol in T27",
            repository: "gHashTag/trios",
            ownedPaths: ["rings/T27-01/a2a.t27", "rings/T27-00/queen_core.t27"],
            acceptanceCriteria: ["`t27c gen-rust rings/T27-01/a2a.t27` produces Rust that compiles."]
        )
        equal(
            twoSpecs.sourceOfTruth.spec, "",
            "two owned specs leave the source of truth empty rather than picking one"
        )
        let ambiguous = QueenMissionContract.refusals(twoSpecs)
        check(
            carries(ambiguous, .noSourceOfTruthSpec(ownedPaths: [])),
            "and the contract is refused"
        )
        check(
            ambiguous.first { same($0, .noSourceOfTruthSpec(ownedPaths: [])) }?
                .message.contains("2 of the owned paths are specs") ?? false,
            "the message says it was ambiguity, not absence"
        )

        let untitled = QueenMissionContract.lift(
            issue: 7, title: "  \n ", repository: " ",
            ownedPaths: [" rings/T27-00/queen_core.t27 ", "", "  "],
            acceptanceCriteria: ["", "   "]
        )
        equal(
            untitled.ownedPaths, ["rings/T27-00/queen_core.t27"],
            "blank owned paths are dropped and the rest are trimmed"
        )
        equal(untitled.acceptance, [], "a blank line is not an acceptance criterion")
        let thin = QueenMissionContract.refusals(untitled)
        check(carries(thin, .missingObjective), "an empty title is refused as a missing objective")
        check(carries(thin, .missingRepository), "an empty repository is refused")
        check(carries(thin, .noAcceptanceCriteria), "no acceptance criteria is refused")
        check(carries(thin, .noRequiredBackends), "no backend named anywhere is refused")
        check(
            thin.count == 4,
            "and nothing else: the spec was owned, a .t27, and inside the lowering gate"
        )
    }

    // MARK: - Backends

    static func backendNames() {
        scenario("a backend is a name something in this tree can run")

        check(MissionBackend.named("rust") == .rust, "rust runs")
        check(MissionBackend.named("zig") == .zig, "zig runs")
        check(MissionBackend.named("c") == .c, "c runs")
        check(MissionBackend.named("verilog") == .verilog, "verilog runs")
        check(MissionBackend.named(" Verilog ") == .verilog, "case and padding do not change the answer")
        check(
            MissionBackend.named("gen-rust") == .rust,
            "the generator subcommand is accepted, because that is how the criteria write it"
        )
        check(MissionBackend.named("gen") == .zig, "bare gen is zig, the backend that never got a suffix")
        check(MissionBackend.named("cuda") == nil, "a backend nobody runs is not silently accepted")
        check(MissionBackend.named("systemverilog") == nil, "and neither is a plausible near-miss")
        check(MissionBackend.named("") == nil, "an empty name names nothing")
        equal(MissionBackend.allCases.count, 4, "four backends, the four make t27-lowering counts")
        equal(
            MissionBackend.c.generatorCommand, "t27c gen-c",
            "each backend names the command that generates it"
        )
    }

    static func backendsReadOutOfProse() {
        scenario("required backends come from the criteria, matched on whole tokens")

        equal(
            MissionBackend.mentioned(in: acceptance1280).map(\.rawValue),
            ["rust", "verilog"],
            "#1280 names gen-rust and generated Verilog, and nothing else"
        )
        check(
            !MissionBackend.mentioned(in: [
                "`t27c gen-rust rings/T27-00/queen_core.t27` compiles."
            ]).contains(.c),
            "t27c is not a mention of the C backend, and queen_core is not one either"
        )
        equal(
            MissionBackend.mentioned(in: ["golden vectors pass on C and RTL simulation"])
                .map(\.rawValue),
            ["c"],
            "a standalone C token is the C backend - the document's own wording"
        )
        equal(
            MissionBackend.mentioned(in: ["No floating point anywhere in the ring."])
                .map(\.rawValue),
            [],
            "a criterion naming no backend yields none rather than a default"
        )
        equal(
            MissionBackend.mentioned(in: ["verilog", "rust", "verilog"]).map(\.rawValue),
            ["rust", "verilog"],
            "repeats collapse and the order is the declaration order, so the lift is deterministic"
        )
    }

    // MARK: - Prohibitions

    static func prohibitionsAreRecognisedOrRefused() {
        scenario("a prohibition is enforceable only when something measures it")

        // Both entries in the document's own example.
        equal(
            MissionProhibition.recognised(in: "hand-edit generated files").map(\.rawValue),
            ["hand-edit-generated-artifacts"],
            "the document's first prohibited entry maps to exactly one clause"
        )
        equal(
            MissionProhibition.recognised(in: "change golden outputs without semantic approval")
                .map(\.rawValue),
            ["change-golden-outputs"],
            "and so does its second"
        )

        for prohibition in MissionProhibition.allCases {
            check(
                MissionProhibition.recognised(in: prohibition.canonicalPhrase) == [prohibition],
                "the canonical phrase for \(prohibition.rawValue) reads back as itself alone"
            )
            check(
                !prohibition.measurement.isEmpty,
                "\(prohibition.rawValue) names the measurement that decides it"
            )
        }

        equal(
            MissionProhibition.recognised(in: "be nice to the compiler").map(\.rawValue), [],
            "prose about the compiler that forbids nothing measurable is not a prohibition"
        )
        equal(
            MissionProhibition.recognised(in: "do not use floating point").map(\.rawValue), [],
            "a real rule with no gate behind it is still unenforceable here"
        )
        equal(
            MissionProhibition.recognised(in: "rewrite the generator").map(\.rawValue), [],
            "a legitimate compiler task is not read as a ban on editing artifacts"
        )
        // This one failed when the clause was keyed on "compil" and "generat",
        // and it is why shipUncompilableRust is keyed on the negation instead:
        // the criterion and the prohibition differ by the single token `not`.
        equal(
            MissionProhibition.recognised(in: "the generated Rust compiles").map(\.rawValue), [],
            "an acceptance criterion is a claim, not a prohibition"
        )
        equal(
            MissionProhibition.recognised(in: "generate Rust that does not compile")
                .map(\.rawValue),
            ["ship-uncompilable-rust"],
            "while its negation, one token away, is the prohibition"
        )
        equal(
            MissionProhibition.recognised(in: "ship Rust that fails to compile")
                .map(\.rawValue),
            ["ship-uncompilable-rust"],
            "and so is the same rule said with a different failure word"
        )
        equal(
            MissionProhibition.recognised(in: "delete a function the spec declares")
                .map(\.rawValue),
            ["drop-declared-functions"],
            "an inflection of the verb is still the same clause"
        )
    }

    static func prohibitionsMustApplyToThisContract() {
        scenario("a clause that names a real measurement may still not reach this spec")

        check(
            QueenMissionContract.applicabilityFault(
                of: .changeGoldenOutputs,
                spec: "rings/T27-00/queen_core.t27",
                ownedPaths: ["rings/T27-00/queen_core.t27"]
            ) == nil,
            "the golden clause applies to the one spec make chain has a twin for"
        )
        check(
            QueenMissionContract.applicabilityFault(
                of: .changeGoldenOutputs,
                spec: "rings/T27-01/a2a.t27",
                ownedPaths: ["rings/T27-01/a2a.t27"]
            ) != nil,
            "and to no other spec, because no other spec has a twin to disagree with"
        )
        check(
            QueenMissionContract.applicabilityFault(
                of: .writeOutsideOwnedPaths, spec: "rings/T27-01/a2a.t27", ownedPaths: []
            ) != nil,
            "the boundary clause needs a boundary: strays returns nothing for an empty one"
        )
        check(
            !QueenMissionContract.standingProhibitions(
                spec: "rings/T27-01/a2a.t27", ownedPaths: ["rings/T27-01/a2a.t27"]
            ).contains(.changeGoldenOutputs),
            "so the lift does not write a golden clause into a contract it cannot enforce"
        )
        equal(
            QueenMissionContract.standingProhibitions(
                spec: "rings/T27-00/queen_core.t27",
                ownedPaths: ["rings/T27-00/queen_core.t27"]
            ).count,
            MissionProhibition.allCases.count,
            "the chain spec carries every clause this tree can enforce"
        )

        var handWritten = lifted1280()
        handWritten.prohibited.append("keep the diff small")
        let refused = QueenMissionContract.refusals(handWritten)
        check(
            carries(refused, .unenforceableProhibition("")),
            "a hand-written clause nothing measures is refused"
        )
        check(
            refused.first { same($0, .unenforceableProhibition("")) }?
                .message.contains("hand-edit generated files") ?? false,
            "and the refusal lists what can be enforced, so it is repaired in one edit"
        )
    }

    // MARK: - The validator

    static func validatorRefusesTheUncheckable() {
        scenario("the validator refuses a contract acceptance could not decide")

        var noAcceptance = lifted1280()
        noAcceptance.acceptance = []
        check(
            carries(QueenMissionContract.refusals(noAcceptance), .noAcceptanceCriteria),
            "no acceptance criteria: acceptance would fall back to a committed SHA"
        )

        var unrunnable = lifted1280()
        unrunnable.requiredBackends = ["rust", "cuda"]
        let cuda = QueenMissionContract.refusals(unrunnable)
        check(carries(cuda, .unrunnableBackend("cuda")), "a backend nobody runs is refused")
        check(
            cuda.first { same($0, .unrunnableBackend("")) }?
                .message.contains("t27c gen-verilog") ?? false,
            "and the refusal names the four that are generated and counted"
        )

        var unowned = lifted1280()
        unowned.ownedPaths = ["rings/T27-01/a2a.t27"]
        check(
            carries(QueenMissionContract.refusals(unowned), .sourceOfTruthNotOwned(spec: "", ownedPaths: [])),
            "a source of truth outside the boundary is refused: the bee could not edit it"
        )

        var swiftSpec = lifted1280()
        swiftSpec.sourceOfTruth = MissionSourceOfTruth(spec: "rings/SR-00/QueenObserver.swift")
        swiftSpec.ownedPaths = ["rings/SR-00/QueenObserver.swift"]
        check(
            carries(QueenMissionContract.refusals(swiftSpec), .sourceOfTruthIsNotASpec("")),
            "a Swift file is not a source of truth a T27 measurement can start from"
        )

        var outsideRings = lifted1280()
        outsideRings.sourceOfTruth = MissionSourceOfTruth(spec: "specs/accumulator.t27")
        outsideRings.ownedPaths = ["specs/accumulator.t27"]
        let unfound = QueenMissionContract.refusals(outsideRings)
        check(
            carries(unfound, .sourceOfTruthOutsideLoweringGate("")),
            "a spec make t27-lowering never finds carries unmeasured backend claims"
        )
        check(
            unfound.first { same($0, .sourceOfTruthOutsideLoweringGate("")) }?
                .message.contains("find $(ROOT)/rings") ?? false,
            "and the refusal quotes the find that decides it"
        )

        var noBoundary = lifted1280()
        noBoundary.ownedPaths = []
        let unbounded = QueenMissionContract.refusals(noBoundary)
        check(carries(unbounded, .noOwnedPaths), "a contract with no boundary is refused")
        check(
            carries(unbounded, .sourceOfTruthNotOwned(spec: "", ownedPaths: [])),
            "and its source of truth is outside that empty boundary too"
        )

        var anonymous = lifted1280()
        anonymous.id = ""
        check(
            carries(QueenMissionContract.refusals(anonymous), .missingIdentifier),
            "a contract with no id has no file name to be written under"
        )

        check(
            QueenMissionContract.refusals(lifted1280()).isEmpty,
            "and the contract lifted from the accepted task is refused for nothing"
        )
    }

    static func everyReasonAtOnce() {
        scenario("every reason is reported, not the first")

        let broken = MissionContract(
            id: "",
            issue: 0,
            objective: "",
            repository: "",
            sourceOfTruth: MissionSourceOfTruth(spec: ""),
            requiredBackends: [],
            invariants: [],
            acceptance: [],
            ownedPaths: [],
            prohibited: ["keep the diff small"]
        )
        let found = QueenMissionContract.refusals(broken)
        check(carries(found, .missingIdentifier), "the id is reported")
        check(carries(found, .missingObjective), "the objective is reported")
        check(carries(found, .missingRepository), "the repository is reported")
        check(carries(found, .noOwnedPaths), "the boundary is reported")
        check(carries(found, .noSourceOfTruthSpec(ownedPaths: [])), "the source of truth is reported")
        check(carries(found, .noRequiredBackends), "the backends are reported")
        check(carries(found, .noAcceptanceCriteria), "the acceptance criteria are reported")
        check(
            carries(found, .unenforceableProhibition("")),
            "the prohibition is reported"
        )
        equal(found.count, 8, "eight defects, eight refusals, one round trip")

        // A missing spec must not also produce three cascading complaints about
        // the spec it does not have.
        check(
            !carries(found, .sourceOfTruthIsNotASpec("")),
            "an absent spec is not also reported as the wrong kind of file"
        )
        check(
            !carries(found, .sourceOfTruthOutsideLoweringGate("")),
            "nor as being outside the lowering gate"
        )

        let report = QueenMissionContract.refusalReport(broken) ?? ""
        check(report.contains("cannot be checked"), "the report says why it stopped")
        equal(
            report.components(separatedBy: "\n  - ").count - 1, 8,
            "and carries one line per refusal"
        )
    }

    static func theDocumentsOwnExample() {
        scenario("the example in section 11.1, as written, is refused for one reason")

        let example = MissionContract(
            id: "Q-2026-0001",
            issue: 1,
            objective: "Implement a bounded ternary accumulator",
            repository: "...",
            sourceOfTruth: MissionSourceOfTruth(spec: "specs/accumulator.t27"),
            requiredBackends: ["c", "verilog"],
            invariants: [
                "accumulator remains within configured width",
                "reset produces zero"
            ],
            acceptance: [
                "semantic validation passes",
                "golden vectors pass on C and RTL simulation",
                "reproducibility manifest matches on two runners"
            ],
            ownedPaths: ["specs/accumulator.t27"],
            prohibited: [
                "hand-edit generated files",
                "change golden outputs without semantic approval"
            ]
        )
        let found = QueenMissionContract.refusals(example)
        equal(found.count, 2, "two refusals, both about where the spec lives")
        check(
            carries(found, .sourceOfTruthOutsideLoweringGate("")),
            "specs/accumulator.t27 is outside rings/, so no gate here measures it"
        )
        check(
            carries(found, .prohibitionOutOfReach("", reason: "")),
            "and its golden clause has no twin to diff against outside the chain spec"
        )
        check(
            !carries(found, .unenforceableProhibition("")),
            "which is a different refusal from one nothing measures, and repaired differently"
        )
        check(
            example.prohibited.allSatisfy { !MissionProhibition.recognised(in: $0).isEmpty },
            "both of the document's prohibited entries name a measurement that exists"
        )
        check(
            !MissionBackend.mentioned(in: example.acceptance).isEmpty,
            "and its acceptance criteria name a backend, so the lift would find one"
        )
    }

    // MARK: - Serialisation

    static func stableJSON() {
        scenario("the contract serialises to JSON that diffs cleanly")

        let contract = lifted1280()
        guard let text = try? QueenMissionContract.json(contract) else {
            check(false, "the contract encodes")
            return
        }

        check(
            text.contains("\"rings/T27-00/queen_core.t27\""),
            "paths are not escaped into rings\\/T27-00, which is the same string and an unreadable diff"
        )
        check(text.hasSuffix("}\n"), "the file ends in a newline, so diff stops complaining about it")
        check(
            text.contains("\"source_of_truth\"") && text.contains("\"required_backends\""),
            "the keys are the document's field names"
        )
        check(text.contains("\"owned_paths\""), "the boundary travels with the contract")

        let again = (try? QueenMissionContract.json(contract)) ?? ""
        equal(again, text, "encoding twice produces the same bytes")

        let keys = ["acceptance", "id", "invariants", "issue", "objective"]
        var lastIndex = text.startIndex
        var sorted = true
        for key in keys {
            guard let range = text.range(of: "\"\(key)\" :") ?? text.range(of: "\"\(key)\":") else {
                sorted = false
                break
            }
            if range.lowerBound < lastIndex { sorted = false; break }
            lastIndex = range.lowerBound
        }
        check(sorted, "keys are sorted by the encoder, not by the order the properties are declared in")

        guard let decoded = try? QueenMissionContract.contract(fromJSON: text) else {
            check(false, "the contract decodes")
            return
        }
        check(decoded == contract, "and round-trips unchanged")

        // The refusal must survive the file. A type that could not hold an
        // invalid contract could not refuse one, and the operator would get a
        // DecodingError with no measurement in it.
        var invalid = contract
        invalid.requiredBackends = ["cuda"]
        invalid.prohibited = ["keep the diff small"]
        guard let invalidText = try? QueenMissionContract.json(invalid),
              let readBack = try? QueenMissionContract.contract(fromJSON: invalidText) else {
            check(false, "an invalid contract still encodes and decodes")
            return
        }
        check(
            carries(QueenMissionContract.refusals(readBack), .unrunnableBackend("")),
            "an unrunnable backend survives the file and is refused by the validator, not the parser"
        )
        check(
            carries(QueenMissionContract.refusals(readBack), .unenforceableProhibition("")),
            "and so does an unenforceable prohibition"
        )
    }

    static func loweringGateReach() {
        scenario("loweringGateCovers repeats the gate's own find, exclusions included")

        check(
            QueenMissionContract.loweringGateCovers("rings/T27-00/queen_core.t27"),
            "a spec under rings/ is measured"
        )
        check(
            !QueenMissionContract.loweringGateCovers("specs/accumulator.t27"),
            "a spec outside rings/ is not"
        )
        check(
            !QueenMissionContract.loweringGateCovers("rings/T27-00/queen_core.swift"),
            "and neither is a file that is not a spec at all"
        )
        check(
            !QueenMissionContract.loweringGateCovers(
                "rings/RUST-13/trios-mesh/.claude/worktrees/x/specs/a.t27"
            ),
            "a copy inside .claude is excluded, as the gate excludes it - it scanned 138 specs once"
        )
        check(
            !QueenMissionContract.loweringGateCovers("rings/.worktrees/prod/queen-1/a.t27"),
            "and so is a worktree copy: a gate measures the tree that ships"
        )
        check(
            QueenMissionContract.isSpecPath("rings/T27-00/Queen_Core.T27"),
            "the extension is read case-insensitively"
        )
        check(!QueenMissionContract.isSpecPath("t27"), "and a bare word is not a spec path")
    }

    static func main() {
        liftingTheAcceptedTask()
        liftInventsNothing()
        backendNames()
        backendsReadOutOfProse()
        prohibitionsAreRecognisedOrRefused()
        prohibitionsMustApplyToThisContract()
        validatorRefusesTheUncheckable()
        everyReasonAtOnce()
        theDocumentsOwnExample()
        stableJSON()
        loweringGateReach()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
    }
}
