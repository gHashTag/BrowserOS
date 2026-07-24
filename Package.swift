// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TriOS",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "TriOSKit", targets: ["TriOSKit"]),
    ],
    targets: [
        .target(
            name: "TriOSKit",
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
                "rings/SR-01/ChatEvents.swift",
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3"),
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "TriOSKitTests",
            dependencies: ["TriOSKit"],
            path: "trios/tests/TriOSKitTests"
        ),
    ]
)
