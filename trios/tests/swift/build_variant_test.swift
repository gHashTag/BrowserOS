// Standalone unit tests for BuildVariantPolicy - Foundation only.
//
// Run (from trios root):
//   swiftc tests/swift/build_variant_test.swift rings/SR-00/BuildVariantPolicy.swift \
//     -o /tmp/trios_build_variant_test && /tmp/trios_build_variant_test

import Foundation

@main
enum BuildVariantTests {
    static var failures = 0
    static var checks = 0

    static func check(_ cond: Bool, _ name: String) {
        checks += 1
        if cond { print("ok   - \(name)") } else { failures += 1; print("FAIL - \(name)") }
    }

    static func scenario(_ name: String) { print("\n# Scenario: \(name)") }

    static func main() {
        safeDefault()
        explicitRelease()
        rejectsTypos()
        fullIsolation()

        print("\n\(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
        print("All BuildVariant tests passed.")
    }

    /// The guard this file exists for. If someone flips the default back to
    /// release, this fails loudly.
    static func safeDefault() {
        scenario("an unqualified build never touches the release app")

        check(
            BuildVariantPolicy.defaultVariant == .dev,
            "the default variant is dev, so a bare ./build.sh cannot overwrite trios.app"
        )
        check(
            BuildVariantPolicy.resolve(flag: nil, environment: nil) == .dev,
            "no flag and no environment resolves to dev"
        )
        check(
            BuildVariantPolicy.resolve(flag: nil, environment: "") == .dev,
            "an empty environment value resolves to dev"
        )
        check(
            BuildVariantPolicy.defaultVariant.appBundleName != BuildVariant.prod.appBundleName,
            "the default build writes a different bundle than release"
        )
    }

    static func explicitRelease() {
        scenario("shipping is deliberate")

        check(BuildVariantPolicy.resolve(flag: "--release", environment: nil) == .prod, "--release ships")
        check(
            BuildVariantPolicy.resolve(flag: nil, environment: "prod") == .prod,
            "TRIOS_VARIANT=prod ships"
        )
        check(BuildVariantPolicy.resolve(flag: "--dev", environment: nil) == .dev, "--dev is explicit too")
        check(
            BuildVariantPolicy.resolve(flag: "--release", environment: "dev") == .prod,
            "an explicit flag beats the environment"
        )
        check(BuildVariant.prod.appBundleName == "trios.app", "release writes trios.app")
        check(BuildVariant.dev.appBundleName == "trios-dev.app", "dev writes trios-dev.app")
    }

    static func rejectsTypos() {
        scenario("a mistyped variant is refused, not guessed")

        check(
            BuildVariantPolicy.resolve(flag: nil, environment: "production") == nil,
            "'production' is not silently treated as prod"
        )
        check(
            BuildVariantPolicy.resolve(flag: nil, environment: "release") == nil,
            "'release' is not silently treated as prod"
        )
        check(
            BuildVariantPolicy.resolve(flag: "--ship", environment: nil) == nil,
            "an unknown flag is refused"
        )
        check(
            BuildVariantPolicy.resolve(flag: nil, environment: "DEV") == nil,
            "the value is case-sensitive rather than loosely matched"
        )
    }

    /// Isolation has to hold on every axis, or the variants contend somewhere.
    static func fullIsolation() {
        scenario("dev and release share nothing that could corrupt the other")

        check(
            BuildVariantPolicy.areFullyIsolated(.dev, .prod),
            "the two variants are isolated on every axis"
        )
        check(
            BuildVariant.dev.bundleIdentifier != BuildVariant.prod.bundleIdentifier,
            "distinct bundle ids, so macOS does not treat one as the other"
        )
        check(
            BuildVariant.dev.standaloneBinaryName != BuildVariant.prod.standaloneBinaryName,
            "distinct standalone binaries, so a dev build cannot overwrite the release one"
        )
        check(
            BuildVariant.dev.frameworksDirectoryName != BuildVariant.prod.frameworksDirectoryName,
            "distinct Frameworks dirs, so dylibs cannot be swapped underneath a running app"
        )
        check(
            BuildVariant.dev.dataDirectoryName != BuildVariant.prod.dataDirectoryName,
            "distinct data roots, so a schema change cannot corrupt release state"
        )
        check(
            BuildVariant.dev.mcpPort != BuildVariant.prod.mcpPort,
            "distinct ports, so the two servers coexist"
        )
        check(
            BuildVariantPolicy.areFullyIsolated(.dev, .dev),
            "a variant is trivially isolated from itself"
        )
    }
}
