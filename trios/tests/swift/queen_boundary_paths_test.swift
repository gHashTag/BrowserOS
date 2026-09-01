// Standalone unit tests for QueenBoundaryPaths - the boundary check - the measurement
// that decides whether a worker wrote outside the files it was given.
//
// It had no test suite at all, which is how the following survived: every
// worker runs inside its own git worktree, so the path it names in a tool
// call is
//
//     <root>/.worktrees/<variant>/<task>/<project>/rings/SR-00/Thing.swift
//
// while `ownedPaths` are project-relative - `rings/SR-00/Thing.swift`.
// `stripRootPrefix` removed only `<root>`, leaving
// `.worktrees/<variant>/<task>/<project>/rings/SR-00/Thing.swift`, which
// neither equals an owned path nor is prefixed by one. So the containment
// test failed for EVERY write, and the Queen was told "it wrote outside the
// paths it was given" about work that was entirely inside the boundary.
//
// Measured on #1286 (2026-08-23): the task sat at the send-back ceiling
// carrying exactly that intervention, and its single commit touched exactly
// the one file in its ownedPaths. The bee was right; the comparison was not.
//
// Run (from trios root):
//   swiftc tests/swift/queen_observer_test.swift \
//     rings/SR-00/QueenBoundaryPaths.swift \
//     -o /tmp/trios_queen_boundary_paths_test \
//     && /tmp/trios_queen_boundary_paths_test

import Foundation

@main
enum QueenBoundaryPathsTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func equal(_ got: String, _ want: String, _ name: String) {
        checks += 1
        if got == want {
            print("ok   - \(name)")
        } else {
            failures += 1
            print("FAIL - \(name)\n         got:  \(got)\n         want: \(want)")
        }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static let root = "/Users/playra/BrowserOS/trios"

    // MARK: - the three reductions, each on its own

    static func rootPrefix() {
        scenario("projectRelative reduces a named path to a project-relative one")

        equal(
            QueenBoundaryPaths.projectRelative("\(root)/rings/SR-00/Thing.swift", root: root),
            "rings/SR-00/Thing.swift",
            "a plain project path loses the root and nothing else"
        )

        // The case that was broken. This exact string is what a worker's Write
        // tool call carried for #1286.
        equal(
            QueenBoundaryPaths.projectRelative(
                "\(root)/.worktrees/prod/queen-1286/trios/rings/SR-00/QueenReviewDecision.swift",
                root: root
            ),
            "rings/SR-00/QueenReviewDecision.swift",
            "a worktree write reduces to the same path the boundary names"
        )

        equal(
            QueenBoundaryPaths.projectRelative(
                ".worktrees/dev/queen-42/trios/docs/note.md", root: root
            ),
            "docs/note.md",
            "an already-relative worktree path reduces too"
        )

        equal(
            QueenBoundaryPaths.projectRelative("trios/rings/SR-00/Thing.swift", root: root),
            "rings/SR-00/Thing.swift",
            "a repository-relative path loses the project directory"
        )

        equal(
            QueenBoundaryPaths.projectRelative("/tmp/locprobe_driver.swift", root: root),
            "/tmp/locprobe_driver.swift",
            "a path outside the tree is left alone, so it can still be a stray"
        )

        equal(
            QueenBoundaryPaths.projectRelative("\(root)/rings/SR-00/Thing.swift", root: ""),
            "\(root)/rings/SR-00/Thing.swift",
            "an empty root reduces nothing rather than guessing"
        )

        equal(
            QueenBoundaryPaths.projectRelative("\(root)/", root: root),
            "",
            "the root itself reduces to nothing"
        )
    }

    static func worktreePrefix() {
        scenario("strippingWorktree takes exactly three components, in first position")

        equal(
            QueenBoundaryPaths.strippingWorktree(".worktrees/prod/queen-1/trios/a.swift"),
            "trios/a.swift",
            "variant and task name come off with the marker"
        )

        equal(
            QueenBoundaryPaths.strippingWorktree(".worktrees/prod/queen-1"),
            ".worktrees/prod/queen-1",
            "the worktree directory itself is not a file inside one"
        )

        equal(
            QueenBoundaryPaths.strippingWorktree(".worktrees/prod"),
            ".worktrees/prod",
            "too few components is not a worktree path"
        )

        equal(
            QueenBoundaryPaths.strippingWorktree("rings/.worktrees/prod/queen-1/a.swift"),
            "rings/.worktrees/prod/queen-1/a.swift",
            "a .worktrees deeper in the path names a different file and keeps its name"
        )

        equal(
            QueenBoundaryPaths.strippingWorktree("rings/SR-00/Thing.swift"),
            "rings/SR-00/Thing.swift",
            "an ordinary path is untouched"
        )
    }

    static func projectPrefix() {
        scenario("strippingProject drops the project directory, once")

        equal(
            QueenBoundaryPaths.strippingProject("trios/rings/a.swift", root: root),
            "rings/a.swift",
            "the project component comes off a repository-relative path"
        )

        equal(
            QueenBoundaryPaths.strippingProject("rings/a.swift", root: root),
            "rings/a.swift",
            "a path that does not start with it is untouched"
        )

        equal(
            QueenBoundaryPaths.strippingProject("trios/trios/a.swift", root: root),
            "trios/a.swift",
            "only the first occurrence comes off"
        )

        equal(
            QueenBoundaryPaths.strippingProject("triosx/a.swift", root: root),
            "triosx/a.swift",
            "a component that merely begins with the project name is not it"
        )
    }

