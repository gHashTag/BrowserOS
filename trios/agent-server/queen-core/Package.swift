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
    // Declared so this package builds on a Mac too. It has no effect on the
    // Linux stage that is the point of it, but without it SwiftPM assumes a
    // macOS floor old enough to reject `withoutEscapingSlashes`, and a package
    // that only compiles on the target platform cannot be checked anywhere
    // else.
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "QueenCore", targets: ["QueenCore"]),
        .library(name: "QueenPolicy", targets: ["QueenPolicy"]),
        .executable(name: "queend", targets: ["queend"]),
    ],
    targets: [
        .target(name: "QueenCore", path: "Sources/QueenCore"),
        // The selection loop's own decisions: which task holds which boundary,
        // whether another worker may start, how candidates are ordered, and
        // when a task's file boundary stops excluding everyone else.
        //
        // A second module rather than more files in the first, because
        // QueenDelegation imports QueenCore in the app and a module cannot
        // import itself. Keeping the import correct here is what lets
        // `make queen-core-sync` compare the copies byte for byte instead of
        // maintaining a diff nobody reads.
        .target(name: "QueenPolicy", dependencies: ["QueenCore"], path: "Sources/QueenPolicy"),
        .executableTarget(name: "queend", dependencies: ["QueenCore", "QueenPolicy"], path: "Sources/queend"),
    ]
)
