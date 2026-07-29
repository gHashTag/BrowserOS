// AGENT-V-WAIVER: https://github.com/browseros-ai/BrowserOS/issues/2023
// Reason: Queen direct-chat hardening — `/apply <uuid> [confirm]` parsing for
// human-in-the-loop confirmation of Queen-generated proposals.
// Follow-up: seal against .trinity/specs/queen-proposal-applier.md.
import Foundation

/// Parsed Queen slash command issued inside the Trinity Queen conversation.
enum QueenCommand: Equatable {
    case help
    case status
    case agents
    case chats
    case switchChat(UUID)
    case newChat(String?)
    case deleteChat(UUID)
    case delegate(agent: String, task: String)
    /// Opens a worker chat bound to a GitHub issue, on its own virtual branch.
    case delegateIssue(issue: IssueReference, worker: String, title: String, paths: [String], skill: String?)
    /// Shows the swarm and what is waiting on the Queen.
    case swarm
    /// Closes the review loop on delegated work.
    case review(issue: IssueReference, decision: ReviewDecision, note: String)
    /// Stops a worker that is going nowhere.
    case cancelTask(issue: IssueReference, reason: String)
    case broadcast(String)
    case audit
    case memory
    case evolve
    case proposals
    case evolveApply(UUID, confirmed: Bool)
    case evolveReject(UUID)
    case doctor(model: String?)
    case tri
    case godMode
    case bridge
    /// Lists what the Queen can run right now.
    case skills
    /// Reads her own code and reports a ranked roadmap.
    case selfAudit
    /// Any skill discovered from a SKILL.md file.
    case runSkill(command: String, arguments: [String])
    case unknown(String)
}

/// What the Queen decided about a worker's result.
enum ReviewDecision: String, Equatable {
    case accept
    case reject
}

/// Parses user input in the Trinity Queen conversation for slash commands.
struct QueenCommandParser {
    static func parse(_ text: String) -> QueenCommand {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return .unknown(trimmed) }

        let withoutSlash = String(trimmed.dropFirst())
        var components = withoutSlash
            .split(separator: " ", maxSplits: Int.max, omittingEmptySubsequences: true)
            .map(String.init)
        guard let name = components.first?.lowercased() else { return .unknown(trimmed) }
        components.removeFirst()

