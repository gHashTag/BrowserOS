import Foundation

/// Section 11.1's mission contract, in the one form a gate can read.
///
/// The plan document (`Queen_T27_MVP_Architecture.md`) marks "Queen/T27 bridge"
/// P0 and "[not demonstrated]". Measured in `.trinity/state/queen_delegation.json`
/// on 2026-08-28, that row is out of date: of 59 delegated tasks, 10 carry a
/// `.t27` owned path, and #1280 on `rings/T27-00/queen_core.t27` reached
/// `accepted`. The Queen already delegates spec work and already accepts it.
///
/// What does not exist is the CONTRACT. There is no `.trinity/missions`
/// directory and nothing under `rings/` holding one, so nothing in this tree
/// says which backends a spec must lower into, or what may not be done to it.
/// Acceptance therefore treats a `.t27` spec exactly like a Swift file: files
/// were committed, a SHA was recorded, accept.
///
/// That is worse than it sounds, because the cheapest thing to check about a
/// spec proves nothing. `t27c`'s parser answers `Err(_) =>
/// recover_to_stmt_boundary()` for any statement it cannot parse - exit 0,
/// empty stderr, reported upstream as gHashTag/t27#2508. `trust_manager.t27`
/// declared 21 functions and emitted 12: nine had been silently gone, in this
/// repository, for as long as the spec existed. So "the spec still parses" is
/// not evidence. `make t27-lowering` is evidence - it counts functions
/// declared against functions emitted per backend, counts `unimplemented!()`
/// (the compiler's empty-body fallback, not a per-construct stub), and builds
/// the generated Rust with a full `rustc --edition 2021 --crate-type lib`,
/// because `--emit=metadata` skips MIR const-prop and hides every
/// `arithmetic_overflow` - `olsr_routing` reports 13 errors under metadata and
/// 26 under a full build.
///
/// The validator below is the half that matters. A contract that reads well
/// and cannot be checked is exactly the prose summary section 11.3 says may
/// accompany the structured form but never replace it, and it would arrive
/// wearing the structured form's clothes. So every refusal here names the
/// measurement that would have decided the question, and refuses when that
/// measurement does not exist or does not reach this contract's spec.
///
/// Deliberately NOT refused, and why:
///
/// - **Empty `invariants`.** 11.1's invariants are prose ("accumulator remains
///   within configured width"). Nothing measures them. Requiring one would
///   make every lifted contract carry an invented sentence, which is the
///   failure this file exists to stop, not an instance of checking.
/// - **Empty `prohibited`.** L0 (generated files are artifacts), L3 (everything
///   committed is English) and the path boundary bind whether or not a contract
///   restates them. A contract that omits them is thinner, not uncheckable.
/// - **The objective's language.** `QueenLanguagePolicy` already measures that,
///   by ratio, with its thresholds argued from a measured incident. A second
///   copy here would be two rules that agree until someone edits one.
/// - **Path shape.** `QueenBoundaryPaths.normalize` reduces the many spellings
///   a WORKER produces. A contract's spec is derived from its own owned paths,
///   so the two are byte-identical by construction; only a hand-written
///   contract can disagree, and for that a whitespace trim is enough.
///
/// Foundation and nothing else, so a suite can link this one file.
enum QueenMissionContract {
    /// The name a contract is written under beside its task, e.g. `Q-1280.json`.
    ///
    /// The directory is the caller's decision - this file knows no paths.
    static func fileName(for contract: MissionContract) -> String {
        "\(contract.id).json"
    }

    /// The spec `make chain` has a hand-written twin for.
    ///
    /// `chain` generates Rust from this one file, runs it, runs
    /// `QueenRetryPolicy` + `QueenReviewDecision` compiled as a Swift twin, and
    /// diffs the two verdict streams. No other spec in the tree has a twin to
    /// disagree with, which is why a "do not change golden outputs" clause is
    /// enforceable for this spec and for nothing else.
    static let goldenChainSpec = "rings/T27-00/queen_core.t27"

