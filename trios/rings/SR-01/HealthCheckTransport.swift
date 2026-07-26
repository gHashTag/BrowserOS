import Foundation

actor HealthCheckTransport: ChatHealthCheckProtocol {
    private let healthURL: URL

    init(healthURL: URL = URL(string: ProjectPaths.browserOSHealthURL) ?? URL(fileURLWithPath: "/dev/null")) {
        self.healthURL = healthURL
    }

    func check() async -> Bool {
        do {
            let (_, response) = try await URLSession.shared.data(from: healthURL)
            guard let httpResponse = response as? HTTPURLResponse else { return false }
            return (200...299).contains(httpResponse.statusCode)
        } catch let error as URLError {
            if isCanaryConnectionRefused(error) { return false }
            return false
        } catch {
            return false
        }
    }

    private func isCanaryConnectionRefused(_ error: URLError) -> Bool {
        let refused = (error.code == .cannotConnectToHost) || (error.code.rawValue == 61)
        guard refused else { return false }
        let canaryPort = Int(ProjectPaths.canaryMcpPort) ?? 9205
        return healthURL.port == canaryPort
    }
}
