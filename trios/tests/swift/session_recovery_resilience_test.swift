import Foundation

@main
struct SessionRecoveryResilienceTest {
    static func main() throws {
        try testManifestVerification()
        try testMissingManifest()
        try testUnsupportedSchemaVersion()
        try testLargeLogFilePlaceholder()
        print("All SessionRecoveryResilience tests passed.")
    }

    private static func testManifestVerification() throws {
        let fileManager = FileManager.default
        let testRoot = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-verify-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: testRoot) }
        try fileManager.createDirectory(at: testRoot, withIntermediateDirectories: true)

        let logRoot = testRoot.appendingPathComponent("source-logs", isDirectory: true)
        try fileManager.createDirectory(at: logRoot, withIntermediateDirectories: true)
        try Data("server ok\n".utf8)
            .write(to: logRoot.appendingPathComponent("sample.log"))

        let conversationID = UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        let conversation = SessionRecoveryConversation(
            id: conversationID,
            title: "Verify test",
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            messages: [
                SessionRecoveryMessage(
                    id: UUID(),
                    role: "user",
                    content: "hello",
                    timestamp: Date(timeIntervalSince1970: 1_700_000_000),
                    isStreaming: false
                )
            ]
        )
        let runtime = SessionRecoveryRuntimeContext(
            appName: "Trinity S3AI",
            appVersion: "1.0.0",
            buildVariant: "test",
            osVersion: "testOS",
            projectRoot: "/project",
            activeConversationID: conversationID,
            provider: "Ollama",
            model: "qwen3.5:cloud",
            baseURL: "http://127.0.0.1:11434/v1",
            credentialStatus: "No API key required",
            inputTokens: 10,
            outputTokens: 20,
            includesEstimate: false,
            triosServerReachable: true,
            browserOSConnected: true,
            cdpPort: "9102",
            draft: "",
            encryptionScheme: "local-aes256-gcm-v1",
            encryptionKeyPath: "~/Library/Application Support/trios/conversation.key"
        )
        let request = SessionRecoveryPackageRequest(
            packageID: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
            createdAt: Date(timeIntervalSince1970: 1_700_000_001),
            activeConversationID: conversationID,
            conversations: [conversation],
            browserContext: SessionRecoveryBrowserContext(
                status: "alive",
                pageID: 7,
                messages: [],
                toolCalls: []
            ),
            runtimeContext: runtime,
            initialRedactionCount: 0,
            logSources: [
                SessionRecoveryLogSource(url: logRoot, archivePath: "logs/test")
            ],
            includeSystemProcessLog: false
        )
        let requestedURL = testRoot.appendingPathComponent("recovery.zip")
        // The writer normalises whatever it is handed to .triosrecovery and its
        // result does not report where the file landed, so the caller has to
        // apply the same rule to find it.
        let archiveURL = requestedURL.appendingPathExtension("triosrecovery")
        let result = try SessionRecoveryPackageWriter().write(request: request, to: requestedURL)
        expect(result.fileCount > 0, "archive produced files")

        let extracted = testRoot.appendingPathComponent("extracted", isDirectory: true)
        try fileManager.createDirectory(at: extracted, withIntermediateDirectories: true)
        try extractArchive(archiveURL, to: extracted)
        let packageRoot = try firstDirectory(in: extracted)
        let manifestPath = packageRoot.appendingPathComponent("manifest.json").path
        expect(fileManager.fileExists(atPath: manifestPath), "manifest exists")

        let readResult = try SessionRecoveryPackageReader.read(from: archiveURL)
        expect(readResult.packageID == request.packageID, "reader returns package id")
        expect(readResult.conversations.count == 1, "reader returns conversation")

        // Corrupt a file and verify checksum mismatch.
        let conversationsPath = packageRoot.appendingPathComponent("session/conversations.json")
        try "corrupted".write(toFile: conversationsPath.path, atomically: true, encoding: .utf8)
        let reArchive = testRoot.appendingPathComponent("corrupted.zip")
        try createArchive(from: packageRoot, to: reArchive)

        do {
            _ = try SessionRecoveryPackageReader.read(from: reArchive)
            expect(false, "corrupted archive should fail integrity check")
        } catch let error as SessionRecoveryPackageReaderError {
            switch error {
            case .checksumMismatch(let path, _, _),
                 .fileSizeMismatch(let path, _, _):
                expect(path.contains("conversations.json"), "integrity failure names path")
            default:
                expect(false, "expected integrity failure, got \(error)")
            }
        }
    }

    private static func testMissingManifest() throws {
        let fileManager = FileManager.default
        let testRoot = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-missing-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: testRoot) }
        try fileManager.createDirectory(at: testRoot, withIntermediateDirectories: true)

        let packageRoot = testRoot.appendingPathComponent("Trinity-Recovery-test", isDirectory: true)
        try fileManager.createDirectory(at: packageRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: packageRoot.appendingPathComponent("session"), withIntermediateDirectories: true)
        try Data("[]".utf8).write(to: packageRoot.appendingPathComponent("session/conversations.json"))
        let archiveURL = testRoot.appendingPathComponent("missing-manifest.zip")
        try createArchive(from: packageRoot, to: archiveURL)

        do {
            _ = try SessionRecoveryPackageReader.read(from: archiveURL)
            expect(false, "missing manifest should fail")
        } catch let error as SessionRecoveryPackageReaderError {
            switch error {
            case .manifestFileMissing:
                break
            default:
                expect(false, "expected manifestFileMissing, got \(error)")
            }
        }
    }

    private static func testUnsupportedSchemaVersion() throws {
        let fileManager = FileManager.default
        let testRoot = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-version-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: testRoot) }
        try fileManager.createDirectory(at: testRoot, withIntermediateDirectories: true)

        let packageRoot = testRoot.appendingPathComponent("Trinity-Recovery-test", isDirectory: true)
        try fileManager.createDirectory(at: packageRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: packageRoot.appendingPathComponent("session"), withIntermediateDirectories: true)
        let manifest: [String: Any] = [
            "schemaVersion": 2,
            "minReaderVersion": 99,
            "createdByAppVersion": "999.0.0",
            "packageID": UUID().uuidString,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "activeConversationID": UUID().uuidString,
            "fileCount": 2,
            "redactionCount": 0,
            "secretsIncluded": false,
            "encryptionScheme": "local-aes256-gcm-v1",
            "files": []
        ]
        let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try manifestData.write(to: packageRoot.appendingPathComponent("manifest.json"))
        try Data("[]".utf8).write(to: packageRoot.appendingPathComponent("session/conversations.json"))
        let archiveURL = testRoot.appendingPathComponent("future-version.zip")
        try createArchive(from: packageRoot, to: archiveURL)

        do {
            _ = try SessionRecoveryPackageReader.read(from: archiveURL)
            expect(false, "future schema should fail")
        } catch let error as SessionRecoveryPackageReaderError {
            switch error {
            case .unsupportedSchemaVersion(let version):
                expect(version == 99, "unsupported version is 99")
            default:
                expect(false, "expected unsupportedSchemaVersion, got \(error)")
            }
        }
    }

    private static func testLargeLogFilePlaceholder() throws {
        let fileManager = FileManager.default
        let testRoot = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-large-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: testRoot) }
        try fileManager.createDirectory(at: testRoot, withIntermediateDirectories: true)

        let logRoot = testRoot.appendingPathComponent("source-logs", isDirectory: true)
        try fileManager.createDirectory(at: logRoot, withIntermediateDirectories: true)
        let bigContent = String(repeating: "x", count: 17 * 1024 * 1024)
        try Data(bigContent.utf8).write(to: logRoot.appendingPathComponent("big.log"))

        let conversationID = UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        let request = SessionRecoveryPackageRequest(
            packageID: UUID(),
            activeConversationID: conversationID,
            conversations: [
                SessionRecoveryConversation(
                    id: conversationID,
                    title: "Large log test",
                    updatedAt: Date(),
                    messages: []
                )
            ],
            browserContext: SessionRecoveryBrowserContext(status: "alive", pageID: nil, messages: [], toolCalls: []),
            runtimeContext: SessionRecoveryRuntimeContext(
                appName: "TriOS",
                appVersion: "1.0",
                buildVariant: "test",
                osVersion: "testOS",
                projectRoot: "/project",
                activeConversationID: conversationID,
                provider: "Ollama",
                model: "qwen3.5:cloud",
                baseURL: "http://127.0.0.1:11434/v1",
                credentialStatus: "none",
                inputTokens: 0,
                outputTokens: 0,
                includesEstimate: false,
                triosServerReachable: true,
                browserOSConnected: true,
                cdpPort: "9102",
                draft: ""
            ),
            initialRedactionCount: 0,
            logSources: [SessionRecoveryLogSource(url: logRoot, archivePath: "logs/test")],
            includeSystemProcessLog: false
        )
        let requestedURL = testRoot.appendingPathComponent("large.zip")
        let archiveURL = requestedURL.appendingPathExtension("triosrecovery")
        _ = try SessionRecoveryPackageWriter().write(request: request, to: requestedURL)

        let extracted = testRoot.appendingPathComponent("extracted", isDirectory: true)
        try fileManager.createDirectory(at: extracted, withIntermediateDirectories: true)
        try extractArchive(archiveURL, to: extracted)
        let packageRoot = try firstDirectory(in: extracted)
        let omittedPath = packageRoot.appendingPathComponent("logs/test/big.log.omitted.txt")
        expect(fileManager.fileExists(atPath: omittedPath.path), "large log omitted note exists")
        let note = try String(contentsOf: omittedPath, encoding: .utf8)
        expect(note.contains("exceeds"), "omitted note explains size limit")
    }

    /// Decrypts a writer-produced package, then unzips it.
    ///
    /// Only ever called on writer output, which is always encrypted, so the
    /// decrypt is unconditional. `createArchive` below deliberately builds
    /// plaintext zips for the legacy-format tests, and those go straight to
    /// SessionRecoveryPackageReader rather than through here - that path is how
    /// backward compatibility with pre-encryption packages stays covered.
    private static func extractArchive(_ archive: URL, to destination: URL) throws {
        let plaintext = try TriOSEncryption.recovery.decrypt(Data(contentsOf: archive))
        let zipURL = destination.appendingPathComponent("archive.zip")
        try plaintext.write(to: zipURL, options: .atomic)
        defer { try? FileManager.default.removeItem(at: zipURL) }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", zipURL.path, destination.path]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw NSError(domain: "SessionRecoveryResilienceTest", code: Int(process.terminationStatus))
        }
    }

    private static func createArchive(from packageRoot: URL, to archiveURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = [
            "--norsrc", "--noextattr", "-c", "-k", "--keepParent",
            packageRoot.path, archiveURL.path
        ]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw NSError(domain: "SessionRecoveryResilienceTest", code: Int(process.terminationStatus))
        }
    }

    private static func firstDirectory(in root: URL) throws -> URL {
        let values = try FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        if let directory = values.first(where: {
            (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }) {
            return directory
        }
        throw NSError(domain: "SessionRecoveryResilienceTest", code: 2)
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
