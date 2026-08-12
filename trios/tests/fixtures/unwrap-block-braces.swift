// Input fixture for the <UNWRAP-BLOCK> operation used by `make mutants-guard`.
// Never compiled by the app build; only lexed.
//
// Unwrapping removes an `if <dev-only> {` line and its matching closing brace
// and KEEPS the body, so the block's contents start running unconditionally.
// That is the accident guards 1, 4 and 5 exist to catch, and it is the one
// edit that leaves their guard-shapes anchor - which sits INSIDE the block -
// alive to be found.
//
// The braces hidden in strings and comments below are the same hazards
// delete-block-braces.swift carries, because both operations share one
// matcher: a character counter closes this `if` on the first log(...) line,
// and unwrapping there would delete a body line instead of the brace.
//
// Paired with unwrap-block-braces.expected.swift, which is the positive arm.
// The three functions after `hazard` are the shapes the operation must REFUSE
// rather than guess at - unwrapping any of them would silently eat code - and
// mutants-guard drives all four arms before it trusts the operation on a real
// source.

func hazard(_ mode: String, _ values: [Int]) -> Bool {
    if devOnly(shape: "brace{here", note: "/* not a comment */") {
        // A closing brace inside a line comment: }
        log("a closing brace inside a string: }")
        /* a block comment with { and } inside it */
        log(#"a raw string where \#n escapes and } is just a brace"#)
        log("""
            a multiline string with { and } in it
            """)
        log("interpolated \(values.map { item in item }.count) then a }")
        log("an opening brace with no partner: {")
        return false // anchor: unwrap-positive
    }
    return true
}

func oneLine(_ mode: String) -> Bool {
    if devOnly(shape: "inline") { return false }
    return true // anchor: unwrap-oneline
}

func braceShared(_ mode: String) -> Bool {
    if devOnly(shape: "shared") {
        log("the body ends on the closing brace's own line") // anchor: unwrap-shared
        return false }
    return true
}

func anchorOutside(_ mode: String) -> Bool {
    if devOnly(shape: "outside") {
        return false
    }
    return true // anchor: unwrap-outside
}
