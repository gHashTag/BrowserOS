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
public enum QueenEpics {
    /// Epics read when nobody has said otherwise.
    ///
    /// #1090 is the supervisor epic she has always known. #1279 is the T27
    /// backend, opened 2026-08-19. Both are defaults rather than constants -
    /// adding a third must not require a build.
    public static let defaultEpics: [Int] = [1090, 1279]

    public static let key = "queen.epics"

    /// The epics to read, in order. Duplicates removed, order preserved: a
    /// repeated epic would fetch the same timeline twice and double-count every
    /// sub-issue in it.
    public static var configured: [Int] {
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
    public static func deduplicated(_ epics: [Int]) -> [Int] {
        var seen = Set<Int>()
        return epics.filter { seen.insert($0).inserted }
    }

    /// Events per timeline page. GitHub's ceiling is 100, which is why one
    /// page cannot be the whole answer for any epic that has lived a while.
    public static let timelinePageSize = 100

    /// How many pages the reader will walk before giving up. Ten pages is a
    /// thousand events - far past any epic here - and a bound rather than a
    /// `while true` against a paginated API.
    public static let timelinePageLimit = 10

    /// The timeline URL for one epic, one page at a time.
    ///
    /// Built rather than written out, so a new epic cannot arrive with a typo
    /// in the path - the failure mode of a hand-written URL is a 404 that reads
    /// like an empty epic.
    ///
    /// The page parameter is the fix for a sharper failure, measured
    /// 2026-08-22: this asked for page one and nothing asked for page two.
    /// Timeline events come oldest-first, so the NEWEST cross-references are
    /// the ones that fall off the end. Epic #1090 held 104 events; the highest
    /// issue the Queen could see was #1228, and every issue opened after it -
    /// #1277, #1286, #1287 - did not exist as far as choosing was concerned,
    /// while she reported "Nothing to choose from 19 candidates" hour after
    /// hour. An epic outgrows one page exactly once, and after that it never
    /// shows its newest work again.
    public static func timelineURL(epic: Int, page: Int = 1, repo: String = "gHashTag/trios") -> URL? {
        URL(
            string: "https://api.github.com/repos/\(repo)/issues/\(epic)"
                + "/timeline?per_page=\(timelinePageSize)&page=\(page)"
        )
    }

    /// Whether a page that returned `count` events can be the last one.
    ///
    /// A short page ends the walk; a full page means there may be more. Kept
    /// as a named function so the stopping rule is stated once and can be
    /// tested without a network.
    public static func isLastTimelinePage(eventCount: Int) -> Bool {
        eventCount < timelinePageSize
    }

    /// How the epics read on a log line or in a notice.
    public static var describedList: String {
        configured.map { "#\($0)" }.joined(separator: ", ")
    }
}
