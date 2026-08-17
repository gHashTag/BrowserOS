// EXPECT: cannot convert value of type 'String' to specified type 'BuildVariant'
//
// A raw literal standing in for a variant value.
//
// The one way into a BuildVariant from a String is `init?(rawValue:)`, which
// is failable and therefore forces the caller to say what an unrecognised
// value means - the rule BuildVariantPolicy.resolve spells out: "an
// unrecognised value is rejected rather than silently falling back, because a
// typo that quietly built release is exactly the accident this policy exists
// to stop."
//
// This witness is what keeps that the only way in. It goes green the moment
// BuildVariant gains ExpressibleByStringLiteral, or becomes a typealias for
// String - either of which re-opens every raw-string fork in the tree at once
// and is invisible to any check that reads text.

enum VariantFenceNegative {
    static func witness() {
        let _: BuildVariant = "prod"
    }
}