    /// Whether `make t27-lowering` would measure this spec at all.
    ///
    /// The gate's own find is `find "$(ROOT)/rings" -name '*.t27' -not -path
    /// '*/.worktrees/*' -not -path '*/.claude/*'`. Two consequences, both
    /// enforced below rather than assumed: a spec outside `rings/` - including
    /// `specs/accumulator.t27`, the path in the document's own example - is
    /// measured by nothing in this tree; and a spec named inside a worktree or
    /// a `.claude` copy is a copy of the tree that ships, which the gate
    /// excludes deliberately (an early version scanned 138 specs instead of 70
    /// and reported a defect that had already been fixed).
    static func loweringGateCovers(_ spec: String) -> Bool {
        let path = spec.trimmingCharacters(in: .whitespacesAndNewlines)
        guard path.hasPrefix("rings/"), isSpecPath(path) else { return false }
        return !path.contains("/.worktrees/") && !path.contains("/.claude/")
    }

    /// Whether a path names a T27 spec. Extension only, case-insensitively:
    /// deciding it by content would need the compiler this file must not link.
    static func isSpecPath(_ path: String) -> Bool {
        path.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasSuffix(".t27")
    }

    // MARK: - Lifting an existing delegation

    /// Builds a contract out of the four fields the Queen already holds for
    /// every delegated task, and invents nothing else.
    ///
    /// Field by field, and each choice is a refusal to guess:
    ///
    /// - `id` is `Q-<issue>`, not the document's `Q-2026-0001`. That serial is
    ///   a register nobody in this tree maintains, and a second register drifts
    ///   from the first. The issue number is already unique, and is what the
    ///   registry record, the virtual branch and `Closes #N` all name, so the
    ///   contract file and the task point at each other with nothing to sync.
    /// - `objective` is the issue title, flattened. Its language is not judged
    ///   here; see the note on `QueenLanguagePolicy` above.
    /// - `sourceOfTruth.spec` is the `.t27` among the owned paths when there is
    ///   exactly one. Zero or two leaves it empty, and the validator says which
    ///   of the two it was. 11.1's `spec:` is singular; picking one of two
    ///   would be the guess.
    /// - `requiredBackends` are read out of the acceptance criteria, because
    ///   that is the only place this Queen has ever named a backend. Measured
    ///   on #1280: criterion 1 names `t27c gen-rust`, criterion 2 says
    ///   "generated Verilog is called `queen_core`", so the lift yields
    ///   rust and verilog and no others. Over-reading a criterion that merely
    ///   mentions Rust makes acceptance stricter; under-reading yields an empty
    ///   list, which is refused rather than quietly unchecked. Both directions
    ///   fail loudly.
    /// - `invariants` is empty. The Queen has none, and see above.
    /// - `prohibited` is this repository's own law, which already binds the
    ///   task. Transcribing law is not inventing data; every entry installed
    ///   here is enforceable by construction, so a lifted contract never fails
    ///   the prohibition check - only a hand-written one can.
    ///
    /// A delegation with no `.t27` path lifts to a contract the validator
    /// refuses. That is the true answer: 49 of the 59 tasks in the registry are
    /// not spec-first missions, and dressing one as a mission would put the
    /// document's P0 row back where it started.
    static func lift(
        issue: Int,
        title: String,
        repository: String,
        ownedPaths: [String],
        acceptanceCriteria: [String]
    ) -> MissionContract {
        let owned = cleaned(ownedPaths)
        let specs = owned.filter(isSpecPath)
        let spec = specs.count == 1 ? specs[0] : ""
        let objective = title
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return MissionContract(
            id: "Q-\(issue)",
            issue: issue,
            objective: objective,
            repository: repository.trimmingCharacters(in: .whitespacesAndNewlines),
            sourceOfTruth: MissionSourceOfTruth(spec: spec),
            requiredBackends: MissionBackend.mentioned(in: acceptanceCriteria)
                .map(\.rawValue),
            invariants: [],
            acceptance: cleaned(acceptanceCriteria),
            ownedPaths: owned,
            prohibited: standingProhibitions(spec: spec, ownedPaths: owned)
                .map(\.canonicalPhrase)
        )
    }

