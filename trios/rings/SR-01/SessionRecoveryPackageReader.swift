import CryptoKit
import Foundation

enum SessionRecoveryPackageReaderError: LocalizedError {
    case missingArchive
    case extractionFailed(String)
    case manifestFileMissing
    case invalidManifest(String)
    case missingConversations
    case invalidConversations(String)
    case unsafePath(String)
    case checksumMismatch(path: String, expected: String, actual: String)
    case fileSizeMismatch(path: String, expected: Int, actual: Int)
    case archiveCorrupt(String)
    case unsupportedSchemaVersion(Int)

    var errorDescription: String? {
        switch self {
        case .missingArchive:
            return "The recovery archive could not be read."
        case .extractionFailed(let message):
            return "Could not extract the recovery ZIP: \(message)"
        case .manifestFileMissing:
            return "The recovery package is missing manifest.json."
        case .invalidManifest(let message):
            return "The recovery manifest is invalid: \(message)"
        case .missingConversations:
            return "The recovery package is missing session/conversations.json."
        case .invalidConversations(let message):
            return "The recovered conversations are invalid: \(message)"
        case .unsafePath(let path):
            return "Unsafe recovery archive path: \(path)"
        case .checksumMismatch(let path, let expected, let actual):
            return "Checksum mismatch for \(path): expected \(expected), got \(actual)."
        case .fileSizeMismatch(let path, let expected, let actual):
            return "File size mismatch for \(path): expected \(expected), got \(actual)."
        case .archiveCorrupt(let message):
            return "Archive is corrupt or missing expected files: \(message)"
        case .unsupportedSchemaVersion(let version):
            return "This TriOS build cannot read recovery schema version \(version)."
        }
    }
}

struct SessionRecoveryImportResult: Sendable {
    let packageID: UUID
    let createdAt: Date
    let activeConversationID: UUID
    let conversations: [SessionRecoveryConversation]
}

struct SessionRecoveryImportSummary: Sendable {
    let conversationCount: Int
    let successCount: Int
    let failureCount: Int
    let messageCount: Int
    let activeConversationID: UUID
    let failedConversationIDs: [UUID]
}

enum SessionRecoveryDuplicateResolution: String, Sendable, Codable, Equatable {
    case replace
    case merge
    case skip
}

private struct SessionRecoveryManifest: Codable {
    let schemaVersion: Int
    let minReaderVersion: Int?
    let createdByAppVersion: String?
    let packageID: UUID
    let createdAt: Date
    let activeConversationID: UUID
    let fileCount: Int
    let redactionCount: Int
    let encryptionScheme: String?
    let files: [SessionRecoveryManifestEntry]
}

private struct SessionRecoveryManifestEntry: Codable {
    let path: String
    let bytes: Int
    let sha256: String
}

enum SessionRecoveryPackageReader {
    /// Supported manifest schema versions. The reader accepts any package whose
    /// `minReaderVersion` is less than or equal to the current supported version.
    static let supportedReaderVersion = 1

    /// Reads a Trinity recovery ZIP produced by `SessionRecoveryPackageWriter`.
    /// Extraction is staged in a temporary directory and cleaned up before return.
    static func read(from archiveURL: URL) throws -> SessionRecoveryImportResult {
        let fileManager = FileManager.default
        let archivePath = archiveURL.standardizedFileURL.resolvingSymlinksInPath().path

        guard fileManager.fileExists(atPath: archivePath) else {
            throw SessionRecoveryPackageReaderError.missingArchive
        }

        let staging = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-import-\(UUID().uuidString)", isDirectory: true)
        try? fileManager.removeItem(at: staging)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        defer {
            try? fileManager.removeItem(at: staging)
        }

        try extractArchive(at: archivePath, to: staging.path)

        let packageRoot = try locatePackageRoot(in: staging)

        let manifestURL = packageRoot.appendingPathComponent("manifest.json")
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            throw SessionRecoveryPackageReaderError.manifestFileMissing
        }

