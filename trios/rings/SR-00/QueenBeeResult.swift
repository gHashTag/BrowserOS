import Foundation

/// The structured Bee result of section 11.3, and the check that says which of
/// its fields a given status actually requires.
///
/// The architecture document files "Queen/T27 bridge" as a P0 gap, "not
/// demonstrated". Measured in the live registry
/// (`.trinity/state/queen_delegation.json`) on 2026-08-28, that row is wrong in
/// one direction and far too kind in another:
///
/// - 59 delegated tasks, 10 of them owning a `.t27` path, and #1280 on
///   `rings/T27-00/queen_core.t27` reached `accepted` with pull request 74.
///   The bridge runs. "Not demonstrated" is out of date.
/// - None of the twelve fields below exist anywhere. What a finished task
///   carries is `committedFiles` - a COUNT - and `committedSHA`. The SHA is
///   present on 11 of the 59 tasks and on 3 of the 16 that reached `accepted`
///   or `merged`; #1280, the one accepted `.t27` task, has `committedFiles: 1`
///   and no `committedSHA` key at all.
/// - Nothing in the registry records WHICH files a worker committed.
///   `ownedPaths` is the boundary the Queen granted before the work started,
///   not a record of what was written. So the classifier below cannot be fed
///   from the registry as it stands; `capture(of:)` says so field by field
///   rather than letting a caller assume otherwise.
/// - Acceptance treats a `.t27` spec exactly like a Swift file.
///
/// That last one is the expensive one. t27c's parser silently discards any
/// statement it cannot parse - `Err(_) => recover_to_stmt_boundary()`, exit 0,
/// empty stderr, filed upstream as gHashTag/t27#2508 - so "the spec still
/// parses" is evidence of nothing. `make t27-lowering` is the measurement that
/// is: functions declared in a spec against functions emitted per backend,
/// zero `unimplemented!()`, and the generated Rust compiled under a full
/// `--crate-type lib` build, because `--emit=metadata` hides arithmetic
/// overflow. It caught `trust_manager.t27` declaring 21 functions and emitting
/// 12 - nine silently gone for as long as the spec had existed. That gate is
/// in `make check` and is not in acceptance, which is what
/// `loweringGateRequirement` below closes.
///
/// Foundation and nothing else, deliberately. The rule is worth testing, so it
/// has to be reachable by a suite that links one file.
struct QueenBeeResult: Codable, Equatable, Sendable {

    // MARK: - the contract

    /// What a bee says happened, which is not the same vocabulary as
    /// `DelegatedTaskState`.
    ///
    /// The registry's eight states are the QUEEN's lifecycle: `queued`,
    /// `awaitingReview`, `accepted` and `merged` are all things she or the
    /// forge do, and a bee cannot report them about itself. These four are the
    /// only endings a worker is in a position to assert. Keeping the two
    /// vocabularies apart is the point: a bee that could report `accepted`
    /// would be reviewing its own work.
    enum Status: String, Codable, Equatable, Sendable, CaseIterable {
        /// The work is done and the bee is offering it for review.
        case completed
        /// The bee stopped and needs a decision it is not allowed to make.
        case blocked
        /// The bee tried and could not.
        case failed
        /// The bee was stopped from outside - section 11.6's stop signal.
        case cancelled
    }

    /// The twelve keys of section 11.3, in the document's order.
    ///
    /// Doubles as `CodingKeys`, so the wire format and the field vocabulary are
    /// literally one list. A rule transcribed twice is two rules that agree
    /// until someone edits one, and this repository has paid for that enough
    /// times to stop doing it on purpose.
    enum Field: String, CodingKey, Codable, Equatable, Sendable, CaseIterable {
        case taskID = "task_id"
        case status = "status"
        case baseCommit = "base_commit"
        case resultCommit = "result_commit"
        case changedSpecs = "changed_specs"
        case changedCompilerFiles = "changed_compiler_files"
        case generatedArtifacts = "generated_artifacts"
        case testsAdded = "tests_added"
        case commandsRun = "commands_run"
        case evidenceManifest = "evidence_manifest"
        case knownRisks = "known_risks"
        case humanDecisionsRequired = "human_decisions_required"
    }

