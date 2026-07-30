import Foundation

/// Which application a build produces.
enum BuildVariant: String, Equatable, Sendable {
    case dev
    case prod

    var bundleIdentifier: String {
        switch self {
        case .dev: return "com.browseros.trios.dev"
        case .prod: return "com.browseros.trios"
        }
    }

    var appBundleName: String {
        switch self {
        case .dev: return "trios-dev.app"
        case .prod: return "trios.app"
        }
    }

    var standaloneBinaryName: String {
        switch self {
        case .dev: return "trios_dev_app"
        case .prod: return "trios_app"
        }
    }

    var frameworksDirectoryName: String {
        switch self {
        case .dev: return "Frameworks-dev"
        case .prod: return "Frameworks"
        }
    }

    var dataDirectoryName: String {
        switch self {
        case .dev: return ".trinity-dev"
        case .prod: return ".trinity"
        }
    }

    var mcpPort: String {
        switch self {
        case .dev: return "9205"
        case .prod: return "9105"
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
