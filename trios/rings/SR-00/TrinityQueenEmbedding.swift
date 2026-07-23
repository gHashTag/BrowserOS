import Foundation

struct TrinityQueenEmbedding: Equatable, Sendable {
    static let moduleName = "QueenUILib"
    static let libraryProduct = "QueenUILib"
    static let canonicalPetalCount = 27
    static let kingdomCount = 3
    static let petalsPerKingdom = 9

    let projectRoot: String

    init(projectRoot: String) {
        self.projectRoot = URL(fileURLWithPath: projectRoot)
            .standardizedFileURL
            .path
    }

    var packageRoot: String {
        URL(fileURLWithPath: projectRoot)
            .appendingPathComponent("apps/queen", isDirectory: true)
            .path
    }

    var stateRoot: String {
        URL(fileURLWithPath: projectRoot)
            .appendingPathComponent(".trinity", isDirectory: true)
            .path
    }

    var moduleName: String { Self.moduleName }
    var libraryProduct: String { Self.libraryProduct }
    var canonicalPetalCount: Int { Self.canonicalPetalCount }
    var kingdomCount: Int { Self.kingdomCount }
    var petalsPerKingdom: Int { Self.petalsPerKingdom }

    var hasCanonicalSourceLayout: Bool {
        let fileManager = FileManager.default
        let package = URL(fileURLWithPath: packageRoot)
        let requiredPaths = [
            package.appendingPathComponent("Package.swift").path,
            package.appendingPathComponent("QueenUI/Navigation/MainView.swift").path,
            package.appendingPathComponent("QueenUI/Widgets/TriangleLogo.swift").path,
            package.appendingPathComponent("QueenUI/Bridge/StateWatcher.swift").path,
        ]
        return requiredPaths.allSatisfy(fileManager.fileExists(atPath:))
    }

    static func resolved(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> TrinityQueenEmbedding {
        if let configured = environment["TRINITY_ROOT"],
           !configured.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return TrinityQueenEmbedding(projectRoot: configured)
        }

        let candidate = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("trinity", isDirectory: true)
            .path
        return TrinityQueenEmbedding(projectRoot: candidate)
    }
}