    typealias CodingKeys = Field

    var taskID: String
    var status: Status
    var baseCommit: String?
    var resultCommit: String?
    var changedSpecs: [String]
    var changedCompilerFiles: [String]
    var generatedArtifacts: [String]
    var testsAdded: [String]
    var commandsRun: [String]
    var evidenceManifest: String?
    var knownRisks: [String]
    var humanDecisionsRequired: [String]

    init(
        taskID: String,
        status: Status,
        baseCommit: String? = nil,
        resultCommit: String? = nil,
        changedSpecs: [String] = [],
        changedCompilerFiles: [String] = [],
        generatedArtifacts: [String] = [],
        testsAdded: [String] = [],
        commandsRun: [String] = [],
        evidenceManifest: String? = nil,
        knownRisks: [String] = [],
        humanDecisionsRequired: [String] = []
    ) {
        self.taskID = taskID
        self.status = status
        self.baseCommit = baseCommit
        self.resultCommit = resultCommit
        self.changedSpecs = changedSpecs
        self.changedCompilerFiles = changedCompilerFiles
        self.generatedArtifacts = generatedArtifacts
        self.testsAdded = testsAdded
        self.commandsRun = commandsRun
        self.evidenceManifest = evidenceManifest
        self.knownRisks = knownRisks
        self.humanDecisionsRequired = humanDecisionsRequired
    }

    /// Builds a result from one flat list of changed paths, splitting it into
    /// the document's three buckets.
    ///
    /// This is the shape a caller actually has: `git diff --name-only` gives a
    /// list, not three lists. Sorting it by hand at each call site is how the
    /// three buckets would drift apart.
    ///
    /// The paths must already be project-relative. Reducing a worker's
    /// worktree spelling to that form is `QueenBoundaryPaths.projectRelative`,
    /// and that reduction is deliberately not duplicated here.
    init(
        taskID: String,
        status: Status,
        baseCommit: String? = nil,
        resultCommit: String? = nil,
        changedPaths: [String],
        testsAdded: [String] = [],
        commandsRun: [String] = [],
        evidenceManifest: String? = nil,
        knownRisks: [String] = [],
        humanDecisionsRequired: [String] = []
    ) {
        let changes = Self.classify(changedPaths)
        self.init(
            taskID: taskID,
            status: status,
            baseCommit: baseCommit,
            resultCommit: resultCommit,
            changedSpecs: changes.specs,
            changedCompilerFiles: changes.compilerFiles,
            generatedArtifacts: changes.generatedArtifacts,
            testsAdded: testsAdded,
            commandsRun: commandsRun,
            evidenceManifest: evidenceManifest,
            knownRisks: knownRisks,
            humanDecisionsRequired: humanDecisionsRequired
        )
    }

