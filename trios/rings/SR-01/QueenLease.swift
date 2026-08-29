import Foundation

/// The Mac's side of "one Queen at a time".
///
/// The container now runs a supervision tick of its own. That is the point of
/// the whole migration - but it means this app is no longer the only thing that
/// can decide to start a bee, and two deciders looking at the same board both
/// see the same issue unclaimed. They would both take it: two worktrees, two
/// branches, two sets of edits to files a boundary system believes it allocated.
///
/// So before an autonomous round chooses anything, it asks for the lease. The
/// lease lives in Postgres, which is the one thing both sides can see; this type
/// is only the way a process with no database connection reaches it.
///
/// WHY STANDING DOWN IS THE FAILURE MODE. If the lease cannot be reached - the
/// network is out, the deployment is mid-restart, the token is wrong - this
/// refuses. A round not run costs half an hour and the next one runs. Two Queens
/// running costs a board nobody can untangle afterwards, and the damage is
/// discovered later, by someone reading a merge conflict. When exclusion cannot
/// be established, the honest reading is that it does not hold.
public enum QueenLease {

    public enum Outcome: Equatable {
        /// The caller may run a round.
        case granted(fence: Int)
        /// Somebody else is the Queen right now.
        case heldBy(String)
        /// Exclusion could not be established. Also a refusal - see above.
        case unreachable(String)
        /// This app knows of no other supervisor to contend with.
        ///
        /// A claim about CONFIGURATION, not about the world. The container ticks
        /// whether or not this app has its address, so an unconfigured Mac
        /// standing beside a running cloud tick is two Queens - and this case is
        /// what that looks like from here. It is reported rather than assumed
        /// away for exactly that reason.
        case uncontested

        public var mayRun: Bool {
            switch self {
            case .granted, .uncontested: return true
            case .heldBy, .unreachable: return false
            }
        }

        /// One line, for the log and for the Queen's own report. The operator
        /// asking "why did nothing happen at 14:00" must find the answer here.
        public var reason: String {
            switch self {
            case .granted(let fence): return "lease held, term \(fence)"
            case .uncontested:
                return "no supervisor address configured; nothing to contend with"
            case .heldBy(let who): return "another supervisor holds the lease (\(who))"
            case .unreachable(let why):
                return "could not reach the lease, so standing down: \(why)"
            }
        }
    }

    /// Distinct per process AND per restart.
    ///
    /// A restarted app must be a NEW contender. Coming back under a name the
    /// lease already knows would match the renewal branch and hand this process
    /// a lease a live container legitimately holds.
    public static var holderName: String {
        let host = ProcessInfo.processInfo.hostName
        return "mac-\(host):\(ProcessInfo.processInfo.processIdentifier)"
    }

    /// Where the lease lives.
    ///
    /// Resolved SEPARATELY from the agent server, and that separation is the
    /// point. `agentServerIsRemote` answers "do my tools run in a container",
    /// which is a different question from "is another supervisor awake" - a Mac
    /// driving a local agent-server can still be racing a cloud tick, and gating
    /// contention on the first question silently answers the second one wrong.
    /// Measured on this machine the day the cloud tick went live: the app used
    /// a loopback server, so the lease was skipped entirely, while the container
    /// was taking terms of its own thirty minutes apart.
    ///
    /// Falls back to the agent server when THAT is remote, because then the two
    /// questions do have the same answer and asking the operator to configure
    /// the same host twice is how the two come to disagree.
    static var endpoint: String? {
        let configured = ProcessInfo.processInfo.environment["TRIOS_QUEEN_LEASE_URL"]
            ?? Bundle.main.infoDictionary?["TRIOS_QUEEN_LEASE_URL"] as? String
        if let configured, !configured.isEmpty {
            var trimmed = configured
            while trimmed.hasSuffix("/") { trimmed.removeLast() }
            return trimmed.isEmpty ? nil : trimmed
        }
        return ProjectPaths.agentServerIsRemote ? ProjectPaths.mcpBaseURL : nil
    }

    /// Ask for the lease for `ttlSeconds`.
    ///
    /// The TTL must outlive a round. A round that takes longer than its lease
    /// finishes as a private citizen: it goes on delegating while a second
    /// supervisor, legitimately holding the lease, delegates too.
    public static func acquire(
        ttlSeconds: Int = 300,
        session: URLSession = .shared
    ) async -> Outcome {
        guard let base = endpoint else { return .uncontested }
        // A configured address with no token is NOT uncontested. Somebody said
        // there is another supervisor at that address; being unable to talk to
        // it is a refusal, not permission.
        guard let token = QueenGit.remoteToken else {
            return .unreachable("a supervisor address is set but no token is")
        }
        guard let url = URL(string: "\(base)/queen/lease") else {
            return .unreachable("bad supervisor URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "holder": holderName,
            "ttlSeconds": ttlSeconds,
        ])

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .unreachable("no HTTP response")
            }
            guard http.statusCode == 200 else {
                return .unreachable("server answered \(http.statusCode)")
            }
            guard
                let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let acquired = object["acquired"] as? Bool
            else {
                return .unreachable("unreadable lease response")
            }
            if acquired {
                return .granted(fence: (object["fence"] as? Int) ?? 0)
            }
            return .heldBy((object["holder"] as? String) ?? "unknown")
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }

    /// Hand it back when the round is done.
    ///
    /// Not required - the TTL covers a process that dies holding it. But a round
    /// that ends at 14:03 and keeps the lease until 14:08 is five minutes in
    /// which the container's tick stands down for no reason, and the whole point
    /// of two supervisors is that either may run whenever the other is not.
    public static func release(session: URLSession = .shared) async {
        guard let base = endpoint,
              let token = QueenGit.remoteToken,
              let encoded = holderName.addingPercentEncoding(
                withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(base)/queen/lease?holder=\(encoded)")
        else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: request)
    }
}