    // MARK: - the verdict the Queen actually reads

    static func boundaryVerdict() {
        scenario("strays judges worktree writes by what they name")

        let owned = ["rings/SR-00/QueenReviewDecision.swift"]

        // The #1286 regression, end to end through the same `consider` path the
        // transcript walk uses.
        check(
            QueenBoundaryPaths.strays(
                among: [
                    "\(root)/.worktrees/prod/queen-1286/trios/rings/SR-00/QueenReviewDecision.swift"
                ],
                ownedPaths: owned, root: root
            ).isEmpty,
            "a worker writing its own owned file from its worktree is not a stray"
        )

        check(
            QueenBoundaryPaths.strays(
                among: [
                    "\(root)/.worktrees/prod/queen-1286/trios/rings/SR-00/QueenLocalisation.swift"
                ],
                ownedPaths: owned, root: root
            ) == ["rings/SR-00/QueenLocalisation.swift"],
            "a worker writing someone else's file from its worktree is still a stray"
        )

        check(
            QueenBoundaryPaths.strays(
                among: ["/tmp/locprobe_driver.swift"],
                ownedPaths: owned, root: root
            ) == ["tmp/locprobe_driver.swift"],
            "a write outside the tree entirely is still a stray"
        )

        check(
            QueenBoundaryPaths.strays(
                among: [
                    "\(root)/.worktrees/prod/queen-9/trios/rings/SR-00/Anything.swift"
                ],
                ownedPaths: ["rings"], root: root
            ).isEmpty,
            "owning a directory covers a worktree write beneath it"
        )

        check(
            QueenBoundaryPaths.strays(
                among: [
                    "\(root)/.worktrees/prod/queen-9/trios/docs/other.md"
                ],
                ownedPaths: ["docs/live"], root: root
            ) == ["docs/other.md"],
            "owning docs/live does not license writing a sibling under docs"
        )

        check(
            QueenBoundaryPaths.strays(
                among: ["\(root)/anything.swift"],
                ownedPaths: [], root: root
            ).isEmpty,
            "no boundary declared means nothing can be outside it"
        )
    }

    /// The #1306 regression: a boundary written repository-relative is the
    /// same boundary as one written project-relative, and neither may accuse
    /// a bee that committed exactly what it was given.
    ///
    /// Git reports writes from the repository root - `trios/…` - while an
    /// issue's boundary section is written by a human, who may spell the same
    /// path either way (this issue's own boundary is repository-relative).
    /// `strays` reduced only the write, so `trios/agent-server/…/x.ts` became
    /// `agent-server/…/x.ts` and was compared against an owned path still
    /// carrying its `trios/` - no equality, no prefix, stray. The write was
    /// exactly the file named in the boundary.
    static func ownedPathSpellings() {
        scenario("strays compares both halves in one project-relative namespace")

        let write = "trios/agent-server/apps/server/src/x.ts"
        let writeInside = "trios/agent-server/apps/server/src/api/y.ts"

        check(
            QueenBoundaryPaths.strays(
                among: [write],
                ownedPaths: ["trios/agent-server/apps/server/src/x.ts"],
                root: root
            ).isEmpty,
            "a repository-relative owned path accepts the identical repository-relative write"
        )

        check(
            QueenBoundaryPaths.strays(
                among: [write, writeInside],
                ownedPaths: ["agent-server/apps/server/src"],
                root: root
            ).isEmpty,
            "a project-relative owned path accepts the repository-relative write beneath it"
        )

        check(
            QueenBoundaryPaths.strays(
                among: [write, "trios/docs/note.md"],
                ownedPaths: ["trios/agent-server/apps/server/src/x.ts", "docs"],
                root: root
            ).isEmpty,
            "one boundary may mix the two spellings of the two paths it owns"
        )

        // FR-003: the reduction takes a LEADING project component, not any
        // directory that happens to be named like the project.
        check(
            QueenBoundaryPaths.strays(
                among: ["trios/docs/trios/inner.md"],
                ownedPaths: ["docs/trios"],
                root: root
            ).isEmpty,
            "an interior directory named like the project is a real directory to own"
        )

        check(
            QueenBoundaryPaths.strays(
                among: ["trios/docs/trios/inner.md"],
                ownedPaths: ["trios"],
                root: root
            ) == ["docs/trios/inner.md"],
            "owning the project name as a path does not swallow the whole project"
        )

        // FR-005: a genuine violation is still named, at the project-relative
        // spelling, whichever way the boundary wrote its paths.
        check(
            QueenBoundaryPaths.strays(
                among: ["trios/agent-server/apps/server/src/x.ts", "trios/src/stray.ts"],
                ownedPaths: ["trios/agent-server/apps/server/src/x.ts", "docs"],
                root: root
            ) == ["src/stray.ts"],
            "a real out-of-boundary write is named at its project-relative path"
        )
    }

    static func main() {
        rootPrefix()
        worktreePrefix()
        projectPrefix()
        boundaryVerdict()
        ownedPathSpellings()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
    }
}
