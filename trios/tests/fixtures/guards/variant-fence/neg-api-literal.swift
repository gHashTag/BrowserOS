// EXPECT: cannot convert value of type 'String' to expected argument type 'BuildVariant'
//
// A variant-taking API fed raw strings.
//
// areFullyIsolated is the function that decides whether two builds can run
// side by side without contending for a bundle id, a binary name, a Frameworks
// directory, a data root or a port. Called with strings it would compare two
// values that were never resolved through the enum, so a caller could ask
// about a variant that does not exist and be told yes.
//
// Separate file from the other two on purpose: a negative arm asserts that a
// compile FAILS, and a compile fails as a whole. Two negatives sharing a file
// would still fail with one of them silently compiling, and the fence would be
// half gone with the check green.

enum VariantFenceNegative {
    static func witness() {
        let _: Bool = BuildVariantPolicy.areFullyIsolated("dev", "prod")
    }
}
