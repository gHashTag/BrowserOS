import Foundation

@main
struct Trinity999TabMapTests {
    static func main() {
        expect(Trinity999TabMap.petalCount == 27, "999 menu must retain 27 petals")
        expect(Trinity999TabMap.routes.count == 6, "Six Trios workspaces must be hosted")
        expect(Trinity999TabMap.isValid, "Hosted routes and shortcuts must be unique")

        expectRoute(.chat, petal: 0, realm: .razum, shortcut: 1)
        expectRoute(.models, petal: 1, realm: .razum, shortcut: 2)
        expectRoute(.git, petal: 14, realm: .materiya, shortcut: 6)
        expectRoute(.terminal, petal: 13, realm: .materiya, shortcut: 5)
        expectRoute(.mesh, petal: 16, realm: .materiya, shortcut: 8)
        expectRoute(.settings, petal: 17, realm: .materiya, shortcut: 9)

        expect(
            Trinity999TabMap.route(forPetal: 15) == nil,
            "Unassigned petals must retain their canonical Queen routes"
        )

        print("All Trinity999TabMap tests passed.")
    }

    private static func expectRoute(
        _ destination: Trios999Destination,
        petal: Int,
        realm: Trinity999Realm,
        shortcut: Int
    ) {
        guard let route = Trinity999TabMap.route(for: destination) else {
            fail("Missing route for \(destination.rawValue)")
        }
        expect(route.petalIndex == petal, "Wrong petal for \(destination.rawValue)")
        expect(route.realm == realm, "Wrong realm for \(destination.rawValue)")
        expect(route.keyboardShortcut == shortcut, "Wrong shortcut for \(destination.rawValue)")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() {
            fail(message)
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}