        let manifestData = try Data(contentsOf: manifestURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let manifest: SessionRecoveryManifest
        do {
            manifest = try decoder.decode(SessionRecoveryManifest.self, from: manifestData)
        } catch {
            throw SessionRecoveryPackageReaderError.invalidManifest(error.localizedDescription)
        }

        let minReaderVersion = manifest.minReaderVersion ?? manifest.schemaVersion
        guard minReaderVersion <= Self.supportedReaderVersion else {
            throw SessionRecoveryPackageReaderError.unsupportedSchemaVersion(minReaderVersion)
        }

        try verifyManifest(manifest, packageRoot: packageRoot)

        let conversationsURL = packageRoot.appendingPathComponent("session/conversations.json")
        guard fileManager.fileExists(atPath: conversationsURL.path) else {
            throw SessionRecoveryPackageReaderError.missingConversations
        }

        let conversationsData = try Data(contentsOf: conversationsURL)
        let conversations: [SessionRecoveryConversation]
        do {
            conversations = try decoder.decode([SessionRecoveryConversation].self, from: conversationsData)
        } catch {
            throw SessionRecoveryPackageReaderError.invalidConversations(error.localizedDescription)
        }

        return SessionRecoveryImportResult(
            packageID: manifest.packageID,
            createdAt: manifest.createdAt,
            activeConversationID: manifest.activeConversationID,
            conversations: conversations
        )
    }

    private static func extractArchive(at archivePath: String, to destinationPath: String) throws {
        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", archivePath, destinationPath]
        process.standardError = errorPipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let error = errorPipe.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: error, encoding: .utf8) ?? "ditto exited with \(process.terminationStatus)"
            throw SessionRecoveryPackageReaderError.extractionFailed(message)
        }
    }

    /// Recovery archives are created with `--keepParent`, so extraction places the
    /// package contents one directory below the staging root. Locate that directory
    /// and validate it stays inside the staging area.
    private static func locatePackageRoot(in staging: URL) throws -> URL {
        let fileManager = FileManager.default
        let contents = try fileManager.contentsOfDirectory(
            at: staging,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        let directories = contents.filter { url in
            guard let isDirectory = try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory else {
                return false
            }
            return isDirectory == true
        }
        guard let packageRoot = directories.first else {
            throw SessionRecoveryPackageReaderError.manifestFileMissing
        }
        let normalizedRoot = staging.standardizedFileURL.resolvingSymlinksInPath()
        let normalizedPackage = packageRoot.standardizedFileURL.resolvingSymlinksInPath()
        guard normalizedPackage.path.hasPrefix(normalizedRoot.path + "/") else {
            throw SessionRecoveryPackageReaderError.unsafePath(normalizedPackage.path)
        }
        return packageRoot
    }

    private static func verifyManifest(
        _ manifest: SessionRecoveryManifest,
        packageRoot: URL
    ) throws {
        let fileManager = FileManager.default
        let normalizedRoot = packageRoot.standardizedFileURL.resolvingSymlinksInPath()

        var missingPaths: [String] = []
        for entry in manifest.files {
            let entryURL = packageRoot.appendingPathComponent(entry.path)
            let normalizedEntry = entryURL.standardizedFileURL.resolvingSymlinksInPath()
            guard normalizedEntry.path.hasPrefix(normalizedRoot.path + "/") else {
                throw SessionRecoveryPackageReaderError.unsafePath(entry.path)
            }
            guard fileManager.fileExists(atPath: normalizedEntry.path) else {
                missingPaths.append(entry.path)
                continue
            }
            let values = try? normalizedEntry.resourceValues(forKeys: [.fileSizeKey])
            let actualSize = values?.fileSize ?? 0
            guard actualSize == entry.bytes else {
                throw SessionRecoveryPackageReaderError.fileSizeMismatch(
                    path: entry.path,
                    expected: entry.bytes,
                    actual: actualSize
                )
            }
            guard let data = try? Data(contentsOf: normalizedEntry) else {
                throw SessionRecoveryPackageReaderError.archiveCorrupt("could not read \(entry.path)")
            }
            let actualHash = SHA256.hash(data: data)
                .map { String(format: "%02x", $0) }
                .joined()
            guard actualHash == entry.sha256 else {
                throw SessionRecoveryPackageReaderError.checksumMismatch(
                    path: entry.path,
                    expected: entry.sha256,
                    actual: actualHash
                )
            }
        }
        guard missingPaths.isEmpty else {
            throw SessionRecoveryPackageReaderError.archiveCorrupt(
                "missing files: \(missingPaths.joined(separator: ", "))"
            )
        }
    }
}
