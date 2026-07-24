import Combine
import Foundation

struct ChatScrollRequest: Equatable, Sendable {
    let sequence: UInt64
    let animated: Bool

    static let idle = ChatScrollRequest(sequence: 0, animated: false)
}

enum ChatScrollPolicy {
    static func isNearBottom(
        bottomAnchorY: Double,
        viewportHeight: Double,
        threshold: Double = 100
    ) -> Bool {
        guard bottomAnchorY.isFinite,
              viewportHeight.isFinite,
              threshold.isFinite,
              viewportHeight > 0,
              threshold >= 0 else {
            return false
        }
        return bottomAnchorY - viewportHeight <= threshold
    }
}

@MainActor
final class SmoothScrollManager: ObservableObject {
    @Published private(set) var scrollRequest: ChatScrollRequest = .idle

    private var lastScrollTime: Date = .distantPast
    private let scrollThrottleInterval: TimeInterval
    private var pendingScrollTask: Task<Void, Never>?

    init(scrollThrottleInterval: TimeInterval = 0.1) {
        self.scrollThrottleInterval = max(0, scrollThrottleInterval)
    }

    func requestScroll(animated: Bool = true) {
        pendingScrollTask?.cancel()

        let elapsed = Date().timeIntervalSince(lastScrollTime)
        guard elapsed < scrollThrottleInterval else {
            emitScroll(animated: animated)
            return
        }

        let delay = scrollThrottleInterval - elapsed
        pendingScrollTask = Task { [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(delay * 1_000_000_000)
            )
            guard !Task.isCancelled, let self else { return }
            emitScroll(animated: animated)
            pendingScrollTask = nil
        }
    }

    func forceScroll(animated: Bool = true) {
        pendingScrollTask?.cancel()
        pendingScrollTask = nil
        emitScroll(animated: animated)
    }

    private func emitScroll(animated: Bool) {
        lastScrollTime = Date()
        scrollRequest = ChatScrollRequest(
            sequence: scrollRequest.sequence &+ 1,
            animated: animated
        )
    }
}
