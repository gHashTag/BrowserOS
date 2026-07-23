import Foundation

enum Trios999Destination: String, CaseIterable, Sendable {
    case chat
    case models
    case git
    case terminal
    case mesh
    case settings
}

enum Trinity999Realm: String, Sendable {
    case razum
    case materiya
    case dukh
}

struct Trios999Route: Equatable, Sendable {
    let destination: Trios999Destination
    let petalIndex: Int
    let realm: Trinity999Realm
    let worldName: String
    let formula: String
    let title: String
    let systemImage: String
    let keyboardShortcut: Int
}

enum Trinity999TabMap {
    static let petalCount = 27

    static let routes: [Trios999Route] = [
        Trios999Route(
            destination: .chat,
            petalIndex: 0,
            realm: .razum,
            worldName: "CHAT",
            formula: "phi = 1.618",
            title: "Chat",
            systemImage: "bubble.left.fill",
            keyboardShortcut: 1
        ),
        Trios999Route(
            destination: .models,
            petalIndex: 1,
            realm: .razum,
            worldName: "MODELS",
            formula: "pi*phi*e = 13.82",
            title: "Models",
            systemImage: "cpu",
            keyboardShortcut: 2
        ),
        Trios999Route(
            destination: .git,
            petalIndex: 14,
            realm: .materiya,
            worldName: "GIT",
            formula: "e^pi = 23.14",
            title: "Git",
            systemImage: "arrow.triangle.branch",
            keyboardShortcut: 6
        ),
        Trios999Route(
            destination: .terminal,
            petalIndex: 13,
            realm: .materiya,
            worldName: "TERMINAL",
            formula: "pi^2 = 9.87",
            title: "Terminal",
            systemImage: "terminal.fill",
            keyboardShortcut: 5
        ),
        Trios999Route(
            destination: .mesh,
            petalIndex: 16,
            realm: .materiya,
            worldName: "MESH",
            formula: "phi^2 + phi^-2 = 3",
            title: "Mesh",
            systemImage: "antenna.radiowaves.left.and.right",
            keyboardShortcut: 8
        ),
        Trios999Route(
            destination: .settings,
            petalIndex: 17,
            realm: .materiya,
            worldName: "SETTINGS",
            formula: "76 photons",
            title: "Settings",
            systemImage: "gear",
            keyboardShortcut: 9
        ),
    ]

    static func route(for destination: Trios999Destination) -> Trios999Route? {
        routes.first { $0.destination == destination }
    }

    static func route(forPetal petalIndex: Int) -> Trios999Route? {
        routes.first { $0.petalIndex == petalIndex }
    }

    static var isValid: Bool {
        let petals = routes.map(\.petalIndex)
        let shortcuts = routes.map(\.keyboardShortcut)
        return routes.count == Trios999Destination.allCases.count
            && Set(petals).count == petals.count
            && Set(shortcuts).count == shortcuts.count
            && petals.allSatisfy { (0..<petalCount).contains($0) }
            && shortcuts.allSatisfy { (1...9).contains($0) }
    }
}
