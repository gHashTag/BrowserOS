import Foundation

/// Where this app keeps the budget knob.
///
/// `SwarmBudget` itself takes the directory, because it is part of the
/// selection core a Linux server compiles and a server has no app bundle for
/// `ProjectPaths` to resolve. The one line that knows this machine's layout
/// lives here instead, in a ring the server does not build.
///
/// Kept as `.current` so the three call sites read exactly as they did; the
/// change is where the path comes from, not what anyone asks for.
extension SwarmBudget {
    static var current: SwarmBudget {
        current(stateDirectory: ProjectPaths.trinity)
    }
}