    /// The prohibitions this tree can enforce for this spec and this boundary.
    ///
    /// Applicability is checked here rather than asserted: a clause about the
    /// golden chain is only enforceable for the one spec that has a twin, and a
    /// clause about the boundary is only enforceable when a boundary exists -
    /// `QueenBoundaryPaths.strays` returns nothing for an empty `ownedPaths`,
    /// because a task with no declared paths is not a task that owns
    /// everything.
    static func standingProhibitions(
        spec: String,
        ownedPaths: [String]
    ) -> [MissionProhibition] {
        MissionProhibition.allCases.filter { prohibition in
            applicabilityFault(
                of: prohibition, spec: spec, ownedPaths: ownedPaths
            ) == nil
        }
    }

    /// Why a recognised prohibition still cannot be enforced on this contract,
    /// or nil when it can.
    ///
    /// The four lowering clauses are absent from this switch on purpose. Their
    /// only applicability condition is that `make t27-lowering` reaches the
    /// spec, and a contract whose spec it does not reach is refused once, by
    /// `sourceOfTruthOutsideLoweringGate`. Repeating it per clause would print
    /// the same measurement five times and bury the other refusals.
    static func applicabilityFault(
        of prohibition: MissionProhibition,
        spec: String,
        ownedPaths: [String]
    ) -> String? {
        switch prohibition {
        case .changeGoldenOutputs:
            guard spec != goldenChainSpec else { return nil }
            return "`make chain` diffs the generated ring against the "
                + "hand-written twin for \(goldenChainSpec) only. No other spec "
                + "has a twin to disagree with, so for \(displayed(spec)) this "
                + "clause names no measurement."
        case .writeOutsideOwnedPaths:
            guard cleaned(ownedPaths).isEmpty else { return nil }
            return "the contract declares no owned paths, and "
                + "`QueenBoundaryPaths.strays` returns nothing for an empty "
                + "boundary - a task with no declared paths is not a task that "
                + "owns everything."
        case .handEditGeneratedArtifacts, .dropDeclaredFunctions,
             .emptyFunctionBodies, .shipUncompilableRust, .rewriteEnglishProse:
            return nil
        }
    }

    // MARK: - The validator

