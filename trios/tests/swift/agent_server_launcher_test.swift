// Standalone unit tests for AgentServerLauncher.spawnVerdict - the pure
// mapping from the measured facts (the child's fate, the port's answer, and
// WHOSE answer it is) to the verdict the launcher reports.
//
// The suite exists because of a measured incident (2026-08-22 05:57Z): a
// busy-but-alive server missed one health probe, the watchdog spawned a
// replacement into the taken port, the replacement died on the collision at
// second four, the old server recovered and answered at second seventeen -
// and the launcher reported "Started the agent server". The port answering
// and the child surviving are independent facts, and even both together do
// not prove the answer CAME from the child - which is why /health now
// carries the serving pid and the verdict compares it against the child's.
//
// Run (from trios root):
//   swiftc tests/swift/agent_server_launcher_test.swift \
//     rings/SR-01/AgentServerLauncher.swift \
//     BR-OUTPUT/ProjectPaths.swift rings/SR-00/BuildVariantPolicy.swift \
//     rings/SR-01/TriosLogBus.swift rings/SR-01/TriosOTLPExporter.swift \
//     -o /tmp/trios_agent_server_launcher_test && /tmp/trios_agent_server_launcher_test

import Foundation

@main
enum AgentServerLauncherTests {
    static var failures = 0
    static var checks = 0

    static let childPID: Int32 = 500
    static let foreignPID: Int32 = 76630

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func verdict(
        alive: Bool, exit: Int32?, health: AgentServerLauncher.HealthProbe
    ) -> AgentServerLauncher.SpawnVerdict {
        AgentServerLauncher.spawnVerdict(
            childAlive: alive, exitStatus: exit, health: health, childPID: childPID
        )
    }

    static func main() {
        attributionRules()
        deadChildRules()
        waitingRules()
        theMeasuredIncident()
        exitStatusHandling()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All AgentServerLauncher tests passed.")
    }

    /// "Started" is a claim about WHOSE answer it is, not just that one came.
    static func attributionRules() {
        scenario("started requires the answer to be the child's - or unattributable at worst")

        check(
            verdict(alive: true, exit: nil, health: .answering(pid: childPID)) == .started,
            "the child's own pid answering is the fully measured 'started'"
        )
        check(
            verdict(alive: true, exit: nil, health: .answering(pid: foreignPID)) == .stillWaiting,
            "a FOREIGN pid answering while the child lives is not started - the bind race resolves it"
        )
        check(
            verdict(alive: true, exit: nil, health: .answering(pid: nil)) == .started,
            "a pre-pid server cannot be attributed; a child that outlived the answer is the best remaining claim"
        )
    }

    /// A dead child is never 'started', whatever the port says.
    static func deadChildRules() {
        scenario("a dead child is never started, and the port's answer picks between superseded and exited")

        check(
            verdict(alive: false, exit: 1, health: .answering(pid: foreignPID))
                == .superseded(exitStatus: 1),
            "dead child + answering port is SUPERSEDED: someone else holds the port"
        )
        check(
            verdict(alive: false, exit: 1, health: .answering(pid: childPID))
                == .superseded(exitStatus: 1),
            "even the child's own pid answering cannot resurrect it - a dead child with a matching pid is pid reuse, reported as superseded"
        )
        check(
            verdict(alive: false, exit: 1, health: .refused) == .exited(exitStatus: 1),
            "dead child + refused connection is EXITED: the spawn failed and nothing listens"
        )
        check(
            verdict(alive: false, exit: 1, health: .silent) == .exited(exitStatus: 1),
            "dead child + silent port is EXITED: the spawn failed and nothing answers"
        )
    }

    /// While the child lives and no attributed answer exists, nothing is
    /// decided - the loop keeps waiting instead of guessing.
    static func waitingRules() {
        scenario("an alive child with no attributed answer keeps the loop waiting")

        check(
            verdict(alive: true, exit: nil, health: .refused) == .stillWaiting,
            "alive child + refused connection: it has not bound the port yet, keep waiting"
        )
        check(
            verdict(alive: true, exit: nil, health: .silent) == .stillWaiting,
            "alive child + silent port: booting, keep waiting"
        )
    }

    /// The 05:57Z incident and its reviewer-found variants: none of them may
    /// produce 'started'.
    static func theMeasuredIncident() {
        scenario("the incident replay and its earlier-shifted variant never say started")

        // The measured shape: child dead on the collision, old server answers.
        check(
            verdict(alive: false, exit: 1, health: .answering(pid: foreignPID)) != .started,
            "the dead child is not reported as started however healthy the port"
        )
        // The reviewer-found variant: the old server recovers WHILE the doomed
        // child still boots. Attribution stops the lie the liveness check
        // cannot: the answer carries the old server's pid, not the child's.
        check(
            verdict(alive: true, exit: nil, health: .answering(pid: foreignPID)) != .started,
            "an alive-but-doomed child is not certified by the old server's recovery - the pid gives the answer an owner"
        )
    }

    /// A dead child whose exit status could not be read still reports as
    /// dead, with a sentinel rather than an invented status.
    static func exitStatusHandling() {
        scenario("exit status is evidence - kept when known, sentinel when not")

        check(
            verdict(alive: false, exit: nil, health: .silent) == .exited(exitStatus: -1),
            "an unknown exit status becomes the -1 sentinel, not a fabricated zero"
        )
        check(
            verdict(alive: false, exit: 137, health: .answering(pid: foreignPID))
                == .superseded(exitStatus: 137),
            "a SIGKILLed child's status (137) survives into the superseded verdict"
        )
    }
}
