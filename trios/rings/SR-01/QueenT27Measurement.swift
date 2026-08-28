import Foundation

/// Measures a T27 change so `QueenT27Acceptance` can judge one.
///
/// `QueenT27Acceptance` is a pure policy: it decides and it measures nothing.
/// This file is the other half. It runs `t27c` and `rustc` the way
/// `make t27-lowering` runs them, counts what they produced, and hands the
/// counts over as a `QueenT27Acceptance.Work`.
///
/// ## The rule this file exists to obey
///
/// An unmeasured spec must never arrive at the policy looking like a measured
/// one. That is how a gate silently starts passing everything, and this tree
/// has shipped it more than once - most recently a compile gate that never
/// found its compiler and reported success. So nothing here defaults a number
/// to 0 or a flag to `true`. Every step returns `Outcome<T>`: either
/// `.measured(value)` or `.unmeasurable(reason)`, and a spec whose measurement
/// failed is left OUT of `Work.specs` and listed in `Report.unmeasured`
/// instead. The policy then refuses it by its own rule - "this change touched
/// a T27 spec and no lowering measurement was supplied for it" - and the
/// report says which command failed and why. Fail-closed, with the reason
/// attached.
///
/// The same discipline covers the corpus sweep. A sweep that could not
/// generate every spec returns `.unmeasurable` rather than an undercount,
/// because an undercount reads as "fewer files are broken than before", which
/// is the ratchet running backwards while looking like progress.
///
/// ## Pure part and shell part
///
/// Everything above `MARK: - the shell` is pure: it takes Strings and returns
/// values, runs no subprocess and touches no file. That is the counting, the
/// Makefile parsing, the spec/artifact path rules, and `assemble`, which is
/// where measured and unmeasurable outcomes are separated. `tests/swift/
/// queen_t27_measurement_test.swift` exercises exactly that layer, on captured
/// `t27c` output, so the suite needs neither `t27c` nor `rustc` to run.
///
/// The shell layer below is deliberately thin: `run` (one `Process`),
/// `generate` (one `t27c`), `compilesAsRustLib` (one `rustc`), and the small
/// amount of glue that sequences them. It is untested by construction, which
/// is why there is so little of it.
///
/// ## What one spec costs
///
/// Measured on this machine on 2026-08-28, wall clock, through THIS code
/// rather than through the shell - a driver that links this file and
/// `QueenT27Acceptance` and calls `measureWork`, run six times. The number is
/// `Report.seconds`, so it is not a claim in a comment: print it and
/// re-measure whenever you doubt this paragraph.
///
///   - one spec whose Rust compiles (`queen_core.t27`):  0.36 - 0.50 s
///   - the same spec, first call in a fresh process:     0.92 - 3.60 s
///   - two such specs in one call:                       0.70 - 0.74 s
///   - one spec whose Rust does NOT compile
///     (`auto_config.t27`, so history is consulted):     0.70 - 1.13 s
///   - `sweepCorpus`, all 70 specs in `rings/`:          9.9 - 11.7 s
///
/// The first call in a process is several times the rest: `t27c` and `rustc`
/// are being paged in, and a `Process` spawn is most of what this code does.
/// A spec that does not compile roughly doubles, because that is the only
/// case where the baseline pass runs - see `baselineField`.
///
/// So a task touching one to three specs pays well under a second, and a
/// caller that also asks for the corpus sweep pays about ten. Acceptance runs
/// once per task; this is cheap enough to run on every one, and the corpus
/// sweep is cheap enough to run on the ones that touch a spec.
///
/// ## Fidelity
///
/// The counters mirror `make t27-lowering` (Makefile lines ~961-1056)
/// character for character, including that `grep -c` counts matching LINES
/// rather than occurrences. Re-measured against the live tree on 2026-08-28:
/// this file's corpus sweep reports 11 non-compiling specs, which is exactly
/// `T27_NOCOMPILE_CEILING`, and `auto_config.t27` reports 19 declared / 19
/// rust / 19 zig / 17 c, which is exactly the `auto_config.t27:c:2` entry in
/// `T27_LOWERING_EXCEPT`.
///
/// Two of those commands are load-bearing in ways that are easy to get wrong:
///
///   - `rustc` runs a FULL `--crate-type lib` build. `--emit=metadata` skips
///     the MIR const-prop lint and hides every `arithmetic_overflow`:
///     `olsr_routing` reports 13 errors under metadata and 26 under a full
///     build. A metadata build makes this gate optimistic.
///   - the ceiling and the declared shortfalls are READ from the Makefile, not
///     typed in here. The ceiling fell from 20 to 11 on 2026-08-28 and will
///     fall again; a copy of it in Swift would be wrong by the next commit,
///     and hard-coding zero shortfalls would re-break `auto_config.t27`.
///
/// Foundation and `QueenT27Acceptance`, and nothing else. The policy's own
/// note applies here too: a file that drags half the app in is a file no suite
/// will link, and a rule no suite links is a rule nobody checks.
enum QueenT27Measurement {

    // MARK: - what could not be measured

