import Foundation

/// Path-safety guard inspired by the July 2026 GhostApproval class of attacks,
/// where malicious repositories redirect agent file writes to sensitive host
/// paths via symlinks. `SafeFilePath` validates that a write target:
/// 1. Resides inside a caller-supplied trusted base directory,
/// 2. Is not itself a symlink or a path component that escapes via symlinks,
/// 3. Does not point to a well-known sensitive host location (SSH, cloud creds,
///    shell rc files, keychain, etc.).
enum SafeFilePathError: LocalizedError {
    case pathOutsideBase(String)
    case symlinkDetected(String)
    case sensitivePath(String)

    var errorDescription: String? {
        switch self {
        case .pathOutsideBase(let path):
            return "Path escapes trusted base: \(path)"
        case .symlinkDetected(let path):
            return "Symlink or symlink jump detected at: \(path)"
        case .sensitivePath(let path):
            return "Refusing to write to sensitive path: \(path)"
        }
    }
}

enum SafeFilePath {
    /// Directories/files that agents must never write to. Patterns are
    /// lowercase for case-insensitive matching on macOS APFS.
    static let sensitiveComponents: Set<String> = [
        ".ssh", ".aws", ".gnupg", ".docker", ".kube",
        ".zshrc", ".bashrc", ".bash_profile", ".profile",
        ".env", ".envrc", ".env.local", ".env.production",
        "authorized_keys", "known_hosts", "id_rsa", "id_ed25519",
        "keychain", "keychains", "login.keychain", "login.keychain-db",
    ]

    /// Validates that `candidate` is safe to write. Resolves symlinks and
    /// requires the real path to be under `baseURL`.
    /// - Parameters:
    ///   - candidate: The path the caller intends to write to.
    ///   - baseURL: The trusted root the write must stay under.
    ///   - allowMissingBase: If true, a missing base directory is allowed
    ///     (useful when creating the first file under a new temp dir).
    ///     Defaults to `false` so callers must opt in and cannot silently
    ///     resolve a non-existent or symlinked base.
    static func validateWritePath(
        candidate: URL,
        baseURL: URL,
        allowMissingBase: Bool = false
    ) throws {
        let fm = FileManager.default
        let candidatePath = candidate.standardizedFileURL.path

        // 1. Reject obvious sensitive names before any filesystem resolution.
        let components = candidatePath
            .split(separator: "/")
            .map { $0.lowercased() }
        for component in components {
            if sensitiveComponents.contains(component) {
                throw SafeFilePathError.sensitivePath(candidatePath)
            }
        }

        // 2. Resolve realpaths for existing portions of the path.
        let resolvedCandidate = resolveRealpath(candidate, fileManager: fm)
        let resolvedBase: String
        if allowMissingBase && !fm.fileExists(atPath: baseURL.path) {
            resolvedBase = baseURL.standardizedFileURL.path
        } else {
            resolvedBase = resolveRealpath(baseURL, fileManager: fm)
        }

        // 3. Ensure the resolved candidate is under the resolved base.
        let isUnderBase = resolvedCandidate == resolvedBase
            || resolvedCandidate.hasPrefix(resolvedBase + "/")
        guard isUnderBase else {
            throw SafeFilePathError.pathOutsideBase(candidatePath)
        }

        // 4. Walk the path from base to candidate and reject any symlink.
        try rejectSymlinkJumps(from: resolvedBase, to: resolvedCandidate, fileManager: fm)
    }

    /// Convenience that validates a string path against a string base.
    static func validateWritePath(
        candidatePath: String,
        basePath: String,
        allowMissingBase: Bool = false
    ) throws {
        try validateWritePath(
            candidate: URL(fileURLWithPath: candidatePath),
            baseURL: URL(fileURLWithPath: basePath),
            allowMissingBase: allowMissingBase
        )
    }

    // MARK: - Internal helpers

    private static func resolveRealpath(_ url: URL, fileManager fm: FileManager) -> String {
        // resolvingSymlinksInPath() resolves symlinks in all path components
        // that exist. For a non-existent file, it resolves the parent directory
        // and preserves the filename.
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
        return resolved
    }

    private static func rejectSymlinkJumps(
        from resolvedBase: String,
        to resolvedCandidate: String,
        fileManager fm: FileManager
    ) throws {
        var current = resolvedCandidate
        while current.count > resolvedBase.count {
            guard !isSymlink(current, fileManager: fm) else {
                throw SafeFilePathError.symlinkDetected(current)
            }
            let parent = (current as NSString).deletingLastPathComponent
            guard parent != current else { break }
            current = parent
        }
        guard !isSymlink(resolvedBase, fileManager: fm) else {
            throw SafeFilePathError.symlinkDetected(resolvedBase)
        }
    }

    private static func isSymlink(_ path: String, fileManager fm: FileManager) -> Bool {
        guard fm.fileExists(atPath: path) else { return false }
        do {
            _ = try fm.destinationOfSymbolicLink(atPath: path)
            return true
        } catch {
            return false
        }
    }
}
