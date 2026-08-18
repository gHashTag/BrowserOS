// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: L6 SSOT temporarily extended on feat/zai-provider to support the
//         out-of-scope mesh-chat feature. Triage before T27 seal; revert or
//         spec-drive when MeshChat is properly claimed.
// Expires: 2026-12-31
// Follow-up: create separate issue/branch to spec-drive mesh chat URL constants.
import Foundation

/// Centralized path configuration for the Trios project.
/// Eliminates hardcoded strings scattered across the codebase.
enum ProjectPaths {
    /// The root directory of the Trios project.
    /// Defaults to the bundled project path or falls back to the developer path.
    static var root: String {
        // Env override is authoritative.
        if let envRoot = ProcessInfo.processInfo.environment["TRIOS_ROOT"], !envRoot.isEmpty {
            return envRoot
        }
        // Try to find the project relative to the app bundle first.
        // Bundle.main.bundlePath is the .app directory; its parent is the
        // project root when the app is built inside the repository.
        let bundlePath = Bundle.main.bundlePath
        if bundlePath.hasSuffix(".app") {
            let candidate = (bundlePath as NSString).deletingLastPathComponent
            if FileManager.default.fileExists(atPath: "\(candidate)/main.swift") {
                return candidate
            }
        }
        // Fallback for development: current working directory.
        return FileManager.default.currentDirectoryPath
    }

    // MARK: - Subdirectories

    static var brOutput: String { "\(root)/BR-OUTPUT" }
    static var rings: String { "\(root)/rings" }
    static var claude: String { "\(root)/.claude" }
    /// Runtime data root, separated per variant.
    ///
    /// The release app's encrypted memory database, logs, and delegation store
    /// live under `.trinity`. If the dev build wrote there too, an agent
    /// iterating on a schema could corrupt the state of the app the user is
    /// actually using - which is the whole thing the two-variant split exists to
    /// prevent. Dev gets `.trinity-dev`.
    static var trinity: String {
        "\(root)/\(variant.dataDirectoryName)"
    }

    /// The release data root, regardless of the running variant. Only for
    /// tooling that deliberately inspects release state.
    static var releaseTrinity: String { "\(root)/.trinity" }

    // MARK: - Key Files

    static var mainSwift: String { "\(root)/main.swift" }
    static var buildScript: String { "\(root)/build.sh" }
    static var triosBinary: String { "\(root)/trios_app" }
    static var appBundle: String { "\(root)/trios.app" }
    static var logoPNG: String { "\(root)/logo.png" }
    static var logoSVG: String { "\(root)/logo.svg" }

    // MARK: - BrowserOS Agent Server

    /// Agent server root. TriOS owns its agent runtime outright: it lives in
    /// this tree, ships with the app, and is the only copy. There is no longer a
    /// fallback into the BrowserOS monorepo - BrowserOS is reached only through
    /// its localhost MCP endpoints.
    static var browserOSAgentRoot: String { "\(root)/agent-server" }

    /// Entry point the app launches for the bundled agent runtime.
    static var agentServerEntrypoint: String {
        "\(browserOSAgentRoot)/apps/server/src/index.ts"
    }

    /// MCP port from Info.plist (injected at build time via TRIOS_VARIANT).
    ///
    /// The fallback follows the variant rather than naming the release port,
    /// so a bundle that somehow carried a variant but no port would still fail
    /// away from the port the release app is listening on. Colliding there is
    /// the one outcome the two-variant split exists to prevent.
    static var mcpPort: String {
        Bundle.main.infoDictionary?["TRIOS_MCP_PORT"] as? String ?? variant.mcpPort
    }

    /// A2A port from Info.plist
    static var a2aPort: String {
        Bundle.main.infoDictionary?["TRIOS_A2A_PORT"] as? String ?? "9200"
    }

    /// Which variant this process is running as.
    ///
    /// Resolved once, here, and every variant-dependent constant below is asked
    /// of `BuildVariant` rather than spelled out again. Those constants used to
    /// be written a third time in this file, beside the copies in `build.sh` and
    /// in `BuildVariant`; only the copy nobody called was under test.
    ///
    /// The bundle wins wherever there is one, so nothing in the environment can
    /// move a shipped app off its own data directory or onto the release
    /// keychain. The environment is consulted only when there is no bundle to
    /// ask: a CLI tool, or a bare test binary.
    ///
    /// Without that, a standalone test binary reports `prod`, takes the Keychain
    /// path, and blocks inside `SecItemCopyMatching` on a password dialog that
    /// nobody is present to answer. It does not fail - it hangs, which in an
    /// unattended run means the job dies on a timeout having reported nothing.
    /// Two recovery suites were unrunnable for exactly this reason.
    ///
    /// Still `.prod` when neither answers, which is what this file has always
    /// said. Deliberately *not* `BuildVariantPolicy.defaultVariant`: that one is
    /// `.dev` and answers a different question, namely what an unqualified build
    /// should produce. Build-time default and runtime fallback look alike and
    /// are not the same thing.
    static var variant: BuildVariant {
        if let bundled = Bundle.main.infoDictionary?["TRIOS_VARIANT"] as? String,
           let resolved = BuildVariant(rawValue: bundled) {
            return resolved
        }
        let environment = ProcessInfo.processInfo.environment["TRIOS_VARIANT"] ?? ""
        return BuildVariant(rawValue: environment) ?? .prod
    }

