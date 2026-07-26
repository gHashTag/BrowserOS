// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: mesh tab integration files on feat/zai-provider lack T27 provenance;
//         triage before T27 seal. Not part of current T27 refactor.
// Expires: 2026-12-31
// Follow-up: create separate issue/branch to spec-drive Mesh models + view model.
import Foundation
import SwiftUI

/// View model for the Mesh tab. Polls clade-meshd and drives mesh operations.
@MainActor
final class MeshStatusViewModel: ObservableObject {
    @Published var nodeId: UInt32 = 0
    @Published var neighbors: [MeshNeighbor] = .init()
    @Published var routes: [MeshRoute] = .init()
    @Published var sessions: [MeshSession] = .init()
    @Published var metrics: MeshMetrics = MeshMetrics(link_loss_to_reroute_ms: nil, node_off_to_reroute_ms: nil)
    @Published var isReachable = false
    @Published var lastError: String?
    @Published var isLoading = false

    private let healthURL: URL
    private let statusURL: URL
    private var pollTimer: Timer?
    private let decoder = JSONDecoder()
    private let meshToken: String

    init(healthURL: URL? = URL(string: ProjectPaths.meshHealthURL),
         statusURL: URL? = URL(string: ProjectPaths.meshStatusURL),
         meshToken: String = MeshAuth.token) {
        guard let healthURL, let statusURL else {
            fatalError("MeshStatusViewModel: invalid health/status URL")
        }
        self.healthURL = healthURL
        self.statusURL = statusURL
        self.meshToken = meshToken
    }

    func startPolling(interval: TimeInterval = 2.0) {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.refresh()
            }
        }
        Task { @MainActor [weak self] in
            await self?.refresh()
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let (healthData, healthResponse) = try await URLSession.shared.data(from: healthURL)
            guard let http = healthResponse as? HTTPURLResponse, http.statusCode == 200 else {
                isReachable = false
                lastError = "mesh health check failed"
                return
            }
            let health = try decoder.decode(MeshHealth.self, from: healthData)
            nodeId = health.node_id
            isReachable = true
            lastError = nil
        } catch {
            isReachable = false
            lastError = error.localizedDescription
            return
        }

        do {
            let request = authorizedRequest(url: statusURL)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                lastError = "mesh status returned non-200"
                return
            }
            let status = try decoder.decode(MeshStatus.self, from: data)
            neighbors = status.neighbors
            routes = status.routes
            sessions = status.sessions
            metrics = status.metrics
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func authorizedRequest(url: URL, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !meshToken.isEmpty {
            request.setValue("Bearer \(meshToken)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = body
        return request
    }

    private func url(for path: String) -> URL? {
        URL(string: path, relativeTo: statusURL)?.absoluteURL
    }

    func observe(peer: UInt32, weHeard: Bool, theyHeard: Bool) async {
        guard let url = url(for: "/observe") else { return }
        let body = try? JSONEncoder().encode(MeshObserveRequest(peer: peer, we_heard: weHeard, they_heard: theyHeard))
        let request = authorizedRequest(url: url, method: "POST", body: body)
        await post(request: request, path: "/observe")
        await refresh()
    }

    func hello(peer: UInt32, seq: UInt32 = 1, heard: [UInt32] = []) async {
        guard let url = url(for: "/hello") else { return }
        let body = try? JSONEncoder().encode(MeshHelloRequest(peer: peer, seq: seq, heard: heard))
        let request = authorizedRequest(url: url, method: "POST", body: body)
        await post(request: request, path: "/hello")
        await refresh()
    }

    func seedPeer(_ peer: UInt32) async {
        guard let url = url(for: "/seed-peer") else { return }
        let body = try? JSONEncoder().encode(MeshPeerRequest(peer: peer))
        let request = authorizedRequest(url: url, method: "POST", body: body)
        await post(request: request, path: "/seed-peer")
        await refresh()
    }

    func forceDead(_ peer: UInt32) async {
        guard let url = url(for: "/force-dead") else { return }
        let body = try? JSONEncoder().encode(MeshPeerRequest(peer: peer))
        let request = authorizedRequest(url: url, method: "POST", body: body)
        await post(request: request, path: "/force-dead")
        await refresh()
    }

    func linkLoss() async {
        guard let url = url(for: "/link-loss") else { return }
        let request = authorizedRequest(url: url, method: "POST")
        await post(request: request, path: "/link-loss")
    }

    func reroute() async {
        guard let url = url(for: "/reroute") else { return }
        let request = authorizedRequest(url: url, method: "POST")
        await post(request: request, path: "/reroute")
        await refresh()
    }

    private func post(request: URLRequest, path: String) async {
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                lastError = "\(path) returned \(http.statusCode)"
            }
        } catch {
            lastError = error.localizedDescription
        }
    }
}
