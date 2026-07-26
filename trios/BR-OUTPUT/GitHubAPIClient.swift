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
        let path = try encodedRepoPath(repo: repo, suffix: "/issues?state=\(state)&per_page=100")
        let (data, _) = try await URLSession.shared.data(for: request(path))
        return try JSONDecoder().decode([GitHubIssue].self, from: data)
    }

    func fetchIssueComments(repo: String, issueNumber: Int) async throws -> [GitHubComment] {
        let path = try encodedRepoPath(repo: repo, suffix: "/issues/\(issueNumber)/comments")
        let (data, _) = try await URLSession.shared.data(for: request(path))
        return try JSONDecoder().decode([GitHubComment].self, from: data)
    }

    private func encodedRepoPath(repo: String, suffix: String) throws -> String {
        guard let encoded = repo.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            throw GitHubAPIError.badURL(endpoint: "/repos/gHashTag/\(repo)\(suffix)")
        }
        return "/repos/gHashTag/\(encoded)\(suffix)"
    }

    func createIssue(repo: String, title: String, body: String, labels: [String] = []) async throws -> GitHubIssue {
        var req = try request("/repos/gHashTag/\(repo)/issues")
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

    func createPR(repo: String, title: String, body: String, head: String, base: String = "dev") async throws -> GitHubPullRequest {
        var req = try request("/repos/gHashTag/\(repo)/pulls")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = [
            "title": title,
            "body": body,
            "head": head,
            "base": base,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(GitHubPullRequest.self, from: data)
    }

    func addComment(repo: String, issueNumber: Int, body: String) async throws -> GitHubComment {
        var req = try request("/repos/gHashTag/\(repo)/issues/\(issueNumber)/comments")
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
        }
    }
}
