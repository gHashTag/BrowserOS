import Foundation

/// Where a skill was found. Determines precedence and whether it can be edited.
enum SkillSource: String, Codable, Equatable, CaseIterable, Sendable {
    /// `.claude/skills/` inside this repository.
    case project
    /// `~/.claude/skills/`, shared across every project on this machine.
    case user
    /// `.trinity/skills/`, the Trinity-specific set.
    case trinity

    var displayName: String {
        switch self {
        case .project: return "Project"
        case .user: return "User"
        case .trinity: return "Trinity"
        }
    }

    /// Project skills win over user skills of the same name, the way a local
    /// config overrides a global one. Surprising precedence is worse than no
    /// precedence, so it is stated once here.
    var precedence: Int {
        switch self {
        case .project: return 0
        case .trinity: return 1
        case .user: return 2
        }
    }
}

/// One skill the Queen can run.
struct SkillDescriptor: Identifiable, Equatable, Sendable {
    /// The invocation name, always slash-prefixed: `/doctor`.
    let id: String
    let name: String
    let description: String
    let source: SkillSource
    let path: String
    /// Rough size of the instruction body, so the tab can warn about a skill
    /// that will eat the context it is loaded into.
    let bodyCharacters: Int

    var command: String { id }
}

/// Reads `SKILL.md` files into descriptors.
///
/// The format is the one Claude Code already uses - YAML-ish frontmatter with
/// `name` and `description` - so a skill written for the CLI works here without
/// a second copy that can drift.
enum SkillCatalog {
    static let fileName = "SKILL.md"

    /// Directories scanned, in precedence order.
    static func searchPaths(projectRoot: String, home: String) -> [(SkillSource, String)] {
        [
            (.project, "\(projectRoot)/.claude/skills"),
            (.trinity, "\(projectRoot)/.trinity/skills"),
            (.user, "\(home)/.claude/skills")
        ]
    }

    /// Parses frontmatter. Returns nil when the file has no usable name, rather
    /// than inventing one from the folder: a skill the user cannot see the name
    /// of is a skill they cannot trust.
    static func parse(
        contents: String,
        directoryName: String,
        source: SkillSource,
        path: String
    ) -> SkillDescriptor? {
        let (frontmatter, body) = splitFrontmatter(contents)
        let name = frontmatter["name"] ?? directoryName
        guard !name.isEmpty else { return nil }

        // A heading is the author's own summary of the file; a random first
        // sentence is whatever happened to be at the top. Some SKILL.md files
        // have no frontmatter at all and their heading is the only description
        // that reads like one.
        let description = frontmatter["description"]
            ?? firstHeading(of: body)
            ?? firstProseLine(of: body)
            ?? "No description."

        return SkillDescriptor(
            id: "/" + name,
            name: name,
            description: description,
            source: source,
            path: path,
            bodyCharacters: body.count
        )
    }

    /// Splits `---` delimited frontmatter from the body.
    ///
    /// Deliberately a small hand parser: descriptions routinely contain colons,
    /// quotes and commas, and a real YAML dependency for four keys is a poor
    /// trade. Only the first colon on a line separates key from value.
    static func splitFrontmatter(_ contents: String) -> ([String: String], String) {
        let lines = contents.components(separatedBy: .newlines)
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else {
            return ([:], contents)
        }
        var frontmatter: [String: String] = [:]
        var index = 1
        var currentKey: String?

        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces) == "---" {
                index += 1
                break
            }
            // A continuation line: indented, belonging to the key above it.
            if line.hasPrefix("  "), let key = currentKey, let existing = frontmatter[key] {
                frontmatter[key] = existing + " " + line.trimmingCharacters(in: .whitespaces)
            } else if let colon = line.firstIndex(of: ":") {
                let key = String(line[line.startIndex..<colon])
                    .trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: colon)...])
                    .trimmingCharacters(in: .whitespaces)
                frontmatter[key] = unquote(value)
                currentKey = key
            }
            index += 1
        }

        let body = lines.dropFirst(index).joined(separator: "\n")
        return (frontmatter, body)
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2 else { return value }
        let quotes: [Character] = ["\"", "'"]
        guard let first = value.first, let last = value.last,
              quotes.contains(first), first == last else {
            return value
        }
        return String(value.dropFirst().dropLast())
    }

    /// The document's own title, used when a skill declares no description.
    static func firstHeading(of body: String) -> String? {
        for line in body.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("#") else { continue }
            let title = trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
            guard !title.isEmpty else { continue }
            return title
        }
        return nil
    }

    /// First line that is neither blank nor a heading, used when a skill has no
    /// description of its own.
    private static func firstProseLine(of body: String) -> String? {
        for line in body.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            return trimmed
        }
        return nil
    }

    /// Resolves duplicates by precedence, keeping one entry per invocation name.
    static func deduplicate(_ skills: [SkillDescriptor]) -> [SkillDescriptor] {
        var best: [String: SkillDescriptor] = [:]
        for skill in skills {
            guard let existing = best[skill.id] else {
                best[skill.id] = skill
                continue
            }
            if skill.source.precedence < existing.source.precedence {
                best[skill.id] = skill
            }
        }
        return best.values.sorted { $0.name < $1.name }
    }
}
