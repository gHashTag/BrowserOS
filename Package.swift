// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TriOS",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "TriOSKit", targets: ["TriOSKit"]),
    ],
    targets: [
        .systemLibrary(
            name: "CSQLCipher",
            pkgConfig: "sqlcipher",
            providers: [.brew(["sqlcipher"])]
        ),
        .target(
            name: "TriOSKit",
            dependencies: ["CSQLCipher"],
            path: "trios",
            sources: [
                // ONE LIST, READ RATHER THAN COPIED.
                //
                // This set must equal what `TRIOS_PRINT_SOURCES=1 trios/build.sh`
                // prints, and `make sources-drift` fails the build when it does
                // not. It is a literal here because a manifest is data other
                // tools parse; build.sh is the list of record.
                //
                // It was not always checked, and by the time it was the two had
                // drifted by 46 paths - 45 of them unintended, the 46th being
                // main.swift, which can never be here. That did not read as a
                // missing file. It read as SwiftPM stopping at "Emitting module
                // TriOSKit" with `cannot find type SessionGuard in scope`, so
                // the whole XCTest suite had never compiled once.
                //
                // The three ring directories are entries, not file lists, so a
                // new rings/SR-0x file needs no edit here - build.sh takes them
                // with `find` and this takes the directory. A NEW ring
                // DIRECTORY does need an entry, and sources-drift is what says
                // so.
                "rings/SR-00",
                "rings/SR-01",
                "rings/SR-02",
                "BR-OUTPUT/A2AMessageRouter.swift",
                "BR-OUTPUT/BrowserOSChatViewModel.swift",
                "BR-OUTPUT/ChatLogic.swift",
                "BR-OUTPUT/ChatSidebarView.swift",
                "BR-OUTPUT/CladeGuard.swift",
                "BR-OUTPUT/GitButlerPanelView.swift",
                "BR-OUTPUT/GitButlerViewModel.swift",
                "BR-OUTPUT/GitHubAPIClient.swift",
                "BR-OUTPUT/GitHubDashboardView.swift",
                "BR-OUTPUT/GitHubModels.swift",
                "BR-OUTPUT/GitWorkspaceView.swift",
                "BR-OUTPUT/GlassmorphismBackground.swift",
                "BR-OUTPUT/HotkeyBar.swift",
                "BR-OUTPUT/LLMClient.swift",
                "BR-OUTPUT/LogsTabView.swift",
                "BR-OUTPUT/MeshAuth.swift",
                "BR-OUTPUT/MeshChatListView.swift",
                "BR-OUTPUT/MeshChatModels.swift",
                "BR-OUTPUT/MeshChatThreadView.swift",
                "BR-OUTPUT/MeshChatView.swift",
                "BR-OUTPUT/MeshChatViewModel.swift",
                "BR-OUTPUT/MeshModels.swift",
                "BR-OUTPUT/MeshStatusViewModel.swift",
                "BR-OUTPUT/MeshTabView.swift",
                "BR-OUTPUT/MessageBubbleView.swift",
                "BR-OUTPUT/ModelsTabView.swift",
                "BR-OUTPUT/ProjectPaths.swift",
                "BR-OUTPUT/QueenCompactSupervisorBar.swift",
                "BR-OUTPUT/QueenDashboardView.swift",
                "BR-OUTPUT/QueenQuickActionsSheet.swift",
                "BR-OUTPUT/QueenStatusBadge.swift",
                "BR-OUTPUT/QueenStatusViewModel.swift",
                "BR-OUTPUT/QueenTaskStatusView.swift",
                "BR-OUTPUT/RecursionGuard.swift",
                "BR-OUTPUT/RichTextRenderer.swift",
                "BR-OUTPUT/ServerManager.swift",
                "BR-OUTPUT/SessionGuard.swift",
                "BR-OUTPUT/SkillsTabView.swift",
                "BR-OUTPUT/SmoothStreamingEnhancements.swift",
                "BR-OUTPUT/TODOAnimations.swift",
                "BR-OUTPUT/TODOListView.swift",
                "BR-OUTPUT/TerminalTabView.swift",
                "BR-OUTPUT/ToolCallCardView.swift",
                "BR-OUTPUT/TriosMCPClient.swift",
                "BR-OUTPUT/TriosTheme.swift",
                "BR-OUTPUT/TypingIndicatorView.swift",
                "BR-OUTPUT/WindowManager.swift",
                // "BR-OUTPUT/HotkeyAnalytics.swift" used to sit here, as the one
                // entry this manifest had and build.sh did not, so that
                // HotkeyAnalyticsEncryptionTests could see the type it asserts
                // is encrypted at rest. The file was deleted in 939028c91
                // ("remove 16 non-whitelisted BR-OUTPUT prototypes") and the
                // entry stayed. SwiftPM does not fail on a source that is not
                // there - it prints `Invalid Source ...: File not found.` as a
                // WARNING and builds on - so nothing said the reference had
                // died. sources-drift now checks that every entry exists.
                // The test file is still in tests/TriOSKitTests.
                //
                // SIX paths are build.sh-only. They are declared as
                // SOURCES_APP_ONLY in the Makefile and sources-drift fails if
                // the set ever grows a seventh, so the exclusion cannot quietly
                // become a habit. Each was excluded because the compiler
                // refused the previous one, not because it was in the way; the
                // errors are quoted so the next reader can re-derive the chain
                // instead of trusting it.
                //
                //   main.swift - the root of it. SwiftPM reclassifies any
                //   target holding a `main` file as an executable and then
                //   refuses to put it in a library product: "library product
                //   'TriOSKit' should not contain executable targets". This one
                //   is a rule of the tool, not of this code.
                //
                //   BR-OUTPUT/MenuBuilder.swift - "cannot find type
                //   'AppDelegate' in scope". Declared at main.swift:12.
                //
                //   BR-OUTPUT/ChatPanelView.swift - "type 'Notification.Name'
                //   has no member 'exportSessionRecoveryPackage'". Those two
                //   names are declared at MenuBuilder.swift:5.
                //
                //   BR-OUTPUT/FullscreenChatWorkspace.swift - "cannot find
                //   'ChatPanelView' in scope".
                //
                //   BR-OUTPUT/QueenTabView.swift - "cannot find
                //   'AdaptiveChatWorkspace' in scope" (FullscreenChatWorkspace).
                //
                //   BR-OUTPUT/TriosTabView.swift - "cannot find 'QueenTabView'
                //   in scope".
                //
                // Only the first link is forced by SwiftPM. The other five are
                // one entanglement: MenuBuilder.swift holds BOTH the AppDelegate
                // menu wiring, which is genuinely app-only, AND the
                // Notification.Name constants the chat views need, which are
                // not. Splitting that file would let four of these five back
                // into the library and under test. That is a Swift-source
                // change and is not made here.
            ],
            linkerSettings: [
                .linkedLibrary("sqlcipher"),
                .linkedFramework("Security"),
                .linkedFramework("CryptoKit"),
            ]
        ),
        .testTarget(
            name: "TriOSKitTests",
            dependencies: ["TriOSKit"],
            path: "trios/tests/TriOSKitTests"
        ),
    ]
)
