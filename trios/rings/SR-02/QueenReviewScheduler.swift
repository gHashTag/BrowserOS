import AppKit
import Foundation

/// Wakes the Queen on a timer so she looks at the swarm and reports.
///
/// Workers finish while nobody is watching. Without a wake the only way to
/// learn that a bee has been waiting three hours is to open the app and look,
/// which makes the supervisor a thing you operate rather than a thing that
/// operates. The digest goes to the Queen's own chat, so the report lands where
/// the decisions are made.
@MainActor
final class QueenReviewScheduler {
    static let shared = QueenReviewScheduler()

    var isRunning: Bool { timer != nil }
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private let interval: TimeInterval
    private let dateProvider: () -> Date
    private(set) var lastReviewDate: Date?

    /// Posts the digest. Injected so the scheduler can be exercised without a
    /// chat, and so it never holds a strong reference to the view model.
    var report: ((String) async -> Void)?
    /// Supplies the current swarm.
    var tasks: (() -> [DelegatedTask])?
    /// Housekeeping run before the digest is composed, so the report describes
    /// the swarm after reaping rather than before.
    var beforeReport: (() async -> Void)?
    /// Estimated spend today, so the report can mention the ceiling.
    var spentToday: (() -> Int)?
    var budget: SwarmBudget = .default

    init(
        interval: TimeInterval = 30 * 60,
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.interval = interval
        self.dateProvider = dateProvider
    }

    func start() {
        guard !isRunning else { return }
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.reviewNow()
            }
        }
        // A laptop asleep for six hours fires no timers. Without this the first
        // report after opening the lid is a whole interval late, which is
        // exactly when the backlog is largest.
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.handleWake()
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let observer = wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            wakeObserver = nil
        }
    }

    /// Runs one review pass. Silent when there is nothing to say.
    func reviewNow() async {
        let now = dateProvider()
        lastReviewDate = now
        await beforeReport?()
        let swarm = tasks?() ?? []
        guard let digest = QueenReviewDigest.text(for: swarm, now: now) else {
            TriosLogBus.shared.debug(.queen, "queen.review.idle", "Nothing to report", [:])
            return
        }

        let stalled = QueenReviewDigest.stalled(swarm, now: now)
        var message = SystemNoticeClassifier.infoMarker + digest
        if !stalled.isEmpty {
            message = SystemNoticeClassifier.warningMarker + digest + "\n\n"
                + QueenReviewDigest.stallParagraph(stalled, now: now)
        }
        if let budgetNote = QueenReviewDigest.budgetParagraph(
            spentToday: spentToday?() ?? 0,
            budget: budget
        ) {
            message += "\n\n" + budgetNote
        }
        await report?(message)
        TriosLogBus.shared.info(
            .queen,
            "queen.review.posted",
            "Posted a swarm review",
            [
                "waiting": String(QueenDelegationPolicy.reviewQueue(swarm).count),
                "running": String(swarm.filter { $0.state == .running }.count),
                "stalled": String(stalled.count)
            ]
        )
    }

    private func handleWake() async {
        guard let last = lastReviewDate else {
            await reviewNow()
            return
        }
        // Only catch up if the machine slept through an interval; waking from a
        // two-minute nap must not spam the chat.
        guard dateProvider().timeIntervalSince(last) >= interval else { return }
        await reviewNow()
    }
}
