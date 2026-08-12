import Foundation

/// What the Queen says when she wakes up and looks at the swarm.
///
/// Written as prose addressed to the user, not as a status table. A supervisor
/// that emits columns is a dashboard with extra steps; the reason to have a
/// Queen at all is that she can say *why* something matters and what she would
/// do about it. Each report carries one analogy, chosen for what it explains
/// rather than for decoration - the isolation of a branch really is the
/// isolation of a culture in its own dish, and saying so is faster than
/// re-explaining git plumbing every time.
///
/// Pure, so the wording is testable without a timer, a chat or a running app.
enum QueenReviewDigest {
    /// `nil` means there is nothing worth waking the user for.
    ///
    /// Silence when idle is the whole contract. A heartbeat that fires whether
    /// or not anything happened is indistinguishable from noise, and the first
    /// thing anyone does with it is stop reading it.
    static func text(for tasks: [DelegatedTask], now: Date) -> String? {
        let running = tasks.filter { $0.state == .running }
        let waiting = QueenDelegationPolicy.reviewQueue(tasks)
        guard !running.isEmpty || !waiting.isEmpty else { return nil }

        var paragraphs: [String] = ["I looked in on the hive at \(timestamp(now))."]

        if !waiting.isEmpty {
            paragraphs.append(waitingParagraph(waiting, now: now))
        }
        if !running.isEmpty {
            paragraphs.append(runningParagraph(running, now: now))
        }
        if !waiting.isEmpty {
            paragraphs.append(
                "Nothing merges without you. Say `/accept <issue>` and I fold the "
                    + "branch into the record, or `/review <issue> reject <why>` and "
                    + "the same bee tries again in the same chat with your reason in hand."
            )
        }
        return paragraphs.joined(separator: "\n\n")
    }

    private static func waitingParagraph(_ waiting: [DelegatedTask], now: Date) -> String {
        var lines: [String] = []
        if waiting.count == 1, let task = waiting[0] as DelegatedTask? {
            lines.append(describeWaiting(task, now: now))
        } else {
            lines.append("\(waiting.count) results are waiting on you:")
            for task in waiting {
                lines.append("  - " + describeWaiting(task, now: now))
            }
        }
        // The isolation is the part people forget, and the part that makes it
        // safe to leave results sitting here rather than merging them on sight.
        lines.append(
            "Each one grew in its own branch, the way a culture grows in its own "
                + "dish: nothing they did has touched the tree you are working in, "
                + "so there is no cost to leaving them until you have read them."
        )
        return lines.joined(separator: "\n")
    }

    private static func describeWaiting(_ task: DelegatedTask, now: Date) -> String {
        var sentence = "\(task.worker) came back from \(task.issue.slug) "
            + "\(age(of: task, now: now)) with \(effortPhrase(task))"
        // nil and 0 are different claims. nil means the branch has not been
        // tallied yet; saying "committed nothing" there accuses a worker of
        // going outside its boundary when all that happened is a race.
        switch task.committedFiles {
        case .some(let files) where files > 0:
            sentence += ", and committed \(files) file\(files == 1 ? "" : "s") to "
                + "`\(task.virtualBranch ?? "its branch")`"
        case .some:
            sentence += ", but committed nothing to its branch, so it either only "
                + "read or it wrote outside the paths it was given"
        case .none:
            sentence += "; I have not tallied its branch yet"
        }
        if task.state == .failed {
            sentence += ". It failed rather than finished, so read its chat before deciding"
        }
        // Say why it is at the top. A ranking nobody can explain is a ranking
        // nobody trusts, and the first thing an untrusted ranking gets is
        // ignored.
        if let why = QueenSalience.reason(for: task, now: now), task.state != .failed {
            sentence += ". I put it first because \(why)"
        }
        if QueenDelegationPolicy.isExpensive(task) {
            sentence += ". It also burned \(spendPhrase(task)), well past "
                + "what this kind of task should cost - worth asking what it got stuck on"
        }
        return sentence + "."
    }

    private static func runningParagraph(_ running: [DelegatedTask], now: Date) -> String {
        if running.count == 1, let task = running.first {
            return "\(task.worker) is still working on \(task.issue.slug), "
                + "\(age(of: task, now: now)) in\(spendClause(task)). "
                + "I hold at most \(QueenDelegationPolicy.maximumConcurrentWorkers) bees at once "
                + "on purpose: past that they start reaching for the same files, and "
                + "the time lost untangling them is larger than the time saved running them."
        }
        var lines = ["\(running.count) are still working:"]
        for task in running {
            lines.append(
                "  - \(task.worker) on \(task.issue.slug), \(age(of: task, now: now)) in"
                    + spendClause(task)
            )
        }
        lines.append(
            "That is \(running.count) of \(QueenDelegationPolicy.maximumConcurrentWorkers) slots. "
                + "The ceiling is deliberate: concurrent writers collide, and "
                + "untangling them costs more than the parallelism buys."
        )
        return lines.joined(separator: "\n")
    }

