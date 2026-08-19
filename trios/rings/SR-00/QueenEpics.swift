import Foundation

/// Which epics the Queen draws work from.
///
/// The number 1090 was written into eight places, one of them a URL. That was
/// fine while there was one epic and became a wall the moment there were two:
/// six well-formed sub-issues were opened under #1279, with acceptance criteria
/// and disjoint boundaries, and the Queen could not see a single one of them.
/// Not refuse them - *see* them. Her selection reported "all 24 candidates look
/// already done" while six untouched tasks sat one epic away.
///
/// A constant is the right shape for a law and the wrong shape for a decision
/// the operator makes. Which work exists is the operator's, so it is stored and
/// the code only supplies a default.
enum QueenEpics {
    /// Epics read when nobody has said otherwise.
    ///
    /// #1090 is the supervisor epic she has always known. #1279 is the T27
    /// backend, opened 2026-08-19. Both are defaults rather than constants -
    /// adding a third must not require a build.
    static let defaultEpics: [Int] = [1090, 1279]

    static let key = "queen.epics"

    /// The epics to read, in order. Duplicates removed, order preserved: a
    /// repeated epic would fetch the same timeline twice and double-count every
    /// sub-issue in it.
    static var configured: [Int] {
        get {
            guard let stored = UserDefaults.standard.array(forKey: key) as? [Int],
                  !stored.isEmpty else {
                return defaultEpics
            }
            return deduplicated(stored)
        }
        set { UserDefaults.standard.set(deduplicated(newValue), forKey: key) }
    }

    /// Preserves first appearance rather than sorting: the operator's order is
    /// a statement about priority, and sorting would silently overrule it.
    static func deduplicated(_ epics: [Int]) -> [Int] {
        var seen = Set<Int>()
        return epics.filter { seen.insert($0).inserted }
    }

    /// The timeline URL for one epic.
    ///
    /// Built rather than written out, so a new epic cannot arrive with a typo
    /// in the path - the failure mode of a hand-written URL is a 404 that reads
    /// like an empty epic.
    static func timelineURL(epic: Int, repo: String = "gHashTag/trios") -> URL? {
        URL(string: "https://api.github.com/repos/\(repo)/issues/\(epic)/timeline?per_page=100")
    }

    /// How the epics read on a log line or in a notice.
    static var describedList: String {
        configured.map { "#\($0)" }.joined(separator: ", ")
    }
}