    /// Why a measurement did not happen.
    ///
    /// Every case names a specific failed step, because "measurement failed"
    /// is not an actionable sentence and this type is read by a supervisor
    /// that has to decide what to do next.
    enum Unmeasurable: Equatable, Sendable {
        /// No `t27c` binary at the path we looked at.
        case generatorMissing(path: String)
        /// `t27c` exists but the process would not start.
        case generatorUnspawnable(path: String)
        /// `t27c` ran and exited nonzero for this backend.
        case generationFailed(backend: String, spec: String, exitStatus: Int32, detail: String)
        /// No `rustc` at any of the paths we know about.
        case rustcMissing(searched: [String])
        /// `rustc` exists but the process would not start.
        case rustcUnspawnable(path: String)
        /// No `git`, so history cannot be consulted.
        case gitMissing(searched: [String])
        /// `git` exists but the process would not start.
        case gitUnspawnable(path: String)
        /// History was consulted and could not answer.
        case historyUnavailable(spec: String, ref: String, detail: String)
        /// The `.t27` itself could not be read.
        case specUnreadable(path: String, detail: String)
        /// A committed generated file could not be read.
        case artifactUnreadable(path: String, detail: String)
        /// The Makefile could not be read, so neither the ceiling nor the
        /// declared shortfalls are known.
        case makefileUnreadable(path: String, detail: String)
        /// The Makefile was read and declares no `T27_NOCOMPILE_CEILING`.
        case ceilingNotDeclared(makefile: String)
        /// The scratch directory could not be created or written.
        case scratchUnusable(path: String, detail: String)
        /// The corpus sweep did not finish, so its count is an undercount and
        /// is refused rather than reported.
        case corpusIncomplete(measured: Int, total: Int, firstFailure: String)

        /// One English line, for a supervisor to print or paste into a task.
        var sentence: String {
            switch self {
            case .generatorMissing(let path):
                return "there is no t27c at \(path), so nothing about this spec was generated "
                    + "or counted. `make t27-rings` builds one."
            case .generatorUnspawnable(let path):
                return "t27c is at \(path) but the process would not start, so nothing was "
                    + "generated or counted."
            case .generationFailed(let backend, let spec, let status, let detail):
                let tail = detail.isEmpty ? "" : " It said: \(detail)"
                return "t27c exited \(status) generating \(backend) from \(spec), so that "
                    + "backend was not counted and this spec has no verdict.\(tail)"
            case .rustcMissing(let searched):
                return "no rustc was found in \(searched.joined(separator: ", ")), so whether "
                    + "the generated Rust compiles is unknown. It is NOT assumed to compile: "
                    + "assuming it is how a compile gate reports success without a compiler."
            case .rustcUnspawnable(let path):
                return "rustc is at \(path) but the process would not start, so whether the "
                    + "generated Rust compiles is unknown."
            case .gitMissing(let searched):
                return "no git was found in \(searched.joined(separator: ", ")), so whether "
                    + "this spec compiled BEFORE the change is unknown."
            case .gitUnspawnable(let path):
                return "git is at \(path) but the process would not start, so whether this "
                    + "spec compiled BEFORE the change is unknown."
            case .historyUnavailable(let spec, let ref, let detail):
                return "the state of \(spec) at \(ref) could not be read, so whether it "
                    + "compiled before this change is unknown: \(detail)"
            case .specUnreadable(let path, let detail):
                return "\(path) could not be read, so the functions it declares were never "
                    + "counted: \(detail)"
            case .artifactUnreadable(let path, let detail):
                return "\(path) could not be read, so it was not compared against a fresh "
                    + "generation: \(detail)"
            case .makefileUnreadable(let path, let detail):
                return "\(path) could not be read, so neither T27_NOCOMPILE_CEILING nor "
                    + "T27_LOWERING_EXCEPT is known: \(detail)"
            case .ceilingNotDeclared(let makefile):
                return "\(makefile) declares no T27_NOCOMPILE_CEILING. That number is the "
                    + "corpus baseline and is not guessed here - a guessed ceiling either "
                    + "refuses every change or excuses every one."
            case .scratchUnusable(let path, let detail):
                return "the scratch directory \(path) could not be used, so nothing could be "
                    + "handed to rustc: \(detail)"
            case .corpusIncomplete(let measured, let total, let first):
                return "the corpus sweep reached \(measured) of \(total) specs and stopped, so "
                    + "its non-compiling count would be an undercount and is not reported. "
                    + "The first failure was: \(first)"
            }
        }
    }

    /// A measured value, or the reason there is not one.
    ///
    /// There is deliberately no `Outcome.valueOrDefault`. Every default is a
    /// number somebody did not measure, wearing the clothes of one that
    /// somebody did.
    enum Outcome<Value: Sendable>: Sendable {
        case measured(Value)
        case unmeasurable(Unmeasurable)

        var measuredValue: Value? {
            if case .measured(let value) = self { return value }
            return nil
        }

        var reason: Unmeasurable? {
            if case .unmeasurable(let why) = self { return why }
            return nil
        }

        var wasMeasured: Bool { measuredValue != nil }
    }

    /// A spec that was touched and could not be measured, with the reason.
    struct Unmeasured: Equatable, Sendable {
        let path: String
        let reason: Unmeasurable
    }

    /// One spec's measurement attempt, keyed by the path the caller named.
    struct SpecOutcome: Equatable, Sendable {
        let path: String
        let outcome: Outcome<QueenT27Acceptance.SpecMeasurement>

        init(path: String, outcome: Outcome<QueenT27Acceptance.SpecMeasurement>) {
            self.path = path
            self.outcome = outcome
        }
    }

    /// Everything the caller needs: what to judge, and what could not be judged.
    ///
    /// `work` goes to `QueenT27Acceptance.refusal(for:)`. `unmeasured` is
    /// printed alongside the verdict; it is never empty and silent, because a
    /// spec in it is a spec the policy will refuse for a reason ("no
    /// measurement was supplied") that says nothing about WHY - and the why is
    /// here.
    struct Report: Equatable, Sendable {
        let work: QueenT27Acceptance.Work
        let unmeasured: [Unmeasured]
        /// The corpus sweep, when one was asked for. `nil` means it was not
        /// requested; `.unmeasurable` means it was requested and did not
        /// finish.
        let corpus: Outcome<Int>?
        /// Wall-clock seconds this report cost, so the caller can see the
        /// price rather than read it in a comment that went stale.
        let seconds: Double