    /// Every reason this contract cannot be checked, in a fixed order.
    ///
    /// All of them, not the first. `QueenLanguagePolicy.rewriteRefusal` stops
    /// at the first staged file because the next one is a separate decision; a
    /// contract is one file repaired by one edit, and reporting one defect per
    /// round trip costs a round trip per defect for no benefit - the whole
    /// contract is in hand and every check is a string comparison.
    static func refusals(_ contract: MissionContract) -> [MissionContractRefusal] {
        var found: [MissionContractRefusal] = []
        let owned = cleaned(contract.ownedPaths)
        let spec = contract.sourceOfTruth.spec
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if contract.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            found.append(.missingIdentifier)
        }
        if contract.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            found.append(.missingObjective)
        }
        if contract.repository.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            found.append(.missingRepository)
        }
        if owned.isEmpty {
            found.append(.noOwnedPaths)
        }

        if spec.isEmpty {
            found.append(.noSourceOfTruthSpec(ownedPaths: owned))
        } else {
            // Three independent faults, all reported: a spec can be the wrong
            // kind of file AND outside the boundary AND outside the gate, and
            // an operator fixing one at a time learns that three times.
            if !isSpecPath(spec) {
                found.append(.sourceOfTruthIsNotASpec(spec))
            }
            if !owned.contains(spec) {
                found.append(.sourceOfTruthNotOwned(spec: spec, ownedPaths: owned))
            }
            if isSpecPath(spec), !loweringGateCovers(spec) {
                found.append(.sourceOfTruthOutsideLoweringGate(spec))
            }
        }

        let declaredBackends = cleaned(contract.requiredBackends)
        if declaredBackends.isEmpty {
            found.append(.noRequiredBackends)
        }
        for raw in declaredBackends where MissionBackend.named(raw) == nil {
            found.append(.unrunnableBackend(raw))
        }

        if cleaned(contract.acceptance).isEmpty {
            found.append(.noAcceptanceCriteria)
        }

        for entry in cleaned(contract.prohibited) {
            let matches = MissionProhibition.recognised(in: entry)
            guard !matches.isEmpty else {
                found.append(.unenforceableProhibition(entry))
                continue
            }
            // Enforceable if ANY reading of it is. The two failures are
            // separate cases because their repairs are: one is rephrased, the
            // other is a clause about a measurement that exists and does not
            // reach this spec, and offering the operator a list of phrasings
            // for that one would be answering a question they did not ask.
            let faults = matches.compactMap {
                applicabilityFault(of: $0, spec: spec, ownedPaths: owned)
            }
            if faults.count == matches.count, let first = faults.first {
                found.append(.prohibitionOutOfReach(entry, reason: first))
            }
        }

        return found
    }

    /// Whether acceptance may be decided against this contract at all.
    static func isCheckable(_ contract: MissionContract) -> Bool {
        refusals(contract).isEmpty
    }

    /// One refusal per line, each naming its measurement, or nil when the
    /// contract is checkable.
    static func refusalReport(_ contract: MissionContract) -> String? {
        let found = refusals(contract)
        guard !found.isEmpty else { return nil }
        let lines = found.map { "  - " + $0.message }.joined(separator: "\n")
        return "`\(displayed(contract.id))` cannot be checked, so it cannot be "
            + "accepted:\n\(lines)"
    }

    // MARK: - Serialisation

    /// Stable JSON, so a contract can be written beside its task and diffed.
    ///
    /// `.sortedKeys` even though a Codable struct already encodes in property
    /// order: the guarantee has to come from the encoder rather than from the
    /// order the properties happen to be declared in, or reordering the struct
    /// silently rewrites every contract on disk and every diff shows the whole
    /// file instead of the change.
    ///
    /// `.withoutEscapingSlashes` because every value in this type that matters
    /// is a path. `rings\/T27-00\/queen_core.t27` is the same string and an
    /// unreadable diff.
    ///
    /// Trailing newline because the file is text and `diff` says
    /// "\\ No newline at end of file" otherwise, on every contract, forever.
    static func json(_ contract: MissionContract) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(contract)
        let text = String(decoding: data, as: UTF8.self)
        return text.hasSuffix("\n") ? text : text + "\n"
    }

    /// Reads a contract back. Decoding is deliberately permissive about
    /// CONTENT and strict about SHAPE: an unrunnable backend and an
    /// unenforceable prohibition must survive decoding, or the validator never
    /// runs on the contract that needed it and the refusal becomes a parse
    /// error with no measurement in it.
    static func contract(fromJSON text: String) throws -> MissionContract {
        try JSONDecoder().decode(MissionContract.self, from: Data(text.utf8))
    }

    // MARK: - Shared helpers

    /// Trimmed, empty entries dropped, order preserved. A blank line in a YAML
    /// list is not an acceptance criterion.
    static func cleaned(_ values: [String]) -> [String] {
        values
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// An empty string has no name to print, and a message reading "for  this
    /// clause" is how a refusal stops being read.
    static func displayed(_ value: String) -> String {
        value.isEmpty ? "(empty)" : value
    }
}

// MARK: - The contract

