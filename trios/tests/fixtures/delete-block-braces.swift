// Input fixture for the <DELETE-BLOCK> brace matcher used by
// `make mutants-guard`. Never compiled by the app build; only lexed.
//
// Every brace below that is NOT code is deliberate, and each line names the
// lexer rule it exercises: line comment, block comment, plain string, raw
// string with a hashed escape, multiline string, and interpolation whose
// contents ARE code again. A counter that walks characters closes this guard
// on the first `log(...)` line and would leave a source nobody can compile.
// The matcher must close it on the guard's own `}`.
//
// Paired with delete-block-braces.expected.swift: that file is exactly what
// the matcher must leave behind, and mutants-guard diffs the two before it
// trusts the operation on real sources.

func hazard(_ mode: String, _ values: [Int]) -> Bool {
    guard ready(shape: "brace{here", note: "/* not a comment */") else {
        // A closing brace inside a line comment: }
        log("a closing brace inside a string: }")
        /* a block comment with { and } inside it */
        log(#"a raw string where \#n escapes and } is just a brace"#)
        log("""
            a multiline string with { and } in it
            """)
        log("interpolated \(values.map { item in item }.count) then a }")
        log("an opening brace with no partner: {")
        return false
    }
    return true
}
