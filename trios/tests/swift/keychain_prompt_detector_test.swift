// Standalone unit tests for KeychainPromptDetector - the measurement that
// tells "the keychain is slow" apart from "the keychain is waiting for a
// human".
//
// Both look identical from inside the app: an eight-second timeout. On
// 2026-08-22 they were confused for over an hour. The release app rebuilt
// itself, its ad-hoc signature stopped matching the ACL on its own keychain
// items, macOS put an access dialog on screen, and every keychain call queued
// behind it. Twenty warm-up attempts across two cycles reported "did not
// answer in 8s" and "the cache is still empty" - both true, both useless,
// both pointing at a keychain that was fine: the shell read the same service
// in 24 ms and the dev app read it successfully in the same minute.
//
// Run (from trios root):
//   swiftc tests/swift/keychain_prompt_detector_test.swift \
//     rings/SR-00/KeychainPromptDetector.swift \
//     -o /tmp/trios_keychain_prompt_detector_test \
//     && /tmp/trios_keychain_prompt_detector_test

import Foundation

@main
enum KeychainPromptDetectorTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        detection()
        theTwoSentences()
        theWarmupVerdict()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All KeychainPromptDetector tests passed.")
    }

    static func detection() {
        scenario("the dialog is detected by asking for its process, not by inferring from a timeout")

        check(
            KeychainPromptDetector.promptIsWaiting(runningProcesses: { ["SecurityAgent"] }),
            "a running SecurityAgent is a waiting dialog"
        )
        check(
            !KeychainPromptDetector.promptIsWaiting(runningProcesses: { [] }),
            "no SecurityAgent is no dialog - the stall is then genuinely the keychain"
        )
        check(
            KeychainPromptDetector.promptIsWaiting(runningProcesses: {
                ["/System/Library/Frameworks/Security.framework/Versions/A/"
                    + "MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent"]
            }),
            "a full executable path still matches - this is the shape ps actually prints"
        )
        check(
            !KeychainPromptDetector.promptIsWaiting(runningProcesses: { ["SecurityAgentHelper"] }),
            "a different process whose name merely starts the same is not the dialog"
        )
    }

    static func theTwoSentences() {
        scenario("a stall says one of two things, and they send the reader to different places")

        let quiet = KeychainPromptDetector.stallExplanation(
            service: "com.browseros.trios.model-keys", deadlineSeconds: 8, promptWaiting: false
        )
        check(
            quiet.contains("did not answer in 8s"),
            "with no dialog the message is the plain measured timeout"
        )
        check(
            !quiet.lowercased().contains("dialog"),
            "and it does not invent a dialog nobody measured"
        )

        let blocked = KeychainPromptDetector.stallExplanation(
            service: "com.browseros.trios.model-keys", deadlineSeconds: 8, promptWaiting: true
        )
        check(
            blocked.contains("waiting for you"),
            "with a dialog the message says a human is being waited on"
        )
        check(
            blocked.contains("Always Allow"),
            "and it names the exact act that clears it"
        )
        check(
            blocked.contains("rebuild"),
            "and why macOS asked at all, so the next rebuild is not a mystery"
        )
        check(
            blocked.contains("com.browseros.trios.model-keys"),
            "the service is still named: which keychain item is still the reader's next question"
        )
    }

    static func theWarmupVerdict() {
        scenario("a failed warm-up says whether trying again could ever work")

        let quiet = KeychainPromptDetector.warmupFailureExplanation(
            attempts: 10, promptWaiting: false
        )
        check(
            quiet.contains("10 attempts") && quiet.contains("cache is still empty"),
            "with no dialog the old, honest sentence stands"
        )

        let blocked = KeychainPromptDetector.warmupFailureExplanation(
            attempts: 10, promptWaiting: true
        )
        check(
            blocked.contains("retrying cannot help"),
            "against a dialog it says an eleventh attempt is pointless - the fact ten attempts could not establish"
        )
        check(
            blocked.contains("no rebuild or relaunch is needed"),
            "and rules out the two things an operator would otherwise try first, both of which I tried and neither of which helped"
        )
    }
}
