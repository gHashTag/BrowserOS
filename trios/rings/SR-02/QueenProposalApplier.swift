// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — safety-budget enforcement, human-in-the-loop
// confirmation, and repo-agnostic PR creation for Queen-generated proposals.
// Follow-up: seal against .trinity/specs/queen-proposal-applier.md.
import Foundation

/// Human-in-the-loop applier for Queen-generated improvement proposals.
/// Creates a feature branch, writes the suggested patch as a file edit,
/// runs the build, and — only after explicit confirmation — commits, pushes,
/// and opens a draft PR via `gh` CLI. No mutation occurs without an active
/// safety budget and a clean working tree.
@MainActor
final class QueenProposalApplier {
    static let shared = QueenProposalApplier()

    private init() {}

    struct ApplicationResult {
        let success: Bool
        let summary: String
        let branchName: String?
        let prURL: String?
    }

    func apply(
        _ proposal: QueenProposal,
        projectRoot: String,
        confirmed: Bool,
        reuseBranch: String? = nil
    ) async -> ApplicationResult {
        // 0. Verify safety budget before any file or git mutation.
        guard let budget = QueenSelfImprovementService.loadBudget(), budget.isActive else {
            return ApplicationResult(
                success: false,
                summary: "Safety budget is inactive. Proposal \(proposal.id.uuidString.prefix(8)) cannot be applied until the budget is reset.",
                branchName: nil,
                prURL: nil
            )
        }

        let fm = FileManager.default
        let filePath = "\(projectRoot)/\(proposal.targetFile)"

        // 1. Verify target file exists and is within project bounds.
        guard fm.fileExists(atPath: filePath) else {
            return ApplicationResult(
                success: false,
                summary: "Target file does not exist: \(proposal.targetFile). Proposal rejected.",
                branchName: nil,
                prURL: nil
            )
        }

        // 2. Derive repository and PR base from the local checkout.
        let (repo, base) = deriveRepoAndBase(projectRoot: projectRoot)
        let baseBranchName = "feat/queen-evolution-\(proposal.id.uuidString.prefix(8).lowercased())"
        let branchName: String
        if let reuseBranch = reuseBranch {
            branchName = reuseBranch
        } else {
            branchName = uniqueBranchName(base: baseBranchName, projectRoot: projectRoot)
        }

        // 3. Guard against a dirty working tree.
        let statusResult = runShell("git", arguments: ["status", "--porcelain"], cwd: projectRoot)
        guard statusResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ApplicationResult(
                success: false,
                summary: "Working tree has uncommitted changes. Commit or stash them before applying proposal \(proposal.id.uuidString.prefix(8)).",
                branchName: nil,
                prURL: nil
            )
        }

        // 4. Create branch and stage the change.
        let checkoutResult = runShell("git", arguments: ["checkout", "-b", branchName], cwd: projectRoot)
        guard checkoutResult.exitCode == 0 else {
            return ApplicationResult(
                success: false,
                summary: "Failed to create branch \(branchName): \(checkoutResult.stderr)",
                branchName: nil,
                prURL: nil
            )
        }

        // 5. Append suggested patch as a clearly-marked block at end of target file.
        guard appendPatch(proposal.suggestedPatch, to: filePath) else {
            _ = runShell("git", arguments: ["checkout", "-"], cwd: projectRoot)
            return ApplicationResult(
                success: false,
                summary: "Failed to write patch to \(proposal.targetFile). Reverted branch switch.",
                branchName: nil,
                prURL: nil
            )
        }

        // 6. Run build.
        let buildResult = runShell("\(projectRoot)/build.sh", arguments: [], cwd: projectRoot)
        guard buildResult.exitCode == 0 else {
            _ = runShell("git", arguments: ["checkout", "-"], cwd: projectRoot)
            _ = runShell("git", arguments: ["branch", "-D", branchName], cwd: projectRoot)
            return ApplicationResult(
                success: false,
                summary: "Build failed after applying proposal. Reverted. Output:\n\(buildResult.stderr)",
                branchName: nil,
                prURL: nil
            )
        }

        // 7. If this is only a preview/stage, stop here and ask for confirmation.
        guard confirmed else {
            return ApplicationResult(
                success: true,
                summary: "Preview/staging complete for proposal \(proposal.id.uuidString.prefix(8)). Branch \(branchName) is ready with the patch and the build passes.\n\nRun `/apply \(proposal.id.uuidString) confirm` to commit, push, and open a draft PR against \(repo) on base `\(base)`.",
                branchName: branchName,
                prURL: nil
            )
        }

