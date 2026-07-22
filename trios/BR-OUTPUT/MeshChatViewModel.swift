// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: untracked mesh-chat file on feat/zai-provider; triage before T27 seal.
// Expires: 2026-07-28
import Foundation
import SwiftUI

/// HTTP bridge and local cache for the trios mesh chat UI.
@MainActor
final class MeshChatViewModel: ObservableObject {
    @Published var conversations: [MeshConversation] = []
    @Published var messages: [UInt32: [MeshChatMessage]] = [:]
    @Published var selectedPeer: UInt32?
    @Published var composerText: String = ""
    @Published var currentChannel: Character = "T"
    @Published var nodeId: UInt32 = 0
    @Published var isReachable = false
    @Published var lastError: String?
    @Published var isLoading = false

    private var sinceId: UInt64 = 0
    private var pollTimer: Timer?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let storeURL: URL

    init(storeURL: URL = ProjectPaths.meshChatStoreURL) {
        self.storeURL = storeURL
        self.decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.encoder.keyEncodingStrategy = .convertToSnakeCase
        loadCache()
    }

    // MARK: - Polling

    private var pollTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?

    func startPolling(interval: TimeInterval = 2.0) {
        stopPolling()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    func refresh() async {
        // Prevent overlapping refresh calls when the timer fires faster than
        // a slow network round-trip completes.
        if let existing = refreshTask, !existing.isCancelled {
            await existing.value
            return
        }

        refreshTask = Task {
            isLoading = true
            defer { isLoading = false }

            await checkHealth()
            guard isReachable, !Task.isCancelled else { return }

            await fetchConversations()
            await fetchSelectedThread()
            await pollNewMessages()
            await updateChannelFromStatus()
            if !Task.isCancelled {
                saveCache()
            }
        }
        await refreshTask?.value
        refreshTask = nil
    }

    // MARK: - Health / Status

    private func checkHealth() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: healthURL)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                isReachable = false
                lastError = "mesh health check failed"
                return
            }
            let health = try decoder.decode(MeshHealth.self, from: data)
            nodeId = health.node_id
            isReachable = true
            lastError = nil
        } catch {
            isReachable = false
            lastError = error.localizedDescription
        }
    }

    private func updateChannelFromStatus() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: statusURL)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            let status = try decoder.decode(MeshStatus.self, from: data)
            let best = status.neighbors.map { $0.etx }.min() ?? .infinity
            if best <= 1.2 {
                currentChannel = "V"
            } else if best <= 2.0 {
                currentChannel = "P"
            } else {
                currentChannel = "T"
            }
        } catch {
            // Keep current channel on transient status errors.
        }
    }

    // MARK: - Conversations

    private func fetchConversations() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: conversationsURL)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "/conversations returned non-200"
                return
            }
            conversations = try decoder.decode([MeshConversation].self, from: data)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func selectPeer(_ peer: UInt32) {
        selectedPeer = peer
        Task { @MainActor in
            await fetchSelectedThread()
            await ackPeer(peer)
        }
    }

    func ackPeer(_ peer: UInt32) async {
        guard let url = URL(string: ProjectPaths.meshChatAckURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? encoder.encode(MeshChatAckRequest(peer: peer))

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            if let idx = conversations.firstIndex(where: { $0.peer == peer }) {
                var updated = conversations[idx]
                updated = MeshConversation(
                    peer: updated.peer,
                    lastMessageId: updated.lastMessageId,
                    unread: 0,
                    updatedAt: updated.updatedAt
                )
                conversations[idx] = updated
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Seed a peer's static public key and optional UDP address with clade-meshd.
    /// Must be called before sending sealed frames to that peer.
    func seedPeer(peer: UInt32, publicKey: String, address: String) async {
        guard let url = URL(string: ProjectPaths.meshSeedPeerURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? encoder.encode(
            MeshSeedPeerRequest(peer: peer, publicKey: publicKey, address: address)
        )

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "/seed-peer failed"
                return
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Thread Messages

    private func fetchSelectedThread() async {
        guard let peer = selectedPeer else { return }
        let urlString = ProjectPaths.meshChatMessagesURL(peer: peer)
        guard let url = URL(string: urlString) else { return }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "/messages/\(peer) returned non-200"
                return
            }
            let thread = try decoder.decode(MeshChatMessagesResponse.self, from: data)
            messages[peer] = thread.messages
            updateSinceId(from: thread.messages)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func pollNewMessages() async {
        guard var components = URLComponents(string: ProjectPaths.meshChatPollURL) else { return }
        components.queryItems = [URLQueryItem(name: "since_id", value: String(sinceId))]
        guard let url = components.url else { return }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            let poll = try decoder.decode(MeshChatPollResponse.self, from: data)
            for msg in poll.messages {
                appendMessage(msg)
            }
            if !poll.conversations.isEmpty {
                conversations = poll.conversations
            }
            updateSinceId(from: poll.messages)
        } catch {
            // Polling is best-effort; do not spam the UI on transient failures.
        }
    }

    private func appendMessage(_ msg: MeshChatMessage) {
        var list = messages[msg.peer] ?? []
        if !list.contains(where: { $0.id == msg.id }) {
            list.append(msg)
            list.sort { $0.sentAt < $1.sentAt }
            messages[msg.peer] = list
        }
    }

    private func updateSinceId(from messages: [MeshChatMessage]) {
        if let maxId = messages.map({ $0.id }).max(), maxId > sinceId {
            sinceId = maxId
        }
    }

    // MARK: - Sending

    func sendMessage(to peer: UInt32) async {
        let trimmed = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed.utf8.count <= 200 else {
            lastError = "Message too long (max 200 bytes)"
            return
        }

        let request = MeshChatSendRequest(
            dst: peer,
            kind: MeshChatMessageKind.text.rawValue,
            text: trimmed,
            payloadBase64: nil
        )

        guard let url = URL(string: ProjectPaths.meshChatSendURL) else { return }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try? encoder.encode(request)

        do {
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "/messages/send failed"
                return
            }
            let send = try decoder.decode(MeshChatSendResponse.self, from: data)
            if send.id > sinceId {
                sinceId = send.id
            }
            if !send.queued {
                lastError = "message stored but not forwarded: seed peer and UDP address"
            }
            composerText = ""
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Simulation (host-sim / e2e helper)

    /// Deliver a sealed frame to the local daemon as if it arrived over the mesh.
    func receiveFrame(src: UInt32, frame: String) async {
        let request = MeshChatReceiveRequest(src: src, frame: frame)
        guard let url = URL(string: ProjectPaths.meshChatReceiveURL) else { return }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try? encoder.encode(request)

        do {
            let (_, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "/messages/receive failed"
                return
            }
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Cache

    private func loadCache() {
        guard FileManager.default.fileExists(atPath: storeURL.path),
              let data = try? Data(contentsOf: storeURL) else { return }
        do {
            let snapshot = try decoder.decode(MeshChatCache.self, from: data)
            conversations = snapshot.conversations
            messages = snapshot.messagesByPeer
            sinceId = snapshot.sinceId
        } catch {
            // Ignore stale/invalid cache; daemon is source of truth.
        }
    }

    private func saveCache() {
        let snapshot = MeshChatCache(
            conversations: conversations,
            messages: messages,
            sinceId: sinceId
        )
        do {
            let parent = storeURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            let data = try encoder.encode(snapshot)
            try data.write(to: storeURL)
        } catch {
            lastError = "cache save failed: \(error.localizedDescription)"
        }
    }

    // MARK: - URLs

    private var healthURL: URL { URL(string: ProjectPaths.meshHealthURL)! }
    private var statusURL: URL { URL(string: ProjectPaths.meshStatusURL)! }
    private var conversationsURL: URL { URL(string: ProjectPaths.meshChatConversationsURL)! }
}

// MARK: - Local Cache Codable

private struct MeshChatCache: Codable {
    var conversations: [MeshConversation]
    var messages: [String: [MeshChatMessage]]
    var sinceId: UInt64

    init(conversations: [MeshConversation], messages: [UInt32: [MeshChatMessage]], sinceId: UInt64) {
        self.conversations = conversations
        self.messages = messages.reduce(into: [:]) { result, pair in
            result[String(pair.key)] = pair.value
        }
        self.sinceId = sinceId
    }

    var messagesByPeer: [UInt32: [MeshChatMessage]] {
        messages.reduce(into: [:]) { result, pair in
            guard let key = UInt32(pair.key) else { return }
            result[key] = pair.value
        }
    }
}
