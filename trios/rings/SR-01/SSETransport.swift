import Foundation

actor SSETransport: ChatTransportProtocol {
    private let serverURL: URL
    private var session: URLSession

    init(serverURL: URL = URL(string: "\(ProjectPaths.mcpBaseURL)/chat") ?? URL(fileURLWithPath: "/dev/null")) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600
        config.httpShouldSetCookies = false
        self.serverURL = serverURL
        self.session = URLSession(configuration: config)
    }

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        var request = URLRequest(url: serverURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = body

        NSLog("[SSETransport] POST \(serverURL.absoluteString), body size: \(body.count)")
        let (bytes, response) = try await session.bytes(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            NSLog("[SSETransport] non-HTTP response")
            throw TransportError.invalidResponse
        }
        NSLog("[SSETransport] HTTP status: \(httpResponse.statusCode)")
        guard (200...299).contains(httpResponse.statusCode) else {
            // Capture a sample of the response body to diagnose non-2xx failures.
            var sampleData = Data()
            for try await byte in bytes {
                sampleData.append(byte)
                if sampleData.count > 500 { break }
            }
            let bodySample = String(data: sampleData, encoding: .utf8) ?? String(describing: sampleData)
            NSLog("[SSETransport] non-2xx response: \(httpResponse.statusCode), body: \(bodySample)")
            throw TransportError.serverError(statusCode: httpResponse.statusCode, bodySample: bodySample)
        }

        return AsyncStream { continuation in
            let readTask = Task {
                do {
                    var buffer = Data()
                    for try await chunk in bytes {
                        buffer.append(chunk)

                        // Parse complete lines from buffer
                        while let newlineIndex = buffer.firstIndex(of: UInt8(10)) {
                            let lineData = buffer.prefix(upTo: newlineIndex)
                            buffer = Data(buffer.suffix(from: newlineIndex + 1))

                            guard let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                                  !line.isEmpty else {
                                // Empty line = SSE event boundary; try to flush any pending event
                                continue
                            }

                            if line.hasPrefix("data: ") {
                                let json = String(line.dropFirst(6))
                                NSLog("[SSETransport] raw SSE line: \(json.prefix(100))")
                                if let event = SSEEventParser.parse(line: line) {
                                    continuation.yield(event)
                                    if shouldFinish(event) {
                                        continuation.finish()
                                        return
                                    }
                                }
                            } else if line.hasPrefix(":") {
                                // SSE comment — ignore
                                continue
                            }
                        }
                    }

                    // Flush remaining buffer after stream ends. Use lossy UTF-8
                    // decoding so a trailing incomplete multi-byte sequence does not
                    // silently drop the final event.
                    let remaining = String(decoding: buffer, as: UTF8.self)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if remaining.hasPrefix("data: "),
                       let event = SSEEventParser.parse(line: remaining) {
                        continuation.yield(event)
                    }

                    continuation.finish()
                } catch {
                    NSLog("[SSETransport] stream error: \(error.localizedDescription)")
                    continuation.yield(.error(id: "", message: error.localizedDescription))
                    continuation.finish()
                }
            }

            continuation.onTermination = { _ in
                readTask.cancel()
            }
        }
    }

    func cancel() async {
        session.invalidateAndCancel()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600
        config.httpShouldSetCookies = false
        session = URLSession(configuration: config)
    }

    private func shouldFinish(_ event: SSEEvent) -> Bool {
        switch event {
        case .finish, .abort, .error:
            return true
        default:
            return false
        }
    }
}

enum TransportError: Error {
    case invalidResponse
    case connectionFailed
    case serverError(statusCode: Int, bodySample: String)

    var localizedDescription: String {
        switch self {
        case .invalidResponse:
            return "Invalid server response"
        case .connectionFailed:
            return "Connection failed"
        case .serverError(let statusCode, let bodySample):
            return "Server returned \(statusCode): \(bodySample)"
        }
    }
}
