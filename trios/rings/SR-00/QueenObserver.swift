import Foundation

/// Watches a running worker and speaks up before it fails.
///
/// The review loop is post-mortem: it can only tell you a bee wasted twenty
/// minutes after it has. An observer reads the stream while it is still moving
/// and names the failure modes that are visible from outside - looping on one
/// tool, spending without producing, reaching past its boundary, going quiet.
///
/// Deliberately a pure function over the transcript rather than a second model.
/// An observer that is itself an agent doubles the cost and adds a component
/// that can be wrong in the same way as the thing it is watching; these
/// patterns are mechanical, and mechanical checks do not hallucinate.
enum QueenObserver {
    /// What the Queen says to a worker she is correcting.
    ///
    /// A separate function because the wording is the intervention. Telling a
    /// worker it is wrong without saying what to do leaves it to guess, and a
    /// correction it cannot argue with turns a mistaken Queen into a stuck task
    /// - so it is invited to push back here rather than work around her.
    static func correctionText(concerns: [String]) -> String {
        "The Queen is watching this task and has a correction:\n"
            + concerns.joined(separator: "\n") + "\n"
            + "Adjust before continuing. If you think the correction is wrong, "
            + "say so here rather than working around it."
    }

    /// Something worth interrupting a human for.
    struct Concern: Equatable {
        enum Kind: String, Equatable {
            /// The same tool, with the same arguments, over and over.
            case looping
            /// Many tool calls, no text, nothing committed.
            case spinning
            /// Touched a path outside the declared boundary.
            case outOfBounds
            /// Spending far beyond what the task should need.
            case overspending
        }

        let kind: Kind
        /// Written for the Queen to relay, so it explains rather than labels.
        let explanation: String
    }

    /// A tool repeated this many times with identical arguments is not making
    /// progress. Three allows a legitimate retry-after-failure; four does not.
    static let loopThreshold = 4
    /// Tool calls with no prose at all. Agents narrate as they work, so silence
    /// this long usually means the model is stuck in a tool cycle.
    static let spinThreshold = 25

    static func evaluate(
        transcript: QueenWorkerTranscript,
        ownedPaths: [String],
        totalTokens: Int
    ) -> [Concern] {
        var concerns: [Concern] = []

        if let repeated = repeatedCall(in: transcript) {
            concerns.append(Concern(
                kind: .looping,
                explanation: "It has called `\(repeated.name)` \(repeated.count) times with the "
                    + "same arguments. A call that returns the same thing repeatedly is not "
                    + "progress; it usually means the model is not reading the result."
            ))
        }

        let calls = transcript.toolCallCount
        if calls >= spinThreshold, transcript.assistantText.isEmpty {
            concerns.append(Concern(
                kind: .spinning,
                explanation: "\(calls) tool calls and not one sentence of explanation. Working "
                    + "agents narrate as they go, so silence this long usually means it is "
                    + "cycling rather than converging."
            ))
        }

        let strays = outOfBoundsPaths(in: transcript, ownedPaths: ownedPaths)
        if !strays.isEmpty {
            concerns.append(Concern(
                kind: .outOfBounds,
                explanation: "It touched \(strays.joined(separator: ", ")), which is outside the "
                    + "paths it was given. Its branch only collects files inside the boundary, "
                    + "so anything it writes out there lands in your working tree unattributed."
            ))
        }

        if totalTokens >= QueenDelegationPolicy.workerTokenWarningThreshold {
            concerns.append(Concern(
                kind: .overspending,
                explanation: "It has spent \(totalTokens) tokens, past what this kind of task "
                    + "should cost. Worth asking what it got stuck on before it spends more."
            ))
        }

        return concerns
    }

    /// The most-repeated identical call, if it crosses the threshold.
    static func repeatedCall(
        in transcript: QueenWorkerTranscript
    ) -> (name: String, count: Int)? {
        var counts: [String: (name: String, count: Int)] = [:]
        for message in transcript.messages {
            for call in message.toolCalls {
                let key = "\(call.name)|\(call.arguments)"
                let existing = counts[key]?.count ?? 0
                counts[key] = (call.name, existing + 1)
            }
        }
        guard let worst = counts.values.max(by: { $0.count < $1.count }),
              worst.count >= loopThreshold else {
            return nil
        }
        return worst
    }

    /// Paths the worker wrote that fall outside its boundary.
    ///
    /// Only write-shaped tools count. A worker reading a file outside its lane
    /// is doing its homework; writing there is the problem.
    /// `observedWrites` are paths something outside this transcript knows
    /// changed - in practice, what git reports against the snapshot taken when
    /// the worker started.
    ///
    /// Tool names cannot see a write made through the shell: filesystem_bash is
    /// neither write-named nor path-argumented, so `echo > file` and `sed -i`
    /// have always been invisible here. That was asserted as a known blind spot
    /// rather than fixed, because reading shell commands means parsing them and
    /// guessing. Measuring what changed needs no parser and no guess. Optional
    /// so the transcript-only answer stays available where a git call would
    /// cost more than the warning is worth.
    static func outOfBoundsPaths(
        in transcript: QueenWorkerTranscript,
        ownedPaths: [String],
        observedWrites: [String] = []
    ) -> [String] {
        guard !ownedPaths.isEmpty else { return [] }
        let owned = ownedPaths.map(QueenDelegationPolicy.normalizePath)
        var strays: Set<String> = []

        func consider(_ path: String) {
            let normalized = QueenDelegationPolicy.normalizePath(path)
            // A write is inside when its own boundary contains it, which is not
            // symmetric: owning `docs/live` does not license writing `docs`.
            // pathsOverlap answers the symmetric question the ownership rule
            // asks, so the containment test stays spelled out here.
            let inside = owned.contains { normalized == $0 || normalized.hasPrefix("\($0)/") }
            if !inside { strays.insert(normalized) }
        }

        for message in transcript.messages {
            for call in message.toolCalls where isWriteTool(call.name) {
                guard let path = extractPath(from: call.arguments) else { continue }
                consider(path)
            }
        }
        observedWrites.forEach(consider)
        return strays.sorted()
    }

    static func isWriteTool(_ name: String) -> Bool {
        let lowered = name.lowercased()
        return lowered.contains("write") || lowered.contains("edit")
    }

    /// Pulls a path out of a tool's JSON arguments without decoding a schema
    /// that varies per tool.
    static func extractPath(from arguments: String) -> String? {
        guard let data = arguments.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        for key in ["path", "file_path", "filePath", "file"] {
            if let value = object[key] as? String, !value.isEmpty { return value }
        }
        return nil
    }
}
