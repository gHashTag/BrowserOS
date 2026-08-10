// Fixture for make parse-tests.
//
// A minimal Swift source that parses cleanly.  Removing the func header
// on the next line makes swiftc -parse fail and name this file and line —
// which is how the target proves it can catch a broken function
// declaration rather than passing silently.
struct ParseFixture {
    func header() -> String { "parses" }
}
