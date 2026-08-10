// Broken fixture for make parse-tests.
//
// This source does NOT parse — the func keyword is deliberately missing.
// The negative arm of parse-tests runs swiftc -parse on this file and
// requires it to fail.  Replacing this file with valid Swift makes the
// target fail, proving the check actually catches broken sources.
struct ParseFixture {
     header() -> String { "parses" }
}
