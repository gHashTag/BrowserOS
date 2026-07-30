import Combine
import Foundation

/// Discovers the Queen's skills, remembers which are enabled, and runs them.
///
/// Skills were previously a hardcoded set of four names inside
/// `QueenStatusViewModel`, so writing a `SKILL.md` did nothing until someone
/// edited Swift. The repository already holds two dozen of them; this makes the
/// files the source of truth and gives the user a switch for each one.
@MainActor
final class SkillStore: ObservableObject {
    static let shared = SkillStore()

    @Published private(set) var skills: [SkillDescriptor] = []
    @Published private(set) var disabledIDs: Set<String> = []
    @Published private(set) var lastError: String?
    /// Skills currently executing, so the tab can show progress and refuse a
    /// second concurrent run of the same one.
    @Published private(set) var runningIDs: Set<String> = []
    @Published private(set) var lastRuns: [String: SkillRunRecord] = [:]

    struct SkillRunRecord: Codable, Equatable {
        let finishedAt: Date
        let succeeded: Bool
        let output: String
    }

    private let projectRoot: String
    private let home: String
    private let statePath: String

    init(
        projectRoot: String = ProjectPaths.root,
        home: String = NSHomeDirectory(),
        statePath: String? = nil
    ) {
        self.projectRoot = projectRoot
        self.home = home
        self.statePath = statePath ?? "\(ProjectPaths.trinity)/state/queen_skills.json"
        loadDisabled()
        reload()
    }

    // MARK: - Queries

    var enabled: [SkillDescriptor] {
        skills.filter { !disabledIDs.contains($0.id) }
    }

    func isEnabled(_ skill: SkillDescriptor) -> Bool {
        !disabledIDs.contains(skill.id)
    }

    func skill(named command: String) -> SkillDescriptor? {
        let normalized = command.hasPrefix("/") ? command : "/" + command
        return skills.first { $0.id == normalized }
    }

    // `canRun(_:)` used to sit here: skill(named:) != nil && isEnabled(...).
    // It had no caller, and unlike the other uncalled rules found this week
    // that was the right outcome rather than an oversight.
    //
    // Both places that decide whether to run a skill need to tell its two
    // failure cases apart. runQueenSkill says "there is no skill called X" or
    // "X is switched off in the Skills tab", which are different problems with
    // different fixes; delegation refuses to open a chat at all and has to name
    // which of the two happened. A predicate returning one Bool throws away
    // exactly the distinction its callers exist to make, so adopting it would
    // have cost the user the more useful message.
    //
    // Deleted rather than wired, and the reasoning kept, because the next
    // reader will otherwise see two call sites doing the same two checks by
    // hand and helpfully factor them back into this.

    /// One line per enabled skill, for the Queen's help text and her system
    /// prompt. Generated rather than written by hand so it cannot go stale.
    var summaryLines: [String] {
        enabled.map { "\($0.id) - \($0.description)" }
    }

    // MARK: - Discovery

    func reload() {
        let manager = FileManager.default
        var found: [SkillDescriptor] = []

        for (source, directory) in SkillCatalog.searchPaths(projectRoot: projectRoot, home: home) {
            guard let entries = try? manager.contentsOfDirectory(atPath: directory) else { continue }
            for entry in entries.sorted() {
                let path = "\(directory)/\(entry)/\(SkillCatalog.fileName)"
                guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
                guard let descriptor = SkillCatalog.parse(
                    contents: contents,
                    directoryName: entry,
                    source: source,
                    path: path
                ) else { continue }
                found.append(descriptor)
            }
        }

        skills = SkillCatalog.deduplicate(found)
        TriosLogBus.shared.info(
            .queen,
            "skills.loaded",
            "Skill catalog refreshed",
            ["total": String(skills.count), "enabled": String(enabled.count)]
        )
    }

    // MARK: - Mutations

