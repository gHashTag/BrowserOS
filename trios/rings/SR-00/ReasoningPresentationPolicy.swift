import Foundation

enum ReasoningPresentationPolicy {
    static func showsStandaloneHeader(segmentCount: Int) -> Bool {
        false
    }

    static func showsCards(segmentCount: Int) -> Bool {
        segmentCount > 0
    }
}