        /// Whether every touched spec produced a measurement.
        var everythingMeasured: Bool {
            unmeasured.isEmpty && (corpus == nil || corpus?.wasMeasured == true)
        }

        /// The lines a supervisor should print with the verdict.
        var summary: String {
            var lines: [String] = []
            lines.append(
                "measured \(work.specs.count) spec(s) in "
                    + String(format: "%.2f", seconds) + "s "
                    + "(ceiling \(work.nocompileBaseline))"
            )
            for item in unmeasured {
                lines.append("NOT MEASURED - \(item.path): \(item.reason.sentence)")
            }
            switch corpus {
            case .none:
                lines.append("corpus not swept, so the corpus ratchet was not checked")
            case .some(.measured(let count)):
                lines.append("corpus: \(count) generated Rust file(s) do not compile")
            case .some(.unmeasurable(let why)):
                lines.append("corpus NOT MEASURED - \(why.sentence)")
            }
            return lines.joined(separator: "\n")
        }
    }

    // MARK: - backends

    /// The four backends `t27-lowering` counts, with the subcommand each one
    /// needs. `gen` is Zig; it is the odd one out and has been misread before.
    enum Backend: String, Sendable, CaseIterable {
        case rust
        case zig
        case c
        case verilog

        var subcommand: String {
            switch self {
            case .rust: return "gen-rust"
            case .zig: return "gen"
            case .c: return "gen-c"
            case .verilog: return "gen-verilog"
            }
        }
    }

    // MARK: - pure counting

    /// POSIX `[[:space:]]` minus the newline, since every predicate below runs
    /// on one line at a time.
    static let horizontalSpace: Set<Character> = [" ", "\t", "\r", "\u{0B}", "\u{0C}"]

