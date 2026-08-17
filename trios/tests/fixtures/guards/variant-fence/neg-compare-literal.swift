// EXPECT: cannot convert value of type 'BuildVariant' to expected argument type 'String'
//
// The dev/release fork decided by comparing the variant against a raw string.
//
// This is not hypothetical. tools/ChatProbe.swift:30 already reads
//
//     let isDev = variant == "dev"
//
// against its own String copy of the variant, while BR-OUTPUT/
// ProjectPaths.swift:128 reads `variant == .dev`. The probe is outside the app
// module, so nothing stops it; this witness is what stops the same line being
// written back INSIDE the module, where `.trinity` vs `.trinity-dev`, the
// Keychain vs DevSecretStore, and 9105 vs 9205 all hang off the answer.
//
// A string comparison has no wrong answers, only false ones: `== "Dev"` is
// merely false, and a dev build that quietly reports itself as release writes
// into the running app's state.

enum VariantFenceNegative {
    static func witness() {
        let _: Bool = (ProjectPaths.variant == "dev")
    }
}
