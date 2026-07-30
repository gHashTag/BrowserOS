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
                "rings/SR-00",
                "rings/SR-01",
                "rings/SR-02",
                "BR-OUTPUT/ProjectPaths.swift",
                "rings/SR-00/KeychainSecrets.swift",
                "BR-OUTPUT/TriosTheme.swift",
                "BR-OUTPUT/GitHubModels.swift",
                "BR-OUTPUT/GitHubAPIClient.swift",
                "BR-OUTPUT/QueenStatusViewModel.swift",
                "BR-OUTPUT/A2AMessageRouter.swift",
                "BR-OUTPUT/ChatLogic.swift",
                "BR-OUTPUT/CladeGuard.swift",
                // HotkeyAnalyticsEncryptionTests asserts that analytics are
                // encrypted at rest, and could not see the type it tests.
                // Excluded from the app build as a prototype, which is a
                // separate question from whether its test can compile.
                "BR-OUTPUT/HotkeyAnalytics.swift",
                "rings/SR-01/ChatEvents.swift",
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
