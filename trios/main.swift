// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — eliminate force-unwraps in panel cycling
// and accessibility frame reads to avoid runtime crashes.
import Cocoa
import Foundation
import SwiftUI
import ApplicationServices

// MARK: - AppDelegate

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem?
    let windowManager = WindowManager()
    let serverManager = ServerManager()
    let screenManager = TriosScreenManager.shared
    let compositionRoot = CompositionRoot()
    lazy var menuBuilder = MenuBuilder(delegate: self, screenManager: screenManager, serverManager: serverManager)

    var chatViewModel: ChatViewModel?
    var sessionGuard: SessionGuard?
    var cladeGuard: CladeGuard?
    var accessibilityGranted = false
    var accessibilityPromptShown = false
    var windowStates: [(AXUIElement, CGRect)] = []
    let sidebarWidth: CGFloat = 400
    var currentSidebarWidth: CGFloat = 400

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SAFETY: Prevent recursive self-launch — enforce single instance
        guard RecursionGuard.shared.ensureSingleInstance() else {
            NSLog("applicationDidFinishLaunching: another trios instance is already running — terminating")
            NSApplication.shared.terminate(nil)
            return
        }
        NSLog("applicationDidFinishLaunching called")
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        ApplicationMenuInstaller.install(delegate: self)

        setupStatusItem()
        // Rotate JSONL audit streams before anything starts writing to them.
        LogRotationPolicy.rotateAuditLogs()
        // Re-run audit rotation periodically in the background while the app runs.
        AuditRotationScheduler.shared.start()
        // CRITICAL: setupSidePanel MUST run synchronously before any UI interaction.
        // Previously it was in Task { @MainActor in } which meant panel was nil
        // when the user clicked the status bar icon before the task completed.
        setupSidePanel()
        accessibilityGranted = AXIsProcessTrusted()
        setupGlobalHotkey()
        serverManager.startIfNeeded()

        // Lower the keychain launch gate after bootstrap settles.  The gate
        // starts raised so no keychain read can block the main thread during
        // launch; five seconds in, a detached task clears it, logs the event,
        // and does one warm-up read so the key is cached for later callers.
        Task.detached {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            KeychainSecrets.clearLaunchGate()
            TriosLogBus.shared.info(
                .security,
                "keychain.launch_gate.cleared",
                "Launch gate lowered; keychain operations are now live",
                [:]
            )
            _ = try? TriOSEncryption.memory.rawKeyData()
        }

        Task { @MainActor in
            if let vm = chatViewModel {
                let guard_ = compositionRoot.makeSessionGuard(for: vm)
                sessionGuard = guard_
                guard_.startMonitoring()
            }
            // CladeGuard monitors Sovereign + Canary health and auto-rollback
            let cg = compositionRoot.makeCladeGuard()
            cladeGuard = cg
            cg.startMonitoring()
            // Queen background service owns A2A registration, heartbeat and the
            // self-improvement audit loop. It survives chat switches and panel close.
            // The server this app talks to, started by the app that needs it.
            // Nothing used to start it, so it was whatever happened to be left
            // running - and after a reboot, nothing.
            let serverState = await AgentServerLauncher.startIfNeeded()
            TriosLogBus.shared.info(
                .app, "server.launch", "Agent server: \(serverState)", [:]
            )
            await QueenBackgroundService.shared.start()
            await runDelegationSelfTestIfRequested()
            // When TRIOS_E2E_DELEGATE is absent the self-test returns at its
            // first guard and runE2EQueenCommand never runs. Call it here for
            // that case; the existing call inside the self-test handles the rest.
            let e2eEnv = ProcessInfo.processInfo.environment
            if e2eEnv["TRIOS_E2E_DELEGATE"]?.isEmpty ?? true {
                await runE2EQueenCommand(environment: e2eEnv)
            }
            await runAcceptanceGateSelfTestIfRequested()
            await runQueenReportSelfTestIfRequested()
        }
    }

    /// The fourth field of `TRIOS_E2E_DELEGATE` is the worker's file boundary.
    /// Without one the brief tells it to ask before editing, so a write task
    /// produces no writes.
    ///
    /// Splits on commas, which is exactly what `QueenCommandParser` did to
    /// `--paths a,b` when this spec was flattened into a slash command. Returns
    /// nil rather than an empty array so the emitted inbox line has the same
    /// shape as the one the Makefile's running-app branch writes (#1090).
    private static func inboxPaths(_ field: String) -> [String]? {
        let parts = field
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts
    }

    /// The fifth field is the acceptance contract. Without one every probe has
    /// delegated work nobody could judge finished, which is why the review gate
    /// has never run against a real task.
    ///
    /// Splits on semicolons, matching `--criteria "a; b"` after the parser
    /// stripped the quotes the old code wrapped around this field: an
    /// acceptance criterion is a sentence and sentences contain commas (#1090).
    private static func inboxCriteria(_ field: String) -> [String]? {
        let parts = field
            .split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts
    }

    /// Drives one real delegation through the Queen and reports what the worker
    /// did, with no window and no clicking.
    ///
    /// Delegation only ever ran from the chat UI, which made "the bee never
    /// started" impossible to prove without a human at the keyboard. Set
    /// `TRIOS_E2E_DELEGATE="owner/repo#N|worker|title[|paths[|criteria]]"` to
    /// exercise the same code path and read the verdict out of the log.
    ///
    /// The spec is written to the dev inbox and consumed there (#1090). It used
    /// to be re-encoded as `/approve` + `/delegate` strings and pushed through
    /// QueenCommandParser, which meant a delegation could reach the app by two
    /// routes that disagreed about what a spec meant. There is one entrance now.
    @MainActor
    private func runDelegationSelfTestIfRequested() async {
        let environment = ProcessInfo.processInfo.environment

        guard let spec = environment["TRIOS_E2E_DELEGATE"], !spec.isEmpty else {
            return
        }
        guard let vm = chatViewModel else {
            TriosLogBus.shared.error(.queen, "queen.selftest.failed", "No chat view model", [:])
            return
        }

        let fields = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard (3...5).contains(fields.count) else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.failed",
                "TRIOS_E2E_DELEGATE must be 'owner/repo#N|worker|title[|paths[|criteria]]'",
                ["spec": spec]
            )
            return
        }
        let issueText = fields[0]
        let worker = fields[1]
        let title = fields[2]

        TriosLogBus.shared.info(.queen, "queen.selftest.start", "Delegation self-test starting", ["spec": spec])
        // Setting TRIOS_E2E_DELEGATE is a person naming this exact issue and
        // asking for it, so it satisfies the approval the Queen now requires
        // before opening any chat. This is consent arriving by a different
        // route, not a bypass: no issue gets worked on that a human did not
        // name. The approval itself now happens inside the poller's
        // `approveDelegation` - the same call the `/approve` line used to
        // reach through the command parser.
        //
        // #1090: this used to build `/approve` + `/delegate` strings and push
        // them through QueenCommandParser, which was a second implementation of
        // what the dev inbox poller already does. The spec is written to the
        // inbox instead and the poller consumes it, so there is one entrance
        // and one set of bugs.
        //
        // An unparseable first field is not an error here: with
        // TRIOS_QUEEN_AUTONOMY=1 the probe is launched with an EMPTY issue and
        // the work arrives via TRIOS_E2E_QUEEN_COMMAND=/choose --start. The
        // registry lookup below already covers that case, so skip the enqueue
        // and carry on rather than failing.
        if IssueReference.parse(issueText) != nil {
            let queued = await vm.enqueueQueenInboxEntry(
                issue: issueText,
                worker: worker.isEmpty ? nil : worker,
                title: title.isEmpty ? nil : title,
                paths: Self.inboxPaths(fields.count >= 4 ? fields[3] : ""),
                skill: nil,
                criteria: Self.inboxCriteria(fields.count == 5 ? fields[4] : "")
            )
            if !queued {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.selftest.failed",
                    "Could not write the delegation to the inbox",
                    ["spec": spec]
                )
                return
            }
        }

        // A second bee, started before the first is waited on, so the two
        // genuinely overlap. Parallel work is the part of the design that has
        // never once been demonstrated: the concurrency bound, the file
        // boundaries and the one-owner-per-path rule are all written and have
        // never run together.
        //
        // Two sequential awaited enqueues, not one batch: today the first
        // delegation is fully awaited before the second is asked for, and this
        // change is not the place to make them concurrent.
        if let second = environment["TRIOS_E2E_DELEGATE_SECOND"], !second.isEmpty {
            let two = second.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            if two.count >= 3, IssueReference.parse(two[0]) != nil {
                // The enqueue answers whether the delegation actually reached
                // the inbox. Discarding that answer made the log claim a
                // second bee had started even when nothing was queued - a
                // release build, an unwritable inbox and a successful append
                // all read identically. Report what happened, not what was
                // attempted.
                let secondQueued = await vm.enqueueQueenInboxEntry(
                    issue: two[0],
                    worker: two[1].isEmpty ? nil : two[1],
                    title: two[2].isEmpty ? nil : two[2],
                    paths: Self.inboxPaths(two.count >= 4 ? two[3] : ""),
                    skill: nil,
                    criteria: nil
                )
                if secondQueued {
                    TriosLogBus.shared.info(
                        .queen, "queen.selftest.secondStarted",
                        "A second bee was started alongside the first",
                        ["issue": two[0]]
                    )
                } else {
                    // Not fatal to the probe: the first bee is already queued
                    // and the run continues to verify it. Only the parallel
                    // half is lost, and it must say so.
                    TriosLogBus.shared.warn(
                        .queen, "queen.selftest.secondNotStarted",
                        "The second bee was not queued - the inbox refused the delegation",
                        ["issue": two[0], "spec": second]
                    )
                }
            }
        }

        await runE2EQueenCommand(environment: environment)

        // When the Queen chose the work herself (`/choose --start`),
        // issueText is empty. The registry still holds the task it
        // registered, so fall back to the most recent non-terminal one
        // instead of declaring failure. An empty registry stays a
        // failure with the same record.
        let lookup: () -> DelegatedTask? = {
            if let issue = IssueReference.parse(issueText) {
                return QueenDelegationRegistry.shared.task(forIssue: issue)
            }
            return QueenDelegationRegistry.shared.tasks
                .filter { !$0.state.isTerminal }
                .max { $0.createdAt < $1.createdAt }
        }

        // #1090: the inbox is now the only entrance, and it has two readers -
        // the synchronous consume inside enqueueQueenInboxEntry and the 5 s
        // background loop. They are separate awaiting calls on the same
        // main-actor object, so the loop can take the line first and still be
        // parked inside fetchIssueBody (2.1 s, measured) when the synchronous
        // consume finds nothing new and returns. Without this wait the probe
        // would report "Delegation did not register a task" for a delegation
        // that is in flight and about to succeed.
        //
        // Bounded at 30 s and costing nothing on the happy path. Deliberately
        // not applied to the empty-issue fallback: with `/choose --start` a
        // genuinely empty registry must keep failing immediately.
        var resolved = lookup()
        if resolved == nil, IssueReference.parse(issueText) != nil {
            for _ in 0..<120 where resolved == nil {
                try? await Task.sleep(nanoseconds: 250_000_000)
                resolved = lookup()
            }
        }

        guard let task = resolved else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.failed",
                "Delegation did not register a task",
                ["issue": issueText]
            )
            return
        }
        let issue = task.issue

        // Wait for the bee, bounded. A self-test that hangs is a self-test that
        // gets ignored. Agent turns that edit a repository routinely run for
        // many minutes, so the ceiling is generous and overridable.
        let seconds = Double(environment["TRIOS_E2E_DELEGATE_TIMEOUT"] ?? "") ?? 900
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline,
              vm.workerRunner?.isRunning(conversationId: task.conversationId) == true {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }

        let transcript = vm.workerRunner?.transcripts[task.conversationId] ?? []
        let answered = transcript.contains { $0.role == .assistant && !$0.content.isEmpty }
        let stillRunning = vm.workerRunner?.isRunning(conversationId: task.conversationId) == true
        let tools = transcript.reduce(0) { $0 + $1.toolCalls.count }
        let state = QueenDelegationRegistry.shared.task(forConversation: task.conversationId)?.state
        // "No answer yet" and "no answer ever" are different verdicts; reporting
        // a running worker as a failure is how a slow bee gets called a broken one.
        let verdict: String
        if answered {
            verdict = "Worker answered"
        } else if stillRunning {
            verdict = "Worker still running at the \(Int(seconds))s deadline"
        } else {
            verdict = "Worker finished without producing assistant text"
        }
        let report = answered ? TriosLogBus.shared.info : TriosLogBus.shared.error
        report(
            .queen,
            answered ? "queen.selftest.passed" : "queen.selftest.failed",
            verdict,
            [
                "issue": task.issue.slug,
                "worker": worker,
                "messages": String(transcript.count),
                "tools": String(tools),
                "state": state?.rawValue ?? "unknown"
            ]
        )

        // A second turn on the same conversation, when asked for. The orphan
        // regression only shows itself on the *next* send: the first turn
        // leaves a tool call unanswered, and the send after it is the one that
        // used to throw before leaving the app. Testing one turn proves nothing
        // about the bug.
        if environment["TRIOS_E2E_SECOND_TURN"] == "1" {
            TriosLogBus.shared.info(
                .queen,
                "queen.selftest.second_turn",
                "Sending a second turn on the same conversation",
                ["issue": issue.slug]
            )
            vm.workerRunner?.start(
                task: task,
                brief: "Continue. This is the turn that fails if the previous "
                    + "one left a tool call unanswered."
            )
            let secondDeadline = Date().addingTimeInterval(120)
            while Date() < secondDeadline,
                  vm.workerRunner?.isRunning(conversationId: task.conversationId) == true {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            let after = vm.workerRunner?.transcripts[task.conversationId] ?? []
            let answered = after.contains { $0.role == .assistant && !$0.content.isEmpty }
            let report = answered ? TriosLogBus.shared.info : TriosLogBus.shared.error
            report(
                .queen,
                answered ? "queen.selftest.second_turn_passed" : "queen.selftest.second_turn_failed",
                answered
                    ? "The conversation survived a turn that left an orphan"
                    : "The second turn produced nothing - the orphan poisoned the conversation",
                ["issue": issue.slug]
            )
        }

        // Prove the wake path while work is still outstanding. Running it after
        // acceptance only ever exercised the silent branch.
        await QueenReviewScheduler.shared.reviewNow()

        // Optionally close the loop, so the review commands are exercised by the
        // same probe rather than only by hand.
        guard let verb = environment["TRIOS_E2E_DELEGATE_REVIEW"], !verb.isEmpty else { return }

        // Wait for the task to leave `running`, not merely for the runner to
        // drop its flag. Those are different moments: the runner clears first,
        // and only afterwards does handleWorkerFinished commit the branch and
        // move the task to awaitingReview. Reviewing in between issues /accept
        // against a running task, which is not a legal transition - so the
        // command was refused, the state never moved, and no pull request was
        // ever opened. Every probe that has ever "closed the loop" was in fact
        // reviewing too early and reporting the refusal as a state.
        for _ in 0..<120 {
            let current = QueenDelegationRegistry.shared
                .task(forConversation: task.conversationId)?.state
            if current != .running { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }

        await vm.runQueenCommand("/swarm")
        let command = verb == "reject"
            ? "/review \(issue.slug) reject probe rejection"
            : "/accept \(issue.slug) probe acceptance"
        await vm.runQueenCommand(command)
        // Poll again, after the review. The earlier reviewNow() runs while work
        // is still outstanding and therefore always before any pull request
        // exists - so the merge half of the loop had never once been reached by
        // a probe. This is the step that closes the cycle: acceptance opens the
        // pull request, and the next poll is what can land it.
        if verb != "reject" {
            for _ in 0..<40 {
                let task = QueenDelegationRegistry.shared.task(forConversation: task.conversationId)
                    ?? QueenDelegationRegistry.shared.tasks.first { $0.issue == issue }
                if task?.pullRequestNumber != nil { break }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            await QueenReviewScheduler.shared.reviewNow()
        }

        let reviewed = QueenDelegationRegistry.shared.tasks
            .first { $0.conversationId == task.conversationId }?
            .state
        TriosLogBus.shared.info(
            .queen,
            "queen.selftest.reviewed",
            "Review command applied",
            ["issue": issue.slug, "command": verb, "state": reviewed?.rawValue ?? "unknown"]
        )

        // Queen command runs AFTER delegation so a probe can assert on
        // delegation results before exercising a slash command.
        await runE2EQueenCommand(environment: environment)
    }

    /// Runs a raw queen slash command from `TRIOS_E2E_QUEEN_COMMAND`, independently
    /// of `TRIOS_E2E_DELEGATE`. Called after the delegation block (or directly
    /// when no delegation was requested), so the command always runs last.
    @MainActor
    private func runE2EQueenCommand(environment: [String: String]) async {
        guard let queenCommand = environment["TRIOS_E2E_QUEEN_COMMAND"], !queenCommand.isEmpty else {
            return
        }
        guard let vm = chatViewModel else {
            TriosLogBus.shared.error(.queen, "queen.command.failed", "No chat view model", [:])
            return
        }
        TriosLogBus.shared.info(
            .queen, "queen.command.start", "E2E queen command", ["command": queenCommand]
        )
        let commands = queenCommand
            .components(separatedBy: ";;")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        for command in commands {
            await vm.runQueenCommand(command)
            TriosLogBus.shared.info(
                .queen, "queen.command.ran", "E2E queen command executed", ["command": command]
            )
        }
    }

    /// Wait for one Queen registry report and log its text as a separate
    /// event so the self-test run gives a verdict, not silence.
    ///
    /// The delegation self-test proves the bee flew; this proves the Queen
    /// noticed and said something about it. Without it, the report is lost to
    /// the chat transcript that nobody reads after the app closes.
    ///
    /// Set `TRIOS_E2E_QUEEN_REPORT=1` to opt in. The report comes from the
    /// same `walkRegistryAndReport()` the loop calls, so the text is exactly
    /// what the Queen would say on a timer wake.
    /// Prove the Queen's first report in a process is always full and that a
    /// second walk without changes collapses to the one-liner.
    ///
    /// Two consecutive walks with no swarm movement: the first must be a full
    /// digest (never "nothing has changed"), the second must be the one-liner.
    /// If someone removes the deduplication guard entirely, the second walk
    /// would produce a full report identical to the first, and this test would
    /// catch it.
    ///
    /// Set `TRIOS_E2E_QUEEN_REPORT=1` to opt in. The reports come from the
    /// same `walkRegistryAndReport()` the loop calls.
    @MainActor
    private func runQueenReportSelfTestIfRequested() async {
        let environment = ProcessInfo.processInfo.environment
        guard environment["TRIOS_E2E_QUEEN_REPORT"] != nil else { return }

        TriosLogBus.shared.info(
            .queen,
            "queen.selftest.report.start",
            "Starting Queen report self-test: two walks, same swarm",
            [:]
        )

        // Reset so the first walk is treated as the first report in the
        // process, even if the timer loop already fired between start() and
        // here. The guarantee under test is "the first report in a process is
        // always full" — the reset puts us in exactly that state.
        QueenBackgroundService.shared.resetReportTracking()

        // ── Walk 1: must be a full report, never the one-liner ──
        await QueenBackgroundService.shared.walkRegistryAndReport()

        guard let firstText = QueenBackgroundService.shared.lastReportText else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.report.failed",
                "First walk produced no report text",
                [:]
            )
            return
        }

        let firstWasOneLiner = QueenBackgroundService.shared.lastReportWasOneLiner ?? false
        let firstLimit = 500
        TriosLogBus.shared.info(
            .queen,
            firstWasOneLiner
                ? "queen.selftest.report.first_was_oneliner"
                : "queen.selftest.report.first",
            String(firstText.prefix(firstLimit)),
            [
                "walk": "1",
                "length": String(firstText.count),
                "one_liner": String(firstWasOneLiner),
                "truncated": firstText.count > firstLimit ? "true" : "false"
            ]
        )

        if firstWasOneLiner {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.report.failed",
                "First report in a process was a one-liner — it must always be full",
                [:]
            )
            return
        }

        // ── Walk 2: same registry, nothing changed — must be the one-liner ──
        await QueenBackgroundService.shared.walkRegistryAndReport()

        guard let secondText = QueenBackgroundService.shared.lastReportText else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.report.failed",
                "Second walk produced no report text",
                [:]
            )
            return
        }

        let secondWasOneLiner = QueenBackgroundService.shared.lastReportWasOneLiner ?? false
        TriosLogBus.shared.info(
            .queen,
            "queen.selftest.report.second",
            String(secondText.prefix(200)),
            [
                "walk": "2",
                "length": String(secondText.count),
                "one_liner": String(secondWasOneLiner)
            ]
        )

        if secondWasOneLiner {
            TriosLogBus.shared.info(
                .queen,
                "queen.selftest.report.passed",
                "First report was full, second was a one-liner — dedup works",
                [:]
            )
        } else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.report.failed",
                "Second walk without changes was not a one-liner — dedup is broken",
                [:]
            )
        }
    }

    /// Proves the acceptance gate in `autoAcceptIfUnambiguous` is load-bearing.
    ///
    /// The gate added in #1133 stops auto-accept from closing a task before
    /// every criterion has a verdict. This self-test exercises that gate end
    /// to end: after a delegation finishes, it checks whether the task
    /// reached `.accepted` only when all criteria are met, and whether a late
    /// `unmet` verdict on an accepted task reopens it.
    ///
    /// Set `TRIOS_E2E_ACCEPTANCE_GATE=1` alongside `TRIOS_E2E_DELEGATE` and
    /// `TRIOS_QUEEN_AUTONOMY=1`. Without autonomy the auto-accept path never
    /// runs, so there is nothing to test — the function reports that and
    /// returns.
    ///
    /// What this proves, criterion by criterion:
    ///
    /// - **#1133-3**: If every criterion is met, the task must be `.accepted`.
    ///   If the gate blocked it, the assertion fires.
    /// - **#1133-4**: If any criterion is not met, the task must NOT be
    ///   `.accepted`. If the criteria check is removed from
    ///   `autoAcceptIfUnambiguous`, the task is accepted regardless, and this
    ///   assertion catches it. That is the sense in which removing the wait
    ///   breaks the check.
    /// - **#1133-2**: If the task was accepted, recording an `unmet` verdict
    ///   on a criterion must reopen it. Without the reopening logic the task
    ///   stays accepted, and the assertion fires.
    @MainActor
    private func runAcceptanceGateSelfTestIfRequested() async {
        let environment = ProcessInfo.processInfo.environment
        guard environment["TRIOS_E2E_ACCEPTANCE_GATE"] != nil else { return }

        guard let vm = chatViewModel else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.acceptance_gate.failed",
                "No chat view model",
                [:]
            )
            return
        }

        guard let spec = environment["TRIOS_E2E_DELEGATE"], !spec.isEmpty else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.acceptance_gate.failed",
                "TRIOS_E2E_ACCEPTANCE_GATE requires TRIOS_E2E_DELEGATE to have run",
                [:]
            )
            return
        }

        let fields = spec.split(separator: "|", omittingEmptySubsequences: false)
            .map(String.init)
        guard (3...5).contains(fields.count) else { return }
        guard let issue = IssueReference.parse(fields[0]) else { return }

        guard let task = QueenDelegationRegistry.shared.task(forIssue: issue) else {
            TriosLogBus.shared.error(
                .queen,
                "queen.selftest.acceptance_gate.failed",
                "No task found for \(issue.slug)",
                [:]
            )
            return
        }

        let autonomy = environment["TRIOS_QUEEN_AUTONOMY"] == "1"
        let criteria = task.acceptanceCriteria
        let verdicts = task.criterionVerdicts
        let state = task.state

        // Build the verdict table the same way the acceptance gate does, so
        // the test's view of "met" matches the gate's.
        let table = QueenAcceptancePolicy.verdicts(
            criteria: criteria, recorded: verdicts
        )
        let metCount = table.filter { $0.verdict == .met }.count
        let unmetCount = table.filter { $0.verdict == .unmet }.count
        let uncheckedCount = table.filter { $0.verdict == .unchecked }.count
        let staleCount = table.filter { $0.verdict == .stale }.count
        let allMet = !criteria.isEmpty
            && unmetCount == 0
            && uncheckedCount == 0
            && staleCount == 0

        TriosLogBus.shared.info(
            .queen,
            "queen.selftest.acceptance_gate.state",
            "Acceptance gate snapshot",
            [
                "issue": issue.slug,
                "state": state.rawValue,
                "criteria": String(criteria.count),
                "met": String(metCount),
                "unmet": String(unmetCount),
                "unchecked": String(uncheckedCount),
                "stale": String(staleCount),
                "autonomy": String(autonomy),
                "all_met": String(allMet)
            ]
        )

        guard autonomy else {
            TriosLogBus.shared.info(
                .queen,
                "queen.selftest.acceptance_gate.skipped",
                "TRIOS_QUEEN_AUTONOMY is not set — auto-accept path did not run",
                [:]
            )
            return
        }

        guard !criteria.isEmpty else {
            TriosLogBus.shared.info(
                .queen,
                "queen.selftest.acceptance_gate.skipped",
                "Task has no acceptance criteria — nothing to gate on",
                [:]
            )
            return
        }

        // ── Criterion 3: met criteria must reach .accepted ──
        if allMet {
            if state == .accepted {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.selftest.acceptance_gate.passed",
                    "All criteria met and task reached accepted",
                    ["issue": issue.slug]
                )
            } else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.selftest.acceptance_gate.failed",
                    "All criteria are met but task is \(state.rawValue), not accepted "
                        + "— the gate blocked a task it should have passed",
                    ["issue": issue.slug, "state": state.rawValue]
                )
            }
        } else {
            // ── Criterion 4: unmet criteria must NOT reach .accepted ──
            // This is the assertion that breaks if the wait (the criteria
            // check in autoAcceptIfUnambiguous) is removed: without it the
            // task is accepted regardless of verdicts, and this fires.
            if state == .accepted {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.selftest.acceptance_gate.failed",
                    "Criteria not all met but task was accepted — the acceptance "
                        + "gate did not wait for verdicts (#1133 criterion 4)",
                    [
                        "issue": issue.slug,
                        "state": state.rawValue,
                        "unmet": String(unmetCount),
                        "unchecked": String(uncheckedCount),
                        "stale": String(staleCount)
                    ]
                )
            } else {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.selftest.acceptance_gate.gate_held",
                    "Criteria not all met; task correctly not accepted",
                    ["issue": issue.slug, "state": state.rawValue]
                )
            }
        }

        // ── Criterion 2: late verdicts must reopen an accepted task ──
        // Only testable when the task was accepted: there must be something
        // to reopen. The test records an `unmet` verdict on the first
        // criterion and checks whether the task returns to awaitingReview.
        if state == .accepted {
            let firstCriterion = criteria[0]
            await vm.runQueenCommand(
                "/verify \(issue.slug) \(firstCriterion) unmet"
            )

            // Give the reopen logic a moment to settle — it posts a notice
            // and transitions, neither of which is instantaneous.
            for _ in 0..<10 {
                let current = QueenDelegationRegistry.shared
                    .task(forIssue: issue)?.state
                if current == .awaitingReview { break }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }

            let reopened = QueenDelegationRegistry.shared
                .task(forIssue: issue)?.state

            if reopened == .awaitingReview {
                TriosLogBus.shared.info(
                    .queen,
                    "queen.selftest.acceptance_gate.reopened",
                    "Task reopened after a late unmet verdict (#1133 criterion 2)",
                    ["issue": issue.slug, "state": reopened?.rawValue ?? "unknown"]
                )
            } else {
                TriosLogBus.shared.error(
                    .queen,
                    "queen.selftest.acceptance_gate.failed",
                    "Task was accepted but a late unmet verdict did not reopen it "
                        + "(#1133 criterion 2)",
                    ["issue": issue.slug, "state": reopened?.rawValue ?? "unknown"]
                )
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        sessionGuard?.stopMonitoring()
        cladeGuard?.stopMonitoring()
        AuditRotationScheduler.shared.stop()
        Task {
            await QueenBackgroundService.shared.stop()
            await MainActor.run {
                serverManager.terminateAll()
            }
        }
    }

    @objc func exportSessionRecoveryPackage(_ sender: Any?) {
        NSLog("Export session recovery package requested")
        NotificationCenter.default.post(name: .exportSessionRecoveryPackage, object: nil)
    }

    @objc func importSessionRecoveryPackage(_ sender: Any?) {
        NSLog("Import session recovery package requested")
        NotificationCenter.default.post(name: .importSessionRecoveryPackage, object: nil)
    }

    private func setupStatusItem() {
        // Guard against duplicate status items if this method is called more than once
        if let existing = statusItem, existing.button != nil {
            NSLog("setupStatusItem: statusItem already exists, skipping creation")
            return
        }

        NSLog("setupStatusItem starting")
        var logoImage: NSImage?
        var isOriginalLogo = false
        if let logoURL = Bundle.main.url(forResource: "logo", withExtension: "png"),
           let image = NSImage(contentsOf: logoURL) {
            logoImage = image
            isOriginalLogo = true
        } else {
            let fallbackPaths = [
                ProjectPaths.logoPNG,
                "\(ProjectPaths.appBundle)/Contents/Resources/logo.png"
            ]
            for path in fallbackPaths {
                if FileManager.default.fileExists(atPath: path),
                   let image = NSImage(contentsOfFile: path) {
                    logoImage = image
                    isOriginalLogo = true
                    break
                }
            }
        }

        // Fallback: generate a solid-color circle icon so the user ALWAYS has a visible status icon
        if logoImage == nil {
            logoImage = generateFallbackIcon()
            NSLog("setupStatusItem: generated fallback circle icon")
        }

        if let image = logoImage {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            // CRITICAL: isTemplate must be false for the colored fallback icon.
            // isTemplate = true tells macOS to recolor the image to match the menubar
            // (black/white), which makes a colored circle invisible. Only use template
            // mode for the original monochrome logo file.
            image.isTemplate = isOriginalLogo
            image.size = NSSize(width: 22, height: 22)
            statusItem?.button?.image = image
            statusItem?.button?.imagePosition = .imageOnly
            statusItem?.button?.title = ""
            NSLog("setupStatusItem: image set (template=\(isOriginalLogo)), size=\(image.size)")
        } else {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem?.button?.title = "T"
            statusItem?.button?.font = NSFont.systemFont(ofSize: 14, weight: .bold)
            NSLog("setupStatusItem: no image, using text fallback 'T'")
        }
        statusItem?.button?.toolTip = "TRIOS AGENT"
        statusItem?.button?.target = self
        statusItem?.button?.action = #selector(statusBarButtonClicked(_:))
        statusItem?.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem?.menu = nil
        if let button = statusItem?.button {
            NSLog("setupStatusItem done — statusItem created, button frame=\(button.frame), image=\(String(describing: button.image))")
        } else {
            NSLog("setupStatusItem ERROR: statusItem.button is nil!")
        }
    }

    /// Generates a solid colored circle NSImage so the status bar icon is always visible
    private func generateFallbackIcon() -> NSImage {
        let size = NSSize(width: 22, height: 22)
        let image = NSImage(size: size)
        image.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        let path = NSBezierPath(ovalIn: rect)
        NSColor(red: 0.45, green: 0.55, blue: 1.0, alpha: 1.0).setFill()
        path.fill()
        image.unlockFocus()
        return image
    }

    @MainActor
    func setupSidePanel() {
        NSLog("setupSidePanel starting")
        let viewModel = compositionRoot.makeChatViewModel()
        self.chatViewModel = viewModel
        NSLog("ChatViewModel created")
        let tabView = TriosTabView(viewModel: viewModel)
        NSLog("TriosTabView created")
        let panel = windowManager.setupPanel(contentView: AnyView(tabView))
        NSLog("Panel created: \(panel)")
    }

    // MARK: - Window Shifting

    func getWindowFrame(_ window: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success,
              let positionAXValue = castAXValue(positionValue) else {
            return nil
        }
        var position = CGPoint.zero
        guard AXValueGetValue(positionAXValue, .cgPoint, &position) else { return nil }

        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let sizeAXValue = castAXValue(sizeValue) else {
            return nil
        }
        var size = CGSize.zero
        guard AXValueGetValue(sizeAXValue, .cgSize, &size) else { return nil }

        return CGRect(origin: position, size: size)
    }

    /// Centralizes the CoreFoundation AXValue cast so the type-ID check and the
    /// cast live in one place. The guard above guarantees the value is an AXValue;
    /// `as!` is the idiomatic form for this CoreFoundation cast.
    private func castAXValue(_ value: CFTypeRef?) -> AXValue? {
        guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        // The type-ID check guarantees the value is an AXValue. `unsafeBitCast`
        // is used instead of `as!` because the compiler treats the forced CF
        // cast as unconditionally succeeding and emits an error for `as?`.
        return unsafeBitCast(value, to: AXValue.self)
    }

    func setWindowFrame(_ window: AXUIElement, frame: CGRect) {
        var position = frame.origin
        var size = frame.size
        if let posValue = AXValueCreate(.cgPoint, &position) {
            AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, posValue)
        }
        if let sizeValue = AXValueCreate(.cgSize, &size) {
            AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
        }
    }

    func getAllWindows() -> [(AXUIElement, CGRect)] {
        var result: [(AXUIElement, CGRect)] = []
        let currentPid = getpid()
        guard let screen = NSScreen.main else { return result }
        let screenFrame = screen.frame

        for app in NSWorkspace.shared.runningApplications {
            guard app.activationPolicy == .regular else { continue }
            let pid = app.processIdentifier
            if pid == currentPid { continue }

            let axApp = AXUIElementCreateApplication(pid)
            var windowsValue: CFTypeRef?
            let copyResult = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)

            if copyResult == .success, let windowList = windowsValue as? [AXUIElement] {
                for window in windowList {
                    if let frame = getWindowFrame(window) {
                        guard frame.width > 100, frame.height > 100 else { continue }
                        guard frame.intersects(screenFrame) else { continue }
                        result.append((window, frame))
                    }
                }
            }
        }
        return result
    }

    func shiftWindows() {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.frame
        let cutoffX = screenFrame.maxX - currentSidebarWidth
        windowStates.removeAll()
        let allWindows = getAllWindows()
        for (window, frame) in allWindows {
            guard frame.maxX > cutoffX else { continue }
            windowStates.append((window, frame))
            var newFrame = frame
            let overlap = frame.maxX - cutoffX
            let minWidth: CGFloat = 400
            if frame.origin.x >= overlap {
                newFrame.origin.x -= overlap
            } else if frame.width - overlap >= minWidth {
                newFrame.size.width -= overlap
            } else {
                newFrame.origin.x = 0
                newFrame.size.width = cutoffX
            }
            setWindowFrame(window, frame: newFrame)
        }
    }

    func restoreWindows() {
        for (window, frame) in windowStates {
            setWindowFrame(window, frame: frame)
        }
        windowStates.removeAll()
    }

    // MARK: - UI Actions

    @objc func statusBarButtonClicked(_ sender: Any?) {
        NSLog("statusBarButtonClicked called")
        guard let event = NSApp.currentEvent else {
            NSLog("statusBarButtonClicked: no current event, toggling")
            toggleSidePanel()
            return
        }
        NSLog("statusBarButtonClicked: event.type = \(event.type)")
        if event.type == .rightMouseUp {
            let menu = createMenu()
            statusItem?.menu = menu
            statusItem?.button?.performClick(nil)
            statusItem?.menu = nil
        } else {
            toggleSidePanel()
        }
    }

    @objc func toggleSidePanel() {
        NSLog("toggleSidePanel called")
        // CRITICAL: Lazy creation — if panel hasn't been built yet, build it now.
        // This prevents the "click does nothing" bug when setupSidePanel hasn't completed.
        Task { @MainActor in
            if windowManager.panel == nil {
                NSLog("toggleSidePanel: panel is nil — creating lazily")
                setupSidePanel()
            }
            performToggle()
        }
    }

    @MainActor
    private func performToggle() {
        guard let panel = windowManager.panel else {
            NSLog("toggleSidePanel: panel is STILL nil after lazy creation — critical error")
            return
        }
        NSLog("toggleSidePanel: panel isVisible=\(panel.isVisible), frame=\(panel.frame)")
        if panel.isVisible {
            NSLog("toggleSidePanel: closing panel")
            windowManager.close { [weak self] in
                self?.restoreWindows()
            }
        } else {
            NSLog("toggleSidePanel: opening panel")
            accessibilityGranted = AXIsProcessTrusted()
            NSLog("toggleSidePanel: accessibilityGranted=\(accessibilityGranted)")
            if accessibilityGranted {
                shiftWindows()
            } else if !accessibilityPromptShown {
                accessibilityPromptShown = true
                showAlert("Please grant Trios Accessibility access in:\nSystem Settings → Privacy & Security → Accessibility")
            }
            NSLog("toggleSidePanel: calling windowManager.open()")
            windowManager.open()
            NSLog("toggleSidePanel: windowManager.open() returned")
        }
    }

    func createMenu() -> NSMenu {
        menuBuilder.buildMenu()
    }

    func statusText() -> String {
        menuBuilder.statusText()
    }

    func setCleanCaptureMode(_ enabled: Bool) {
        guard let panel = windowManager.panel else { return }
        screenManager.setCleanCaptureMode(enabled, for: panel)
    }

    @objc func toggleCleanCaptureMode() {
        guard let panel = windowManager.panel else { return }
        setCleanCaptureMode(panel.appearance != nil)
    }

    @objc func toggleServer() {
        serverManager.toggleServer()
    }

    @objc func toggleFunnel() {
        serverManager.toggleFunnel()
    }

    @objc func openLocal() {
        guard let url = URL(string: ProjectPaths.mcpBaseURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func openPublic() {
        let host = ProcessInfo.processInfo.environment["TRIOS_PUBLIC_HOST"]
            ?? "https://playras-macbook-pro-1.tail01804b.ts.net"
        guard let url = URL(string: host) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func connectMCP() {
        guard let url = URL(string: "browseros://settings") else { return }
        NSWorkspace.shared.open(url)
        let alert = NSAlert()
        alert.messageText = "Connect TRIOS to Local Server"
        alert.informativeText = """
1. In TRIOS Settings, find "Add Custom App"
2. Name: TRIOS Local Filesystem
3. URL: http://127.0.0.1:9105/mcp
4. Click Save

Your filesystem tools will be available!
"""
        alert.alertStyle = .informational
        alert.runModal()
    }

    @objc func quit() {
        RecursionGuard.shared.cleanup()
        Task {
            await QueenBackgroundService.shared.stop()
            await MainActor.run {
                serverManager.terminateAll()
                NSApplication.shared.terminate(nil)
            }
        }
    }

    // MARK: - URL / Reopen Safety Guards

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            let urlString = url.absoluteString.lowercased()
            // Block any URL that could trigger a recursive self-launch
            if urlString.contains("trios") || urlString.contains("browseros://settings") {
                NSLog("[AppDelegate] Blocked recursive URL open: \(url)")
                continue
            }
            NSWorkspace.shared.open(url)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // If panel is already visible, just focus it instead of creating duplicate state
        if let panel = windowManager.panel {
            panel.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            return false
        }
        return true
    }

    func showAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    // MARK: - Panel Mode Actions

    @objc func setPanelMode(_ sender: NSMenuItem) {
        let modes = TriosPanelMode.allCases
        guard sender.tag < modes.count else { return }
        screenManager.panelMode = modes[sender.tag]
        if let panel = windowManager.panel {
            screenManager.applyMode(to: panel)
        }
    }

    @objc func moveToScreen(_ sender: NSMenuItem) {
        let screens = NSScreen.screens
        guard sender.tag < screens.count else { return }
        if let panel = windowManager.panel {
            screenManager.positionPanel(panel, on: screens[sender.tag], width: sidebarWidth)
        }
    }

    // MARK: - Global Hotkey

    func setupGlobalHotkey() {
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.contains(.command),
                  event.modifierFlags.contains(.shift),
                  event.keyCode == 17 else { return }
            DispatchQueue.main.async {
                self?.toggleSidePanel()
            }
        }
    }
}

// CompositionRoot + TriosPanelMode + TriosScreenManager + NSScreen extension
// extracted to rings/SR-00/CompositionRoot.swift, TriosPanelMode.swift, TriosScreenManager.swift

// MARK: - Boot Sequence

// SAFETY: Enforce single instance before any UI is created or the run loop starts.
// This catches launches that would otherwise race through AppDelegate initialization.
guard RecursionGuard.shared.ensureSingleInstance() else {
    NSLog("[main] Another trios instance is already running — exiting")
    exit(0)
}

MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
}
