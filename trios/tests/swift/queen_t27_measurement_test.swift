// Standalone unit tests for QueenT27Measurement - the adapter that MEASURES a
// T27 change so QueenT27Acceptance can judge one.
//
// Everything checked here is pure: counting, Makefile parsing, path rules, and
// the assembly step that separates a measured spec from an unmeasurable one.
// The suite therefore needs neither t27c nor rustc, and it must keep not
// needing them - the day it does, it stops running on any machine where the
// thing it guards is broken, which is the only day it matters.
//
// The generated samples below are REAL t27c output, captured on 2026-08-28
// from rings/T27-00/queen_core.t27 with the binary at
// .trinity/t27c-build/release/t27c:
//
//     t27c gen-rust    queen_core.t27   -> 7 functions
//     t27c gen         queen_core.t27   -> 7 functions   (Zig)
//     t27c gen-c       queen_core.t27   -> 7 functions
//     t27c gen-verilog queen_core.t27   -> 8 functions   (7 + the __mul_noop
//                                                         wrapper)
//     rings/T27-00/queen_core.t27       -> 7 declared
//
// The constants hold representative SLICES of those outputs, so the counts
// asserted here are the slices' own, not the whole file's. Two elisions, both
// deliberate:
//
//   - the `DO NOT EDIT` header line of the Rust and Zig output carries a
//     U+2014 em dash and this tree is ASCII only (L3), so that one line is
//     dropped. The C and Verilog headers use an ASCII hyphen and are kept.
//   - the slices stop mid-function where a slice has to stop.
//
// Nothing else is edited. The samples are raw string literals so that a
// backslash or a `\(` in generated code cannot be read as Swift.
//
// Run (from trios root):
//   swiftc tests/swift/queen_t27_measurement_test.swift \
//     rings/SR-01/QueenT27Measurement.swift \
//     rings/SR-00/QueenT27Acceptance.swift \
//     -o /tmp/trios_queen_t27_measurement_test \
//     && /tmp/trios_queen_t27_measurement_test

import Foundation

@main
enum QueenT27MeasurementTests {
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

    static func equal(_ got: Int, _ want: Int, _ name: String) {
        checks += 1
        if got == want {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)\n         got:  \(got)\n         want: \(want)")
        }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    // MARK: - captured t27c output

    /// `t27c gen-rust rings/T27-00/queen_core.t27`, lines 1 and 3-30.
    /// Two `pub fn` in this slice.
    static let capturedRust = #"""
    // Generated from .t27 spec

    pub const MAX_CONCURRENT_WORKERS: i32 = 4;

    pub const MAX_REAL_ATTEMPTS: i32 = 2;

    pub const MAX_SEND_BACKS: i32 = 2;

    pub const FAILURE_INTERRUPTED: i32 = 0;

    pub const FAILURE_PRODUCED_NOTHING: i32 = 1;

    pub const FAILURE_WORKED_BUT_FAILED: i32 = 2;

    pub fn counts_against_issue(kind: i32) -> bool {
        if (kind == FAILURE_PRODUCED_NOTHING) {
            return true;
        }
        if (kind == FAILURE_WORKED_BUT_FAILED) {
            return true;
        }
        return false;
    }

    pub const RETRY_ATTEMPT: i32 = 0;

    pub const RETRY_ESCALATE: i32 = 1;

