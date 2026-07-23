import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

@main
enum CompanionServerConfigTests {
    static func main() {
        check(
            CompanionServerConfig.resolveCDPPort(from: json(["cdp_port": 9102])) == 9102,
            "reads current snake-case runtime key"
        )
        check(
            CompanionServerConfig.resolveCDPPort(from: json(["cdpPort": "9010"])) == 9010,
            "reads legacy camel-case runtime key"
        )
        check(
            CompanionServerConfig.resolveCDPPort(from: json(["ports": ["cdp": 9000]])) == 9000,
            "reads nested runtime key"
        )
        check(
            CompanionServerConfig.resolveCDPPort(from: json(["cdp_port": 0])) == 9102,
            "rejects invalid ports"
        )
        check(
            CompanionServerConfig.resolveCDPPort(from: nil) == 9102,
            "uses fallback when runtime config is unavailable"
        )
        print("All CompanionServerConfig tests passed.")
    }

    private static func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }
}