    /// Decodes leniently on every field except the status, and the asymmetry is
    /// the whole design.
    ///
    /// A bee that omits `result_commit` must produce a result that DECODES and
    /// is then judged incomplete by name. If decoding threw, an incomplete
    /// result would arrive as an unparseable blob, and "the JSON did not
    /// decode" tells the Queen nothing about which promise was not kept - it is
    /// the same undifferentiated ending that made `failureKind` necessary in
    /// the registry.
    ///
    /// The status is the exception because it selects the requirements. There
    /// is no set of missing fields to report for a result that will not say
    /// what it is claiming, so that one refuses, and it refuses by name.
    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: Field.self)
        taskID = (try box.decodeIfPresent(String.self, forKey: .taskID)) ?? ""

        guard let rawStatus = try box.decodeIfPresent(String.self, forKey: .status) else {
            throw DecodingError.dataCorruptedError(
                forKey: .status, in: box,
                debugDescription: "A bee result carries no `status`, so there is "
                    + "nothing to check it against. One of: "
                    + Status.allCases.map(\.rawValue).joined(separator: ", ") + "."
            )
        }
        guard let parsed = Status(rawValue: rawStatus) else {
            throw DecodingError.dataCorruptedError(
                forKey: .status, in: box,
                debugDescription: "`\(rawStatus)` is not a bee status. One of: "
                    + Status.allCases.map(\.rawValue).joined(separator: ", ")
                    + ". The Queen's own lifecycle words (accepted, merged, "
                    + "awaitingReview) are hers, not the worker's."
            )
        }
        status = parsed

        baseCommit = try box.decodeIfPresent(String.self, forKey: .baseCommit)
        resultCommit = try box.decodeIfPresent(String.self, forKey: .resultCommit)
        evidenceManifest = try box.decodeIfPresent(String.self, forKey: .evidenceManifest)
        changedSpecs = (try box.decodeIfPresent([String].self, forKey: .changedSpecs)) ?? []
        changedCompilerFiles =
            (try box.decodeIfPresent([String].self, forKey: .changedCompilerFiles)) ?? []
        generatedArtifacts =
            (try box.decodeIfPresent([String].self, forKey: .generatedArtifacts)) ?? []
        testsAdded = (try box.decodeIfPresent([String].self, forKey: .testsAdded)) ?? []
        commandsRun = (try box.decodeIfPresent([String].self, forKey: .commandsRun)) ?? []
        knownRisks = (try box.decodeIfPresent([String].self, forKey: .knownRisks)) ?? []
        humanDecisionsRequired =
            (try box.decodeIfPresent([String].self, forKey: .humanDecisionsRequired)) ?? []
    }

    /// Stable bytes: sorted keys, so two encodings of one result compare equal
    /// and a manifest can be hashed.
    func jsonData() throws -> Data {
        let coder = JSONEncoder()
        coder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return try coder.encode(self)
    }

    static func decoded(from data: Data) throws -> QueenBeeResult {
        try JSONDecoder().decode(QueenBeeResult.self, from: data)
    }

    // MARK: - what trios can actually record today

    /// Whether a field can be filled from data trios already holds.
    ///
    /// This exists so the completeness check tells the truth about whose gap it
    /// is naming. A missing field the platform never captures is not a lazy
    /// bee, and sending the task back for it produces a second identical
    /// failure - which is the loop `sendBacks` was capped at two to stop.
    enum Capture: Equatable, Sendable {
        /// trios records this today; the value can be filled without new wiring.
        case recorded(String)
        /// trios records something ADJACENT and not this. Naming what it
        /// records keeps the near-miss visible instead of letting it pass as
        /// the thing itself.
        case adjacent(String)
        /// Nothing in trios records this. A bee can only assert it, and an
        /// assertion nobody measured is what section 11.3 exists to replace.
        case absent

        var isRecorded: Bool {
            if case .recorded = self { return true }
            return false
        }

        /// What is behind the verdict, for a UI or a report that has to explain
        /// itself.
        var note: String {
            switch self {
            case .recorded(let source): return "recorded today: \(source)"
            case .adjacent(let source): return "not recorded; the nearest thing is \(source)"
            case .absent: return "not recorded anywhere in trios"
            }
        }
    }

    /// Measured against the live registry's own keys on 2026-08-28. Every
    /// number below came from reading the 59 stored tasks, not from reading the
    /// code that writes them - the two disagree, which is the point.
    static func capture(of field: Field) -> Capture {
        switch field {
        case .taskID:
            return .recorded("DelegatedTask.issue.number, with .id as the stable key")
        case .status:
            return .recorded(
                "DelegatedTask.state, though four of its eight values are the "
                    + "Queen's verdict rather than the worker's report"
            )
        case .baseCommit:
            // A write-tree hash names CONTENT. It cannot be checked out, it has
            // no parent, and `git show` on it prints a directory listing. Two
            // tasks branched from different commits with identical trees share
            // one. It is not a commit and must not be reported as one.
            return .adjacent(
                "baselineTree, a git write-tree hash - content without history, "
                    + "so it names no commit"
            )
        case .resultCommit:
            return .recorded(
                "committedSHA - on 11 of 59 tasks, 3 of the 16 that reached "
                    + "accepted or merged, and absent on #1280, the one "
                    + "accepted .t27 task"
            )
        case .changedSpecs, .changedCompilerFiles, .generatedArtifacts:
            // The single most load-bearing honest line in this file. The
            // classifier below needs paths; the registry stores a number.
            return .adjacent(
                "committedFiles, a count with no paths (1 on #1280); ownedPaths "
                    + "is the boundary granted before the work, not a record of "
                    + "what was written"
            )
        case .commandsRun:
            return .adjacent(
                "toolCalls, a count (33 on #1280) that names no command"
            )
        case .humanDecisionsRequired:
            // Opposite direction, and the distinction is not pedantic: one is
            // the Queen steering, the other is the bee refusing to guess.
            return .adjacent(
                "interventions, which records what the Queen sent INTO the "
                    + "worker rather than what the worker asked of her"
            )
        case .testsAdded, .evidenceManifest, .knownRisks:
            return .absent
        }
    }

    /// The fields no amount of bee diligence can fill until trios captures
    /// them. Useful for a roadmap; used below to keep a refusal honest.
    static var fieldsNeedingNewCapture: [Field] {
        Field.allCases.filter { !capture(of: $0).isRecorded }
    }

    // MARK: - completeness

    /// One promise a status carries, and the fields that could keep it.
    ///
    /// `fields` is a disjunction: any one of them being present satisfies the
    /// requirement. Most requirements name exactly one field; "something
    /// changed" names three, because a completed result may have touched a
    /// spec, or the compiler, or a generated artifact, and demanding all three
    /// would be demanding a shape of work rather than evidence of it.
    struct Requirement: Equatable, Sendable {
        let fields: [Field]
        let reason: String

        /// How the requirement is named in a message.
        var subject: String {
            fields.isEmpty ? "result" : fields.map(\.rawValue).joined(separator: " / ")
        }

        var captures: [Capture] { fields.map(QueenBeeResult.capture(of:)) }

        /// True when nothing in trios records any field that would satisfy
        /// this, so the gap belongs to the platform and a send-back cannot
        /// close it.
        var needsNewCapture: Bool { !captures.contains { $0.isRecorded } }
    }

    /// What a status promises, before looking at any particular result.
    ///
    /// What is deliberately NOT required, and why:
    ///
    /// - **`tests_added`, for anything.** L4 says a change must PASS the build,
    ///   the e2e flow and a verdict, not that it must add a test. A result that
    ///   only regenerates artifacts adds no test by construction, and a
    ///   requirement that a correct result cannot meet gets switched off rather
    ///   than met. `commands_run` carries the same evidence and can be checked.
    /// - **`known_risks`, for `completed`.** An empty risk list is a real
    ///   answer. Forcing one produces the ritual sentence, and a field that is
    ///   always filled stops being read.
    /// - **Anything at all beyond `task_id`, for `cancelled`.** Section 11.6's
    ///   stop signal comes from outside the bee. Demanding evidence from work
    ///   that was told to stop is how a cancel gets recorded as a failure, and
    ///   the registry already cannot tell those two apart - `failureKind`
    ///   exists because every ending was spelled with the same word.
    static func requirements(for status: Status) -> [Requirement] {
        switch status {
        case .completed:
            return [
                Requirement(
                    fields: [.taskID],
                    reason: "a result that does not name its task cannot be filed against one"
                ),
                Requirement(
                    fields: [.baseCommit],
                    reason: "acceptance has to know what the work started from; without it "
                        + "a verdict cannot be told from one carved against a tree that "
                        + "has since moved"
                ),
                Requirement(
                    fields: [.resultCommit],
                    reason: "the commit is the only part of a result still checkable after "
                        + "the worker is gone"
                ),
                Requirement(
                    fields: [.changedSpecs, .changedCompilerFiles, .generatedArtifacts],
                    reason: "completed means something changed; a result naming no file is "
                        + "a prose claim wearing a struct"
                ),
                Requirement(
                    fields: [.commandsRun],
                    reason: "what was run is what separates a checked result from a claimed one"
                ),
                Requirement(
                    fields: [.evidenceManifest],
                    reason: "section 11.4 may accept only when evidence artifacts are "
                        + "readable, which needs something to point at"
                ),
            ]
        case .blocked:
            return [
                Requirement(
                    fields: [.taskID],
                    reason: "a result that does not name its task cannot be filed against one"
                ),
                Requirement(
                    fields: [.baseCommit],
                    reason: "a block is against a state of the tree; the tree moves, and "
                        + "then the block may no longer be one"
                ),
                Requirement(
                    fields: [.humanDecisionsRequired, .knownRisks],
                    reason: "blocked with nothing a human must decide and no risk named is "
                        + "not a block, it is a pause nobody can act on"
                ),
            ]
        case .failed:
            return [
                Requirement(
                    fields: [.taskID],
                    reason: "a result that does not name its task cannot be filed against one"
                ),
                Requirement(
                    fields: [.baseCommit],
                    reason: "a failure against an unnamed base cannot be reproduced or "
                        + "ruled obsolete"
                ),
                Requirement(
                    fields: [.commandsRun],
                    reason: "a failure that names no command it ran is indistinguishable "
                        + "from a worker that never started, and the Queen retries those "
                        + "differently"
                ),
            ]
        case .cancelled:
            return [
                Requirement(
                    fields: [.taskID],
                    reason: "a result that does not name its task cannot be filed against one"
                ),
            ]
        }
    }

    /// The requirements this result does not keep. Empty means complete.
    func missingRequirements() -> [Requirement] {
        var missing = Self.requirements(for: status).filter { requirement in
            !requirement.fields.contains { carries($0) }
        }
        if let gate = loweringGateRequirement() { missing.append(gate) }
        return missing
    }

    /// Field names only, for a caller that just wants the list.
    var missingFieldNames: [String] { missingRequirements().map(\.subject) }

    var isComplete: Bool { missingRequirements().isEmpty }

    /// The T27 requirement that is the reason this file exists.
    ///
    /// A completed result that touched a spec or a generated artifact must name
    /// the lowering gate among the commands it ran. Not "it compiled" and not
    /// "the spec parses": t27c's parser recovers silently from statements it
    /// cannot parse and exits 0, so a spec can lose nine functions and every
    /// exit-status-trusting gate downstream passes it. `make t27-lowering`
    /// counts declared functions against emitted ones per backend, rejects
    /// `unimplemented!()`, and compiles the generated Rust for real. It is
    /// already in `make check`; wiring it into acceptance is one string.
    ///
    /// Returns nil when the gate does not apply - a non-completed result, or a
    /// completed one that touched no spec and no artifact.
    func loweringGateRequirement() -> Requirement? {
        guard status == .completed else { return nil }
        guard !changedSpecs.isEmpty || !generatedArtifacts.isEmpty else { return nil }
        guard !commandsRun.contains(where: { $0.contains(Self.loweringGateNeedle) }) else {
            return nil
        }
        return Requirement(
            fields: [.commandsRun],
            reason: "a .t27 spec or a generated artifact changed and `\(Self.loweringGateCommand)`"
                + " was not run; t27c discards statements it cannot parse and still exits 0, "
                + "so nothing else in the pipeline would notice a function disappearing"
        )
    }

    /// The gate as an operator would type it.
    static let loweringGateCommand = "make t27-lowering"

    /// Matched as a substring so `DEVELOPER_DIR=... make t27-lowering` counts.
    /// The target name is the specific thing; the invocation around it varies
    /// per machine and pinning that would only teach bees to lie about it.
    static let loweringGateNeedle = "t27-lowering"

    /// English refusal naming every unkept promise, and separating the bee's
    /// gaps from the platform's.
    ///
    /// The last sentence is the part that matters. A refusal that lists six
    /// missing fields, four of which trios has never captured, reads as a bad
    /// worker and would be answered with a send-back that cannot possibly
    /// succeed. Saying which are unrecordable turns four of those into a
    /// roadmap item and leaves two for the bee.
    var refusal: String? {
        let missing = missingRequirements()
        guard !missing.isEmpty else { return nil }
        let subject = taskID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "A bee result"
            : "Bee result \(taskID)"
        var text = "\(subject) reports `\(status.rawValue)` and does not keep "
            + "\(missing.count) of the promises that status carries:\n"
            + missing.map { "  - \($0.subject): \($0.reason)" }.joined(separator: "\n")
        let unrecordable = missing.filter(\.needsNewCapture)
        if !unrecordable.isEmpty {
            text += "\n\(unrecordable.count) of these are not recorded anywhere in trios "
                + "today (" + unrecordable.map(\.subject).joined(separator: ", ")
                + "), so no send-back can produce them. They need new capture."
        }
        return text
    }

    /// Whether the field is filled with something that is not blank.
    ///
    /// Blank counts as absent, deliberately: `"commands_run": [""]` is a filled
    /// field and an empty promise, and a completeness check that accepts it is
    /// measuring JSON shape rather than evidence.
    func carries(_ field: Field) -> Bool {
        switch field {
        case .taskID: return Self.isNamed(taskID)
        case .status: return true
        case .baseCommit: return Self.isNamed(baseCommit)
        case .resultCommit: return Self.isNamed(resultCommit)
        case .evidenceManifest: return Self.isNamed(evidenceManifest)
        case .changedSpecs: return Self.hasEntry(changedSpecs)
        case .changedCompilerFiles: return Self.hasEntry(changedCompilerFiles)
        case .generatedArtifacts: return Self.hasEntry(generatedArtifacts)
        case .testsAdded: return Self.hasEntry(testsAdded)
        case .commandsRun: return Self.hasEntry(commandsRun)
        case .knownRisks: return Self.hasEntry(knownRisks)
        case .humanDecisionsRequired: return Self.hasEntry(humanDecisionsRequired)
        }
    }

    private static func isNamed(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func hasEntry(_ values: [String]) -> Bool {
        values.contains { isNamed($0) }
    }

    // MARK: - the classifier

    /// What a changed path is, which decides whether a T27 review is owed.
    enum PathKind: String, Codable, Equatable, Sendable, CaseIterable {
        /// A `.t27` file. The source of truth under L0.
        case spec
        /// Under a `gen/` directory. An artifact, not edited by hand.
        case generatedArtifact
        /// Everything else - the compiler, the app, the documents.
        case source
    }

    /// A changed set split into section 11.3's three buckets.
    struct Changes: Equatable, Sendable {
        var specs: [String] = []
        var compilerFiles: [String] = []
        var generatedArtifacts: [String] = []

        var isEmpty: Bool {
            specs.isEmpty && compilerFiles.isEmpty && generatedArtifacts.isEmpty
        }

        /// Whether acceptance owes this change a T27 review at all.
        ///
        /// This is the question the Queen could not previously ask, which is
        /// why a `.t27` spec was reviewed exactly like a Swift file. A source
        /// change alone does not need one; a spec or an artifact always does,
        /// including an artifact that moved on its own - especially that.
        var needsT27Review: Bool { !specs.isEmpty || !generatedArtifacts.isEmpty }
    }

    /// The extension that makes a file the source of truth.
    static let specExtension = ".t27"

    /// The directory component that makes a file an artifact. Measured: the
    /// generated trees in this checkout live at
    /// `rings/RUST-13/trios-mesh/gen/rust`, so the marker is a COMPONENT
    /// anywhere in the path and not a prefix.
    static let generatedDirectory = "gen"

    /// Classifies one path.
    ///
    /// The artifact rule is checked FIRST, and the ordering is a deliberate
    /// choice about which way to be wrong. A `.t27` sitting under `gen/` is
    /// either a copy or a hand edit inside an artifact tree; calling it a spec
    /// would let it be accepted as the source of truth and license the
    /// artifact drift L0 forbids. Calling it an artifact merely demands a
    /// review that a real spec did not need. One failure is silent and the
    /// other is loud, so the loud one wins.
    ///
    /// The extension is compared case-insensitively; a path component is not.
    /// A directory called `Gen` on a case-insensitive filesystem is the same
    /// directory as `gen`, but git records the name it was added under, and
    /// guessing about it would make the bucket depend on the machine.
    static func kind(of path: String) -> PathKind {
        let value = normalized(path)
        let components = value.split(separator: "/", omittingEmptySubsequences: true)
        if components.contains(where: { $0 == generatedDirectory }) {
            return .generatedArtifact
        }
        if value.lowercased().hasSuffix(specExtension) { return .spec }
        return .source
    }

    /// Splits a changed set into the three buckets, sorted and de-duplicated.
    ///
    /// Blank entries are dropped rather than filed as source: a stray empty
    /// string in a diff listing is noise, and counting it would let a result
    /// with no changes at all satisfy "something changed".
    ///
    /// De-duplicated because `./a.t27` and `a.t27` are one file, and a bee that
    /// lists both should not appear to have touched two.
    static func classify(_ paths: [String]) -> Changes {
        var changes = Changes()
        var seen: Set<String> = []
        for path in paths {
            let value = normalized(path)
            guard !value.isEmpty, seen.insert(value).inserted else { continue }
            switch kind(of: value) {
            case .spec: changes.specs.append(value)
            case .generatedArtifact: changes.generatedArtifacts.append(value)
            case .source: changes.compilerFiles.append(value)
            }
        }
        changes.specs.sort()
        changes.compilerFiles.sort()
        changes.generatedArtifacts.sort()
        return changes
    }

    /// Whether this set of paths obliges a T27 review.
    static func requiresT27Review(paths: [String]) -> Bool {
        classify(paths).needsT27Review
    }

    /// What this result changed, recomposed from its three stored buckets.
    var changes: Changes {
        Changes(
            specs: changedSpecs,
            compilerFiles: changedCompilerFiles,
            generatedArtifacts: generatedArtifacts
        )
    }

    /// L0, stated as a refusal: an artifact that moved with no spec behind it.
    ///
    /// "Generated files are artifacts. They are not edited. A diff that changes
    /// a generated file without changing its `.t27` is a defect." A generated
    /// tree that drifts is worse than a wrong one, because every downstream
    /// check reads the artifact and agrees with it.
    ///
    /// Known and accepted coarseness: this pairs the SET of artifacts against
    /// the SET of specs, not each artifact against its own spec. So a result
    /// that edits `a.t27` by hand and hand-edits an artifact generated from
    /// `b.t27` passes here. Closing that needs the generator's own
    /// spec-to-output manifest, which does not exist in this tree - and the
    /// case this catches, an artifact changed with no spec changed at all, is
    /// the one that has actually happened.
    static func artifactDriftRefusal(_ changes: Changes) -> String? {
        guard !changes.generatedArtifacts.isEmpty else { return nil }
        guard changes.specs.isEmpty else { return nil }
        return "\(changes.generatedArtifacts.count) generated file(s) changed and no "
            + ".t27 spec did: "
            + changes.generatedArtifacts.joined(separator: ", ")
            + ". L0 says generated files are artifacts and a diff that changes one "
            + "without changing its spec is a defect. Either the spec change is "
            + "missing from this result, or the artifact was edited by hand."
    }

    /// The same rule against a raw path list, for a caller that has not
    /// classified yet.
    static func artifactDriftRefusal(paths: [String]) -> String? {
        artifactDriftRefusal(classify(paths))
    }

    /// Trims and drops leading `./` and `/` so two spellings of one path
    /// compare equal.
    ///
    /// Deliberately does NOT reduce worktree or project prefixes.
    /// `QueenBoundaryPaths.projectRelative` owns that reduction, it is tested
    /// where it lives, and a second copy here would be the transcribed rule
    /// this file's `Field`/`CodingKeys` alias exists to avoid. The caller is
    /// expected to hand over project-relative paths.
    static func normalized(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasPrefix("./") { value.removeFirst(2) }
        while value.hasPrefix("/") { value.removeFirst() }
        return value
    }
}
