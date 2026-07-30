// Sends a real chat turn and reports whether the agent answered.
//
// Built so the change can be verified without asking a human to click Send.
// It drives the same server, the same local-auth gate and the same provider
// configuration the app uses, then prints the reply and exits non-zero when
// nothing came back - which makes it usable as a gate as well as a probe.
//
// Usage:
//   make chat-probe                       (dev variant)
//   make chat-probe VARIANT=prod MSG="hi"
//
// Everything here is Foundation-only so it compiles standalone.

import Foundation

// MARK: - Configuration

struct ProbeConfig {
    let serverPort: String
    let provider: String
    let model: String
    let baseURL: String
    let apiKey: String
    let message: String
    let dataRoot: String

    /// Reads the same places the app reads, in the same order, so the probe
    /// tests the user's real configuration rather than a hand-written guess.
    static func load(variant: String, message: String) -> ProbeConfig {
        let isDev = variant == "dev"
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        let root = FileManager.default.currentDirectoryPath
        let domain = isDev ? "com.browseros.trios.dev" : "com.browseros.trios"

        let provider = defaultsString(domain: domain, key: "trios.model.provider") ?? "zai"
        let model = defaultsString(domain: domain, key: "trios.model.\(provider).selection")
            ?? "glm-5.2"
        let baseURL = defaultsString(domain: domain, key: "trios.model.\(provider).base-url")
            ?? "https://api.z.ai/api/coding/paas/v4"

        return ProbeConfig(
            serverPort: isDev ? "9205" : "9105",
            provider: provider,
            model: model,
            baseURL: baseURL,
            apiKey: readAPIKey(provider: provider, isDev: isDev, home: home),
            message: message,
            dataRoot: isDev ? "\(root)/.trinity-dev" : "\(root)/.trinity"
        )
    }

    private static func defaultsString(domain: String, key: String) -> String? {
        guard let defaults = UserDefaults(suiteName: domain),
              let value = defaults.string(forKey: key),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    /// Dev keeps secrets in files; release keeps them in the Keychain. The probe
    /// reads the dev files directly and falls back to ~/.trios/config.json,
    /// because shelling out to `security` would prompt for a password.
    private static func readAPIKey(provider: String, isDev: Bool, home: String) -> String {
        if isDev {
            let directory = "\(home)/.trios-dev/secrets"
            let service = "com.browseros.trios.model-keys"
            if let names = try? FileManager.default.contentsOfDirectory(atPath: directory) {
                // Account is "<provider>#<uuid>", sanitised into the file name.
                let prefix = "\(service)__\(provider)"
                for name in names.sorted() where name.hasPrefix(prefix) {
                    if let data = FileManager.default.contents(atPath: "\(directory)/\(name)"),
                       let key = String(data: data, encoding: .utf8),
                       !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        return key.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
            }
        }
        for path in ["\(home)/.trios-dev/config.json", "\(home)/.trios/config.json"] {
            guard let data = FileManager.default.contents(atPath: path),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            let envKey = "TRIOS_\(provider.uppercased())_API_KEY"
            if let key = json[envKey] as? String, !key.isEmpty { return key }
        }
        return ""
    }
}

// MARK: - Probe

enum ChatProbe {
    static func run(_ config: ProbeConfig) async -> Int32 {
        print("probe -> \(config.provider) \(config.model)")
        print("         \(config.baseURL)")
        print("         key: \(config.apiKey.isEmpty ? "MISSING" : "present")")
        print("         server: 127.0.0.1:\(config.serverPort)")

        guard !config.apiKey.isEmpty else {
            print("\nFAIL: no API key for \(config.provider). The request would be sent unauthenticated.")
            return 2
        }

        guard let token = await localAuthToken(port: config.serverPort) else {
            print("\nFAIL: could not obtain a local-auth token. Is the agent server running?")
            return 3
        }

        let started = Date()
        let (status, body) = await send(config: config, token: token)
        let elapsed = Int(Date().timeIntervalSince(started) * 1000)

        guard status == 200 else {
            print("\nFAIL: HTTP \(status) after \(elapsed) ms")
            print(String(body.prefix(400)))
            return 4
        }

        let reply = extractReply(from: body)
        guard !reply.isEmpty else {
            print("\nFAIL: the server answered 200 but produced no assistant text after \(elapsed) ms.")
            print(String(body.prefix(400)))
            return 5
        }

        print("\nPASS in \(elapsed) ms")
        print("reply: \(reply.prefix(300))")
        return 0
    }

    /// The chat route is behind the local-auth gate, same as the app.
    private static func localAuthToken(port: String) async -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/auth/local-token") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["token"] as? String
    }

    /// Mirrors the payload `ChatRequestBuilder` produces: a top-level `message`
    /// plus a `messages` array beginning with the system prompt. Sending only
    /// one of the two is what made earlier hand-written probes fail with
    /// "Messages array must not be empty".
    private static func send(config: ProbeConfig, token: String) async -> (Int, String) {
        guard let url = URL(string: "http://127.0.0.1:\(config.serverPort)/chat") else {
            return (0, "bad url")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-TriOS-Local-Auth")

        let payload: [String: Any] = [
            "conversationId": UUID().uuidString,
            "message": config.message,
            "mode": "agent",
            "origin": "sidepanel",
            "provider": config.provider,
            "model": config.model,
            "baseUrl": config.baseURL,
            "apiKey": config.apiKey,
            "messages": [
                ["role": "system", "content": "You are a helpful assistant. Answer briefly."],
                ["role": "user", "content": config.message]
            ]
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            return (0, "encode failed")
        }
        request.httpBody = body

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (status, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (0, error.localizedDescription)
        }
    }

    /// The reply arrives as an SSE stream of deltas; collect the text.
    static func extractReply(from body: String) -> String {
        var text = ""
        for line in body.components(separatedBy: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]", let data = payload.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            if let delta = json["textDelta"] as? String { text += delta }
            if let delta = json["delta"] as? String { text += delta }
            if let content = json["content"] as? String { text += content }
        }
        if text.isEmpty, let data = body.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let choices = json["choices"] as? [[String: Any]],
           let message = choices.first?["message"] as? [String: Any],
           let content = message["content"] as? String {
            text = content
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Entry

let arguments = ProcessInfo.processInfo.arguments
let variant = arguments.firstIndex(of: "--variant").flatMap { index -> String? in
    index + 1 < arguments.count ? arguments[index + 1] : nil
} ?? "dev"
let message = arguments.firstIndex(of: "--message").flatMap { index -> String? in
    index + 1 < arguments.count ? arguments[index + 1] : nil
} ?? "Reply with exactly: TRIOS OK"

let config = ProbeConfig.load(variant: variant, message: message)
let code = await ChatProbe.run(config)
exit(code)