/// Section 11.1's fields, as JSON rather than YAML.
///
/// JSON via `Codable` because that is what every other piece of state in this
/// repository uses, and a hand-rolled YAML parser would be a second source of
/// truth about the source of truth.
///
/// `requiredBackends` and `prohibited` are `[String]`, not enums, on purpose. A
/// type that cannot represent an invalid contract cannot refuse one: if an
/// unknown backend failed to decode, the validator would never see the contract
/// that needed refusing, and the operator would get a `DecodingError` with no
/// measurement in it instead of a sentence naming what can be run.
///
/// Two departures from the document, both to make it diffable: the `mission:`
/// root key is dropped, and `issue` is carried explicitly rather than parsed
/// back out of `id` - recovering a field by parsing an identifier is how the id
/// and the thing it names drift apart.
struct MissionContract: Codable, Equatable, Sendable {
    var id: String
    var issue: Int
    var objective: String
    var repository: String
    var sourceOfTruth: MissionSourceOfTruth
    var requiredBackends: [String]
    var invariants: [String]
    var acceptance: [String]
    var ownedPaths: [String]
    var prohibited: [String]

    enum CodingKeys: String, CodingKey {
        case id
        case issue
        case objective
        case repository
        case sourceOfTruth = "source_of_truth"
        case requiredBackends = "required_backends"
        case invariants
        case acceptance
        case ownedPaths = "owned_paths"
        case prohibited
    }
}

/// 11.1 nests the spec under `source_of_truth`. Kept nested so the shape a
/// reader sees in the document is the shape they find in the file.
struct MissionSourceOfTruth: Codable, Equatable, Sendable {
    var spec: String
}

// MARK: - Backends

/// The backends something in this tree can actually run.
///
/// Four, because `make t27-lowering` generates and counts exactly four for
/// every spec under `rings/`, and each rule it applies was validated against
/// all 70 specs before being trusted: Zig is held to equality (0 of 70
/// disagreed), C and Verilog to "at least", because Verilog emits a wrapper and
/// C emits the spec's test blocks, and pinning counts nobody understands is
/// pinning behaviour nobody understands.
///
/// A fifth name in a contract is not a backend this repository is missing - it
/// is a claim no gate can decide, which is why `named` returns nil for it
/// rather than inventing a case.
enum MissionBackend: String, CaseIterable, Codable, Sendable {
    case rust
    case zig
    case c
    case verilog

    /// The command that generates it. `zig` is bare `gen` because it was the
    /// first backend and never got a suffix.
    var generatorCommand: String {
        switch self {
        case .rust: return "t27c gen-rust"
        case .zig: return "t27c gen"
        case .c: return "t27c gen-c"
        case .verilog: return "t27c gen-verilog"
        }
    }

    /// The backend a declared name refers to, or nil when nothing runs it.
    ///
    /// The generator subcommands are accepted as aliases because that is how
    /// every acceptance criterion in the registry writes them - #1280 says
    /// "`t27c gen-rust ...` produces Rust that compiles", not "backend: rust".
    static func named(_ raw: String) -> MissionBackend? {
        let value = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return alias[value]
    }

    /// The backends named anywhere in these criteria, deduplicated, in
    /// declaration order so the lift is deterministic.
    ///
    /// Matched on whole tokens, never substrings. `c` as a substring is in
    /// every other word in English; as a token it appears in "golden vectors
    /// pass on C and RTL simulation" and nowhere accidental. The tokeniser
    /// keeps `-` and `_` so `gen-rust` stays one token and `queen_core` does
    /// not decompose into a token `c`.
    static func mentioned(in criteria: [String]) -> [MissionBackend] {
        var seen = Set<MissionBackend>()
        for criterion in criteria {
            for token in tokens(criterion) {
                if let backend = alias[token] { seen.insert(backend) }
            }
        }
        return allCases.filter { seen.contains($0) }
    }

    /// Names accepted for each backend. Deliberately closed: an unknown name is
    /// the case the validator exists to catch.
    private static let alias: [String: MissionBackend] = [
        "rust": .rust, "rustc": .rust, "gen-rust": .rust,
        "zig": .zig, "gen": .zig,
        "c": .c, "gen-c": .c,
        "verilog": .verilog, "gen-verilog": .verilog
    ]