    pub fn retry_verdict(real_attempts: i32) -> i32 {
    """#

    /// `t27c gen rings/T27-00/queen_core.t27` (Zig), lines 1 and 3-22.
    /// Two `pub fn` in this slice, at column zero, with no `->` before the
    /// return type - which is why Zig gets its own predicate.
    static let capturedZig = #"""
    // Generated from t27 spec: queen_core (module name)
    // phi^2 + 1/phi^2 = 3 | TRINITY

    pub const MAX_CONCURRENT_WORKERS: i32 = 4;
    pub const MAX_REAL_ATTEMPTS: i32 = 2;
    pub const MAX_SEND_BACKS: i32 = 2;
    pub const FAILURE_INTERRUPTED: i32 = 0;
    pub const FAILURE_PRODUCED_NOTHING: i32 = 1;
    pub const FAILURE_WORKED_BUT_FAILED: i32 = 2;
    pub fn counts_against_issue(kind: i32) bool {
        if (kind == FAILURE_PRODUCED_NOTHING) {
            return true;
        }
        if (kind == FAILURE_WORKED_BUT_FAILED) {
            return true;
        }
        return false;
    }
    pub const RETRY_ATTEMPT: i32 = 0;
    pub const RETRY_ESCALATE: i32 = 1;
    pub fn retry_verdict(real_attempts: i32) i32 {
    """#

    /// `t27c gen-c rings/T27-00/queen_core.t27`, lines 44-75.
    ///
    /// The seven leading lines are PROTOTYPES, ending in `);`. t27c emits every
    /// function twice - once declared, once defined - so a counter that missed
    /// the `{` would report fourteen for seven and never notice a dropped body.
    /// Three definitions in this slice.
    static let capturedC = #"""
    bool counts_against_issue(int32_t kind);
    int32_t retry_verdict(int32_t real_attempts);
    int32_t review_verdict(int32_t total_criteria, int32_t judged, int32_t unmet, int32_t committed_files, int32_t prior_send_backs);
    int32_t merge_verdict(int32_t rollup, bool mergeable, bool is_draft, bool checks_configured);
    int32_t merge_verdict_for_no_checks(bool checks_configured);
    bool can_start_another(int32_t running);
    int32_t free_slots(int32_t running);

    /* -------------------------------------------------------
       Function implementations
       ------------------------------------------------------- */

    bool counts_against_issue(int32_t kind) {
        if ((kind == FAILURE_PRODUCED_NOTHING)) {
            return true;
        }
        if ((kind == FAILURE_WORKED_BUT_FAILED)) {
            return true;
        }
        return false;
    }

    int32_t retry_verdict(int32_t real_attempts) {
        if ((real_attempts >= MAX_REAL_ATTEMPTS)) {
            return RETRY_ESCALATE;
        }
        return RETRY_ATTEMPT;
    }

    int32_t review_verdict(int32_t total_criteria, int32_t judged, int32_t unmet, int32_t committed_files, int32_t prior_send_backs) {
        if ((total_criteria <= 0)) {
            return REVIEW_ESCALATE;
    """#

    /// `t27c gen-verilog rings/T27-00/queen_core.t27`, lines 40-72.
    ///
    /// `__mul_noop` is the wrapper the Makefile's comment names: it is why
    /// Verilog emits 8 for 7 declared, and why C and Verilog are held to "at
    /// least" rather than pinned. Two `function` lines in this slice, both
    /// indented inside the module.
    static let capturedVerilog = #"""
        parameter signed [31:0] MERGE_REFUSE = 3;

        // -------------------------------------------------------
        // R-SI-1: multiplication helper (no `*` operator)
        // -------------------------------------------------------
        function [31:0] __mul_noop;
            input [31:0] a;
            input [31:0] b;
            integer i;
            reg [63:0] acc;
            begin
                acc = 64'd0;
                for (i = 0; i < 32; i = i + 1) begin
                    if (b[i]) acc = acc + ({32'd0, a} << i);
                end
                __mul_noop = acc[31:0];
            end
        endfunction

        assign ready = 1'b1;

        // -------------------------------------------------------
        // Combinational logic (from function declarations)
        // -------------------------------------------------------

        // function: counts_against_issue
        function counts_against_issue; // -> bool
            input signed [31:0] kind;
            begin : counts_against_issue_body
                if ((kind == FAILURE_PRODUCED_NOTHING)) begin
                    counts_against_issue = 1'b1;
                end else begin
                    if ((kind == FAILURE_WORKED_BUT_FAILED)) begin
    """#

    /// `rings/T27-00/queen_core.t27`, lines 61-75 followed by lines 108-125.
    ///
    /// The second half is the case a naive counter gets wrong:
    /// `pub fn review_verdict(` opens on one line and its five parameters
    /// follow on their own. One declaration, not six. Two in this slice.
    static let capturedSpec = #"""
    // Whether an ending counts against the issue.
    //
    // An interruption is the supervisor's accident, not the issue's difficulty.
    // Counting it would retire issues for the crime of being open while somebody
    // rebuilt the app. Only the two endings that are the issue's own doing count;
    // anything else a future registry invents does not, until this file says so.
    pub fn counts_against_issue(kind: i32) bool {
        if (kind == FAILURE_PRODUCED_NOTHING) {
            return true;
        }
        if (kind == FAILURE_WORKED_BUT_FAILED) {
            return true;
        }
        return false;
    }
    //
    // `committed_files` matters independently of the verdicts: every criterion met
    // against an empty diff is not a pass, it is a reviewer that had nothing in
    // front of it and answered anyway.
    pub fn review_verdict(
        total_criteria: i32,
        judged: i32,
        unmet: i32,
        committed_files: i32,
        prior_send_backs: i32
    ) i32 {
        if (total_criteria <= 0) {
            return REVIEW_ESCALATE;
        }
        if (judged < total_criteria) {
            return REVIEW_WAIT;
        }
        if (unmet <= 0) {
    """#

    /// `rings/RUST-13/trios-mesh/specs/timing_closure.t27`, lines 28-41.
    ///
    /// Every declaration in that spec is INDENTED, inside a block. That is why
    /// the pattern carries `[[:space:]]*` and why dropping it would silently
    /// report zero declared functions for a whole spec - a spec that then
    /// cannot fail a count it is not part of. Four declarations here.
    static let capturedIndentedSpec = #"""
        fn extract_delay(path: u32) -> u32 {
            return ((path >> 16) & 0xFFFF);
        }

        fn extract_stages(path: u32) -> u32 {
            return ((path >> 8) & 0xFF);
        }

        fn extract_slack(path: u32) -> u32 {
            return (path & 0xFF);
        }

        // Timing grade based on slack
        fn grade_timing(slack: u32) -> u32 {
    """#

    /// The four lines of the real Makefile that matter, verbatim as of
    /// 2026-08-28: the tab-indented variable LIST at line 865, the two
    /// assignments at 925 and 939, and one of the five tab-indented recipe
    /// lines that USE the variable, at 1029. The list and the usage are here
    /// precisely because a parser that reads either as a definition gets a
    /// different answer.
    static let capturedMakefile = [
        "\tT27C T27_ROOT CHAIN_DIR DEVELOPER_DIR T27_LOWERING_EXCEPT T27_NOCOMPILE_CEILING \\",
        "T27_NOCOMPILE_CEILING := 11",
        "T27_LOWERING_EXCEPT := auto_config.t27:c:2",
        "\t\t\tif echo \" $(T27_LOWERING_EXCEPT) \" | grep -q \" $$(basename $$f):c:$$short \"; then \\",
    ].joined(separator: "\n")

    // MARK: - counting

    static func counting() {
        scenario("the four counters mirror the four grep patterns, on real t27c output")

        equal(
            QueenT27Measurement.declaredFunctions(inSpec: capturedSpec), 2,
            "a spec's declarations are counted once each, including a five-line signature"
        )

        equal(
            QueenT27Measurement.declaredFunctions(inSpec: capturedIndentedSpec), 4,
            "indented declarations count - timing_closure.t27 has no other kind"
        )

        equal(
            QueenT27Measurement.emittedFunctions(.rust, in: capturedRust), 2,
            "generated Rust is counted by `^pub fn `"
        )

        equal(
            QueenT27Measurement.emittedFunctions(.zig, in: capturedZig), 2,
            "generated Zig is counted by `^(pub )?fn `"
        )

        equal(
            QueenT27Measurement.emittedFunctions(.c, in: capturedC), 3,
            "generated C counts definitions and not the seven prototypes above them"
        )

        equal(
            QueenT27Measurement.emittedFunctions(.verilog, in: capturedVerilog), 2,
            "generated Verilog counts indented `function ` lines, wrapper included"
        )

        equal(
            QueenT27Measurement.stubbedBodies(inGeneratedRust: capturedRust), 0,
            "queen_core generates no emptied bodies"
        )

        equal(
            QueenT27Measurement.stubbedBodies(
                inGeneratedRust: "pub fn a() -> i32 {\n    unimplemented!()\n}\n"
            ),
            1,
            "an `unimplemented!()` body is counted"
        )

        equal(
            QueenT27Measurement.stubbedBodies(
                inGeneratedRust: "    unimplemented!(); unimplemented!()\n"
            ),
            1,
            "two on one line count once, because `grep -c` counts lines and so must this"
        )
    }

    static func countingEdges() {
        scenario("the counters refuse the near-misses the patterns refuse")

        check(
            !QueenT27Measurement.declaresFunction("pub  fn wide(x: i32) i32 {"),
            "`pub  fn` with two spaces does not match, in the ERE or here"
        )

        check(
            QueenT27Measurement.declaresFunction("\tfn tabbed(x: i32) i32 {"),
            "a tab counts as leading space"
        )

        check(
            !QueenT27Measurement.declaresFunction("// fn commented(x: i32) i32 {"),
            "a mention inside a comment is not a declaration"
        )

        check(
            !QueenT27Measurement.zigEmitsFunction("    pub fn indented() bool {"),
            "Zig output is matched at column zero only, as the Makefile matches it"
        )

        check(
            !QueenT27Measurement.cEmitsFunction("int32_t prototype(int32_t a);"),
            "a C prototype has no brace and is not a definition"
        )

        check(
            !QueenT27Measurement.cEmitsFunction("    if ((x == 1)) {"),
            "an indented C statement fails the identifier-head rule"
        )

        check(
            !QueenT27Measurement.cEmitsFunction("#define MAX_SEND_BACKS 2"),
            "a C define is not a function"
        )

        check(
            QueenT27Measurement.cEmitsFunction("bool f(int32_t a)   {"),
            "spaces between `)` and `{` are allowed, as ` *` allows them"
        )

        check(
            !QueenT27Measurement.cEmitsFunction("bool f(int32_t a)\t{"),
            "a TAB between `)` and `{` is not, because ` *` is spaces only"
        )

        check(
            !QueenT27Measurement.verilogEmitsFunction("    endfunction"),
            "`endfunction` is not a function"
        )
    }

    // MARK: - reading the Makefile rather than restating it

    static func makefileReading() {
        scenario("the ceiling and the exception list are read from the Makefile")

        equal(
            QueenT27Measurement.nocompileCeiling(inMakefile: capturedMakefile) ?? -1, 11,
            "T27_NOCOMPILE_CEILING is read as 11 - the value on 2026-08-28, down from 20"
        )

        let shortfalls = QueenT27Measurement.declaredShortfalls(inMakefile: capturedMakefile)
        equal(shortfalls.count, 1, "T27_LOWERING_EXCEPT declares exactly one entry today")
        check(
            shortfalls.first
                == QueenT27Measurement.DeclaredShortfall(
                    spec: "auto_config.t27", backend: "c", count: 2
                ),
            "and it is auto_config.t27:c:2 - C cannot return an array by value"
        )

        equal(
            QueenT27Measurement.declaredShortfall(
                spec: "rings/RUST-13/trios-mesh/specs/auto_config.t27",
                backend: "c", among: shortfalls
            ),
            2,
            "the entry is found by basename, from a full path"
        )

        equal(
            QueenT27Measurement.declaredShortfall(
                spec: "auto_config.t27", backend: "rust", among: shortfalls
            ),
            0,
            "the C exception does not excuse Rust"
        )

        equal(
            QueenT27Measurement.declaredShortfall(
                spec: "queen_core.t27", backend: "c", among: shortfalls
            ),
            0,
            "a spec with no entry has no declared shortfall, which is what makes the gate bite"
        )
    }

    static func makefileTraps() {
        scenario("a usage of the variable is not a definition of it")

        // The recipe line in capturedMakefile contains `$(T27_LOWERING_EXCEPT)`
        // and the literal text `:c:$$short`. If it were read as an assignment
        // the exception list would gain a garbage entry - or, worse, replace
        // the real one and switch auto_config's exception off.
        equal(
            QueenT27Measurement.declaredShortfalls(inMakefile: capturedMakefile).count, 1,
            "the tab-indented recipe line that uses the variable adds no entry"
        )

        check(
            QueenT27Measurement.makefileValue(
                of: "T27C", in: capturedMakefile
            ) == nil,
            "the tab-indented variable LIST at line 865 defines nothing"
        )

        check(
            QueenT27Measurement.nocompileCeiling(inMakefile: "# nothing here\nOTHER := 3\n") == nil,
            "a Makefile with no ceiling gives nil, not zero - a guessed ceiling either "
                + "refuses every change or excuses every one"
        )

        equal(
            QueenT27Measurement.makefileValue(
                of: "T27_NOCOMPILE_CEILING",
                in: "T27_NOCOMPILE_CEILING := 11  # was 20 on 2026-08-23"
            ) ?? "",
            "11",
            "a trailing make comment is not part of the value"
        )

        equal(
            QueenT27Measurement.makefileValue(
                of: "T27_NOCOMPILE_CEILING",
                in: "T27_NOCOMPILE_CEILING := 20\nT27_NOCOMPILE_CEILING := 11"
            ) ?? "",
            "11",
            "the last assignment wins, as it does in make"
        )

        equal(
            QueenT27Measurement.makefileValue(
                of: "T27_LOWERING_EXCEPT",
                in: "T27_LOWERING_EXCEPT := a.t27:c:2\nT27_LOWERING_EXCEPT += b.t27:c:1"
            ) ?? "",
            "a.t27:c:2 b.t27:c:1",
            "`+=` appends rather than replacing"
        )

        equal(
            QueenT27Measurement.makefileValue(
                of: "T27_NOCOMPILE_CEILING",
                in: "T27_NOCOMPILE_CEILING := 11\nT27_NOCOMPILE_CEILING ?= 99"
            ) ?? "",
            "11",
            "`?=` does not override a value already set"
        )

        check(
            QueenT27Measurement.makefileValue(
                of: "T27_NOCOMPILE", in: capturedMakefile
            ) == nil,
            "a variable whose name is a prefix of a real one is not that one"
        )

        equal(
            QueenT27Measurement.unparsableExceptions(
                inDeclaration: "auto_config.t27:c:2 trust_manager.t27:c oops:c:zero"
            ).joined(separator: ","),
            "trust_manager.t27:c,oops:c:zero",
            "a malformed exception is surfaced rather than dropped in silence, "
                + "because a typo there switches a declared exception off"
        )
    }

    // MARK: - which paths are specs

    static func pathRules() {
        scenario("spec selection keeps a worker's worktree writes and drops stale copies")

        equal(
            QueenT27Measurement.specPaths(
                among: [
                    "rings/T27-00/queen_core.t27",
                    "rings/SR-00/QueenDelegation.swift",
                    "docs/note.md",
                ]
            ).joined(separator: ","),
            "rings/T27-00/queen_core.t27",
            "only the .t27 is selected"
        )

        equal(
            QueenT27Measurement.specPaths(
                among: ["rings/T27-00/queen_core.t27", "./rings/T27-00/queen_core.t27"]
            ).count,
            1,
            "the same spec named twice is measured once"
        )

        equal(
            QueenT27Measurement.specPaths(among: ["rings/T27-00/Queen_Core.T27"]).count, 1,
            "an uppercase extension is still a spec - a gate you step around with the "
                + "shift key is not a gate"
        )

        check(
            QueenT27Measurement.isCorpusSpec(
                "/root/rings/RUST-13/trios-mesh/specs/auto_config.t27"
            ),
            "a spec in the tree that ships is in the corpus"
        )

        check(
            !QueenT27Measurement.isCorpusSpec(
                "/root/rings/RUST-13/trios-mesh/.claude/worktrees/x/specs/auto_config.t27"
            ),
            "a copy under .claude is not - the first version of the gate counted 138 specs "
                + "instead of 70 and failed on an already-fixed defect"
        )

        check(
            !QueenT27Measurement.isCorpusSpec("/root/.worktrees/prod/queen-1/rings/a.t27"),
            "nor is a copy under .worktrees"
        )

        // The corpus sweep excludes worktrees; spec SELECTION must not, or a
        // bee's own edits - which arrive with a worktree prefix - would be
        // dropped and the change would look like it touched no spec at all.
        equal(
            QueenT27Measurement.specPaths(
                among: [".worktrees/prod/queen-9/trios/rings/T27-00/queen_core.t27"]
            ).count,
            1,
            "a worktree write is still a touched spec, because the caller reduces the path"
        )

        equal(
            QueenT27Measurement.absolutePath("rings/a.t27", root: "/root/trios"),
            "/root/trios/rings/a.t27",
            "a relative spec path is resolved against the root"
        )

        equal(
            QueenT27Measurement.absolutePath("/elsewhere/a.t27", root: "/root/trios"),
            "/elsewhere/a.t27",
            "an absolute one is left alone"
        )
    }

    // MARK: - artifacts

    static func artifacts() {
        scenario("artifact drift ignores the trailing newline and nothing else")

        check(
            QueenT27Measurement.artifactMatches(
                committed: "pub fn a() {}\n", freshlyGenerated: "pub fn a() {}"
            ),
            "a committed file ending in a newline matches stdout that does not - t27c "
                + "writes to stdout and git files end with one"
        )

        check(
            !QueenT27Measurement.artifactMatches(
                committed: "pub fn a() {}\n", freshlyGenerated: "pub fn a() { }"
            ),
            "a difference inside the file is drift, including a whitespace one"
        )

        check(
            !QueenT27Measurement.artifactMatches(
                committed: "pub fn a() {}\npub fn b() {}\n",
                freshlyGenerated: "pub fn a() {}"
            ),
            "a committed file with an extra function is drift"
        )
    }

    // MARK: - the baseline field

    static func baseline() {
        scenario("history is consulted only when it can change the verdict")

        let unreadable = QueenT27Measurement.Outcome<Bool?>.unmeasurable(
            .gitMissing(searched: ["/usr/bin/git"])
        )

        check(
            QueenT27Measurement.baselineField(compilesNow: true, history: unreadable)
                .measuredValue != nil
                ? QueenT27Measurement.baselineField(compilesNow: true, history: unreadable)
                    .measuredValue! == nil
                : false,
            "when the Rust compiles, the field is inert and unreadable history is not fatal"
        )

        check(
            QueenT27Measurement.baselineField(compilesNow: false, history: unreadable).reason
                != nil,
            "when it does NOT compile, unreadable history makes the spec unmeasurable - "
                + "guessing false would excuse a regression and true would refuse a "
                + "pre-existing failure this task did not cause"
        )

        check(
            QueenT27Measurement.baselineField(
                compilesNow: false, history: .measured(false)
            ).measuredValue.flatMap { $0 } == false,
            "a measured `did not compile before` is passed through"
        )

        check(
            QueenT27Measurement.baselineField(
                compilesNow: false, history: .measured(nil)
            ).measuredValue.map { $0 == nil } == true,
            "a spec absent at the ref is passed through as new"
        )
    }

    // MARK: - the point of the whole file

    static func assembly() {
        scenario("an unmeasurable spec never reaches the policy looking measured")

        let measured = QueenT27Acceptance.SpecMeasurement(
            path: "rings/T27-00/queen_core.t27",
            declaredFunctions: 7,
            backends: [
                .init(backend: "rust", emitted: 7),
                .init(backend: "zig", emitted: 7),
                .init(backend: "c", emitted: 7),
                .init(backend: "verilog", emitted: 8),
            ]
        )

        let report = QueenT27Measurement.assemble(
            touchedPaths: [
                "rings/T27-00/queen_core.t27",
                "rings/RUST-13/trios-mesh/specs/auto_config.t27",
            ],
            outcomes: [
                .init(path: "rings/T27-00/queen_core.t27", outcome: .measured(measured)),
                .init(
                    path: "rings/RUST-13/trios-mesh/specs/auto_config.t27",
                    outcome: .unmeasurable(.rustcMissing(searched: ["/usr/bin/rustc"]))
                ),
            ],
            nocompileBaseline: 11,
            corpus: nil,
            seconds: 0.3
        )

        equal(report.work.specs.count, 1, "only the measured spec is in the Work")

        equal(
            report.unmeasured.map(\.path).joined(separator: ","),
            "rings/RUST-13/trios-mesh/specs/auto_config.t27",
            "the unmeasured one is reported by name, with its reason"
        )

        check(!report.everythingMeasured, "and the report says so in one word")

        // This is the load-bearing assertion of the suite. No placeholder was
        // invented for the spec that could not be measured, so the policy sees
        // a touched spec with no measurement, and refuses. A gate that failed
        // here would be a gate that passes everything the moment rustc goes
        // missing, which this repository has shipped before.
        let verdict = QueenT27Acceptance.refusal(for: report.work)
        check(verdict != nil, "the policy refuses the work rather than accepting it")
        check(
            verdict?.contains("no ") == true && verdict?.contains("measurement") == true,
            "and the refusal names the missing measurement"
        )

        check(
            report.summary.contains("NOT MEASURED"),
            "the printed summary says NOT MEASURED beside the spec"
        )
        check(
            report.summary.contains("no rustc was found"),
            "and carries the concrete reason, which the policy's own message cannot"
        )
    }

    static func corpusHonesty() {
        scenario("a corpus sweep that did not finish reports nothing rather than a low number")

        let unfinished = QueenT27Measurement.assemble(
            touchedPaths: [],
            outcomes: [],
            nocompileBaseline: 11,
            corpus: .unmeasurable(
                .corpusIncomplete(measured: 12, total: 70, firstFailure: "t27c exited 1")
            ),
            seconds: 0.1
        )

        check(
            unfinished.work.nocompileNow == nil,
            "an incomplete sweep passes nil, not a count - an undercount reads as a corpus "
                + "that got healthier"
        )
        check(
            QueenT27Acceptance.corpusRefusal(now: unfinished.work.nocompileNow, baseline: 11)
                == nil,
            "so the corpus rule is skipped rather than fed a number nobody measured"
        )
        check(
            unfinished.summary.contains("corpus NOT MEASURED"),
            "and the summary says the sweep did not happen"
        )

        let finished = QueenT27Measurement.assemble(
            touchedPaths: [], outcomes: [], nocompileBaseline: 11,
            corpus: .measured(12), seconds: 0.1
        )
        check(
            finished.work.nocompileNow == 12,
            "a finished sweep passes its count through"
        )
        check(
            QueenT27Acceptance.corpusRefusal(now: finished.work.nocompileNow, baseline: 11) != nil,
            "and 12 above a ceiling of 11 is refused"
        )

        let notRequested = QueenT27Measurement.assemble(
            touchedPaths: [], outcomes: [], nocompileBaseline: 11,
            corpus: nil, seconds: 0.1
        )
        check(
            notRequested.summary.contains("corpus not swept"),
            "a sweep nobody asked for is distinguished from one that failed"
        )
    }

    // MARK: - the captured output, all the way to a verdict

    static func endToEndOnCapturedOutput() {
        scenario("the captured slices assemble into a Work the policy accepts")

        // Built with nothing but the pure counters, from the real t27c output
        // at the top of this file. Slice counts: 2 declared, 2 rust, 2 zig,
        // 3 c, 2 verilog.
        let spec = QueenT27Acceptance.SpecMeasurement(
            path: "rings/T27-00/queen_core.t27",
            declaredFunctions: QueenT27Measurement.declaredFunctions(inSpec: capturedSpec),
            backends: [
                .init(
                    backend: "rust",
                    emitted: QueenT27Measurement.emittedFunctions(.rust, in: capturedRust)
                ),
                .init(
                    backend: "zig",
                    emitted: QueenT27Measurement.emittedFunctions(.zig, in: capturedZig)
                ),
                .init(
                    backend: "c",
                    emitted: QueenT27Measurement.emittedFunctions(.c, in: capturedC)
                ),
                .init(
                    backend: "verilog",
                    emitted: QueenT27Measurement.emittedFunctions(.verilog, in: capturedVerilog)
                ),
            ],
            stubbedBodies: QueenT27Measurement.stubbedBodies(inGeneratedRust: capturedRust)
        )

        let report = QueenT27Measurement.assemble(
            touchedPaths: ["rings/T27-00/queen_core.t27"],
            outcomes: [.init(path: "rings/T27-00/queen_core.t27", outcome: .measured(spec))],
            nocompileBaseline: QueenT27Measurement.nocompileCeiling(
                inMakefile: capturedMakefile
            ) ?? -1,
            corpus: .measured(11),
            seconds: 0.14
        )

        check(
            QueenT27Acceptance.refusal(for: report.work) == nil,
            "real counts from real output are accepted"
        )

        // The defect the whole chain exists for: trust_manager.t27 declared 21
        // functions and emitted 12, for as long as the spec had existed, with
        // every gate that trusted t27c's exit status passing it.
        let dropped = QueenT27Acceptance.SpecMeasurement(
            path: "rings/RUST-13/trios-mesh/specs/trust_manager.t27",
            declaredFunctions: 21,
            backends: [.init(backend: "rust", emitted: 12)]
        )
        let droppedReport = QueenT27Measurement.assemble(
            touchedPaths: ["rings/RUST-13/trios-mesh/specs/trust_manager.t27"],
            outcomes: [
                .init(
                    path: "rings/RUST-13/trios-mesh/specs/trust_manager.t27",
                    outcome: .measured(dropped)
                )
            ],
            nocompileBaseline: 11, corpus: nil, seconds: 0.14
        )
        check(
            QueenT27Acceptance.refusal(for: droppedReport.work)?.contains("dropped") == true,
            "21 declared against 12 emitted is refused as a drop"
        )

        // auto_config: the shortfall the Makefile declares must survive the
        // round trip, or the first task to touch that spec is refused for a
        // limitation it did not cause.
        let shortfalls = QueenT27Measurement.declaredShortfalls(inMakefile: capturedMakefile)
        let autoConfig = QueenT27Acceptance.SpecMeasurement(
            path: "rings/RUST-13/trios-mesh/specs/auto_config.t27",
            declaredFunctions: 19,
            backends: [
                .init(backend: "rust", emitted: 19),
                .init(backend: "zig", emitted: 19),
                .init(
                    backend: "c", emitted: 17,
                    declaredShortfall: QueenT27Measurement.declaredShortfall(
                        spec: "rings/RUST-13/trios-mesh/specs/auto_config.t27",
                        backend: "c", among: shortfalls
                    )
                ),
            ]
        )
        check(
            QueenT27Acceptance.structuralRefusal(spec: autoConfig) == nil,
            "auto_config's 19/19/17 is accepted because the Makefile declares the two"
        )

        let undeclared = QueenT27Acceptance.SpecMeasurement(
            path: "rings/RUST-13/trios-mesh/specs/other.t27",
            declaredFunctions: 19,
            backends: [
                .init(
                    backend: "c", emitted: 17,
                    declaredShortfall: QueenT27Measurement.declaredShortfall(
                        spec: "rings/RUST-13/trios-mesh/specs/other.t27",
                        backend: "c", among: shortfalls
                    )
                )
            ]
        )
        check(
            QueenT27Acceptance.structuralRefusal(spec: undeclared) != nil,
            "the same shortfall in a spec with no entry is refused"
        )
    }

    // MARK: - the reasons are sentences a person can act on

    static func reasons() {
        scenario("every unmeasurable reason says what was not run")

        let all: [QueenT27Measurement.Unmeasurable] = [
            .generatorMissing(path: "/x/t27c"),
            .generatorUnspawnable(path: "/x/t27c"),
            .generationFailed(backend: "rust", spec: "a.t27", exitStatus: 1, detail: "boom"),
            .rustcMissing(searched: ["/usr/bin/rustc"]),
            .rustcUnspawnable(path: "/usr/bin/rustc"),
            .gitMissing(searched: ["/usr/bin/git"]),
            .gitUnspawnable(path: "/usr/bin/git"),
            .historyUnavailable(spec: "a.t27", ref: "HEAD", detail: "no such ref"),
            .specUnreadable(path: "a.t27", detail: "no permission"),
            .artifactUnreadable(path: "a.rs", detail: "no permission"),
            .makefileUnreadable(path: "Makefile", detail: "no permission"),
            .ceilingNotDeclared(makefile: "Makefile"),
            .scratchUnusable(path: "/tmp/x", detail: "read only"),
            .corpusIncomplete(measured: 3, total: 70, firstFailure: "t27c exited 1"),
        ]
        check(
            all.allSatisfy { $0.sentence.count > 40 },
            "each of the \(all.count) reasons produces a full sentence, not a code"
        )
        check(
            QueenT27Measurement.Unmeasurable
                .rustcMissing(searched: ["/usr/bin/rustc"]).sentence
                .contains("NOT assumed to compile"),
            "the missing-rustc reason says out loud that nothing was assumed"
        )
        check(
            QueenT27Measurement.Unmeasurable
                .ceilingNotDeclared(makefile: "Makefile").sentence.contains("not guessed"),
            "the missing-ceiling reason says the number is not guessed"
        )
    }

    static func main() {
        counting()
        countingEdges()
        makefileReading()
        makefileTraps()
        pathRules()
        artifacts()
        baseline()
        assembly()
        corpusHonesty()
        endToEndOnCapturedOutput()
        reasons()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
    }
}
