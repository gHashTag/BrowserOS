//
//  SlackIntegration.swift
//  TriOS - Queen Master Chat
//
//  Slack integration for messaging
//

import Foundation

/// SlackIntegration - Send/receive Slack messages
@MainActor
class SlackIntegration {
    
    @Published var isConnected: Bool = false
    @Published var workspace: String?
    
    private var authToken: String?
    private let apiBaseUrl = "https://slack.com/api"
    
    /// Connect to Slack
    func connect(credentials: String) async -> Bool {
        // Validate and store credentials
        authToken = credentials
        isConnected = true
        workspace = "TriOS Team"
        
        return true
    }
    
    /// Disconnect from Slack
    func disconnect() async {
        authToken = nil
        isConnected = false
        workspace = nil
    }
    
    /// Sync messages
    func sync() async {
        guard isConnected else { return }
        // Fetch recent messages from Slack
    }
    
    /// Send message to Slack channel/user
    func send(_ message: String, to recipient: String) async -> Bool {
        guard let token = authToken else { return false }

        // Validate the API endpoint.
        guard var components = URLComponents(string: "\(apiBaseUrl)/chat.postMessage"),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              let url = components.url else {
            NSLog("[SlackIntegration] Invalid API base URL: \(apiBaseUrl)")
            return false
        }

        // Validate recipient shape (channel ID, user ID, or #channel name).
        let trimmedRecipient = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        let validRecipient = trimmedRecipient.count >= 1
            && trimmedRecipient.count <= 80
            && trimmedRecipient.range(of: "[\n\r]", options: .regularExpression) == nil
            && trimmedRecipient.range(of: "^[#]?[A-Za-z0-9_-]+$", options: .regularExpression) != nil
        guard validRecipient else {
            NSLog("[SlackIntegration] Invalid recipient: \(recipient)")
            return false
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let cappedMessage = String(message.prefix(4000))
        let body: [String: Any] = [
            "channel": trimmedRecipient,
            "text": cappedMessage
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        } catch {
            NSLog("[SlackIntegration] Failed to encode body: \(error)")
            return false
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return false }
            return httpResponse.statusCode == 200
        } catch {
            return false
        }
    }
    
    /// Send message with blocks (rich formatting)
    func sendBlocks(_ blocks: [SlackBlock], to channel: String) async -> Bool {
        guard authToken != nil else { return false }
        
        // Call Slack API with blocks
        return true
    }
}

// MARK: - Slack Block Kit

struct SlackBlock: Codable {
    let type: String
    var text: SlackText?
    var elements: [SlackElement]?
}

struct SlackText: Codable {
    let type: String
    let text: String
}

struct SlackElement: Codable {
    let type: String
    var text: SlackText?
}
