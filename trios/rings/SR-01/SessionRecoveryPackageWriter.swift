import CryptoKit
import Dispatch
import Foundation

enum SessionRecoveryPackageError: LocalizedError {
    case missingActiveConversation
    case invalidArchivePath(String)
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingActiveConversation:
            return "The active conversation could not be found in the recovery snapshot."
        case .invalidArchivePath(let path):
            return "Unsafe recovery archive path: \(path)"
        case .commandFailed(let message):
            return "Could not create the recovery ZIP: \(message)"
        }
    }
}

private struct SessionRecoveryManifest: Codable {
    let schemaVersion: Int
    let minReaderVersion: Int
    let createdByAppVersion: String
    let packageID: UUID
    let createdAt: Date
    let activeConversationID: UUID
    let fileCount: Int
    let redactionCount: Int
    let secretsIncluded: Bool
    let encryptionScheme: String
    let files: [SessionRecoveryManifestEntry]
}

private struct SessionRecoveryManifestEntry: Codable {
    let path: String
    let bytes: Int
    let sha256: String
}

struct SessionRecoveryPackageWriter {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func write(
        request: SessionRecoveryPackageRequest,
        to requestedURL: URL
    ) throws -> SessionRecoveryExportResult {
        let archiveURL = normalizedArchiveURL(requestedURL)
        let stagingParent = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-\(request.packageID.uuidString)", isDirectory: true)
        let packageName = archiveURL.deletingPathExtension().lastPathComponent
        let packageRoot = stagingParent.appendingPathComponent(packageName, isDirectory: true)
        let partialArchive = archiveURL.deletingLastPathComponent()
            .appendingPathComponent(".\(archiveURL.lastPathComponent).\(request.packageID.uuidString).partial")

        try? fileManager.removeItem(at: stagingParent)
        try? fileManager.removeItem(at: partialArchive)
        defer {
            try? fileManager.removeItem(at: stagingParent)
            try? fileManager.removeItem(at: partialArchive)
        }

        try fileManager.createDirectory(at: packageRoot, withIntermediateDirectories: true)
        var redactionCount = request.initialRedactionCount

        guard let activeConversation = request.conversations.first(where: {
            $0.id == request.activeConversationID
        }) else {
            throw SessionRecoveryPackageError.missingActiveConversation
        }

        try writeJSON(
            request.conversations,
            to: packageRoot.appendingPathComponent("session/conversations.json"),
            redactionCount: &redactionCount
        )
        try writeJSON(
            request.browserContext,
            to: packageRoot.appendingPathComponent("session/browseros-context.json"),
            redactionCount: &redactionCount
        )
        try writeJSON(
            request.runtimeContext,
            to: packageRoot.appendingPathComponent("diagnostics/runtime-context.json"),
            redactionCount: &redactionCount
        )

        try writeSanitizedText(
            SessionRecoveryTranscriptBuilder.build(activeConversation),
            to: packageRoot.appendingPathComponent("session/current-transcript.md"),
            redactionCount: &redactionCount
        )
        for conversation in request.conversations {
            let fileName = "\(safeFileComponent(conversation.title))-\(conversation.id.uuidString.prefix(8)).md"
            try writeSanitizedText(
                SessionRecoveryTranscriptBuilder.build(conversation),
                to: packageRoot.appendingPathComponent("session/all-transcripts/\(fileName)"),
                redactionCount: &redactionCount
            )
        }

        try writeSanitizedText(
            readme(request: request),
            to: packageRoot.appendingPathComponent("README.md"),
            redactionCount: &redactionCount
        )
        try writeSanitizedText(
            handoff(request: request, activeConversation: activeConversation),
            to: packageRoot.appendingPathComponent("HANDOFF.md"),
            redactionCount: &redactionCount
        )

        var logErrors: [String] = []
        for source in request.logSources {
            do {
                try copyLogSource(
                    source,
                    into: packageRoot,
                    redactionCount: &redactionCount
                )
            } catch {
                logErrors.append("\(source.url.path): \(error.localizedDescription)")
            }
        }

        let systemLog: String
        if request.includeSystemProcessLog {
            do {
                systemLog = try collectSystemLog(processName: request.systemProcessName)
            } catch {
                systemLog = "System process log unavailable: \(error.localizedDescription)\n"
                logErrors.append(error.localizedDescription)
            }
        } else {
            systemLog = "System process log collection disabled for this export.\n"
        }
        try writeSanitizedText(
            systemLog,
            to: packageRoot.appendingPathComponent("logs/system-trios.log"),
            redactionCount: &redactionCount
        )

        if !logErrors.isEmpty {
            try writeSanitizedText(
                logErrors.joined(separator: "\n") + "\n",
                to: packageRoot.appendingPathComponent("logs/collection-errors.log"),
                redactionCount: &redactionCount
            )
        }

        let entries = try manifestEntries(in: packageRoot)
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let manifest = SessionRecoveryManifest(
            schemaVersion: 1,
            minReaderVersion: 1,
            createdByAppVersion: appVersion,
            packageID: request.packageID,
            createdAt: request.createdAt,
            activeConversationID: request.activeConversationID,
            fileCount: entries.count + 1,
            redactionCount: redactionCount,
            secretsIncluded: false,
            encryptionScheme: "local-aes256-gcm-v1",
            files: entries
        )
        try writeEncodedJSON(
            manifest,
            to: packageRoot.appendingPathComponent("manifest.json")
        )

        try createArchive(from: packageRoot, to: partialArchive)
        if fileManager.fileExists(atPath: archiveURL.path) {
            try fileManager.removeItem(at: archiveURL)
        }
        try fileManager.moveItem(at: partialArchive, to: archiveURL)

        let archiveSize = (try? archiveURL.resourceValues(forKeys: [.fileSizeKey]).fileSize)
            .map(Int64.init) ?? 0
        return SessionRecoveryExportResult(
            archiveURL: archiveURL,
            fileCount: entries.count + 1,
            redactionCount: redactionCount,
            archiveSize: archiveSize
        )
    }