    /// Explains a stall in terms of what actually happened, not just a flag.
    static func stallParagraph(_ stalled: [DelegatedTask], now: Date) -> String {
        let subject = stalled.count == 1
            ? "\(stalled[0].worker) on \(stalled[0].issue.slug) has"
            : "\(stalled.count) bees have"
        return "\(subject) shown no sign of life for over an hour. A worker in that "
            + "state is a reaction that stopped without producing anything: it still "
            + "occupies a slot, so the hive looks busier than it is. I will close them "
            + "on the next sweep unless they come back; re-delegate when you want "
            + "another attempt."
    }

    private static func effortPhrase(_ task: DelegatedTask) -> String {
        let tools = task.toolCalls ?? 0
        if tools == 0 { return "no tool calls at all" }
        if tools == 1 { return "a single tool call" }
        if tools < 10 { return "\(tools) tool calls" }
        return "\(tools) tool calls, so it worked the problem rather than guessing"
    }

    /// Silent when the provider reported no usage. "spent 0 tokens" reads as a
    /// measurement; it is really the absence of one, and saying so would be a
    /// claim about the worker rather than about the provider.
    private static func spendClause(_ task: DelegatedTask) -> String {
        guard task.totalTokens > 0 else { return "" }
        return " and \(spendPhrase(task)) so far"
    }

    /// Money when the model is priced, tokens otherwise. An unpriced model must
    /// not silently become a dollar figure someone believes.
    private static func spendPhrase(_ task: DelegatedTask) -> String {
        guard let cost = task.estimatedCostUSD, cost > 0 else {
            return "\(formatted(task.totalTokens)) tokens"
        }
        return "about \(ModelPricing.format(cost)) (\(formatted(task.totalTokens)) tokens)"
    }

    /// Appended to a report when the day's spend is worth mentioning.
    static func budgetParagraph(spentToday: Double, budget: SwarmBudget) -> String? {
        switch budget.verdict(spentToday: spentToday) {
        case .fine:
            return nil
        case .nearingLimit(let remaining):
            return "The swarm has spent about \(ModelPricing.format(spentToday)) today, leaving "
                + "\(ModelPricing.format(remaining)) of the \(ModelPricing.format(budget.dailyLimitUSD)) "
                + "ceiling. I will keep going, but it is worth knowing before you queue more."
        case .exhausted(let overBy):
            return "The swarm has spent about \(ModelPricing.format(spentToday)) today, "
                + "\(ModelPricing.format(overBy)) past the ceiling. I will not start new work "
                + "until tomorrow or until you raise it. Bees already running keep running - "
                + "stopping one mid-edit leaves the repository in a state nobody chose."
        }
    }

    private static func formatted(_ tokens: Int) -> String {
        CompactCount.format(tokens)
    }

    /// A worker that has been "running" for hours is far more likely to be stuck
    /// than busy, so every line carries its age.
    static func age(of task: DelegatedTask, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(task.updatedAt))
        if seconds < 60 { return "a moment ago" }
        if seconds < 3600 { return "\(Int(seconds / 60)) minutes ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) hours ago" }
        return "\(Int(seconds / 86_400)) days ago"
    }

    /// Running bees that have stopped without saying so.
    ///
    /// The same question the reaper asks, through the same predicate. This used
    /// to measure silence from `updatedAt` alone, which is a clock and not
    /// evidence: `updatedAt` records the last time the Queen wrote bookkeeping,
    /// not the last time the worker spoke. A bee that streamed for ninety
    /// minutes never touched it, so the hourly digest announced it as stalled
    /// in the same minute the reaper - reading the runner's facts - correctly
    /// left it alone (#1247, #1248). One supervisor with two answers is worse
    /// than either answer on its own: whichever the user reads, the other half
    /// of the system is acting on the opposite belief.
    ///
    /// There is exactly one notion of silence in this project and it lives in
    /// `QueenDelegationPolicy.hasGoneSilent`: no byte for `threshold`, and no
    /// open stream. `QueenReviewScheduler`, `QueenBackgroundService` and
    /// `QueenDelegationRegistry.stalled` all reach it through one of these two
    /// call sites. Neither keeps a copy, so neither can drift.
    static func stalled(
        _ tasks: [DelegatedTask],
        now: Date,
        threshold: TimeInterval = QueenDelegationPolicy.stallThreshold
    ) -> [DelegatedTask] {
        tasks.filter {
            $0.state == .running
                && QueenDelegationPolicy.hasGoneSilent($0, now: now, threshold: threshold)
        }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
