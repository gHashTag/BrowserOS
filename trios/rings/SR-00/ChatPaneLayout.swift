import Foundation

/// Vertical budget for the chat pane.
///
/// The pane stacks three things: the message scroll area, the execution planner,
/// and the composer. The planner used to be a fixed three rows, so its height
/// was effectively constant. Once steps became dynamic it can carry a dozen
/// rows plus a memory drawer, and in a `VStack` that growth comes out of its
/// neighbours - squeezing the message list and pushing the composer off the
/// bottom edge.
///
/// The composer is never negotiable: a user who cannot see the input box cannot
/// use the app at all. So the planner gets a bounded share of what is left and
/// scrolls internally beyond that.
enum ChatPaneLayout {
    /// Largest share of the pane the planner may occupy.
    static let plannerMaxHeightFraction: Double = 0.34
    /// Never squeeze the planner below this; under it the card is unreadable
    /// and collapsing entirely is the better answer.
    static let plannerMinUsefulHeight: Double = 96
    /// Space the composer must always keep, including its status row.
    static let composerReservedHeight: Double = 108
    /// The message list must keep at least this much or the conversation
    /// becomes a peephole.
    static let messagesReservedHeight: Double = 120

    /// Height cap for the planner card given the pane height.
    ///
    /// Returns nil when there is not enough room for a useful planner at all;
    /// callers should hide it rather than render an unusable sliver.
    static func plannerMaxHeight(paneHeight: Double) -> Double? {
        guard paneHeight.isFinite, paneHeight > 0 else { return nil }
        let available = paneHeight - composerReservedHeight - messagesReservedHeight
        guard available >= plannerMinUsefulHeight else { return nil }
        let byFraction = paneHeight * plannerMaxHeightFraction
        return max(plannerMinUsefulHeight, min(byFraction, available))
    }

    /// Height the planner container should take: the content's own height,
    /// clamped to the cap.
    ///
    /// Without this the container was a bare `ScrollView` capped at the maximum,
    /// and a ScrollView fills whatever it is offered - so a one-row plan left a
    /// tall empty gap above the composer.
    static func plannerHeight(contentHeight: Double, cap: Double) -> Double {
        guard contentHeight.isFinite, contentHeight > 0 else { return 0 }
        return min(contentHeight, cap)
    }

    /// True when the pane is too short to show the planner alongside the
    /// message list and composer.
    static func shouldHidePlanner(paneHeight: Double) -> Bool {
        plannerMaxHeight(paneHeight: paneHeight) == nil
    }
}
