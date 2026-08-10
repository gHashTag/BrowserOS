import Foundation

actor GitHubAPIClient {
    static let shared = GitHubAPIClient()
    let baseURL = "https://api.github.com"

    /// macOS Keychain service/account where the GitHub token must be stored.
    /// The token is intentionally never read from the environment; env fallbacks
    /// leave secrets in shell history, launchctl, and process args.
    private static let keychainService = "ai.browseros.trios"
    private static let keychainAccount = "github-token"

    private func token() throws -> String {
        let value = try KeychainSecrets.read(
            service: Self.keychainService,
            account: Self.keychainAccount
        )
        let trimmed = value.filter { !$0.isWhitespace }
        guard !trimmed.isEmpty else {
            throw GitHubAPIError.missingToken
        }
        return trimmed
    }

    /// Convenience for callers that need to seed the Keychain from a UI flow.
    static func storeToken(_ token: String) throws {
        try KeychainSecrets.write(
            service: keychainService,
            account: keychainAccount,
            secret: token
        )
    }

    /// Remove the stored token from the Keychain.
    static func deleteToken() throws {
        try KeychainSecrets.delete(
            service: keychainService,
            account: keychainAccount
        )
    }

    private func request(_ endpoint: String) throws -> URLRequest {
        let token = try token()
        guard let url = URL(string: baseURL + endpoint) else {
            throw GitHubAPIError.badURL(endpoint: endpoint)
        }
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github.v3+json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    func fetchRepos() async throws -> [GitHubRepo] {
        let (data, _) = try await URLSession.shared.data(for: request("/users/gHashTag/repos?per_page=100"))
        return try JSONDecoder().decode([GitHubRepo].self, from: data)
    }

    func fetchIssues(repo: String, state: String = "all") async throws -> [GitHubIssue] {
        let path = try GitHubEndpoint.repositoryPath(repo, "/issues?state=\(state)&per_page=100")
        let (data, _) = try await URLSession.shared.data(for: request(path))
        return try JSONDecoder().decode([GitHubIssue].self, from: data)
    }

    /// One issue, because the Queen needs its body to read the contract the
    /// author already wrote. The list endpoint would work but pulls a hundred
    /// issues to answer a question about one.
    func fetchIssue(repo: String, number: Int) async throws -> GitHubIssue {
        let path = try GitHubEndpoint.repositoryPath(repo, "/issues/\(number)")
        let (data, response) = try await URLSession.shared.data(for: request(path))
        try validate(response, endpoint: path)
        return try JSONDecoder().decode(GitHubIssue.self, from: data)
    }

    func fetchIssueComments(repo: String, issueNumber: Int) async throws -> [GitHubComment] {
        let path = try GitHubEndpoint.repositoryPath(repo, "/issues/\(issueNumber)/comments")
        let (data, _) = try await URLSession.shared.data(for: request(path))
        return try JSONDecoder().decode([GitHubComment].self, from: data)
    }

    func createIssue(repo: String, title: String, body: String, labels: [String] = []) async throws -> GitHubIssue {
        var req = try request(GitHubEndpoint.repositoryPath(repo, "/issues"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = [
            "title": title,
            "body": body,
            "labels": labels,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(GitHubIssue.self, from: data)
    }

    // MARK: - Pull-request helpers (pure, testable)

    /// The outcome of a merge attempt.
    ///
    /// The forge refuses for many reasons — branch protection, a failing
    /// check, a moved head — and the status code is what tells them apart.
    /// Carrying it lets the caller log and decide without a second request,
    /// instead of learning only that something went wrong.
    ///
    /// A **conflict** is a permanent refusal: the branches diverge and no
    /// retry will resolve it. The forge signals this through
    /// `mergeable == false` or `mergeable_state == "dirty"`. This is not
    /// "not yet" — it is "never without a rebase" — and retrying is
    /// pointless. The `.conflict` case exists so the caller can stop,
    /// name the conflict, and move on (#1252).
    enum MergeOutcome {
        case merged
        case refused(statusCode: Int, mergeable: Bool?, mergeState: String?)
        case conflict(mergeable: Bool?, mergeState: String?)
    }

    /// A conflict is permanent: the branches diverge and no retry will
    /// resolve it. The forge signals this through `mergeable == false`
    /// or `mergeable_state == "dirty"`. Extracted as a pure function so
    /// the classification is testable without a network call — the same
    /// pattern as `headFilter` and `matchingPullRequest` (#1252).
    static func isConflict(mergeable: Bool?, mergeState: String?) -> Bool {
        mergeable == false || mergeState == "dirty"
    }

    /// Builds the `owner:branch` value the GitHub pulls endpoint requires for
    /// the `head` query parameter, percent-encoded as a query value.
    ///
    /// A bare branch name returns every open PR in the repo; an unencoded
    /// slash from the branch name injects a path segment. Both are the kind
    /// of mistake that looks correct until the wrong pull request is adopted.
    static func headFilter(owner: String, branch: String) -> String {
        let qualified = "\(owner):\(branch)"
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: ":/")
        return qualified.addingPercentEncoding(withAllowedCharacters: allowed) ?? qualified
    }

    /// Extracts the owner from a repository string the same way
    /// `GitHubEndpoint.repositoryPath` does: `"name"` uses the default owner,
    /// `"owner/name"` uses the one provided.
    static func ownerFromRepo(_ repo: String) -> String {
        let parts = repo.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        return parts.count >= 2 ? parts[0] : GitHubEndpoint.defaultOwner
    }

    /// Returns the first pull request whose head ref matches the expected
    /// branch, rejecting any whose ref differs.
    ///
    /// The list is filtered by `owner:branch`, but a PR from a fork whose
    /// owner happens to match would still appear. This is the guard that
    /// stops it from being adopted as someone else's work.
    static func matchingPullRequest(
        in list: [GitHubPullRequest], expectedBranch: String
    ) -> GitHubPullRequest? {
        list.first { $0.head?.ref == expectedBranch }
    }

    func createPR(repo: String, title: String, body: String, head: String, base: String = "dev") async throws -> GitHubPullRequest {
        var req = try request(GitHubEndpoint.repositoryPath(repo, "/pulls"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = [
            "title": title,
            "body": body,
            "head": head,
            "base": base,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: req)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1

        if (200..<300).contains(statusCode) {
            return try JSONDecoder().decode(GitHubPullRequest.self, from: data)
        }

        if statusCode == 422,
           let bodyString = String(data: data, encoding: .utf8),
           bodyString.localizedCaseInsensitiveContains("pull request already exists") {
            // The forge says a PR for this head already exists. The list
            // endpoint requires `owner:branch` to narrow by source — a bare
            // branch name returns every open PR — and the value must be
            // percent-encoded as a query parameter because an unencoded slash
            // injects a path segment.
            let qualifiedHead = Self.headFilter(
                owner: Self.ownerFromRepo(repo), branch: head
            )
            let listPath = try GitHubEndpoint.repositoryPath(
                repo, "/pulls?head=\(qualifiedHead)&state=open"
            )
            let (listData, listResponse) = try await URLSession.shared.data(for: try request(listPath))
            try validate(listResponse, endpoint: listPath)
            let existing = try JSONDecoder().decode([GitHubPullRequest].self, from: listData)
            // A PR with a different head ref is not the one we asked for. The
            // list is filtered, but a forked PR whose owner matches would still
            // appear. Verify rather than adopt.
            if let pr = Self.matchingPullRequest(in: existing, expectedBranch: head) {
                return pr
            }
        }

        let message: String
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = json["message"] as? String {
            message = msg
        } else if let bodyString = String(data: data, encoding: .utf8), !bodyString.isEmpty {
            message = String(bodyString.prefix(200))
        } else {
            message = "HTTP \(statusCode)"
        }
        throw GitHubAPIError.createPRFailed(statusCode: statusCode, message: message)
    }

    /// Decodable subset of the single-PR response — just the fields that
    /// distinguish a conflict from a not-yet. The full `GitHubPullRequest`
    /// model lives in a file this client cannot extend, so only the
    /// merge-relevant fields are decoded here.
    private struct MergeStatusPayload: Codable {
        let mergeable: Bool?
        let mergeable_state: String?
    }

    /// Fetches `mergeable` and `mergeable_state` for one pull request.
    /// Returns `(nil, nil)` on any failure — absence is not a conflict.
    private func fetchMergeStatus(repo: String, number: Int) async -> (Bool?, String?) {
        guard let path = try? GitHubEndpoint.repositoryPath(repo, "/pulls/\(number)"),
              let (data, _) = try? await URLSession.shared.data(for: try request(path)),
              let payload = try? JSONDecoder().decode(MergeStatusPayload.self, from: data)
        else { return (nil, nil) }
        return (payload.mergeable, payload.mergeable_state)
    }

    /// Merges a pull request.
    ///
    /// Squash by default: a worker's branch is a session's worth of
    /// intermediate commits, and the history that matters afterwards is one
    /// change with the issue attached, not eleven attempts at it.
    ///
    /// Returns `.refused(statusCode:mergeable:mergeState:)` when the forge
    /// says "not yet" — branch protection, a failing check, an out-of-date
    /// base — rather than throwing, because "not allowed to merge yet" is a
    /// normal answer here and the task simply stays open.
    ///
    /// Returns `.conflict(mergeable:mergeState:)` when the forge says
    /// "never without a rebase" — the branches diverge. This is not a
    /// not-yet: retrying will not help. The caller stops retrying and emits
    /// its own event naming the conflict (#1252).
    func mergePullRequest(repo: String, number: Int, title: String) async throws -> MergeOutcome {
        let path = try GitHubEndpoint.repositoryPath(repo, "/pulls/\(number)/merge")
        var put = try request(path)
        put.httpMethod = "PUT"
        put.setValue("application/json", forHTTPHeaderField: "Content-Type")
        put.httpBody = try JSONSerialization.data(withJSONObject: [
            "merge_method": "squash",
            "commit_title": title
        ])
        let (_, response) = try await URLSession.shared.data(for: put)
        guard let http = response as? HTTPURLResponse else {
            return .refused(statusCode: -1, mergeable: nil, mergeState: nil)
        }
        if http.statusCode == 200 {
            return .merged
        }

        // The forge refused. Before reporting a generic refusal, fetch the
        // PR's mergeable state so the caller can tell a conflict (permanent)
        // from a not-yet (temporary). A conflict means the branches diverge
        // and no retry will succeed — the distinction that #1252 exists to
        // make.
        let (mergeable, mergeState) = await fetchMergeStatus(repo: repo, number: number)
        if Self.isConflict(mergeable: mergeable, mergeState: mergeState) {
            return .conflict(mergeable: mergeable, mergeState: mergeState)
        }
        // 405 not mergeable, 409 head moved — both mean "not now", and both
        // are answers rather than errors. The status code travels with the
        // refusal so the caller can distinguish them, along with the
        // mergeable fields so the caller does not need a second request.
        return .refused(statusCode: http.statusCode, mergeable: mergeable, mergeState: mergeState)
    }

    /// Fetches one pull request, which is the only endpoint that reports
    /// `merged`. List endpoints omit it, and without it a closed pull request
    /// cannot be told from a landed one.
    func fetchPullRequest(repo: String, number: Int) async throws -> GitHubPullRequest {
        let path = try GitHubEndpoint.repositoryPath(repo, "/pulls/\(number)")
        let (data, _) = try await URLSession.shared.data(for: try request(path))
        return try JSONDecoder().decode(GitHubPullRequest.self, from: data)
    }

    func addComment(repo: String, issueNumber: Int, body: String) async throws -> GitHubComment {
        var req = try request(GitHubEndpoint.repositoryPath(repo, "/issues/\(issueNumber)/comments"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = ["body": body]
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(GitHubComment.self, from: data)
    }

    func fetchTriNetSnapshot() async throws -> TriNetRepositorySnapshot {
        let repositoryEndpoint = "/repos/gHashTag/tri-net"
        let pullEndpoint = "/repos/gHashTag/tri-net/pulls/89"
        let commitsEndpoint = "/repos/gHashTag/tri-net/commits?sha=main&per_page=12"

        let repositoryRequest = try request(repositoryEndpoint)
        let pullRequest = try request(pullEndpoint)
        let commitsRequest = try request(commitsEndpoint)

        async let repositoryResponse = URLSession.shared.data(for: repositoryRequest)
        async let pullResponse = URLSession.shared.data(for: pullRequest)
        async let commitsResponse = URLSession.shared.data(for: commitsRequest)

        let (repositoryPair, pullPair, commitsPair) = try await (
            repositoryResponse,
            pullResponse,
            commitsResponse
        )
        try validate(repositoryPair.1, endpoint: repositoryEndpoint)
        try validate(pullPair.1, endpoint: pullEndpoint)
        try validate(commitsPair.1, endpoint: commitsEndpoint)

        let decoder = JSONDecoder()
        let repository = try decoder.decode(TriNetRepositoryPayload.self, from: repositoryPair.0)
        let pull = try decoder.decode(TriNetPullRequestPayload.self, from: pullPair.0)
        let commits = try decoder.decode([TriNetCommitPayload].self, from: commitsPair.0)
        guard let mainCommit = commits.first else {
            throw GitHubAPIError.cannotParseResponse(endpoint: commitsEndpoint)
        }

        let compareEndpoint = "/repos/gHashTag/tri-net/compare/\(pull.merge_commit_sha)...\(repository.default_branch)"
        let compareRequest = try request(compareEndpoint)
        let (compareData, compareResponse) = try await URLSession.shared.data(for: compareRequest)
        try validate(compareResponse, endpoint: compareEndpoint)
        let comparison = try decoder.decode(TriNetComparePayload.self, from: compareData)

        return TriNetRepositorySnapshot(
            repositoryURL: repository.html_url,
            repositoryDescription: repository.description ?? "TRI-NET mesh repository",
            defaultBranch: repository.default_branch,
            pullRequestNumber: pull.number,
            pullRequestTitle: pull.title,
            pullRequestURL: pull.html_url,
            pullRequestMerged: pull.merged,
            pullRequestMergedAt: pull.merged_at,
            pullRequestMergedBy: pull.merged_by.login,
            pullRequestCommitCount: pull.commits,
            pullRequestHeadSHA: pull.head.sha,
            mergeCommitSHA: pull.merge_commit_sha,
            currentMainSHA: mainCommit.sha,
            commitsSinceMerge: comparison.ahead_by,
            recentCommits: commits.map { commit in
                TriNetCommitHighlight(
                    sha: commit.sha,
                    headline: commit.commit.message.components(separatedBy: "\n").first ?? commit.commit.message,
                    url: commit.html_url
                )
            },
            source: .live,
            fetchedAt: Date()
        )
    }

    private func validate(_ response: URLResponse, endpoint: String) throws {
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw GitHubAPIError.badServerResponse(endpoint: endpoint)
        }
    }
}

enum GitHubAPIError: Error, LocalizedError {
    case missingToken
    case badURL(endpoint: String)
    case badServerResponse(endpoint: String)
    case cannotParseResponse(endpoint: String)
    case createPRFailed(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .missingToken:
            return "GitHub token not found in Keychain. Store it with GitHubAPIClient.storeToken(_:) or in Keychain item 'ai.browseros.trios' / 'github-token'."
        case .badURL(let endpoint):
            return "Invalid GitHub URL for endpoint \(endpoint)"
        case .badServerResponse(let endpoint):
            return "Unexpected GitHub response for endpoint \(endpoint)"
        case .cannotParseResponse(let endpoint):
            return "Could not parse GitHub response for endpoint \(endpoint)"
        case .createPRFailed(let statusCode, let message):
            return "GitHub createPR failed (\(statusCode)): \(message)"
        }
    }
}
