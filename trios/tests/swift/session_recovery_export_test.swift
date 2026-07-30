import CryptoKit
import Foundation

@main
struct SessionRecoveryExportTest {
    static func main() throws {
        testRedactionPatterns()
        try testMessageSanitizationAndTranscript()
        testActiveConversationMerge()
        testPortableFileName()
        try testPackageWriter()
        print("All SessionRecoveryExport tests passed.")
    }

    private static func testRedactionPatterns() {
        let source = """
        Authorization: Bearer sk-proj-1234567890abcdefghijkl
        {"api_key":"sk-ant-api03-abcdefghijklmnopqrstuvwxyz","password":"hunter2"}
        OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz
        Cookie: session=super-secret-cookie
        github=ghp_abcdefghijklmnopqrstuvwxyz1234567890
        https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getMe
        ordinary model=qwen3.5:cloud
        """

        let result = SessionRecoveryRedactor.redact(source)
        expect(!result.text.contains("sk-proj-"), "OpenAI-style key removed")
        expect(!result.text.contains("sk-ant-"), "Anthropic-style key removed")
        expect(!result.text.contains("sk-or-v1-"), "OpenRouter-style key removed")
        expect(!result.text.contains("hunter2"), "password removed")
        expect(!result.text.contains("super-secret-cookie"), "cookie removed")
        expect(!result.text.contains("ghp_"), "GitHub token removed")
        expect(!result.text.contains("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), "Telegram bot token removed")
        expect(result.text.contains("qwen3.5:cloud"), "ordinary text preserved")
        expect(result.count >= 7, "redactions counted")

        let repeated = SessionRecoveryRedactor.redact(result.text)
        expect(repeated.text == result.text, "redaction is stable when repeated")
        expect(repeated.count == 0, "redaction marker is not counted as another secret")
    }

    private static func testMessageSanitizationAndTranscript() throws {
        let secret = "sk-proj-1234567890abcdefghijkl"
        let message = SessionRecoveryMessage(
            id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!,
            role: "assistant",
            content: "Completed with \(secret)",
            timestamp: Date(timeIntervalSince1970: 1_700_000_000),
            isStreaming: false,
            segments: [
                SessionRecoverySegment(kind: "reasoning", text: "Use token \(secret)"),
                SessionRecoverySegment(kind: "toolInput", name: "filesystem_read", arguments: "{\"apiKey\":\"\(secret)\"}"),
                SessionRecoverySegment(kind: "toolOutput", name: "filesystem_read", result: "Authorization: Bearer \(secret)"),
                SessionRecoverySegment(kind: "error", text: "password=\(secret)")
            ],
            toolCalls: [
                SessionRecoveryToolCall(
                    id: "tool-1",
                    name: "filesystem_read",
                    arguments: "{\"token\":\"\(secret)\"}",
                    output: "Cookie: auth=\(secret)",
                    isComplete: true
                )
            ],
            task: SessionRecoveryTask(
                id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
                title: "Recover session",
                description: "Do not expose \(secret)",
                state: "inProgress",
                priority: 2,
                assignee: "agent-codex",
                createdAt: "2026-07-22T12:00:00Z",
                updatedAt: "2026-07-22T12:01:00Z"
            )
        )

        let sanitized = SessionRecoverySanitizer.sanitize(message)
        let encoded = try JSONEncoder().encode(sanitized.value)
        let json = String(decoding: encoded, as: UTF8.self)
        expect(!json.contains(secret), "message tree sanitized")
        expect(sanitized.redactionCount >= 7, "nested message redactions counted")

        let conversation = SessionRecoveryConversation(
            id: UUID(uuidString: "99999999-8888-7777-6666-555555555555")!,
            title: "Recovery test",
            updatedAt: message.timestamp,
            messages: [sanitized.value]
        )
        let transcript = SessionRecoveryTranscriptBuilder.build(conversation)
        expect(transcript.contains("## Assistant"), "assistant transcript section")
        expect(transcript.contains("### Reasoning"), "reasoning transcript section")
        expect(transcript.contains("### Tool request: filesystem_read"), "tool request transcript section")
        expect(transcript.contains("### Tool result: filesystem_read"), "tool result transcript section")
        expect(transcript.contains("### Error"), "error transcript section")
        expect(transcript.contains("### Agent task"), "task transcript section")
    }

    private static func testActiveConversationMerge() {
        let activeID = UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        let otherID = UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!
        let oldActive = SessionRecoveryConversation(
            id: activeID,
            title: "Old",
            updatedAt: Date(timeIntervalSince1970: 1),
            messages: []
        )
        let other = SessionRecoveryConversation(
            id: otherID,
            title: "Other",
            updatedAt: Date(timeIntervalSince1970: 2),
            messages: []
        )
        let liveActive = SessionRecoveryConversation(
            id: activeID,
            title: "Live",
            updatedAt: Date(timeIntervalSince1970: 3),
            messages: [
                SessionRecoveryMessage(
                    id: UUID(),
                    role: "user",
                    content: "latest",
                    timestamp: Date(timeIntervalSince1970: 3),
                    isStreaming: false
                )
            ]
        )

        let merged = SessionRecoveryConversationMerger.merge(
            persisted: [oldActive, other],
            active: liveActive
        )
        expect(merged.count == 2, "active conversation is not duplicated")
        expect(merged.first?.id == activeID, "active conversation is first")
        expect(merged.first?.title == "Live", "live conversation replaces persisted copy")
        expect(merged.first?.messages.first?.content == "latest", "live messages win")
    }

    private static func testPortableFileName() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let name = SessionRecoveryPackageNaming.fileName(date: date)
        expect(name.hasPrefix("Trinity-Recovery-"), "portable filename prefix")
        // Not .zip. The package stopped being a plain archive when it started
        // being encrypted, and naming an AES-GCM blob .zip invites Archive
        // Utility to open it and fail in a way that looks like corruption.
        // SessionRecoveryPackageReader still reads legacy plaintext .zip files,
        // so old packages keep working; only what we write changed.
        expect(name.hasSuffix(".triosrecovery"), "portable filename extension")
        expect(!name.contains(":"), "portable filename excludes colon")
        expect(!name.contains(" "), "portable filename excludes spaces")
    }

    private static func testPackageWriter() throws {
        let fileManager = FileManager.default
        let testRoot = fileManager.temporaryDirectory
            .appendingPathComponent("trios-recovery-test-\(UUID().uuidString)", isDirectory: true)
        let keepArtifacts = ProcessInfo.processInfo.environment["KEEP_RECOVERY_TEST"] == "1"
        defer {
            if !keepArtifacts { try? fileManager.removeItem(at: testRoot) }
        }
        if keepArtifacts { print("Recovery test root: \(testRoot.path)") }
        try fileManager.createDirectory(at: testRoot, withIntermediateDirectories: true)

        let logRoot = testRoot.appendingPathComponent("source-logs", isDirectory: true)
        try fileManager.createDirectory(at: logRoot, withIntermediateDirectories: true)
        let secret = "sk-proj-1234567890abcdefghijkl"
        try Data("Authorization: Bearer \(secret)\nserver ok\n".utf8)
            .write(to: logRoot.appendingPathComponent("sample.log"))

        let conversationID = UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        let conversation = SessionRecoveryConversation(
            id: conversationID,
            title: "Export test",
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
            messages: [
                SessionRecoveryMessage(
                    id: UUID(),
                    role: "user",
                    content: "Continue the task",
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
            draft: ""
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
        // Deliberately request a .zip. The writer normalises any other
        // extension to .triosrecovery, so asking for the wrong one and checking
        // where the file actually landed is the only way this test covers that
        // rule - and the rule is easy to trip over, because `write` returns a
        // result that does not carry the final URL. A caller who wants to reveal
        // the file in Finder has to re-derive the normalisation, exactly as this
        // test now does.
        let requestedURL = testRoot.appendingPathComponent("recovery.zip")
        let archiveURL = requestedURL.appendingPathExtension("triosrecovery")
        let result = try SessionRecoveryPackageWriter().write(request: request, to: requestedURL)
        expect(
            !fileManager.fileExists(atPath: requestedURL.path),
            "writer does not leave a file at the un-normalised path"
        )
        expect(fileManager.fileExists(atPath: archiveURL.path), "archive written")
        expect(result.fileCount >= 8, "archive reports detailed files")
        expect(result.redactionCount >= 1, "archive reports log redaction")

        let extracted = testRoot.appendingPathComponent("extracted", isDirectory: true)
        try fileManager.createDirectory(at: extracted, withIntermediateDirectories: true)
        try extractArchive(archiveURL, to: extracted)
        let packageRoot = try firstDirectory(in: extracted)
        let required = [
            "README.md",
            "HANDOFF.md",
            "manifest.json",
            "session/conversations.json",
            "session/current-transcript.md",
            "session/browseros-context.json",
            "diagnostics/runtime-context.json",
            "logs/test/sample.log"
        ]
        for path in required {
            expect(
                fileManager.fileExists(atPath: packageRoot.appendingPathComponent(path).path),
                "archive contains \(path)"
            )
        }

        let copiedLog = try String(
            contentsOf: packageRoot.appendingPathComponent("logs/test/sample.log"),
            encoding: .utf8
        )
        expect(!copiedLog.contains(secret), "copied logs are sanitized")
        expect(copiedLog.contains("[REDACTED]"), "copied logs retain redaction marker")

        let manifest = try String(
            contentsOf: packageRoot.appendingPathComponent("manifest.json"),
            encoding: .utf8
        )
        expect(manifest.contains("sha256"), "manifest contains checksums")
        expect(manifest.contains("session/conversations.json"), "manifest inventories session JSON")

        let manifestData = Data(manifest.utf8)
        let manifestObject = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
        let entries = manifestObject?["files"] as? [[String: Any]] ?? []
        expect(!entries.isEmpty, "manifest has file entries")
        for entry in entries {
            guard let path = entry["path"] as? String,
                  let expectedHash = entry["sha256"] as? String else {
                expect(false, "manifest entry shape")
                continue
            }
            let fileURL = packageRoot.appendingPathComponent(path)
            expect(fileManager.fileExists(atPath: fileURL.path), "manifest path resolves: \(path)")
            guard let data = try? Data(contentsOf: fileURL) else { continue }
            let actualHash = SHA256.hash(data: data)
                .map { String(format: "%02x", $0) }
                .joined()
            expect(actualHash == expectedHash, "manifest checksum matches: \(path)")
        }
    }

    /// Decrypts the package, then unzips it.
    ///
    /// `ditto` reads zips, and the package stopped being one when it started
    /// being encrypted - it fails with "Couldn't read PKZip signature", which
    /// reads like a corrupt archive rather than an encrypted one. The decrypt
    /// step is unconditional because the writer normalises every path it is
    /// given to `.triosrecovery`; branching on the extension here would copy
    /// SessionRecoveryPackageReader's rule into a second place where it could
    /// drift, and this test has already been bitten once by exactly that.
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
            throw NSError(domain: "SessionRecoveryExportTest", code: Int(process.terminationStatus))
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
        throw NSError(domain: "SessionRecoveryExportTest", code: 2)
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
