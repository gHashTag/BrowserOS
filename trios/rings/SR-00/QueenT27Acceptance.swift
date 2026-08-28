import Foundation

/// Whether work that touched a `.t27` spec may be accepted.
///
/// This is section 11.4's "required conformance passed" specialised to T27,
/// and the P0 row of the architecture document's gap table. Acceptance today
/// treats a `.t27` spec exactly like a Swift file. Measured in the live
/// registry on 2026-08-28: of 59 delegated tasks, 10 own a `.t27` path, and
/// #1280 on `rings/T27-00/queen_core.t27` reached `accepted` on the evidence
/// that one file was committed. Nothing between the bee and that verdict read
/// the spec, or the code the spec generates.
///
/// "The spec still parses" is not available as evidence here. t27c's parser
/// silently discards any statement it cannot parse - `Parser::parse_fn_body`
/// does `Err(_) => self.recover_to_stmt_boundary()` - and then exits 0 with
/// empty stderr. Reported upstream as gHashTag/t27#2508, in a repository this
/// one may not edit. When `make t27-lowering` was written it found
/// `trust_manager.t27` declaring 21 functions and emitting 12: nine had been
/// gone for as long as the spec had existed, and every gate that trusted an
/// exit status had passed them.
///
/// So the evidence is COUNTED rather than read: functions declared against
/// functions emitted per backend, `unimplemented!()` bodies, the committed
/// artifact against a fresh generation, and rustc's opinion of the generated
/// Rust. `make t27-lowering` already performs exactly those measurements,
/// corpus-wide; it is simply not wired into acceptance. This file is the
/// verdict, not the measurement - it runs no subprocess and reads no file, so
/// a suite can link it on its own.
///
/// Foundation and nothing else, deliberately, for the reason recorded in
/// `QueenBoundaryPaths`: the last rule that could only be reached through
/// `ChatMessage` went untested for months and was wrong the whole time.
enum QueenT27Acceptance {
    // MARK: - what the caller measures

    /// One backend's share of a spec, counted the way `t27-lowering` counts it.
    struct BackendEmission: Equatable, Sendable {
        /// `rust`, `zig`, `c`, `verilog` - whatever the caller generated. Kept
        /// as a string rather than an enum so a fifth backend can be measured
        /// without this policy being edited to permit it.
        let backend: String

        /// Functions found in the generated code.
        let emitted: Int

        /// Functions this backend is DECLARED unable to lower, with the reason
        /// recorded where a person reads it - the Makefile's
        /// `T27_LOWERING_EXCEPT`, today exactly one entry, `auto_config.t27:c:2`:
        /// `create_default_config` and `create_backup` return
        /// `[u32; MAX_PARAMS]` by value, C cannot return an array by value, so
        /// Rust and Zig emit all 19 and C emits 17.
        ///
        /// Without this field the first task to touch `auto_config.t27` would
        /// be refused for a backend limitation it did not cause, and the second
        /// would arrive to find the gate switched off.
        let declaredShortfall: Int

        init(backend: String, emitted: Int, declaredShortfall: Int = 0) {
            self.backend = backend
            self.emitted = emitted
            self.declaredShortfall = declaredShortfall
        }
    }

    /// A generated file committed alongside its spec.
    struct Artifact: Equatable, Sendable {
        let path: String

        /// Whether the committed bytes equal a fresh generation from the spec
        /// as committed.
        let matchesFreshGeneration: Bool

        init(path: String, matchesFreshGeneration: Bool) {
            self.path = path
            self.matchesFreshGeneration = matchesFreshGeneration
        }
    }

    /// One touched spec, measured.
    struct SpecMeasurement: Equatable, Sendable {
        let path: String

        /// Functions the `.t27` declares.
        let declaredFunctions: Int

        /// What each backend emitted from it.
        let backends: [BackendEmission]

        /// `unimplemented!()` occurrences in the generated Rust.
        let stubbedBodies: Int

        /// Generated files committed with the change, if any. A ring that
        /// commits no artifact - `rings/T27-00` today - passes an empty array,
        /// and nothing here invents a drift to report.
        let artifacts: [Artifact]

        /// Whether the generated Rust compiles under a FULL `--crate-type lib`
        /// build. `--emit=metadata` does not run the MIR const-prop lint and so
        /// hides every `arithmetic_overflow`: `olsr_routing` reports 13 errors
        /// under metadata and 26 under a full build.
        let generatedRustCompiles: Bool

