import Foundation

/// File-backed secret storage for the development build.
///
/// The dev variant deliberately does NOT use the macOS Keychain. An ad-hoc
/// signed binary changes identity on every rebuild, so the Keychain treats each
/// build as a different application and re-prompts for the login password once
/// per stored secret - in practice half a dozen dialogs per rebuild, which makes
/// an agent-driven edit loop unusable.
///
/// The trade-off is explicit and scoped: dev secrets sit in a file under the dev
/// data directory with owner-only permissions instead of the Keychain. The
/// release build is untouched and keeps Keychain storage. Nothing here is
/// reachable from the release variant.
enum DevSecretStore {
    /// Directory holding dev-only secrets. Separate from the release data dir so
    /// the two builds can never read each other's state.
    static var directory: String {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        return "\(home)/.trios-dev/secrets"
    }

    static func path(service: String, account: String) -> String {
        "\(directory)/\(sanitize(service))__\(sanitize(account))"
    }

    /// Keeps a file name free of path separators so a crafted service or
    /// account string cannot escape the directory.
    static func sanitize(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._"))
        let scalars = value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
        let joined = String(scalars)
        return joined.isEmpty ? "unnamed" : String(joined.prefix(120))
    }

    static func read(service: String, account: String) -> Data? {
        FileManager.default.contents(atPath: path(service: service, account: account))
    }

    @discardableResult
    static func write(service: String, account: String, data: Data) -> Bool {
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory) {
            try? manager.createDirectory(
                atPath: directory,
                withIntermediateDirectories: true,
                // Owner-only on the directory as well as the files.
                attributes: [.posixPermissions: 0o700]
            )
        }
        let target = path(service: service, account: account)
        guard manager.createFile(
            atPath: target,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        ) else {
            return false
        }
        var url = URL(fileURLWithPath: target)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return true
    }

    @discardableResult
    static func delete(service: String, account: String) -> Bool {
        let target = path(service: service, account: account)
        guard FileManager.default.fileExists(atPath: target) else { return true }
        return (try? FileManager.default.removeItem(atPath: target)) != nil
    }

    /// Accounts stored for a service, used where the Keychain would be enumerated.
    static func accounts(service: String) -> [(account: String, created: Date?)] {
        let prefix = "\(sanitize(service))__"
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else {
            return []
        }
        return names.compactMap { name in
            guard name.hasPrefix(prefix) else { return nil }
            let account = String(name.dropFirst(prefix.count))
            let attrs = try? FileManager.default.attributesOfItem(
                atPath: "\(directory)/\(name)"
            )
            return (account, attrs?[.creationDate] as? Date)
        }
    }
}