        switch name {
        case "help", "?":
            return .help
        case "status":
            return .status
        case "agents":
            return .agents
        case "chats":
            return .chats
        case "switch", "open":
            guard let idString = components.first,
                  let id = UUID(uuidString: idString) else { return .unknown(trimmed) }
            return .switchChat(id)
        case "new", "create":
            let title = components.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            return .newChat(title.isEmpty ? nil : title)
        case "delete", "rm":
            guard let idString = components.first,
                  let id = UUID(uuidString: idString),
                  id != ChatConversation.trinityQueenId else { return .unknown(trimmed) }
            return .deleteChat(id)
        case "delegate", "assign":
            guard let first = components.first else { return .unknown(trimmed) }
            components.removeFirst()
            // `/delegate owner/repo#123 worker Title` opens a worker chat bound
            // to that issue. The older `/delegate worker task` form still works,
            // so existing habits keep functioning.
            if let issue = IssueReference.parse(first) {
                let worker = components.first ?? "queen-swift"
                if !components.isEmpty { components.removeFirst() }
                // `--paths a,b` gives the worker an explicit boundary. Without
                // one it is told to ask before editing shared files, which is
                // the safe default but means it will not write anything.
                var paths: [String] = []
                if let flag = components.firstIndex(of: "--paths"), flag + 1 < components.count {
                    paths = components[flag + 1]
                        .split(separator: ",")
                        .map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty }
                    components.removeSubrange(flag...(flag + 1))
                }
                // `--skill /phi-loop` hands the worker a rehearsed procedure
                // instead of a paraphrase of one. A brief written from memory
                // drifts from the skill it is describing; a reference cannot.
                var skill: String?
                if let flag = components.firstIndex(of: "--skill"), flag + 1 < components.count {
                    skill = components[flag + 1]
                    components.removeSubrange(flag...(flag + 1))
                }
                let title = components.joined(separator: " ")
                return .delegateIssue(
                    issue: issue,
                    worker: worker,
                    title: title.isEmpty ? "Work on \(issue.slug)" : title,
                    paths: paths,
                    skill: skill
                )
            }
            return .delegate(agent: first, task: components.joined(separator: " "))
        case "swarm", "workers", "bees":
            return .swarm
        case "cancel", "stop":
            guard let first = components.first,
                  let issue = IssueReference.parse(first) else { return .unknown(trimmed) }
            components.removeFirst()
            return .cancelTask(issue: issue, reason: components.joined(separator: " "))
        case "review", "accept", "reject-task":
            guard let first = components.first,
                  let issue = IssueReference.parse(first) else { return .unknown(trimmed) }
            components.removeFirst()
            // `/accept <issue>` needs no verb; `/review <issue> accept|reject`
            // does. Anything else is refused rather than guessed - closing a
            // task the wrong way is not a mistake worth being helpful about.
            let decision: ReviewDecision
            if name == "accept" {
                decision = .accept
            } else if name == "reject-task" {
                decision = .reject
            } else if let verb = components.first.map({ $0.lowercased() }),
                      let parsed = ReviewDecision(rawValue: verb) {
                components.removeFirst()
                decision = parsed
            } else {
                return .unknown(trimmed)
            }
            return .review(
                issue: issue,
                decision: decision,
                note: components.joined(separator: " ")
            )
        case "broadcast", "notify":
            return .broadcast(components.joined(separator: " "))
        case "audit":
            return .audit
        case "memory":
            return .memory
        case "evolve", "improve", "self-evolve":
            return .evolve
        case "proposals", "patches":
            return .proposals
        case "apply", "evolve-apply":
            guard let idString = components.first,
                  let id = UUID(uuidString: idString) else { return .unknown(trimmed) }
            components.removeFirst()
            let confirmed = components.first?.lowercased() == "confirm"
            return .evolveApply(id, confirmed: confirmed)
        case "reject", "evolve-reject":
            guard let idString = components.first,
                  let id = UUID(uuidString: idString) else { return .unknown(trimmed) }
            return .evolveReject(id)
        case "doctor", "dr":
            if let idx = components.firstIndex(of: "--model"),
               idx + 1 < components.count {
                return .doctor(model: components[idx + 1])
            }
            return .doctor(model: nil)
        case "tri":
            return .tri
        case "god-mode", "godmode":
            return .godMode
        case "bridge":
            return .bridge
        case "skills":
            return .skills
        case "self-audit", "introspect", "roadmap":
            return .selfAudit
        default:
            // Anything else may be a skill on disk. The parser cannot know -
            // the catalog is read at runtime - so it hands the name on and the
            // handler refuses it if no such skill exists. Hardcoding the list
            // here is what kept two dozen SKILL.md files unreachable.
            return .runSkill(command: "/" + name, arguments: components)
        }
    }

    static var helpText: String {
        """
        Queen commands:
        /help                — show this list
        /status              — sovereign component status
        /agents              — list online A2A agents
        /chats               — list all conversations
        /switch <uuid>       — open a conversation
        /new [title]         — create a conversation
        /delete <uuid>       — delete a conversation (not the Queen)
        /delegate <agent> <task> — assign a task to an agent
        /delegate <owner/repo#N> <worker> [--paths a,b] <title> — open a worker chat on its own branch
        /swarm               — show every delegated task and what awaits review
        /accept <owner/repo#N> [note] — accept a worker's result
        /review <owner/repo#N> reject <why> — send the work back to the same worker
        /broadcast <message> — message all online agents
        /audit               — run self-improvement audit
        /memory              — recall recent consolidated memory
        /evolve              — run audit and generate improvement proposals
        /proposals           — list pending proposals
        /apply <uuid>        — preview/stage a pending proposal (human-in-the-loop)
        /apply <uuid> confirm — commit, push, and open a draft PR for a staged proposal
        /reject <uuid>       — reject a pending proposal
        /doctor [--model <model>] — run build/dirty health check skill (optionally pin the Claude model)
        /tri                 — run trios quick status skill
        /god-mode            — run full oversight audit skill
        /bridge              — run BrowserOS MCP bridge skill
        """
    }
}