        /// Whether it compiled BEFORE this change, or nil when the spec is new.
        /// This is the per-spec half of the ratchet - see `compileRefusal`.
        let compiledBeforeChange: Bool?

        init(
            path: String,
            declaredFunctions: Int,
            backends: [BackendEmission],
            stubbedBodies: Int = 0,
            artifacts: [Artifact] = [],
            generatedRustCompiles: Bool = true,
            compiledBeforeChange: Bool? = true
        ) {
            self.path = path
            self.declaredFunctions = declaredFunctions
            self.backends = backends
            self.stubbedBodies = stubbedBodies
            self.artifacts = artifacts
            self.generatedRustCompiles = generatedRustCompiles
            self.compiledBeforeChange = compiledBeforeChange
        }
    }

    /// A finished task, as far as this policy needs to see it.
    struct Work: Equatable, Sendable {
        /// Every path the change touched. Reduce worktree paths with
        /// `QueenBoundaryPaths.projectRelative` before calling; matching below
        /// falls back to the basename for the case where the caller did not.
        let touchedPaths: [String]

        /// The measurements, one per touched spec. A touched spec with no
        /// measurement is refused rather than waved through - see `refusal`.
        let specs: [SpecMeasurement]

        /// How many generated Rust files in the WHOLE corpus were allowed not
        /// to compile before this change: `T27_NOCOMPILE_CEILING`, 11 of 70 on
        /// 2026-08-28, down from 20 on 2026-08-23.
        let nocompileBaseline: Int

        /// How many do not compile now, corpus-wide, or nil when the corpus was
        /// not re-measured. Nil skips only the corpus rule; the per-spec rule
        /// still judges everything this change touched.
        let nocompileNow: Int?

        init(
            touchedPaths: [String],
            specs: [SpecMeasurement],
            nocompileBaseline: Int,
            nocompileNow: Int? = nil
        ) {
            self.touchedPaths = touchedPaths
            self.specs = specs
            self.nocompileBaseline = nocompileBaseline
            self.nocompileNow = nocompileNow
        }
    }

    // MARK: - path handling

    /// Trims whitespace and leading `./` and `/` so two spellings compare equal.
    ///
    /// A local three-line trim rather than a call into `QueenBoundaryPaths`,
    /// because a policy that links a second file is a policy no suite will
    /// link. The real reduction - worktree prefix, project directory - is
    /// deliberately NOT copied here: it is a rule, it lives in one place, and
    /// the caller applies it before handing paths over.
    static func trimmed(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasPrefix("./") { value.removeFirst(2) }
        while value.hasPrefix("/") { value.removeFirst() }
        return value
    }

    /// Whether a path names a T27 spec.
    ///
    /// Case-insensitive on the extension only. A file called `Foo.T27` is the
    /// same source to t27c, and a gate that can be stepped around by holding
    /// the shift key is not a gate.
    static func isSpecPath(_ path: String) -> Bool {
        trimmed(path).lowercased().hasSuffix(".t27")
    }

    /// The `.t27` paths among everything the change touched, in the order given.
    static func touchedSpecs(in paths: [String]) -> [String] {
        paths.filter(isSpecPath)
    }

    /// The measurement for a touched path, or nil when none was supplied.
    ///
    /// Exact match first; basename second. The fallback exists because the
    /// caller's touched paths come from git or from a worker's tool calls and
    /// may still carry a worktree prefix, while the measurements are keyed by
    /// the spec the generator was pointed at. It is only taken when exactly one
    /// measurement carries that basename - measured 2026-08-28, `rings/` holds
    /// 70 specs and no two share one, and `T27_LOWERING_EXCEPT` keys its own
    /// entries by basename for the same reason. Two candidates is a guess, and
    /// a guess here would either excuse a spec nobody measured or refuse one
    /// that was fine.
    static func measurement(
        for path: String,
        among specs: [SpecMeasurement]
    ) -> SpecMeasurement? {
        let wanted = trimmed(path)
        if let exact = specs.first(where: { trimmed($0.path) == wanted }) { return exact }
        let base = (wanted as NSString).lastPathComponent
        guard !base.isEmpty else { return nil }
        let sameName = specs.filter {
            (trimmed($0.path) as NSString).lastPathComponent == base
        }
        return sameName.count == 1 ? sameName[0] : nil
    }

    // MARK: - the verdict

