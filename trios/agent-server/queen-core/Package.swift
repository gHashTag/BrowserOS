// swift-tools-version:5.9
import PackageDescription

// The Queen's policy, built for Linux.
//
// `make queen-core` on macOS proves these files compile against Foundation
// alone. That is not the same claim as "they build on Linux": Combine,
// Security, CryptoKit and AppKit are all importable on a Mac and absent on a
// server, and a file that quietly acquired one would still pass the macOS
// gate. This package is compiled by the Railway builder, which is Linux, so
// the claim is checked where it matters.
//
// The sources are copied here by the Dockerfile rather than referenced across
// the repository, because the build context is the agent-server directory.
let package = Package(
    name: "QueenCore",
    products: [
        .library(name: "QueenCore", targets: ["QueenCore"]),
        .executable(name: "queend", targets: ["queend"]),
    ],
    targets: [
        .target(name: "QueenCore", path: "Sources/QueenCore"),
        .executableTarget(name: "queend", dependencies: ["QueenCore"], path: "Sources/queend"),
    ]
)