    static func tokens(_ text: String) -> [String] {
        text.lowercased()
            .split(whereSeparator: { character in
                !(character.isLetter || character.isNumber
                    || character == "-" || character == "_")
            })
            .map(String.init)
    }
}

// MARK: - Prohibitions

/// The prohibitions this tree can decide, and the measurement that decides each.
///
/// A prohibition with no measurement behind it is the same sentence as a
/// prohibition with one, and only one of them stops anything. So the set is
/// closed, and prose that matches none of it is refused rather than accepted
/// and quietly unenforced. Failing closed is safe here: the cost is one word
/// from the operator, and the alternative is a contract that forbids something
/// nothing checks.
enum MissionProhibition: String, CaseIterable, Codable, Sendable {
    /// The document's own first example, and this repository's L0: "Generated
    /// files are artifacts. A diff that changes a generated file without
    /// changing its `.t27` is a defect."
    case handEditGeneratedArtifacts = "hand-edit-generated-artifacts"

    /// gHashTag/t27#2508, the reason this whole file exists.
    case dropDeclaredFunctions = "drop-declared-functions"

    case emptyFunctionBodies = "empty-function-bodies"

    case shipUncompilableRust = "ship-uncompilable-rust"

    case writeOutsideOwnedPaths = "write-outside-owned-paths"

    case rewriteEnglishProse = "rewrite-english-prose"

    /// The document's own second example, "change golden outputs without
    /// semantic approval".
    case changeGoldenOutputs = "change-golden-outputs"

    /// How the clause is written into a lifted contract.
    var canonicalPhrase: String {
        switch self {
        case .handEditGeneratedArtifacts:
            return "hand-edit generated files"
        case .dropDeclaredFunctions:
            return "drop functions the spec declares"
        case .emptyFunctionBodies:
            return "emit unimplemented function bodies"
        case .shipUncompilableRust:
            return "generate Rust that does not compile"
        case .writeOutsideOwnedPaths:
            return "write outside the owned paths"
        case .rewriteEnglishProse:
            return "replace English prose with another language"
        case .changeGoldenOutputs:
            return "change golden outputs without semantic approval"
        }
    }

    /// What would catch a breach. Every string here names something that exists
    /// in this tree today; that is the whole test of whether a clause belongs
    /// in this enum.
    var measurement: String {
        switch self {
        case .handEditGeneratedArtifacts:
            return "regenerate with `t27c gen-<backend> <spec>` and diff against "
                + "the committed artifact; L0 makes a difference a defect, and "
                + "`make chain` does exactly this for \(QueenMissionContract.goldenChainSpec)"
        case .dropDeclaredFunctions:
            return "`make t27-lowering` counts functions declared in the spec "
                + "against functions emitted per backend (gHashTag/t27#2508: the "
                + "parser discards what it cannot parse, exit 0, empty stderr)"
        case .emptyFunctionBodies:
            return "`make t27-lowering` counts `unimplemented!()` in the "
                + "generated Rust - the compiler's empty-body fallback, so it "
                + "means the body was emptied, not left deliberately unwritten"
        case .shipUncompilableRust:
            return "`make t27-lowering` builds every generated file with "
                + "`rustc --edition 2021 --crate-type lib`; `--emit=metadata` "
                + "hides `arithmetic_overflow` and is not used"
        case .writeOutsideOwnedPaths:
            return "`QueenBoundaryPaths.strays(among:ownedPaths:root:)` over the "
                + "paths the worker named"
        case .rewriteEnglishProse:
            return "`QueenLanguagePolicy.rewriteRefusal(path:before:after:)`, L3"
        case .changeGoldenOutputs:
            return "`make chain` runs the generated ring and the hand-written "
                + "Swift twin and diffs their verdict streams"
        }
    }