    /// `grep -c`: the number of LINES that match, not the number of matches.
    /// Two hits on one line count once, in the Makefile and here.
    static func matchingLineCount(in text: String, where predicate: (Substring) -> Bool) -> Int {
        var count = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false)
        where predicate(line) {
            count += 1
        }
        return count
    }

    private static func withoutLeadingSpace(_ line: Substring) -> Substring {
        line.drop(while: { horizontalSpace.contains($0) })
    }

    /// `^[[:space:]]*(pub )?fn ` against a `.t27` line.
    ///
    /// Indentation is allowed because specs really do indent them:
    /// `timing_closure.t27` declares its whole body inside an indented block.
    /// `pub  fn` with two spaces does not match, in the ERE and here, because
    /// the optional group carries the single space with it.
    static func declaresFunction(_ line: Substring) -> Bool {
        var rest = withoutLeadingSpace(line)
        if rest.hasPrefix("pub ") { rest = rest.dropFirst(4) }
        return rest.hasPrefix("fn ")
    }

    /// `^pub fn ` against generated Rust.
    static func rustEmitsFunction(_ line: Substring) -> Bool {
        line.hasPrefix("pub fn ")
    }

    /// `^(pub )?fn ` against generated Zig. No leading whitespace: t27c emits
    /// Zig functions at column zero, and the Makefile's pattern says so.
    static func zigEmitsFunction(_ line: Substring) -> Bool {
        var rest = line
        if rest.hasPrefix("pub ") { rest = rest.dropFirst(4) }
        return rest.hasPrefix("fn ")
    }

    /// `^[a-zA-Z_].*\(.*\) *\{` against generated C.
    ///
    /// The `{` is what separates a definition from a prototype: t27c emits
    /// every function twice, once as `bool f(int32_t k);` in the header block
    /// and once as `bool f(int32_t k) {`, and a pattern that counted both
    /// would report double and never notice a dropped body.
    static func cEmitsFunction(_ line: Substring) -> Bool {
        guard let first = line.first else { return false }
        let isIdentifierHead =
            (first >= "a" && first <= "z") || (first >= "A" && first <= "Z") || first == "_"
        guard isIdentifierHead else { return false }
        let characters = Array(line)
        // `[a-zA-Z_]` consumed index 0, so the `(` must be at 1 or later.
        guard let open = (1..<characters.count).first(where: { characters[$0] == "(" }) else {
            return false
        }
        var index = open + 1
        while index < characters.count {
            if characters[index] == ")" {
                var after = index + 1
                // ` *` is spaces only in the ERE - not tabs.
                while after < characters.count, characters[after] == " " { after += 1 }
                if after < characters.count, characters[after] == "{" { return true }
            }
            index += 1
        }
        return false
    }

    /// `^[[:space:]]*function ` against generated Verilog. Indented, because
    /// t27c nests them inside the module.
    static func verilogEmitsFunction(_ line: Substring) -> Bool {
        withoutLeadingSpace(line).hasPrefix("function ")
    }

    /// Functions a `.t27` declares.
    static func declaredFunctions(inSpec text: String) -> Int {
        matchingLineCount(in: text, where: declaresFunction)
    }

    /// Functions a backend emitted, counted the way `t27-lowering` counts that
    /// backend.
    static func emittedFunctions(_ backend: Backend, in generated: String) -> Int {
        switch backend {
        case .rust: return matchingLineCount(in: generated, where: rustEmitsFunction)
        case .zig: return matchingLineCount(in: generated, where: zigEmitsFunction)
        case .c: return matchingLineCount(in: generated, where: cEmitsFunction)
        case .verilog: return matchingLineCount(in: generated, where: verilogEmitsFunction)
        }
    }

    /// `grep -c 'unimplemented!'` on the generated Rust: lines, not
    /// occurrences, exactly as the Makefile counts them.
    static func stubbedBodies(inGeneratedRust text: String) -> Int {
        matchingLineCount(in: text, where: { $0.contains("unimplemented!") })
    }

    // MARK: - pure Makefile reading

    /// One backend shortfall declared in `T27_LOWERING_EXCEPT`.
    struct DeclaredShortfall: Equatable, Sendable {
        /// The spec's basename with its extension, e.g. `auto_config.t27`. The
        /// Makefile keys by basename and so does this, for the reason
        /// `QueenT27Acceptance.measurement(for:among:)` records: `rings/` holds
        /// 70 specs and no two share a basename.
        let spec: String
        /// `c`, lowercased.
        let backend: String
        /// How many functions that backend is declared unable to lower.
        let count: Int
    }

    /// The value of a Makefile variable, or nil when the file does not define it.
    ///
    /// An assignment starts in column zero. That single rule is what keeps
    /// `$(T27_LOWERING_EXCEPT)` inside a tab-indented recipe - it appears five
    /// times in `t27-lowering` alone - from being read as a definition, and
    /// keeps the tab-indented variable LIST at Makefile line 865 from being
    /// read as one either.
    static func makefileValue(of name: String, in makefile: String) -> String? {
        var value: String?
        for raw in makefile.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let first = raw.first, first != " ", first != "\t" else { continue }
            var line = raw
            if line.hasPrefix("export ") {
                line = line.dropFirst(7).drop(while: { $0 == " " })
            }
            guard line.hasPrefix(name) else { continue }
            var rest = line.dropFirst(name.count).drop(while: { $0 == " " || $0 == "\t" })
            let operators = ["::=", ":=", "?=", "+=", "="]
            guard let op = operators.first(where: { rest.hasPrefix($0) }) else { continue }
            rest = rest.dropFirst(op.count)

            // make ends a value at the first unescaped `#`.
            var text = ""
            var escaped = false
            for character in rest {
                if escaped {
                    text.append(character)
                    escaped = false
                    continue
                }
                if character == "\\" {
                    escaped = true
                    text.append(character)
                    continue
                }
                if character == "#" { break }
                text.append(character)
            }
            let trimmed = text.trimmingCharacters(in: .whitespaces)

            switch op {
            case "+=":
                if let existing = value, !existing.isEmpty {
                    value = trimmed.isEmpty ? existing : existing + " " + trimmed
                } else {
                    value = trimmed
                }
            case "?=":
                // `?=` does not override a value already set above it.
                if value == nil { value = trimmed }
            default:
                value = trimmed
            }
        }
        return value
    }

    /// `T27_NOCOMPILE_CEILING`, or nil when the Makefile does not declare one.
    ///
    /// Nil, never a number. The ceiling is the corpus baseline; a guessed one
    /// is either zero, which refuses every change, or something large, which
    /// excuses every change.
    static func nocompileCeiling(inMakefile text: String) -> Int? {
        guard let raw = makefileValue(of: "T27_NOCOMPILE_CEILING", in: text) else { return nil }
        return Int(raw.trimmingCharacters(in: .whitespaces))
    }

    /// `T27_LOWERING_EXCEPT`, parsed. Empty when the Makefile declares none.
    static func declaredShortfalls(inMakefile text: String) -> [DeclaredShortfall] {
        guard let raw = makefileValue(of: "T27_LOWERING_EXCEPT", in: text) else { return [] }
        return declaredShortfalls(inDeclaration: raw)
    }

    /// The entries in a `T27_LOWERING_EXCEPT` value: `spec.t27:backend:count`,
    /// space separated. Today exactly one, `auto_config.t27:c:2`.
    static func declaredShortfalls(inDeclaration raw: String) -> [DeclaredShortfall] {
        var found: [DeclaredShortfall] = []
        for token in raw.split(whereSeparator: { horizontalSpace.contains($0) }) {
            let parts = token.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 3,
                  !parts[0].isEmpty,
                  !parts[1].isEmpty,
                  let count = Int(parts[2]),
                  count > 0
            else { continue }
            found.append(
                DeclaredShortfall(
                    spec: String(parts[0]),
                    backend: String(parts[1]).lowercased(),
                    count: count
                )
            )
        }
        return found
    }

    /// Tokens in a `T27_LOWERING_EXCEPT` value that are not `spec:backend:count`.
    ///
    /// The Makefile's `grep -q " name:c:n "` ignores a malformed entry in
    /// silence, so a typo there switches a declared exception off and nothing
    /// says a word. This returns them so the caller can.
    static func unparsableExceptions(inDeclaration raw: String) -> [String] {
        var bad: [String] = []
        for token in raw.split(whereSeparator: { horizontalSpace.contains($0) }) {
            let parts = token.split(separator: ":", omittingEmptySubsequences: false)
            let wellFormed =
                parts.count == 3 && !parts[0].isEmpty && !parts[1].isEmpty
                && (Int(parts[2]).map { $0 > 0 } ?? false)
            if !wellFormed { bad.append(String(token)) }
        }
        return bad
    }

    /// How many functions `backend` is declared unable to lower from `spec`.
    ///
    /// Zero when nothing is declared, which is the honest answer: the shortfall
    /// is then undeclared and the policy refuses it, which is the whole point
    /// of the list.
    static func declaredShortfall(
        spec path: String,
        backend: String,
        among list: [DeclaredShortfall]
    ) -> Int {
        let base = (QueenT27Acceptance.trimmed(path) as NSString).lastPathComponent
        let wanted = backend.lowercased()
        // First match, not the sum: two entries for one pair is a mistake in
        // the Makefile, and adding them up would quietly double the excuse.
        return list.first(where: { $0.spec == base && $0.backend == wanted })?.count ?? 0
    }

    // MARK: - pure path rules

    /// Whether a path in the tree is one of the 70 specs `t27-lowering`
    /// measures.
    ///
    /// The exclusions are not decoration. The first version of that gate
    /// scanned `rings/RUST-13/trios-mesh/.claude/worktrees/<name>/specs` too
    /// and reported 138 specs instead of 70, failing on a defect that had
    /// already been fixed in the tree that ships.
    static func isCorpusSpec(_ path: String) -> Bool {
        guard QueenT27Acceptance.isSpecPath(path) else { return false }
        return !path.contains("/.worktrees/") && !path.contains("/.claude/")
    }

    /// The specs among the paths a change touched, deduplicated, in order.
    ///
    /// No worktree exclusion here, on purpose: a worker's own writes arrive
    /// carrying `.worktrees/<variant>/<task>/trios/...`, and the caller reduces
    /// them with `QueenBoundaryPaths.projectRelative` first. Excluding them
    /// here would drop every spec a bee actually edited.
    static func specPaths(among touched: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for path in QueenT27Acceptance.touchedSpecs(in: touched) {
            if seen.insert(QueenT27Acceptance.trimmed(path)).inserted { ordered.append(path) }
        }
        return ordered
    }

    /// An absolute path for a spec the caller may have named relatively.
    static func absolutePath(_ path: String, root: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("/") { return trimmed }
        let base = root.hasSuffix("/") ? String(root.dropLast()) : root
        return "\(base)/\(QueenT27Acceptance.trimmed(trimmed))"
    }

    /// Whether a committed generated file is what its spec generates now.
    ///
    /// Trailing newlines are normalised on both sides and nothing else is.
    /// `t27c` writes to stdout and the Makefile captures it through
    /// `$(...)`, which strips trailing newlines, while a file committed to git
    /// conventionally ends with one - so a byte-exact comparison would report
    /// drift on every artifact in the tree for a difference no editor made.
    /// Any other difference, including whitespace inside the file, is drift.
    static func artifactMatches(committed: String, freshlyGenerated: String) -> Bool {
        droppingTrailingNewlines(committed) == droppingTrailingNewlines(freshlyGenerated)
    }

    static func droppingTrailingNewlines(_ text: String) -> String {
        var value = Substring(text)
        while let last = value.last, last == "\n" || last == "\r" { value = value.dropLast() }
        return String(value)
    }

    /// What to pass the policy for `compiledBeforeChange`.
    ///
    /// The policy reads that field only inside `compileRefusal`, which returns
    /// early unless the generated Rust fails to compile NOW. So when it
    /// compiles, history cannot change any verdict and is not consulted - that
    /// is the halving of the cost noted at the top of this file, and `nil` is
    /// passed because all three values are inert there.
    ///
    /// When it does NOT compile, history decides between three different
    /// outcomes - a regression, a new spec that never compiled, and one of the
    /// eleven pre-existing failures that is explicitly nobody's fault - and
    /// guessing picks a wrong one. `.some(false)` would excuse a real
    /// regression; `.some(true)` would refuse a task for a failure it did not
    /// cause, which is how a gate gets switched off. So an unreadable history
    /// is propagated as unmeasurable and the spec drops out of the Work.
    static func baselineField(
        compilesNow: Bool,
        history: Outcome<Bool?>
    ) -> Outcome<Bool?> {
        if compilesNow { return .measured(nil) }
        return history
    }

    // MARK: - pure assembly

    /// Splits measured specs from unmeasurable ones and builds the `Work`.
    ///
    /// This is the function the whole file is arranged around. An
    /// unmeasurable spec is NOT given a placeholder `SpecMeasurement` - it is
    /// left out of `Work.specs` entirely, which makes it a touched spec with
    /// no measurement, which is a case `QueenT27Acceptance.refusal` already
    /// refuses by name. So the failure mode of this adapter is a refusal with
    /// a reason attached, not an acceptance with a fabricated number behind it.
    static func assemble(
        touchedPaths: [String],
        outcomes: [SpecOutcome],
        nocompileBaseline: Int,
        corpus: Outcome<Int>?,
        seconds: Double
    ) -> Report {
        var measured: [QueenT27Acceptance.SpecMeasurement] = []
        var unmeasured: [Unmeasured] = []
        for item in outcomes {
            switch item.outcome {
            case .measured(let spec):
                measured.append(spec)
            case .unmeasurable(let why):
                unmeasured.append(Unmeasured(path: item.path, reason: why))
            }
        }
        return Report(
            work: QueenT27Acceptance.Work(
                touchedPaths: touchedPaths,
                specs: measured,
                nocompileBaseline: nocompileBaseline,
                // `nil` when the sweep did not happen or did not finish. The
                // policy documents nil as "the corpus was not re-measured" and
                // skips only the corpus rule; a 0 here would read as a corpus
                // in perfect health.
                nocompileNow: corpus?.measuredValue
            ),
            unmeasured: unmeasured,
            corpus: corpus,
            seconds: seconds
        )
    }

    // MARK: - the shell

    /// Where the tools are.
    ///
    /// Explicit absolute paths, checked in order, rather than resolved through
    /// a shell: an app launched from Finder does not inherit a login shell's
    /// PATH, which is the single most common way "works in the terminal, not
    /// in the app" happens. `AgentServerLauncher.bunCandidates` is the same
    /// pattern for the same reason.
    struct Tools: Sendable {
        var root: String
        var t27c: String
        var makefile: String
        var rustc: String?
        var git: String?
        var scratch: String

        static let rustcCandidates = [
            "\(NSHomeDirectory())/.cargo/bin/rustc",
            "/opt/homebrew/bin/rustc",
            "/usr/local/bin/rustc",
            "/usr/bin/rustc",
        ]

        static let gitCandidates = [
            "/usr/bin/git",
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
        ]

        /// `root` is the trios project directory - the caller passes
        /// `ProjectPaths.root`, which is why this file does not import it.
        static func forRoot(
            _ root: String,
            existsAt: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
        ) -> Tools {
            let base = root.hasSuffix("/") ? String(root.dropLast()) : root
            return Tools(
                root: base,
                t27c: "\(base)/.trinity/t27c-build/release/t27c",
                makefile: "\(base)/Makefile",
                rustc: rustcCandidates.first(where: existsAt),
                git: gitCandidates.first(where: existsAt),
                scratch: NSTemporaryDirectory() + "trios-t27-measurement"
            )
        }
    }

    struct CommandResult: Equatable, Sendable {
        let status: Int32
        let standardOutput: String
        let standardError: String
    }

    /// One subprocess. Returns nil only when it could not be started at all.
    ///
    /// Both streams go to files rather than pipes. `gen-rust` produces up to
    /// 14.5 KB across this corpus today, comfortably inside a pipe buffer -
    /// and "comfortably inside today" is exactly the assumption that turns
    /// into a deadlocked gate the week a spec grows.
    static func run(
        _ executable: String,
        _ arguments: [String],
        in directory: String? = nil
    ) -> CommandResult? {
        let manager = FileManager.default
        guard manager.isExecutableFile(atPath: executable) else { return nil }
        let stem = NSTemporaryDirectory() + "trios-t27-\(UUID().uuidString)"
        let outPath = stem + ".out"
        let errPath = stem + ".err"
        defer {
            try? manager.removeItem(atPath: outPath)
            try? manager.removeItem(atPath: errPath)
        }
        manager.createFile(atPath: outPath, contents: nil)
        manager.createFile(atPath: errPath, contents: nil)
        guard let outHandle = FileHandle(forWritingAtPath: outPath),
              let errHandle = FileHandle(forWritingAtPath: errPath)
        else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let directory { process.currentDirectoryURL = URL(fileURLWithPath: directory) }
        process.standardOutput = outHandle
        process.standardError = errHandle
        do {
            try process.run()
        } catch {
            try? outHandle.close()
            try? errHandle.close()
            return nil
        }
        process.waitUntilExit()
        try? outHandle.close()
        try? errHandle.close()
        let out = (try? Data(contentsOf: URL(fileURLWithPath: outPath))) ?? Data()
        let err = (try? Data(contentsOf: URL(fileURLWithPath: errPath))) ?? Data()
        return CommandResult(
            status: process.terminationStatus,
            standardOutput: String(decoding: out, as: UTF8.self),
            standardError: String(decoding: err, as: UTF8.self)
        )
    }

    private static func firstLine(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
    }

    /// Generates one backend from one spec.
    static func generate(
        _ backend: Backend,
        spec absoluteSpecPath: String,
        tools: Tools
    ) -> Outcome<String> {
        guard FileManager.default.isExecutableFile(atPath: tools.t27c) else {
            return .unmeasurable(.generatorMissing(path: tools.t27c))
        }
        guard let result = run(tools.t27c, [backend.subcommand, absoluteSpecPath]) else {
            return .unmeasurable(.generatorUnspawnable(path: tools.t27c))
        }
        guard result.status == 0 else {
            return .unmeasurable(
                .generationFailed(
                    backend: backend.rawValue,
                    spec: absoluteSpecPath,
                    exitStatus: result.status,
                    detail: firstLine(result.standardError)
                )
            )
        }
        return .measured(result.standardOutput)
    }

    private static func ensureScratch(_ tools: Tools) -> Unmeasurable? {
        do {
            try FileManager.default.createDirectory(
                atPath: tools.scratch, withIntermediateDirectories: true
            )
            return nil
        } catch {
            return .scratchUnusable(path: tools.scratch, detail: error.localizedDescription)
        }
    }

    /// Whether generated Rust survives a FULL `--crate-type lib` build.
    ///
    /// Not `--emit=metadata`. Metadata does not run the MIR const-prop lint
    /// and so hides every `arithmetic_overflow`: `olsr_routing` reports 13
    /// errors under metadata and 26 under a full build.
    static func compilesAsRustLib(
        _ generated: String,
        crateName: String,
        tools: Tools
    ) -> Outcome<Bool> {
        guard let rustc = tools.rustc else {
            return .unmeasurable(.rustcMissing(searched: Tools.rustcCandidates))
        }
        if let why = ensureScratch(tools) { return .unmeasurable(why) }
        let source = "\(tools.scratch)/\(crateName).rs"
        do {
            try generated.write(toFile: source, atomically: true, encoding: .utf8)
        } catch {
            return .unmeasurable(
                .scratchUnusable(path: source, detail: error.localizedDescription)
            )
        }
        guard let result = run(
            rustc,
            [
                "--edition", "2021",
                "--crate-type", "lib",
                "-A", "unused_parens",
                "--out-dir", tools.scratch,
                source,
            ]
        ) else {
            return .unmeasurable(.rustcUnspawnable(path: rustc))
        }
        return .measured(result.status == 0)
    }

    /// The repository that owns a path, and the path relative to it.
    ///
    /// Not an optimisation. `rings/RUST-13/trios-mesh` is a submodule, so
    /// `git -C <trios> show HEAD:./rings/RUST-13/trios-mesh/specs/auto_config.t27`
    /// fails - the parent tree stores a gitlink, not the file - and reading
    /// that failure as "the spec is new" would tell the policy to refuse 40-odd
    /// mesh specs the first time one of them failed to compile.
    static func owningRepository(
        ofSpecAt absolutePath: String,
        tools: Tools
    ) -> (root: String, relativePath: String)? {
        guard let git = tools.git else { return nil }
        let directory = (absolutePath as NSString).deletingLastPathComponent
        guard let result = run(git, ["rev-parse", "--show-toplevel"], in: directory),
              result.status == 0
        else { return nil }
        let top = result.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !top.isEmpty, absolutePath.hasPrefix(top + "/") else { return nil }
        return (top, String(absolutePath.dropFirst(top.count + 1)))
    }

    /// Whether the Rust generated from this spec compiled at `ref`.
    ///
    /// `.measured(nil)` means the spec did not exist at that ref - it is new,
    /// which is what the policy's `compiledBeforeChange == nil` means.
    static func historicalCompile(
        specAt absoluteSpecPath: String,
        ref: String,
        tools: Tools
    ) -> Outcome<Bool?> {
        guard let git = tools.git else {
            return .unmeasurable(.gitMissing(searched: Tools.gitCandidates))
        }
        guard let owner = owningRepository(ofSpecAt: absoluteSpecPath, tools: tools) else {
            return .unmeasurable(
                .historyUnavailable(
                    spec: absoluteSpecPath, ref: ref,
                    detail: "no git repository claims this path"
                )
            )
        }
        let object = "\(ref):./\(owner.relativePath)"
        guard let probe = run(git, ["-C", owner.root, "cat-file", "-e", object]) else {
            return .unmeasurable(.gitUnspawnable(path: git))
        }
        if probe.status != 0 {
            // Nonzero covers two different facts - the ref does not resolve,
            // and the path is not in it - so ask which before calling the spec
            // new. A ref that does not resolve is a broken measurement; a path
            // that is absent from a good ref is a new file.
            let resolves = run(
                git, ["-C", owner.root, "rev-parse", "--verify", "--quiet", "\(ref)^{commit}"]
            )
            guard let resolves, resolves.status == 0 else {
                return .unmeasurable(
                    .historyUnavailable(
                        spec: owner.relativePath, ref: ref,
                        detail: "`\(ref)` does not resolve to a commit in \(owner.root)"
                    )
                )
            }
            return .measured(nil)
        }
        guard let show = run(git, ["-C", owner.root, "show", object]), show.status == 0 else {
            return .unmeasurable(
                .historyUnavailable(
                    spec: owner.relativePath, ref: ref,
                    detail: "`git show` failed on a path `git cat-file -e` had just confirmed"
                )
            )
        }
        if let why = ensureScratch(tools) { return .unmeasurable(why) }
        let stem = ((absoluteSpecPath as NSString).lastPathComponent as NSString)
            .deletingPathExtension
        let priorSpec = "\(tools.scratch)/\(stem)__at_ref.t27"
        do {
            try show.standardOutput.write(toFile: priorSpec, atomically: true, encoding: .utf8)
        } catch {
            return .unmeasurable(
                .scratchUnusable(path: priorSpec, detail: error.localizedDescription)
            )
        }
        switch generate(.rust, spec: priorSpec, tools: tools) {
        case .unmeasurable(let why):
            return .unmeasurable(why)
        case .measured(let generated):
            switch compilesAsRustLib(generated, crateName: "\(stem)__at_ref", tools: tools) {
            case .unmeasurable(let why):
                return .unmeasurable(why)
            case .measured(let compiled):
                return .measured(compiled)
            }
        }
    }

    /// A committed generated file the caller wants compared against the spec.
    struct ArtifactRequest: Equatable, Sendable {
        let path: String
        let backend: Backend

        init(path: String, backend: Backend) {
            self.path = path
            self.backend = backend
        }
    }

    /// Measures one spec end to end: 0.36 - 0.50 s warm, up to 3.60 s for the
    /// first call in a process. A `baselineRef` costs a `git show`, a second
    /// `gen-rust` and a second `rustc` - about double - and only for a spec
    /// whose Rust does not compile now.
    static func measureSpec(
        path: String,
        tools: Tools,
        shortfalls: [DeclaredShortfall],
        baselineRef: String? = "HEAD",
        artifacts: [ArtifactRequest] = []
    ) -> Outcome<QueenT27Acceptance.SpecMeasurement> {
        let absolute = absolutePath(path, root: tools.root)
        let specText: String
        do {
            specText = try String(contentsOfFile: absolute, encoding: .utf8)
        } catch {
            return .unmeasurable(
                .specUnreadable(path: absolute, detail: error.localizedDescription)
            )
        }
        let declared = declaredFunctions(inSpec: specText)

        var generated: [Backend: String] = [:]
        for backend in Backend.allCases {
            switch generate(backend, spec: absolute, tools: tools) {
            case .unmeasurable(let why):
                return .unmeasurable(why)
            case .measured(let text):
                generated[backend] = text
            }
        }
        guard let rustText = generated[.rust] else {
            return .unmeasurable(.generatorUnspawnable(path: tools.t27c))
        }

        let emissions = Backend.allCases.map { backend in
            QueenT27Acceptance.BackendEmission(
                backend: backend.rawValue,
                emitted: emittedFunctions(backend, in: generated[backend] ?? ""),
                declaredShortfall: declaredShortfall(
                    spec: absolute, backend: backend.rawValue, among: shortfalls
                )
            )
        }

        let stem = ((absolute as NSString).lastPathComponent as NSString).deletingPathExtension
        let compilesNow: Bool
        switch compilesAsRustLib(rustText, crateName: stem, tools: tools) {
        case .unmeasurable(let why):
            return .unmeasurable(why)
        case .measured(let value):
            compilesNow = value
        }

        let history: Outcome<Bool?>
        if compilesNow {
            // Not consulted: `compileRefusal` never reads the field when the
            // Rust compiles. See `baselineField`.
            history = .measured(nil)
        } else if let ref = baselineRef {
            history = historicalCompile(specAt: absolute, ref: ref, tools: tools)
        } else {
            history = .unmeasurable(
                .historyUnavailable(
                    spec: absolute, ref: "(none)",
                    detail: "the caller asked for no baseline ref, and this spec does not "
                        + "compile, so a regression cannot be told from a pre-existing failure"
                )
            )
        }
        let compiledBefore: Bool?
        switch baselineField(compilesNow: compilesNow, history: history) {
        case .unmeasurable(let why):
            return .unmeasurable(why)
        case .measured(let value):
            compiledBefore = value
        }

        var measuredArtifacts: [QueenT27Acceptance.Artifact] = []
        for request in artifacts {
            let artifactPath = absolutePath(request.path, root: tools.root)
            let committed: String
            do {
                committed = try String(contentsOfFile: artifactPath, encoding: .utf8)
            } catch {
                return .unmeasurable(
                    .artifactUnreadable(
                        path: artifactPath, detail: error.localizedDescription
                    )
                )
            }
            let fresh = generated[request.backend] ?? ""
            measuredArtifacts.append(
                QueenT27Acceptance.Artifact(
                    path: request.path,
                    matchesFreshGeneration: artifactMatches(
                        committed: committed, freshlyGenerated: fresh
                    )
                )
            )
        }

        return .measured(
            QueenT27Acceptance.SpecMeasurement(
                path: path,
                declaredFunctions: declared,
                backends: emissions,
                stubbedBodies: stubbedBodies(inGeneratedRust: rustText),
                artifacts: measuredArtifacts,
                generatedRustCompiles: compilesNow,
                compiledBeforeChange: compiledBefore
            )
        )
    }

    /// Every spec `t27-lowering` walks, in the same order (`find ... | sort`).
    static func corpusSpecs(tools: Tools) -> [String] {
        let ringsPath = "\(tools.root)/rings"
        guard let walker = FileManager.default.enumerator(atPath: ringsPath) else { return [] }
        var found: [String] = []
        for case let relative as String in walker {
            let full = "\(ringsPath)/\(relative)"
            if isCorpusSpec(full) { found.append(full) }
        }
        return found.sorted()
    }

    /// How many generated Rust files in the whole corpus do not compile.
    ///
    /// 9.9 - 11.7 s for the 70 specs in `rings/` today. Reports
    /// `.unmeasurable` the moment a generation fails rather than finishing
    /// with a smaller number: an undercount here reads as a corpus that got
    /// healthier, which is the ratchet running backwards while looking like
    /// progress.
    static func measureCorpusNocompile(tools: Tools) -> Outcome<Int> {
        let specs = corpusSpecs(tools: tools)
        var failures = 0
        var done = 0
        for spec in specs {
            switch generate(.rust, spec: spec, tools: tools) {
            case .unmeasurable(let why):
                return .unmeasurable(
                    .corpusIncomplete(measured: done, total: specs.count, firstFailure: why.sentence)
                )
            case .measured(let text):
                let stem = ((spec as NSString).lastPathComponent as NSString).deletingPathExtension
                switch compilesAsRustLib(text, crateName: stem, tools: tools) {
                case .unmeasurable(let why):
                    return .unmeasurable(
                        .corpusIncomplete(
                            measured: done, total: specs.count, firstFailure: why.sentence
                        )
                    )
                case .measured(let compiles):
                    if !compiles { failures += 1 }
                }
            }
            done += 1
        }
        return .measured(failures)
    }

    /// The whole measurement, ready to hand to `QueenT27Acceptance.refusal`.
    ///
    /// Returns `.unmeasurable` only for the two facts that make every verdict
    /// meaningless - an unreadable Makefile and a missing ceiling. A per-spec
    /// failure does not stop the run; it lands in `Report.unmeasured`, the
    /// spec stays out of the `Work`, and the policy refuses it for having no
    /// measurement.
    ///
    /// Cost: roughly 0.35 s per touched spec warm, up to 3.6 s for the first
    /// call in a process, plus about 10 s when `sweepCorpus` is asked for.
    /// `Report.seconds` carries the measured figure for the call you made.
    static func measureWork(
        touchedPaths: [String],
        tools: Tools,
        baselineRef: String? = "HEAD",
        sweepCorpus: Bool = false,
        artifacts: [String: [ArtifactRequest]] = [:]
    ) -> Outcome<Report> {
        let started = Date()
        let makefileText: String
        do {
            makefileText = try String(contentsOfFile: tools.makefile, encoding: .utf8)
        } catch {
            return .unmeasurable(
                .makefileUnreadable(path: tools.makefile, detail: error.localizedDescription)
            )
        }
        guard let ceiling = nocompileCeiling(inMakefile: makefileText) else {
            return .unmeasurable(.ceilingNotDeclared(makefile: tools.makefile))
        }
        let shortfalls = declaredShortfalls(inMakefile: makefileText)

        var outcomes: [SpecOutcome] = []
        for spec in specPaths(among: touchedPaths) {
            outcomes.append(
                SpecOutcome(
                    path: spec,
                    outcome: measureSpec(
                        path: spec,
                        tools: tools,
                        shortfalls: shortfalls,
                        baselineRef: baselineRef,
                        artifacts: artifacts[spec] ?? []
                    )
                )
            )
        }

        let corpus: Outcome<Int>? = sweepCorpus ? measureCorpusNocompile(tools: tools) : nil
        return .measured(
            assemble(
                touchedPaths: touchedPaths,
                outcomes: outcomes,
                nocompileBaseline: ceiling,
                corpus: corpus,
                seconds: Date().timeIntervalSince(started)
            )
        )
    }
}

extension QueenT27Measurement.Outcome: Equatable where Value: Equatable {}
