import Foundation

/// Which application a build produces.
enum BuildVariant: String, Equatable, Sendable {
    case dev
    case prod
    case test

    var bundleIdentifier: String {
        switch self {
        case .dev: return "com.browseros.trios.dev"
        case .prod: return "com.browseros.trios"
        case .test: return "com.browseros.trios.test"
        }
    }

    var appBundleName: String {
        switch self {
        case .dev: return "trios-dev.app"
        case .prod: return "trios.app"
        case .test: return "trios-test.app"
        }
    }

    var standaloneBinaryName: String {
        switch self {
        case .dev: return "trios_dev_app"
        case .prod: return "trios_app"
        case .test: return "trios_test_app"
        }
    }

    var frameworksDirectoryName: String {
        switch self {
        case .dev: return "Frameworks-dev"
        case .prod: return "Frameworks"
        case .test: return "Frameworks-test"
        }
    }

    var dataDirectoryName: String {
        switch self {
        case .dev: return ".trinity-dev"
        case .prod: return ".trinity"
        case .test: return ".trinity-test"
        }
    }

    /// The shipped app the user runs. The one variant that must be protected
    /// from every harness convenience below.
    ///
    /// Both predicates that follow are `!isRelease`, deliberately written
    /// against one source rather than repeating the comparison: they answer
    /// different questions and may diverge later, but until they do, a drift
    /// between two copies of the same rule is a defect waiting for a fourth
    /// variant.
    var isRelease: Bool { self == .prod }

    /// Whether this variant keeps its secrets in files instead of the Keychain.
    ///
    /// Split out of `isDevVariant`, which was answering two different questions
    /// with one word. Ten call sites meant "do not touch the Keychain" and
    /// three meant "this is the dev supervisor build"; they agreed only for as
    /// long as there were exactly two variants. The moment `test` became
    /// buildable, the first ten would have sent the harness at the real
    /// Keychain - which does not fail, it BLOCKS on a dialog nobody is there to
    /// answer, so the suite would hang rather than go red.
    ///
    /// Phrased as "not prod" rather than "dev or test" on purpose: a fourth
    /// variant added later is a non-release build until someone deliberately
    /// says otherwise, and the safe default for a secret store is the one that
    /// cannot reach the user's real credentials.
    var usesFileSecretStore: Bool { !isRelease }

    /// Whether this variant runs the Queen's delegation inbox.
    ///
    /// Every comment at the three call sites said the same thing - "so a
    /// release app never picks up an inbox" - while the code asked "is this
    /// dev". With two variants those agreed; with three they stopped, and the
    /// harness was refused its own delegation with the message "No inbox in a
    /// release build" while running as `test`. Nothing can leak across: the
    /// path is `ProjectPaths.trinity/state/queen_inbox.jsonl`, so each variant
    /// reads a different file by construction.
    var hasSupervisorInbox: Bool { !isRelease }

    var mcpPort: String {
        switch self {
        case .dev: return "9205"
        case .prod: return "9105"
        case .test: return "9305"
        }
    }
}

/// Decides which variant a build targets.
///
/// The rule this encodes: **an unqualified build must never touch the release
/// app.** Every skill, cron job and agent runs a bare `./build.sh`, and while
/// that defaulted to release it kept overwriting the bundle the user was
/// running - breaking a working UI as a side effect of routine work. Shipping
/// is now something you ask for explicitly.
enum BuildVariantPolicy {
    /// What a build with no arguments and no environment produces.
    static let defaultVariant: BuildVariant = .dev

    /// Resolves the variant from an explicit flag and the environment.
    /// An unrecognised value is rejected rather than silently falling back,
    /// because a typo that quietly built release is exactly the accident this
    /// policy exists to stop.
    static func resolve(flag: String?, environment: String?) -> BuildVariant? {
        if let flag {
            switch flag {
            case "--release": return .prod
            case "--dev": return .dev
            default: return nil
            }
        }
        guard let environment, !environment.isEmpty else { return defaultVariant }
        return BuildVariant(rawValue: environment)
    }

    /// True when the two variants can run side by side without contending for
    /// any file, port, or bundle identity.
    static func areFullyIsolated(_ a: BuildVariant, _ b: BuildVariant) -> Bool {
        guard a != b else { return true }
        return a.bundleIdentifier != b.bundleIdentifier
            && a.appBundleName != b.appBundleName
            && a.standaloneBinaryName != b.standaloneBinaryName
            && a.frameworksDirectoryName != b.frameworksDirectoryName
            && a.dataDirectoryName != b.dataDirectoryName
            && a.mcpPort != b.mcpPort
    }
}
