// Standalone unit tests for QueenBeeResult - the structured Bee result of
// section 11.3, and the completeness check that decides whether a bee reported
// a result or a sentence.
//
// The registry it replaces was measured on 2026-08-28: 59 delegated tasks, 10
// owning a `.t27` path, #1280 accepted on `rings/T27-00/queen_core.t27` with a
// pull request. What that accepted task carries is `committedFiles: 1` and no
// `committedSHA` key. Nothing anywhere records WHICH files it committed, so
// "the bee completed the task" is a state word and a number - which is what
// these checks exist to stop being enough.
//
// The T27-specific case: t27c's parser silently discards statements it cannot
// parse (`Err(_) => recover_to_stmt_boundary()`, exit 0, empty stderr,
// gHashTag/t27#2508), so a completed result that touched a spec and did not run
// `make t27-lowering` proved nothing at all.
//
// Run (from trios root):
//   swiftc tests/swift/queen_bee_result_test.swift \
//     rings/SR-00/QueenBeeResult.swift \
//     -o /tmp/bridge-bee-result/probe \
//     && /tmp/bridge-bee-result/probe

import Foundation

@main
enum QueenBeeResultTests {
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
        checks += 1
        if got == want {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)\n         got:  \(got)\n         want: \(want)")
        }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    // MARK: - the classifier

    static func pathKinds() {
        scenario("kind separates a spec from a compiler file from an artifact")

        check(
            QueenBeeResult.kind(of: "rings/T27-00/queen_core.t27") == .spec,
            "a .t27 file is a spec - the one .t27 path a task has ever owned to acceptance"
        )

        check(
            QueenBeeResult.kind(of: "rings/SR-00/QueenBeeResult.swift") == .source,
            "a Swift file is source"
        )

        check(
            QueenBeeResult.kind(of: "rings/RUST-13/trios-mesh/gen/rust/crc16.rs")
                == .generatedArtifact,
            "a file under gen/ is an artifact - the path the generated trees actually live at"
        )

        check(
            QueenBeeResult.kind(of: "gen/lib.rs") == .generatedArtifact,
            "gen/ in first position is an artifact too"
        )

        // The ordering decision, stated as a test. Wrong-as-artifact demands a
        // review that was not needed; wrong-as-spec licenses artifact drift.
        check(
            QueenBeeResult.kind(of: "rings/RUST-13/trios-mesh/gen/copy.t27")
                == .generatedArtifact,
            "a .t27 under gen/ is an artifact, not a source of truth"
        )

        check(
            QueenBeeResult.kind(of: "./rings/T27-01/a2a.t27") == .spec,
            "a leading ./ does not change what a path is"
        )

        check(
            QueenBeeResult.kind(of: "  rings/T27-01/a2a.t27  ") == .spec,
            "surrounding whitespace does not change what a path is"
        )

        check(
            QueenBeeResult.kind(of: "rings/T27-01/A2A.T27") == .spec,
            "the spec extension is matched case-insensitively"
        )

        check(
            QueenBeeResult.kind(of: "docs/generated/notes.md") == .source,
            "a directory called generated is not the gen/ marker"
        )

        check(
            QueenBeeResult.kind(of: "scripts/gen.swift") == .source,
            "a FILE called gen is not a gen/ directory"
        )

        check(
            QueenBeeResult.kind(of: "rings/genome/model.rs") == .source,
            "a component that merely begins with gen is not it"
        )

        check(
            QueenBeeResult.kind(of: "docs/t27.md") == .source,
            "a document about t27 is not a t27 spec"
        )
    }

    static func classification() {
        scenario("classify splits, sorts, de-duplicates and drops blanks")

        let changes = QueenBeeResult.classify([
            "rings/SR-00/QueenBeeResult.swift",
            "./rings/T27-00/queen_core.t27",
            "rings/T27-00/queen_core.t27",
            "rings/RUST-13/trios-mesh/gen/rust/crc16.rs",
            "   ",
            "",
            "Makefile",
        ])

        equal(changes.specs, ["rings/T27-00/queen_core.t27"], "two spellings of one spec count once")
        equal(
            changes.compilerFiles,
            ["Makefile", "rings/SR-00/QueenBeeResult.swift"],
            "source files land in changed_compiler_files, sorted"
        )
        equal(
            changes.generatedArtifacts,
            ["rings/RUST-13/trios-mesh/gen/rust/crc16.rs"],
            "artifacts land in their own bucket"
        )

        check(
            QueenBeeResult.classify(["", "  ", "\n"]).isEmpty,
            "a list of blanks is not a change"
        )

        check(
            QueenBeeResult.requiresT27Review(paths: ["rings/T27-00/queen_core.t27"]),
            "a spec change owes a T27 review"
        )
        check(
            QueenBeeResult.requiresT27Review(paths: ["rings/RUST-13/trios-mesh/gen/rust/a.rs"]),
            "an artifact change owes a T27 review - especially one that moved alone"
        )
        check(
            !QueenBeeResult.requiresT27Review(paths: ["rings/SR-00/ChatMessage.swift", "AGENTS.md"]),
            "a pure source change owes no T27 review"
        )
        check(
            !QueenBeeResult.requiresT27Review(paths: []),
            "no paths owes no review"
        )
    }

    static func artifactDrift() {
        scenario("L0: a generated file that changed with no spec behind it")

        let drifted = QueenBeeResult.artifactDriftRefusal(paths: [
            "rings/RUST-13/trios-mesh/gen/rust/crc16.rs",
            "rings/SR-00/Thing.swift",
        ])
        check(drifted != nil, "an artifact changed with no spec is refused")
        check(
            drifted?.contains("gen/rust/crc16.rs") == true,
            "the refusal names the artifact that moved"
        )
        check(
            drifted?.contains("L0") == true,
            "the refusal names the law it is enforcing"
        )

        check(
            QueenBeeResult.artifactDriftRefusal(paths: [
                "rings/T27-00/queen_core.t27",
                "rings/RUST-13/trios-mesh/gen/rust/queen_core.rs",
            ]) == nil,
            "an artifact regenerated alongside a spec change is not drift"
        )

        check(
            QueenBeeResult.artifactDriftRefusal(paths: ["rings/SR-00/Thing.swift"]) == nil,
            "a change with no artifacts cannot drift"
        )
    }

    // MARK: - completeness

    static func completedResults() {
        scenario("completed: a result, or a prose claim wearing a struct")

        let good = QueenBeeResult(
            taskID: "1280",
            status: .completed,
            baseCommit: "2875b9cc646cf38c4f1e57e3a40a9b3b887cdfd6",
            resultCommit: "cd1bbfd609dc3767794e68f2d800975270a8b1cf",
            changedPaths: ["rings/SR-00/QueenBeeResult.swift"],
            commandsRun: ["make check"],
            evidenceManifest: ".trinity/evidence/1280.json"
        )
        check(good.isComplete, "a completed result naming base, result, a file and evidence stands")

        // The exact sentence from the brief.
        let claim = QueenBeeResult(taskID: "1280", status: .completed)
        let missing = claim.missingFieldNames
        check(
            missing.contains("result_commit"),
            "completed with no result_commit is named as missing it"
        )
        check(
            missing.contains("changed_specs / changed_compiler_files / generated_artifacts"),
            "completed with no changed files is named as missing all three buckets at once"
        )
        check(
            missing.contains("base_commit"),
            "completed with no base_commit is named as missing it"
        )
        check(
            missing.contains("commands_run"),
            "completed that names no command it ran is incomplete"
        )
        check(
            missing.contains("evidence_manifest"),
            "completed with nothing to point at is incomplete"
        )
        check(!claim.isComplete, "so it is not a completed result")

        check(
            QueenBeeResult(taskID: "  ", status: .completed).missingFieldNames.contains("task_id"),
            "a whitespace task_id is not a task_id"
        )

        // A filled field with an empty promise inside it.
        let hollow = QueenBeeResult(
            taskID: "1280",
            status: .completed,
            baseCommit: "aaa",
            resultCommit: "bbb",
            changedPaths: ["rings/SR-00/Thing.swift"],
            commandsRun: ["", "   "],
            evidenceManifest: ".trinity/evidence/1280.json"
        )
        check(
            hollow.missingFieldNames == ["commands_run"],
            "commands_run holding only blanks is measured as absent, not as filled"
        )

        // Any ONE of the three buckets satisfies "something changed".
        for paths in [
            ["rings/T27-00/queen_core.t27"],
            ["rings/SR-00/Thing.swift"],
            ["rings/RUST-13/trios-mesh/gen/rust/a.rs"],
        ] {
            let result = QueenBeeResult(
                taskID: "1",
                status: .completed,
                baseCommit: "aaa",
                resultCommit: "bbb",
                changedPaths: paths,
                commandsRun: ["make t27-lowering"],
                evidenceManifest: "m"
            )
            check(
                !result.missingFieldNames.contains(
                    "changed_specs / changed_compiler_files / generated_artifacts"
                ),
                "a change in \(QueenBeeResult.kind(of: paths[0]).rawValue) alone satisfies "
                    + "the changed-files promise"
            )
        }
    }

    static func loweringGate() {
        scenario("the lowering gate, wired into the result contract")

        let base = { (paths: [String], commands: [String]) in
            QueenBeeResult(
                taskID: "1280",
                status: .completed,
                baseCommit: "aaa",
                resultCommit: "bbb",
                changedPaths: paths,
                commandsRun: commands,
                evidenceManifest: ".trinity/evidence/1280.json"
            )
        }

        let unproven = base(["rings/T27-00/queen_core.t27"], ["t27c gen-rust rings/T27-00/queen_core.t27"])
        check(
            !unproven.isComplete,
            "a spec change proved only by gen-rust exiting 0 is not complete"
        )
        check(
            unproven.loweringGateRequirement() != nil,
            "the gate requirement is the one it is missing"
        )
        check(
            unproven.refusal?.contains("make t27-lowering") == true,
            "the refusal names the command that would have measured it"
        )

        check(
            base(["rings/T27-00/queen_core.t27"], ["make t27-lowering"]).isComplete,
            "the same result with the gate run is complete"
        )
        check(
            base(
                ["rings/T27-00/queen_core.t27"],
                ["DEVELOPER_DIR=/Library/Developer/CommandLineTools make t27-lowering"]
            ).isComplete,
            "the gate is matched inside the invocation an operator actually types"
        )
        check(
            base(["rings/RUST-13/trios-mesh/gen/rust/a.rs", "rings/T27-01/a2a.t27"], ["make check"])
                .loweringGateRequirement() != nil,
            "an artifact change owes the gate as much as a spec change does"
        )
        check(
            base(["rings/SR-00/Thing.swift"], ["make check"]).loweringGateRequirement() == nil,
            "a pure Swift change does not owe the T27 gate"
        )

        var stopped = base(["rings/T27-00/queen_core.t27"], ["make check"])
        stopped.status = .cancelled
        check(
            stopped.loweringGateRequirement() == nil,
            "a cancelled task is not asked to have proved its spec"
        )
    }

    static func otherStatuses() {
        scenario("blocked, failed and cancelled carry different promises")

        let blocked = QueenBeeResult(
            taskID: "1290",
            status: .blocked,
            baseCommit: "aaa",
            humanDecisionsRequired: ["the IR schema change needs a semantic owner"]
        )
        check(blocked.isComplete, "a block naming a decision a human must make is a block")

        let pause = QueenBeeResult(taskID: "1290", status: .blocked, baseCommit: "aaa")
        check(
            pause.missingFieldNames == ["human_decisions_required / known_risks"],
            "a block with nothing to decide and no risk named is a pause nobody can act on"
        )
        check(
            QueenBeeResult(
                taskID: "1290", status: .blocked, baseCommit: "aaa",
                knownRisks: ["the golden vectors may be wrong"]
            ).isComplete,
            "a named risk satisfies the same promise as a named decision"
        )
        check(
            !blocked.missingFieldNames.contains("result_commit"),
            "a block is never asked for a result commit it does not have"
        )

        let failed = QueenBeeResult(
            taskID: "1127",
            status: .failed,
            baseCommit: "aaa",
            commandsRun: ["cargo build", "make check"]
        )
        check(failed.isComplete, "a failure that names what it ran is a failure")
        check(
            QueenBeeResult(taskID: "1127", status: .failed, baseCommit: "aaa")
                .missingFieldNames == ["commands_run"],
            "a failure that ran nothing is indistinguishable from a worker that never started"
        )

        check(
            QueenBeeResult(taskID: "1290", status: .cancelled).isComplete,
            "a cancelled task owes only its own name - the stop came from outside it"
        )
        check(
            QueenBeeResult(taskID: "", status: .cancelled).missingFieldNames == ["task_id"],
            "and it still owes that"
        )

        check(
            QueenBeeResult.requirements(for: .completed).count == 6,
            "completed carries six promises"
        )
        check(
            QueenBeeResult.requirements(for: .cancelled).count == 1,
            "cancelled carries one"
        )
    }

    // MARK: - honesty about what trios records

    static func captureHonesty() {
        scenario("capture says which fields trios can fill today")

        check(
            QueenBeeResult.capture(of: .taskID).isRecorded,
            "task_id is recorded: the delegation record carries the issue number"
        )
        check(
            QueenBeeResult.capture(of: .status).isRecorded,
            "status is recorded: DelegatedTask.state"
        )
        check(
            QueenBeeResult.capture(of: .resultCommit).isRecorded,
            "result_commit is recorded: committedSHA"
        )
        check(
            QueenBeeResult.capture(of: .resultCommit).note.contains("11 of 59"),
            "and the note carries the measurement rather than the intention"
        )

        // The load-bearing honest line: the classifier wants paths and the
        // registry stores a count.
        for field in [
            QueenBeeResult.Field.changedSpecs,
            .changedCompilerFiles,
            .generatedArtifacts,
        ] {
            check(
                !QueenBeeResult.capture(of: field).isRecorded,
                "\(field.rawValue) is NOT recorded - committedFiles is a count with no paths"
            )
        }
        check(
            QueenBeeResult.capture(of: .changedSpecs).note.contains("ownedPaths"),
            "and the note says why ownedPaths is not a substitute"
        )
        check(
            QueenBeeResult.capture(of: .baseCommit).note.contains("write-tree"),
            "base_commit names baselineTree as adjacent, not as available"
        )
        check(
            QueenBeeResult.capture(of: .evidenceManifest) == .absent,
            "evidence_manifest has nothing behind it at all"
        )
        check(
            QueenBeeResult.capture(of: .humanDecisionsRequired).note.contains("Queen sent INTO"),
            "human_decisions_required is not interventions - the arrow points the other way"
        )

        equal(
            QueenBeeResult.fieldsNeedingNewCapture.map(\.rawValue),
            [
                "base_commit",
                "changed_specs",
                "changed_compiler_files",
                "generated_artifacts",
                "tests_added",
                "commands_run",
                "evidence_manifest",
                "known_risks",
                "human_decisions_required",
            ],
            "nine of the twelve fields need capture that does not exist yet"
        )

        let claim = QueenBeeResult(taskID: "1280", status: .completed)
        let unrecordable = claim.missingRequirements().filter(\.needsNewCapture)
        equal(
            unrecordable.map(\.subject),
            [
                "base_commit",
                "changed_specs / changed_compiler_files / generated_artifacts",
                "commands_run",
                "evidence_manifest",
            ],
            "four of the five gaps in an empty completed result are the platform's, not the bee's"
        )
        check(
            claim.refusal?.contains("no send-back can produce them") == true,
            "and the refusal says so, so nobody sends the task back for them"
        )
        check(
            claim.missingRequirements().first(where: { $0.subject == "result_commit" })?
                .needsNewCapture == false,
            "result_commit is the one gap in that list a bee could actually have filled"
        )
    }

    // MARK: - the wire

    static func wireFormat() {
        scenario("the JSON is section 11.3's JSON")

        // Verbatim from the architecture document, section 11.3.
        let document = """
        {
          "task_id": "Q-2026-0001/implement",
          "status": "completed",
          "base_commit": "aaa",
          "result_commit": "bbb",
          "changed_specs": [],
          "changed_compiler_files": [],
          "generated_artifacts": [],
          "tests_added": [],
          "commands_run": [],
          "evidence_manifest": "",
          "known_risks": [],
          "human_decisions_required": []
        }
        """
        guard let decoded = try? QueenBeeResult.decoded(from: Data(document.utf8)) else {
            check(false, "the document's own example decodes")
            return
        }
        check(true, "the document's own example decodes")
        equal(decoded.taskID, "Q-2026-0001/implement", "task_id survives the wire")
        check(decoded.status == .completed, "status survives the wire")
        // Worth stating plainly: the contract's own illustration does not
        // satisfy the contract. It names a base and a result commit and then
        // reports that a completed task changed no file, ran no command and
        // produced no evidence. That is exactly the shape this check exists to
        // reject, and it is the shape a bee will copy if nobody checks.
        equal(
            decoded.missingFieldNames,
            [
                "changed_specs / changed_compiler_files / generated_artifacts",
                "commands_run",
                "evidence_manifest",
            ],
            "the document's own example is itself an incomplete completed result"
        )

        // The point of lenient decoding: an under-filled result must arrive as
        // a judgeable result, not as a parse error.
        guard let minimal = try? QueenBeeResult.decoded(
            from: Data("{\"task_id\":\"x\",\"status\":\"failed\"}".utf8)
        ) else {
            check(false, "a minimal result decodes rather than throwing")
            return
        }
        check(true, "a minimal result decodes rather than throwing")
        equal(minimal.commandsRun, [], "absent arrays decode as empty rather than failing")
        check(
            minimal.missingFieldNames == ["base_commit", "commands_run"],
            "so its gaps can be named instead of arriving as an unparseable blob"
        )

        check(
            (try? QueenBeeResult.decoded(from: Data("{\"task_id\":\"x\"}".utf8))) == nil,
            "a result that will not say what it is claiming is refused"
        )
        check(
            (try? QueenBeeResult.decoded(
                from: Data("{\"task_id\":\"x\",\"status\":\"accepted\"}".utf8)
            )) == nil,
            "accepted is the Queen's word, not the worker's, and does not decode as a bee status"
        )

        let round = QueenBeeResult(
            taskID: "1280",
            status: .completed,
            baseCommit: "aaa",
            resultCommit: "bbb",
            changedPaths: ["rings/T27-00/queen_core.t27"],
            commandsRun: ["make t27-lowering"],
            evidenceManifest: "m"
        )
        guard let data = try? round.jsonData(),
              let text = String(data: data, encoding: .utf8),
              let back = try? QueenBeeResult.decoded(from: data)
        else {
            check(false, "a result round-trips through JSON")
            return
        }
        check(back == round, "a result round-trips through JSON")
        check(text.contains("\"changed_specs\""), "the keys are snake_case on the wire")
        check(
            text.contains("\"known_risks\" : ["),
            "empty arrays are emitted, so the shape matches the document"
        )
        check(
            !text.contains("\"tests_added\" : null"),
            "and absent optionals are omitted rather than written as null"
        )
        check(
            (try? round.jsonData()) == data,
            "two encodings of one result are the same bytes, so a manifest can hash it"
        )
    }

    static func main() {
        pathKinds()
        classification()
        artifactDrift()
        completedResults()
        loweringGate()
        otherStatuses()
        captureHonesty()
        wireFormat()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
    }
}
