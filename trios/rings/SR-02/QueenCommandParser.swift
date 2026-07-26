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
    case broadcast(String)
    case audit
    case memory
    case evolve
    case proposals
    case evolveApply(UUID, confirmed: Bool)
    case evolveReject(UUID)
    case doctor
    case tri
    case godMode
    case bridge
    case unknown(String)
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
            guard let agent = components.first else { return .unknown(trimmed) }
            components.removeFirst()
            return .delegate(agent: agent, task: components.joined(separator: " "))
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
            return .doctor
        case "tri":
            return .tri
        case "god-mode", "godmode":
            return .godMode
        case "bridge":
            return .bridge
        default:
            return .unknown(trimmed)
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
        /broadcast <message> — message all online agents
        /audit               — run self-improvement audit
        /memory              — recall recent consolidated memory
        /evolve              — run audit and generate improvement proposals
        /proposals           — list pending proposals
        /apply <uuid>        — preview/stage a pending proposal (human-in-the-loop)
        /apply <uuid> confirm — commit, push, and open a draft PR for a staged proposal
        /reject <uuid>       — reject a pending proposal
        /doctor              — run build/dirty health check skill
        /tri                 — run trios quick status skill
        /god-mode            — run full oversight audit skill
        /bridge              — run BrowserOS MCP bridge skill
        """
    }
}