    /// The clauses a prose entry can be read as, in declaration order. Empty
    /// means nothing measures it.
    ///
    /// A clause matches when the entry names both its subject and something
    /// said about that subject. One alone is not a prohibition: "the generated
    /// Rust compiles" is an acceptance criterion, and "do not change anything"
    /// is not a rule.
    static func recognised(in entry: String) -> [MissionProhibition] {
        let tokens = MissionBackend.tokens(entry)
            .flatMap { $0.split(separator: "-").map(String.init) }
        return allCases.filter { prohibition in
            hits(prohibition.subjects, in: tokens)
                && hits(prohibition.predicates, in: tokens)
        }
    }

    /// Terms are matched as token PREFIXES, so `chang` covers change, changed,
    /// changes and changing. A stem that reads like a typo is the price of not
    /// shipping an inflection table for six verbs.
    private static func hits(_ terms: [String], in tokens: [String]) -> Bool {
        terms.contains { term in tokens.contains { $0.hasPrefix(term) } }
    }

    /// `gen` is NOT a subject term, though `gen/` is where the artifacts live.
    /// As a token prefix it also matches "generator", so "rewrite the
    /// generator" - a legitimate compiler task - would have been read as a ban
    /// on hand-editing artifacts and passed as enforceable by a measurement
    /// that says nothing about it.
    var subjects: [String] {
        switch self {
        case .handEditGeneratedArtifacts: return ["generated", "artifact"]
        case .dropDeclaredFunctions: return ["function", "fn", "declaration"]
        case .emptyFunctionBodies: return ["unimplemented", "stub", "body", "bodies"]
        case .shipUncompilableRust: return ["rust", "rustc"]
        case .writeOutsideOwnedPaths: return ["owned", "ownership", "boundary", "path"]
        case .rewriteEnglishProse: return ["english", "language", "russian"]
        case .changeGoldenOutputs: return ["golden", "expectation", "vector"]
        }
    }

    /// What the entry must say about the subject. Usually a verb - and for
    /// `shipUncompilableRust` a NEGATION, which the suite forced.
    ///
    /// With `generat` in this list and `compil` among the subjects, "the
    /// generated Rust compiles" was recognised as a prohibition. It is an
    /// acceptance criterion, and the only token separating the two sentences is
    /// `not`. So that clause is keyed on the failure it forbids rather than on
    /// the compiler it mentions, and a positive claim about the same
    /// measurement no longer reads as a ban.
    var predicates: [String] {
        switch self {
        case .handEditGeneratedArtifacts:
            return ["edit", "modif", "chang", "rewrit", "touch", "writ", "patch"]
        case .dropDeclaredFunctions:
            return ["drop", "delet", "remov", "los", "discard", "silenc"]
        case .emptyFunctionBodies:
            return ["emit", "leav", "ship", "empt", "generat", "writ"]
        case .shipUncompilableRust:
            return ["not", "cannot", "never", "fail", "break", "uncompilable", "nocompile"]
        case .writeOutsideOwnedPaths:
            return ["writ", "edit", "touch", "modif", "outside", "beyond"]
        case .rewriteEnglishProse:
            return ["replac", "rewrit", "translat", "commit", "writ"]
        case .changeGoldenOutputs:
            return ["chang", "updat", "edit", "replac", "regenerat", "rewrit"]
        }
    }
}

// MARK: - Refusals

/// Why a contract cannot be checked. Each case's `message` names the
/// measurement it wanted and could not have, because a refusal that cannot show
/// its measurement is the guess this repository keeps paying for.
enum MissionContractRefusal: Equatable, Sendable {
    case missingIdentifier
    case missingObjective
    case missingRepository
    case noOwnedPaths
    case noSourceOfTruthSpec(ownedPaths: [String])
    case sourceOfTruthIsNotASpec(String)
    case sourceOfTruthNotOwned(spec: String, ownedPaths: [String])
    case sourceOfTruthOutsideLoweringGate(String)
    case noRequiredBackends
    case unrunnableBackend(String)
    case noAcceptanceCriteria
    case unenforceableProhibition(String)
    case prohibitionOutOfReach(String, reason: String)