    /// The reason this work may not be accepted, or nil when it may.
    ///
    /// Order is chosen, not incidental. A dropped function is reported before a
    /// compile failure on the same spec, because the drop is usually the cause
    /// of the failure and is always the more actionable sentence. The corpus
    /// ratchet is last, because it is the only rule whose subject is the
    /// repository rather than this change.
    static func refusal(for work: Work) -> String? {
        let touched = touchedSpecs(in: work.touchedPaths)

        // Not this policy's business. A change with no spec and no measurement
        // is a Swift change, and this file has no opinion about Swift.
        //
        // `specs` is checked as well as `touchedPaths` on purpose: a change
        // that edits a generated file WITHOUT editing its `.t27` touches no
        // spec and is precisely the L0 hand-edit this policy must catch. The
        // caller supplies the spec's measurement in that case, and the artifact
        // rule below fires.
        if touched.isEmpty && work.specs.isEmpty { return nil }

        // Nothing measured is not the same as nothing wrong, and t27c's exit
        // status cannot tell them apart.
        for path in touched where measurement(for: path, among: work.specs) == nil {
            return "`\(trimmed(path))` is a T27 spec and this change touched it, but no "
                + "lowering measurement was supplied for it. `make t27-lowering` is that "
                + "measurement. Without it the only evidence is that t27c exited 0, and "
                + "t27c exits 0 on a spec it silently truncated (gHashTag/t27#2508). Run "
                + "the gate, or accept this by hand and record why."
        }

        for spec in work.specs {
            if let reason = structuralRefusal(spec: spec) { return reason }
        }
        for spec in work.specs {
            if let reason = compileRefusal(spec: spec, baseline: work.nocompileBaseline) {
                return reason
            }
        }
        return corpusRefusal(now: work.nocompileNow, baseline: work.nocompileBaseline)
    }

    /// What the spec itself says: functions kept, bodies kept, artifact honest.
    ///
    /// Named separately so each rule is reachable from a test without
    /// assembling a whole `Work`.
    static func structuralRefusal(spec: SpecMeasurement) -> String? {
        if let reason = shortfallRefusal(spec: spec) { return reason }
        if let reason = stubRefusal(spec: spec) { return reason }
        return artifactRefusal(spec: spec)
    }

    /// A backend that emitted fewer functions than the spec declares.
    ///
    /// Shortfall only. The Makefile pins Rust and Zig to exact equality, and
    /// this policy deliberately does not: emitting MORE than declared is not
    /// silent deletion, and two backends do it by design - Verilog adds a
    /// wrapper, C emits the spec's test blocks. Pinning a count I cannot
    /// explain would refuse correct work, and a gate that refuses correct work
    /// is switched off within a week and then protects nothing. The direction
    /// with evidence behind it is the one measured on `trust_manager.t27`:
    /// 21 declared, 12 emitted, nine functions gone.
    static func shortfallRefusal(spec: SpecMeasurement) -> String? {
        for backend in spec.backends {
            let missing = spec.declaredFunctions - backend.emitted
            guard missing > 0 else { continue }
            let undeclared = missing - backend.declaredShortfall
            guard undeclared > 0 else { continue }
            if backend.declaredShortfall > 0 {
                return "`\(trimmed(spec.path))` declares \(spec.declaredFunctions) "
                    + "functions and the \(backend.backend) backend emitted "
                    + "\(backend.emitted). \(backend.declaredShortfall) of that shortfall "
                    + "is declared in T27_LOWERING_EXCEPT and \(undeclared) is not. Either "
                    + "the spec lost code to gHashTag/t27#2508, or this is a new backend "
                    + "limitation, and a new limitation has to be declared with a reason "
                    + "before work resting on it can be accepted."
            }
            return "`\(trimmed(spec.path))` declares \(spec.declaredFunctions) functions "
                + "and the \(backend.backend) backend emitted \(backend.emitted): "
                + "\(missing) were dropped between the spec and the generated code. t27c "
                + "recovers from a statement it cannot parse by skipping it and still "
                + "exits 0 (gHashTag/t27#2508), so nothing downstream reports this - code "
                + "nobody calls cannot fail a test. Rewrite the spec into the subset the "
                + "parser accepts - parenthesised conditions, explicit returns, no match - "
                + "until the two counts agree."
        }
        return nil
    }