    /// True for the development build.
    ///
    /// The dev variant runs beside the release app with its own bundle id,
    /// ports and data directory, so an agent rebuilding it cannot disturb a
    /// working release instance.
    ///
    /// Narrowly "is this the dev supervisor build". For the separate question
    /// "may this build reach the real Keychain" use `usesFileSecretStore`: the
    /// two used to be the same word, and they stopped agreeing the moment a
    /// third variant existed.
    static var isDevVariant: Bool { variant == .dev }

    /// Whether secrets live in files rather than the Keychain - see
    /// DevSecretStore, and `BuildVariant.usesFileSecretStore` for the reasoning.
    static var usesFileSecretStore: Bool { variant.usesFileSecretStore }

    /// Whether this build runs the Queen's delegation inbox. True in every
    /// variant since 2026-08-18; see `BuildVariant.hasSupervisorInbox`.
    static var hasSupervisorInbox: Bool { variant.hasSupervisorInbox }

    /// Whether the Queen picks up work unprompted absent a stored preference.
    static var autonomyDefault: Bool { variant.autonomyDefault }

    /// Build variant as a string, for callers that record or display it.
    ///
    /// Reports what the bundle actually said, not the variant we fell back to.
    /// These differ only for a value `build.sh` refuses to write, and that is
    /// exactly the case worth seeing: a session recovery export or a status line
    /// reading `prod` for a bundle stamped something else would hide the broken
    /// bundle instead of showing it. Behaviour follows `variant`; this field
    /// stays a record of what was found.
    static var buildVariant: String {
        Bundle.main.infoDictionary?["TRIOS_VARIANT"] as? String ?? variant.rawValue
    }

    static var canaryMcpPort: String {
        Bundle.main.infoDictionary?["TRIOS_CANARY_MCP_PORT"] as? String ?? "9205"
    }

    static var meshPort: String {
        Bundle.main.infoDictionary?["TRIOS_MESH_PORT"] as? String ?? "9505"
    }

    static var mcpBaseURL: String { "http://127.0.0.1:\(mcpPort)" }
    static var browserOSHealthURL: String { "\(mcpBaseURL)/health" }
    /// The A2A registry and BrowserOS MCP server share the same loopback port.
    /// `a2aPort` (9200) is not currently served, so the Agent status must probe
    /// the BrowserOS health endpoint on `mcpPort` (9105).
    /// AGENT-V-WAIVER: port-alignment fix (Agent V conditional waiver, 2026-07-27).
    static var agentHealthURL: String { browserOSHealthURL }
    static var canaryHealthURL: String { "http://127.0.0.1:\(canaryMcpPort)/health" }
    static var meshHealthURL: String { "http://127.0.0.1:\(meshPort)/health" }
    static var meshStatusURL: String { "http://127.0.0.1:\(meshPort)/status" }
    static var meshSeedPeerURL: String { "http://127.0.0.1:\(meshPort)/seed-peer" }
    static var meshChatSendURL: String { "http://127.0.0.1:\(meshPort)/messages/send" }
    static var meshChatReceiveURL: String { "http://127.0.0.1:\(meshPort)/messages/receive" }
    static var meshChatAckURL: String { "http://127.0.0.1:\(meshPort)/messages/ack" }
    static var meshChatConversationsURL: String { "http://127.0.0.1:\(meshPort)/conversations" }
    static var meshChatPollURL: String { "http://127.0.0.1:\(meshPort)/messages/poll" }
    static func meshChatMessagesURL(peer: UInt32) -> String { "http://127.0.0.1:\(meshPort)/messages/\(peer)" }
    static var meshChatStoreURL: URL {
        URL(fileURLWithPath: "\(trinity)/mesh_chat/swift_store.json")
    }

    // MARK: - Trinity State

    static var trinityState: String { "\(trinity)/state/last_wake.json" }
    static var trinityLog: String { "\(trinity)/cron.log" }
    static var trinityEventLog: String { "\(trinity)/event_log.jsonl" }

    // MARK: - Helpers

    static func rings(_ subdir: String) -> String {
        "\(root)/rings/\(subdir)"
    }

    static func brOutput(_ file: String) -> String {
        "\(root)/BR-OUTPUT/\(file)"
    }

    static func claude(_ subpath: String) -> String {
        "\(root)/.claude/\(subpath)"
    }

    // MARK: - Runtime State Paths

    static var trinityRun: String { "\(trinity)/run" }
    /// Lock and PID files are per variant, otherwise the dev build would look
    /// like a second instance of the release app and refuse to start.
    static var singletonLockFile: String {
        isDevVariant
            ? "\(trinityRun)/trios_dev_singleton.lock"
            : "\(trinityRun)/trios_singleton.lock"
    }
    static var singletonPIDFile: String {
        isDevVariant
            ? "\(trinityRun)/trios_dev_singleton.pid"
            : "\(trinityRun)/trios_singleton.pid"
    }
    static var bundleIdentifier: String { variant.bundleIdentifier }
}
