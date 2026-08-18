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
    /// True everywhere as of 2026-08-18, by the operator's decision. It was
    /// `!isRelease` on the reasoning that a shipped build must not open chats
    /// by itself - sound in general, and wrong for this product, where the
    /// supervisor IS the product. The consequence of the old answer was that
    /// the swarm was invisible in the app the user actually runs: the sidebar's
    /// Swarm section draws only when the registry has live work, the release
    /// registry never had any, so the section was not hidden - it was empty and
    /// therefore absent.
    ///
    /// Nothing leaks across variants: the path is
    /// `ProjectPaths.trinity/state/queen_inbox.jsonl`, so each reads its own
    /// file by construction. What the inbox does NOT decide is whether the
    /// Queen starts work unprompted - that is `autonomyDefault` below, and it
    /// answers true for exactly one variant.
    var hasSupervisorInbox: Bool { true }

    /// Whether the Queen picks up work unprompted when nothing says otherwise.
    ///
    /// Exactly one variant, and release is the one, because two autonomous
    /// Queens choose from the same epic and neither can see the other's
    /// registry - the stores are separate files by design. They would take the
    /// same issue twice, open two chats for it, and cut two branches. The
    /// worktree paths differ per variant so nothing would be corrupted; the
    /// work would simply be done twice and reviewed twice.
    ///
    /// A stored preference overrides this in either direction. The default is
    /// only what happens before anyone has said anything.
    var autonomyDefault: Bool { isRelease }

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
