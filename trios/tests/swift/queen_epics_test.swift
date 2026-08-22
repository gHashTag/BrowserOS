// Standalone unit tests for QueenEpics - which epics the Queen reads work
// from, and how far into each one she can see.
//
// The suite exists because of a measured horizon (2026-08-22): the timeline
// URL asked for one page of 100 events and nothing asked for page two.
// Timeline events arrive oldest-first, so the newest cross-references are
// exactly the ones that fall off the end. Epic #1090 held 104 events; the
// highest issue visible on page one was #1228, and #1277, #1286 and #1287 did
// not exist as far as choosing was concerned - while the log reported
// "Nothing to choose from 19 candidates" hour after hour.
//
// Run (from trios root):
//   swiftc tests/swift/queen_epics_test.swift rings/SR-00/QueenEpics.swift \
//     -o /tmp/trios_queen_epics_test && /tmp/trios_queen_epics_test

import Foundation

@main
enum QueenEpicsTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        theHorizon()
        theStoppingRule()
        theEpicList()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All QueenEpics tests passed.")
    }

    /// The URL must be able to ask for a page beyond the first, or an epic
    /// stops showing its newest work the moment it outgrows one page.
    static func theHorizon() {
        scenario("the timeline can be asked for more than its first page")

        let first = QueenEpics.timelineURL(epic: 1090)?.absoluteString ?? ""
        check(
            first.contains("per_page=100"),
            "the first page asks for the API's maximum, so the walk is as short as it can be"
        )
        check(first.contains("page=1"), "the default page is stated, not implied")

        let third = QueenEpics.timelineURL(epic: 1090, page: 3)?.absoluteString ?? ""
        check(third.contains("page=3"), "a later page can be asked for at all")
        check(
            third.contains("/issues/1090/timeline"),
            "the epic still addresses its own timeline on a later page"
        )
        check(
            first != third,
            "the page changes the URL - a page parameter nobody puts in the URL is the defect this fixes"
        )
    }

    /// The walk has to end, and it has to end on evidence rather than on a
    /// guess about how long an epic is.
    static func theStoppingRule() {
        scenario("a short page ends the walk, a full page does not")

        check(
            QueenEpics.isLastTimelinePage(eventCount: 0),
            "an empty page is the end"
        )
        check(
            QueenEpics.isLastTimelinePage(eventCount: 4),
            "a page with fewer events than the page size is the end - #1090's 104 events end four into page two"
        )
        check(
            !QueenEpics.isLastTimelinePage(eventCount: QueenEpics.timelinePageSize),
            "a FULL page is never the end: this is the case the old code got wrong by never asking"
        )
        check(
            QueenEpics.timelinePageLimit > 1,
            "the page limit permits a second page at all"
        )
        check(
            QueenEpics.timelinePageLimit * QueenEpics.timelinePageSize >= 1000,
            "the bound is far past any epic here, so it is a backstop and not a horizon of its own"
        )
    }

    /// The epic list is the other half of "what can she see" - a second epic
    /// was already invisible once.
    static func theEpicList() {
        scenario("every configured epic is read, with no duplicates")

        check(
            QueenEpics.configured.count == Set(QueenEpics.configured).count,
            "no epic is listed twice - a repeat would fetch the same timeline and double-count it"
        )
        check(
            QueenEpics.configured.contains(1090),
            "the supervisor epic is configured"
        )
        check(
            QueenEpics.configured.count >= 2,
            "more than one epic is read: six well-formed issues under a second epic were once invisible"
        )
    }
}