    var message: String {
        switch self {
        case .missingIdentifier:
            return "the contract has no `id`, and the id is the file name it is "
                + "written under beside its task."
        case .missingObjective:
            return "the contract has no `objective`. 11.1 makes this the "
                + "issue-level source of truth, and a source of truth that says "
                + "nothing is a file."
        case .missingRepository:
            return "the contract has no `repository`. Every path in it is "
                + "repository-relative, so with no repository there is no file "
                + "to measure."
        case .noOwnedPaths:
            return "the contract declares no owned paths, so no worker can be "
                + "told what it may write and `QueenBoundaryPaths.strays` has "
                + "no boundary to judge against."
        case let .noSourceOfTruthSpec(ownedPaths):
            let specs = ownedPaths.filter(QueenMissionContract.isSpecPath)
            if specs.count > 1 {
                return "`source_of_truth.spec` is empty and \(specs.count) of "
                    + "the owned paths are specs (\(specs.joined(separator: ", "))). "
                    + "11.1 names one spec; choosing between them is the Queen's "
                    + "decision to state, not this file's to guess."
            }
            return "`source_of_truth.spec` is empty and none of the "
                + "\(ownedPaths.count) owned path(s) is a `.t27`. This is a "
                + "delegation, not a mission: nothing here is spec-first, so "
                + "none of the T27 measurements apply to it."
        case let .sourceOfTruthIsNotASpec(spec):
            return "`source_of_truth.spec` is `\(spec)`, which is not a `.t27`. "
                + "Every measurement this contract can carry - lowering counts, "
                + "`unimplemented!()`, the Rust build, the golden chain - starts "
                + "by running `t27c` on a spec."
        case let .sourceOfTruthNotOwned(spec, ownedPaths):
            return "`source_of_truth.spec` is `\(spec)`, which is not among the "
                + "owned paths (\(ownedPaths.joined(separator: ", "))). The "
                + "worker cannot edit its own source of truth, so the mission "
                + "cannot be worked - and every write it makes to the spec would "
                + "be reported as a stray."
        case let .sourceOfTruthOutsideLoweringGate(spec):
            return "`\(spec)` is outside `rings/`, and `make t27-lowering` finds "
                + "specs with `find $(ROOT)/rings -name '*.t27'`. Nothing in this "
                + "tree would count its functions, count its `unimplemented!()` "
                + "or compile its Rust, so its backend claims are unmeasured."
        case .noRequiredBackends:
            return "`required_backends` is empty, so the contract makes no claim "
                + "about what the spec must lower into. `make t27-lowering` "
                + "would still run, and its verdict would be about nothing this "
                + "contract asked for."
        case let .unrunnableBackend(raw):
            let runnable = MissionBackend.allCases
                .map { "\($0.rawValue) (`\($0.generatorCommand)`)" }
                .joined(separator: ", ")
            return "`\(raw)` is not a backend anything here runs. What "
                + "`make t27-lowering` generates and counts: \(runnable)."
        case .noAcceptanceCriteria:
            return "`acceptance` is empty. Acceptance would then be decided by "
                + "whether files were committed and a SHA recorded, which is "
                + "what the Queen already does to `.t27` specs and is the gap "
                + "this contract exists to close."
        case let .unenforceableProhibition(entry):
            let enforceable = MissionProhibition.allCases
                .map { "\"\($0.canonicalPhrase)\"" }
                .joined(separator: ", ")
            return "nothing in this tree measures the prohibition \"\(entry)\", "
                + "so it would be a sentence and not a rule. What can be "
                + "enforced: \(enforceable)."
        case let .prohibitionOutOfReach(entry, reason):
            return "the prohibition \"\(entry)\" names a measurement that does "
                + "not reach this contract: \(reason)"
        }
    }
}
