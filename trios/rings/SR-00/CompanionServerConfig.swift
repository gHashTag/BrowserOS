import Foundation

struct CompanionServerConfig {
    static let fallbackCDPPort = 9102
    static let maxPort = 65_535

    let cdpPort: Int
    let serverPort: Int
    let agentRoot: String

    static func resolveCDPPort(from data: Data?) -> Int {
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return fallbackCDPPort }

        let candidates: [Any?] = [
            object["cdp_port"],
            object["cdpPort"],
            (object["ports"] as? [String: Any])?["cdp"]
        ]
        for candidate in candidates {
            let port: Int?
            if let number = candidate as? NSNumber {
                port = number.intValue
            } else if let string = candidate as? String {
                port = Int(string)
            } else {
                port = nil
            }
            if let port, (1...maxPort).contains(port) {
                return port
            }
        }
        return fallbackCDPPort
    }

    static func browserRuntimeConfigURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/BrowserOS/.browseros/server_config.json")
    }

    static func loadCDPPort() -> Int {
        resolveCDPPort(from: try? Data(contentsOf: browserRuntimeConfigURL()))
    }
}