    func setEnabled(_ enabled: Bool, for skill: SkillDescriptor) {
        if enabled {
            disabledIDs.remove(skill.id)
        } else {
            disabledIDs.insert(skill.id)
        }
        persistDisabled()
        TriosLogBus.shared.info(
            .queen,
            enabled ? "skills.enabled" : "skills.disabled",
            "\(skill.id) is now \(enabled ? "available" : "unavailable") to the Queen",
            ["skill": skill.id]
        )
    }

    // MARK: - Running

    /// Runs a skill through the Claude CLI and returns its output.
    ///
    /// A disabled skill is refused rather than silently run: the toggle has to
    /// mean something, including when the Queen is the caller.
    @discardableResult
    func run(_ command: String, arguments: [String] = [], timeout: TimeInterval = 120) async -> String {
        guard let skill = skill(named: command) else {
            return "There is no skill called \(command). Run /skills to see what I have."
        }
        guard isEnabled(skill) else {
            return "\(skill.id) is switched off in the Skills tab, so I did not run it."
        }
        guard !runningIDs.contains(skill.id) else {
            return "\(skill.id) is already running."
        }
        guard let claude = QueenStatusViewModel.CommandResolver.executableURL(for: "claude") else {
            return "The Claude CLI is not on PATH. Set TRIOS_CLAUDE_PATH to run \(skill.id)."
        }

        runningIDs.insert(skill.id)
        defer { runningIDs.remove(skill.id) }

        let root = projectRoot
        let output = await Task.detached(priority: .userInitiated) { () -> String in
            QueenStatusViewModel.runProcess(
                claude.path,
                arguments: arguments + [skill.id],
                workDir: root,
                timeout: timeout
            )
        }.value

        // A skill that produces nothing is a skill that failed quietly; treating
        // empty output as success is how a broken skill keeps its green tick.
        let trimmed = output.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        let succeeded = !trimmed.isEmpty
        lastRuns[skill.id] = SkillRunRecord(
            finishedAt: Date(),
            succeeded: succeeded,
            output: output
        )
        TriosLogBus.shared.info(
            .queen,
            succeeded ? "skills.run" : "skills.run_empty",
            "Ran \(skill.id)",
            ["skill": skill.id, "chars": String(output.count)]
        )
        return output.isEmpty ? "\(skill.id) produced no output." : output
    }

    // MARK: - Editing

    /// Reads a skill's file. Separate from the descriptor because the body can
    /// be tens of kilobytes and the catalog is held for every skill at once.
    func body(of skill: SkillDescriptor) -> String? {
        try? String(contentsOfFile: skill.path, encoding: .utf8)
    }

    /// Writes a skill back and refreshes the catalog.
    ///
    /// Refuses a file whose frontmatter no longer parses. A skill saved into an
    /// unreadable state silently disappears from the catalog, and the user is
    /// left believing they saved it.
    @discardableResult
    func save(_ skill: SkillDescriptor, body: String) -> String? {
        guard SkillCatalog.parse(
            contents: body,
            directoryName: skill.name,
            source: skill.source,
            path: skill.path
        ) != nil else {
            return "That would not parse as a skill, so I did not write it."
        }
        do {
            try body.write(toFile: skill.path, atomically: true, encoding: .utf8)
        } catch {
            return "Could not write \(skill.path): \(error.localizedDescription)"
        }
        reload()
        TriosLogBus.shared.info(
            .queen,
            "skills.edited",
            "Saved \(skill.id)",
            ["skill": skill.id, "chars": String(body.count)]
        )
        return nil
    }

    // MARK: - Persistence

    private struct State: Codable {
        var disabled: [String]
    }

    private func loadDisabled() {
        guard let data = FileManager.default.contents(atPath: statePath),
              let state = try? JSONDecoder().decode(State.self, from: data) else {
            return
        }
        disabledIDs = Set(state.disabled)
    }

    private func persistDisabled() {
        let directory = (statePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(State(disabled: disabledIDs.sorted())) else {
            lastError = "Could not save the skill settings."
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
            lastError = nil
        } catch {
            lastError = "Could not save the skill settings: \(error.localizedDescription)"
        }
    }
}