    /// An emptied body.
    ///
    /// `unimplemented!()` is t27c's EMPTY-BODY fallback, not a per-construct
    /// stub, so it means a body was emptied rather than that a function was
    /// left deliberately unwritten. Counted separately from the shortfall
    /// because the two hide each other: a spec can keep every function and lose
    /// every body, and the count stays right while the code stops meaning
    /// anything.
    static func stubRefusal(spec: SpecMeasurement) -> String? {
        guard spec.stubbedBodies > 0 else { return nil }
        let plural = spec.stubbedBodies == 1 ? "body" : "bodies"
        return "`\(trimmed(spec.path))` generated \(spec.stubbedBodies) `unimplemented!()` "
            + "\(plural). That is t27c's empty-body fallback rather than a deliberate "
            + "stub, so a function survived by name and lost its contents. Find the "
            + "statement the parser gave up on and rewrite it; the function count will "
            + "not tell you, because it still agrees."
    }

    /// A committed artifact that is not what its spec generates now.
    ///
    /// L0: generated files are artifacts, they are not edited, and a diff that
    /// changes one without changing its `.t27` is a defect. The measurement
    /// cannot say WHICH of the two happened - a hand edit, or a spec that moved
    /// and left its artifact behind - so the message names both and asks for
    /// the one action that fixes either.
    static func artifactRefusal(spec: SpecMeasurement) -> String? {
        for artifact in spec.artifacts where !artifact.matchesFreshGeneration {
            return "`\(trimmed(artifact.path))` is not what `\(trimmed(spec.path))` "
                + "generates now. Under L0 a generated file is an artifact and is never "
                + "edited, so this is either a hand edit or a stale commit - regenerating "
                + "from the spec and committing the result fixes both. If the difference "
                + "is wanted, it belongs in the `.t27`, where it will survive the next "
                + "generation."
        }
        return nil
    }

    /// The per-spec half of the compile ratchet.
    ///
    /// This is the rule most likely to be written wrongly, so it is written
    /// narrowly. Eleven of the corpus's seventy generated Rust files do not
    /// compile today, for reasons upstream of this repository - chiefly
    /// `gen-rust` never emitting `mut` on a function parameter. Refusing a task
    /// because a spec it touched was already in that eleven would refuse work
    /// for a defect the work did not cause, and a gate that does that is turned
    /// off. So a pre-existing failure passes, and only two things are refused:
    ///
    /// - it compiled before this change and does not now - a regression;
    /// - it is new and does not compile - which raises the corpus count by one,
    ///   which is the same harm arriving by a different door.
    ///
    /// A spec that did not compile and still does not is accepted with no
    /// comment. Fixing it was never this task's job.
    static func compileRefusal(spec: SpecMeasurement, baseline: Int) -> String? {
        guard !spec.generatedRustCompiles else { return nil }
        switch spec.compiledBeforeChange {
        case .some(true):
            return "the Rust generated from `\(trimmed(spec.path))` does not compile, and "
                + "it did before this change. Measured with a full `--crate-type lib` "
                + "build, which `--emit=metadata` would have hidden - metadata skips the "
                + "const-prop lint and every `arithmetic_overflow` with it. Counting "
                + "functions did not catch this: a body can lose a `return` and keep its "
                + "signature."
        case .none:
            return "`\(trimmed(spec.path))` is new and the Rust generated from it does not "
                + "compile, so this change adds one to the corpus count of \(baseline) that "
                + "already do not. That number is a ratchet - it falls, and it is raised "
                + "only with a reason in the commit message - so a new spec has to compile "
                + "on the way in."
        case .some(false):
            // Pre-existing, upstream of us, and explicitly not refused.
            return nil
        }
    }

    /// The corpus half of the ratchet.
    ///
    /// The per-spec rule cannot see everything, which is why this one exists:
    /// a change may regenerate artifacts across the tree - tri-net 2257dea
    /// regenerated eighteen stale ones in a single commit - and move the count
    /// for specs it never named. The per-spec rule cannot see those, and this
    /// one cannot see a net-zero swap where one spec is fixed and another
    /// broken. Neither subsumes the other, so both run.
    ///
    /// At or below the baseline is accepted, including when the baseline is not
    /// zero. That is the whole point of a ratchet: it is a number that may only
    /// fall, not a target that must already be met.
    static func corpusRefusal(now: Int?, baseline: Int) -> String? {
        guard let now, now > baseline else { return nil }
        return "\(now) generated Rust files in the corpus do not compile, above the "
            + "recorded baseline of \(baseline). The baseline is a ratchet: it may fall, "
            + "and raising it takes a reason in the commit message, which is a decision "
            + "for the operator and not for a task. Bring it back to \(baseline) or below, "
            + "or say in the issue which \(now - baseline) are new and why they have to be."
    }
}