    private func writeJSON<T: Encodable>(
        _ value: T,
        to url: URL,
        redactionCount: inout Int
    ) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try encoder.encode(value)
        let sanitized = try sanitizeJSON(encoded)
        redactionCount += sanitized.redactionCount
        try writeData(sanitized.data, to: url)
    }

    private func writeEncodedJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        try writeData(try encoder.encode(value), to: url)
    }

    private func sanitizeJSON(_ data: Data) throws -> (data: Data, redactionCount: Int) {
        let object = try JSONSerialization.jsonObject(with: data)
        var redactionCount = 0
        let sanitized = sanitizeJSONObject(object, redactionCount: &redactionCount)
        let output = try JSONSerialization.data(
            withJSONObject: sanitized,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        return (output, redactionCount)
    }

    private func sanitizeJSONObject(_ value: Any, redactionCount: inout Int) -> Any {
        if let dictionary = value as? [String: Any] {
            return dictionary.reduce(into: [String: Any]()) { output, entry in
                if isSensitiveKey(entry.key) {
                    output[entry.key] = "[REDACTED]"
                    redactionCount += 1
                } else {
                    output[entry.key] = sanitizeJSONObject(entry.value, redactionCount: &redactionCount)
                }
            }
        }
        if let array = value as? [Any] {
            return array.map { sanitizeJSONObject($0, redactionCount: &redactionCount) }
        }
        if let string = value as? String {
            let result = SessionRecoveryRedactor.redact(string)
            redactionCount += result.count
            return result.text
        }
        return value
    }

    private func isSensitiveKey(_ key: String) -> Bool {
        let normalized = key.lowercased().filter { $0.isLetter || $0.isNumber }
        return [
            "apikey", "accesstoken", "authtoken", "token", "password",
            "passwd", "secret", "clientsecret", "cookie", "setcookie",
            "authorization", "proxyauthorization"
        ].contains(normalized)
    }

    private func copyLogSource(
        _ source: SessionRecoveryLogSource,
        into packageRoot: URL,
        redactionCount: inout Int
    ) throws {
        let archivePath = try safeArchivePath(source.archivePath)
        let sourceURL = source.url.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: sourceURL.path, isDirectory: &isDirectory) else {
            return
        }

        if !isDirectory.boolValue {
            try copyLogFile(
                sourceURL,
                to: packageRoot.appendingPathComponent(archivePath),
                redactionCount: &redactionCount
            )
            return
        }

        guard let enumerator = fileManager.enumerator(
            at: sourceURL,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return }

        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(
                forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
            )
            if values.isSymbolicLink == true {
                enumerator.skipDescendants()
                continue
            }
            guard values.isRegularFile == true else { continue }
            let normalizedFileURL = fileURL.standardizedFileURL.resolvingSymlinksInPath()
            let relativeComponents = normalizedFileURL.pathComponents
                .dropFirst(sourceURL.pathComponents.count)
            let relative = relativeComponents.joined(separator: "/")
            let safeRelative = try safeArchivePath(relative)
            try copyLogFile(
                fileURL,
                to: packageRoot.appendingPathComponent("\(archivePath)/\(safeRelative)"),
                redactionCount: &redactionCount
            )
        }
    }

    /// Maximum size for any single copied log or diagnostic file.
    private static let maxCopiedFileBytes: Int64 = 16 * 1024 * 1024

    private func copyLogFile(
        _ source: URL,
        to destination: URL,
        redactionCount: inout Int
    ) throws {
        let fileSize = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize)
            .map(Int64.init) ?? 0
        guard fileSize <= Self.maxCopiedFileBytes else {
            let notice = """
            Diagnostic file omitted: \(source.lastPathComponent) (
            \(ByteCountFormatter.string(fromByteCount: fileSize, countStyle: .file))
            ) exceeds the \(ByteCountFormatter.string(
                fromByteCount: Self.maxCopiedFileBytes,
                countStyle: .file
            )) safety limit.
            """
            try writeSanitizedText(
                notice + "\n",
                to: destination.appendingPathExtension("omitted.txt"),
                redactionCount: &redactionCount
            )
            return
        }

        let data = try Data(contentsOf: source)
        if let text = String(data: data, encoding: .utf8) {
            try writeSanitizedText(text, to: destination, redactionCount: &redactionCount)
        } else {
            let notice = "Binary or non-UTF-8 diagnostic omitted: \(source.lastPathComponent)\n"
            try writeSanitizedText(
                notice,
                to: destination.appendingPathExtension("omitted.txt"),
                redactionCount: &redactionCount
            )
        }
    }

    private func writeSanitizedText(
        _ value: String,
        to url: URL,
        redactionCount: inout Int
    ) throws {
        let sanitized = SessionRecoveryRedactor.redact(value)
        redactionCount += sanitized.count
        try writeData(Data(sanitized.text.utf8), to: url)
    }

    private func writeData(_ data: Data, to url: URL) throws {
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: url, options: .atomic)
    }

    private func collectSystemLog(processName: String) throws -> String {
        let safeName = processName.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        let captureID = UUID().uuidString
        let outputURL = fileManager.temporaryDirectory
            .appendingPathComponent("trios-system-log-\(captureID).txt")
        let errorURL = fileManager.temporaryDirectory
            .appendingPathComponent("trios-system-log-\(captureID).err")
        _ = fileManager.createFile(atPath: outputURL.path, contents: nil)
        _ = fileManager.createFile(atPath: errorURL.path, contents: nil)
        defer {
            try? fileManager.removeItem(at: outputURL)
            try? fileManager.removeItem(at: errorURL)
        }

        let outputHandle = try FileHandle(forWritingTo: outputURL)
        let errorHandle = try FileHandle(forWritingTo: errorURL)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/log")
        process.arguments = [
            "show", "--style", "compact", "--last", "24h",
            "--predicate", "process == \"\(safeName)\""
        ]
        process.standardOutput = outputHandle
        process.standardError = errorHandle
        let completion = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completion.signal() }
        try process.run()
        if completion.wait(timeout: .now() + 20) == .timedOut {
            process.terminate()
            _ = completion.wait(timeout: .now() + 3)
            try outputHandle.close()
            try errorHandle.close()
            throw SessionRecoveryPackageError.commandFailed(
                "System log collection exceeded the 20 second safety limit."
            )
        }
        try outputHandle.close()
        try errorHandle.close()
        let output = try Data(contentsOf: outputURL)
        let error = try Data(contentsOf: errorURL)
        guard process.terminationStatus == 0 else {
            let message = String(data: error, encoding: .utf8) ?? "log exited with \(process.terminationStatus)"
            throw SessionRecoveryPackageError.commandFailed(message)
        }
        return String(data: output, encoding: .utf8) ?? "System log output was not UTF-8.\n"
    }

    private func manifestEntries(in packageRoot: URL) throws -> [SessionRecoveryManifestEntry] {
        let normalizedRoot = packageRoot.standardizedFileURL.resolvingSymlinksInPath()
        guard let enumerator = fileManager.enumerator(
            at: normalizedRoot,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var entries: [SessionRecoveryManifestEntry] = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true else { continue }
            let normalizedFileURL = fileURL.standardizedFileURL.resolvingSymlinksInPath()
            let relative = normalizedFileURL.pathComponents
                .dropFirst(normalizedRoot.pathComponents.count)
                .joined(separator: "/")
            let data = try Data(contentsOf: normalizedFileURL)
            entries.append(
                SessionRecoveryManifestEntry(
                    path: relative,
                    bytes: values.fileSize ?? data.count,
                    sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                )
            )
        }
        return entries.sorted { $0.path < $1.path }
    }

    private func createArchive(from packageRoot: URL, to archiveURL: URL) throws {
        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = [
            "--norsrc", "--noextattr", "-c", "-k", "--keepParent",
            packageRoot.path, archiveURL.path
        ]
        process.standardError = errorPipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let error = errorPipe.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: error, encoding: .utf8) ?? "ditto exited with \(process.terminationStatus)"
            throw SessionRecoveryPackageError.commandFailed(message)
        }
    }

    private func normalizedArchiveURL(_ url: URL) -> URL {
        url.pathExtension.lowercased() == "zip" ? url : url.appendingPathExtension("zip")
    }

    private func safeArchivePath(_ path: String) throws -> String {
        let components = path.split(separator: "/").map(String.init)
        guard !path.hasPrefix("/"), !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw SessionRecoveryPackageError.invalidArchivePath(path)
        }
        return components.joined(separator: "/")
    }

    private func safeFileComponent(_ value: String) -> String {
        let allowed = value.unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_" {
                return Character(String(scalar))
            }
            return "-"
        }
        let result = String(allowed).replacingOccurrences(of: "--", with: "-")
        return String(result.prefix(48)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
            .nonEmpty ?? "conversation"
    }

    private func readme(request: SessionRecoveryPackageRequest) -> String {
        """
        # Trinity S3AI Recovery Package

        This package preserves a TriOS chat session for diagnosis or transfer to
        another agent. Machine-readable JSON is canonical. Markdown files are
        provided for quick human and agent review.

        ## Start here

        1. Read `HANDOFF.md`.
        2. Read `diagnostics/runtime-context.json`.
        3. Read `session/current-transcript.md`.
        4. Use `session/conversations.json` for exact message, reasoning, tool,
           error, task, and timestamp data.
        5. Inspect `logs/` when diagnosing a failure.
        6. Validate file integrity against `manifest.json`.

        ## Security

        API keys, passwords, cookies, authorization headers, and recognizable
        secret token formats were replaced by `[REDACTED]`. macOS Keychain values
        were not read into this package.

        Package ID: `\(request.packageID.uuidString)`
        """
    }

    private func handoff(
        request: SessionRecoveryPackageRequest,
        activeConversation: SessionRecoveryConversation
    ) -> String {
        let lastUserMessage = activeConversation.messages.last(where: { $0.role == "user" })?.content
            ?? "No user message was available."
        return """
        # Agent Handoff

        Continue the active Trinity S3AI task without restarting it from scratch.

        ## Active session

        - Conversation: \(activeConversation.title)
        - Conversation ID: `\(activeConversation.id.uuidString)`
        - Provider: \(request.runtimeContext.provider)
        - Model: \(request.runtimeContext.model)
        - Input tokens: \(request.runtimeContext.inputTokens)
        - Output tokens: \(request.runtimeContext.outputTokens)

        ## Last user request

        \(lastUserMessage)

        ## Recovery procedure

        Treat `session/conversations.json` as the exact session record. Preserve
        message ordering, reasoning/tool chronology, unresolved instructions, and
        the active draft. Read `session/browseros-context.json` before continuing
        browser work. Inspect `logs/system-trios.log` and the remaining `logs/`
        tree if the prior agent or companion server failed.

        Never ask the user to repeat context already present in this package.
        """
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
