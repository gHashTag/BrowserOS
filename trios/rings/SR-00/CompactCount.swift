import Foundation

/// Renders a count small enough to sit in a status line without lying about it.
///
/// The rule existed three times - token counts in the task banner, token counts
/// in the review digest, and character counts in the Skills tab - and the third
/// copy had drifted. It divided by 1000 unconditionally, so a 580-character
/// skill displayed as "0k chars", which reads as an empty file rather than a
/// short one.
///
/// Same failure as printing "$0.00" for a sub-cent spend: a measurement that
/// exists rendered as though nothing was there. A number the user cannot
/// distinguish from zero is worse than no number, because they will act on it.
enum CompactCount {
    /// Below the threshold the exact figure is shown, because at that size the
    /// exact figure is short enough to read and rounding it destroys the only
    /// information it carried.
    static let abbreviateAbove = 1000

    static func format(_ value: Int) -> String {
        guard value >= abbreviateAbove else { return "\(value)" }
        return "\(value / abbreviateAbove)k"
    }

    /// Same rule with a unit appended, for places that show characters rather
    /// than tokens.
    static func format(_ value: Int, unit: String) -> String {
        "\(format(value)) \(unit)"
    }
}
