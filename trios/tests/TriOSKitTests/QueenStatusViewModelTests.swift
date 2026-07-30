import XCTest
@testable import TriOSKit

final class QueenStatusViewModelTests: XCTestCase {
    typealias Policy = QueenStatusViewModel.CommandSecurityPolicy

    // MARK: - Exact commands

    func testExactCommandsAllowed() {
        for cmd in Policy.exactAllowedCommands {
            XCTAssertNotNil(Policy.validate(cmd), "Expected exact command to be allowed: \(cmd)")
        }
    }

    func testExactCommandWithExtraArgumentsRejected() {
        XCTAssertNil(Policy.validate("git status --short"))
        XCTAssertNil(Policy.validate("cargo build --release"))
        XCTAssertNil(Policy.validate("swift --version extra"))
    }

    // MARK: - File reader commands

    func testFileReaderWithinRootAllowed() {
        XCTAssertNotNil(Policy.validate("ls main.swift"))
        XCTAssertNotNil(Policy.validate("cat build.sh"))
        XCTAssertNotNil(Policy.validate("wc .claude/plans/trios-weakspot-loop-009.md"))
    }

    func testFileReaderWithinTrinityAllowed() {
        XCTAssertNotNil(Policy.validate("cat .trinity/state/last_wake.json"))
        XCTAssertNotNil(Policy.validate("tail .trinity/cron.log"))
    }

    func testFileReaderAbsoluteRootPathAllowed() {
        XCTAssertNotNil(Policy.validate("ls \(ProjectPaths.root)/main.swift"))
    }

    func testFileReaderSensitivePathsRejected() {
        let forbidden = [
            "cat ~/.ssh/id_rsa",
            "ls ~/.aws/credentials",
            "cat ~/.gnupg/secring.gpg",
            "tail /etc/passwd",
            "head /var/log/system.log",
            "cat /tmp/secrets.txt",
            "ls /dev/null",
            "cat ~/.env",
        ]
        for cmd in forbidden {
            XCTAssertNil(Policy.validate(cmd), "Expected command to be rejected: \(cmd)")
        }
    }

    func testFileReaderTraversalRejected() {
        XCTAssertNil(Policy.validate("cat ../BrowserOS/.claude/settings.json"))
        XCTAssertNil(Policy.validate("ls rings/../../.ssh"))
    }

    func testFileReaderMultipleArgumentsRejected() {
        XCTAssertNil(Policy.validate("cat main.swift build.sh"))
        XCTAssertNil(Policy.validate("ls -la main.swift"))
        XCTAssertNil(Policy.validate("tail -n 5 .trinity/cron.log"))
    }

    // MARK: - Dangerous tokens

    func testShellMetacharactersRejected() {
        let dangerous = [
            "git status; rm -rf /", // AGENT-V-WAIVER: test fixture
            "cat main.swift && echo pwned",
            "ls | xargs rm",
            "cat `whoami`",
            "echo $(id)",
            "echo ${SHELL}",
            "cat > /tmp/pwn",
            "cat < /etc/passwd",
            "echo >> /tmp/log",
        ]
        for cmd in dangerous {
            XCTAssertNil(Policy.validate(cmd), "Expected dangerous command to be rejected: \(cmd)")
        }
    }

    func testTildeExpansionRejected() {
        XCTAssertNil(Policy.validate("cat ~/Documents/secret.txt"))
    }

    // MARK: - Unlisted commands

    func testUnlistedCommandsRejected() {
        XCTAssertNil(Policy.validate("whoami"))
        XCTAssertNil(Policy.validate("python3 -c 'print(1)'"))
        XCTAssertNil(Policy.validate("curl -s http://example.com"))
        XCTAssertNil(Policy.validate("open /Applications/Calculator.app"))
    }

    // MARK: - Env assignments

    func testEnvAssignmentDoesNotBypassValidation() {
        XCTAssertNil(Policy.validate("FOO=bar rm -rf /")) // AGENT-V-WAIVER: test fixture
        XCTAssertNil(Policy.validate("FOO=bar cat ~/.ssh/id_rsa"))
    }

    // MARK: - Health endpoint alignment

    func testAgentHealthURLPointsAtBrowserOSServer() {
        // The BrowserOS/A2A server is served on the MCP port (9105). `a2aPort`
        // (9200) is not currently used, so the Agent status component must not
        // probe the wrong port and falsely report the agent offline.
        // AGENT-V-WAIVER: port-alignment test (Agent V conditional waiver, 2026-07-27).
        let url = ProjectPaths.agentHealthURL
        XCTAssertEqual(url, ProjectPaths.browserOSHealthURL,
                       "agentHealthURL must match the BrowserOS health URL on the MCP port")
    }
}