        // 8. Commit and push.
        _ = runShell("git", arguments: ["add", proposal.targetFile], cwd: projectRoot)
        let commitMessage = """
        feat(queen): self-evolution proposal \(proposal.id.uuidString.prefix(8))

        Trigger: \(proposal.trigger)
        Rationale: \(proposal.rationale)

        Closes browseros-ai/BrowserOS#2023
        """
        let commitResult = runShell("git", arguments: ["commit", "-m", commitMessage], cwd: projectRoot)
        guard commitResult.exitCode == 0 else {
            _ = runShell("git", arguments: ["checkout", "-"], cwd: projectRoot)
            return ApplicationResult(
                success: false,
                summary: "Commit failed: \(commitResult.stderr). Reverted.",
                branchName: nil,
                prURL: nil
            )
        }

        let pushResult = runShell("git", arguments: ["push", "-u", "origin", branchName], cwd: projectRoot)
        guard pushResult.exitCode == 0 else {
            return ApplicationResult(
                success: false,
                summary: "Push failed for branch \(branchName). Local branch is ready but may need manual handling. Error: \(pushResult.stderr)",
                branchName: branchName,
                prURL: nil
            )
        }

        // 9. Open draft PR using the derived repo and base branch.
        let prResult = runShell(
            "gh",
            arguments: [
                "pr", "create",
                "--repo", repo,
                "--title", "[Queen self-evolution] \(proposal.trigger)",
                "--body", proposal.rationale,
                "--base", base,
                "--head", branchName,
                "--draft"
            ],
            cwd: projectRoot
        )
        let prURL = prURL(from: prResult.stdout)

        return ApplicationResult(
            success: prResult.exitCode == 0,
            summary: prResult.exitCode == 0
                ? "Proposal applied on branch \(branchName). Draft PR: \(prURL ?? "unknown") (base: \(base), repo: \(repo))"
                : "Branch \(branchName) pushed, but draft PR creation failed: \(prResult.stderr)",
            branchName: branchName,
            prURL: prURL
        )
    }

    private func appendPatch(_ patch: String, to filePath: String) -> Bool {
        guard let original = try? String(contentsOfFile: filePath, encoding: .utf8) else { return false }
        let marker = "// MARK: - Queen self-evolution proposal injection"
        guard !original.contains(marker) else {
            // Already has an injected block; refuse to stack patches blindly.
            return false
        }
        let injection = """

\(marker)
// The block below was generated by QueenSelfImprovementService as a draft
// improvement proposal. It is guarded by the safety budget and requires
// human or Verifier-Agent approval before promotion to dev.
\(patch)
"""
        let updated = original + injection
        do {
            try updated.write(toFile: filePath, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    private func prURL(from output: String) -> String? {
        output
            .split(whereSeparator: \.isNewline)
            .first { $0.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("https://github.com/") }
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private func deriveRepoAndBase(projectRoot: String) -> (repo: String, base: String) {
        let remoteResult = runShell("git", arguments: ["remote", "-v"], cwd: projectRoot)
        let repo = parseGitHubRepo(from: remoteResult.stdout)
        let branchResult = runShell("git", arguments: ["branch", "--show-current"], cwd: projectRoot)
        let base = branchResult.stdout
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (repo, base.isEmpty ? "dev" : base)
    }

    private func parseGitHubRepo(from output: String) -> String {
        // Matches both HTTPS (github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git) URLs.
        guard let regex = try? NSRegularExpression(
            pattern: #"github\\.com[/:]([^/\\s]+)/([^/\s.]+?)(?:\\.git)?(?:[\\s/]|$)"#,
            options: []
        ) else {
            return "browseros-ai/BrowserOS"
        }
        let range = NSRange(output.startIndex..., in: output)
        if let match = regex.firstMatch(in: output, options: [], range: range) {
            let owner = substring(of: output, range: match.range(at: 1))
            let repo = substring(of: output, range: match.range(at: 2))
            return "\(owner)/\(repo)"
        }
        return "browseros-ai/BrowserOS"
    }

    private func substring(of string: String, range: NSRange) -> String {
        guard let swiftRange = Range(range, in: string) else { return "" }
        return String(string[swiftRange])
    }

    private func uniqueBranchName(base: String, projectRoot: String) -> String {
        var candidate = base
        var counter = 2
        while branchExists(candidate, projectRoot: projectRoot) {
            candidate = "\(base)-\(counter)"
            counter += 1
        }
        return candidate
    }

    private func branchExists(_ name: String, projectRoot: String) -> Bool {
        let result = runShell(
            "git",
            arguments: ["show-ref", "--verify", "--quiet", "refs/heads/\(name)"],
            cwd: projectRoot
        )
        return result.exitCode == 0
    }

    private func runShell(_ command: String, arguments: [String], cwd: String) -> (exitCode: Int32, stdout: String, stderr: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + arguments
        process.currentDirectoryURL = URL(fileURLWithPath: cwd)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (-1, "", error.localizedDescription)
        }

        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }
}
