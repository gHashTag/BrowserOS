import Foundation

struct GitHubRepo: Codable, Identifiable {
    let id: Int
    let name: String
    let description: String?
    let open_issues_count: Int
    let updated_at: String
    let html_url: String
}

struct GitHubIssue: Codable, Identifiable {
    let id: Int
    let number: Int
    let title: String
    let state: String
    let created_at: String
    let html_url: String
    let labels: [GitHubLabel]
    let body: String?
}

struct GitHubLabel: Codable, Identifiable {
    let id: Int?
    let name: String
    let color: String
}

struct GitHubComment: Codable, Identifiable {
    let id: Int
    let user: GitHubUser
    let body: String
    let created_at: String
}

struct GitHubUser: Codable {
    let login: String
    let avatar_url: String?
}

struct GitHubPullRequest: Codable, Identifiable {
    let id: Int
    let number: Int
    let title: String
    /// GitHub reports only "open" or "closed" here. A merged pull request and
    /// an abandoned one are both "closed", so this field alone cannot answer
    /// the only question that matters when deciding whether work landed.
    let state: String
    let html_url: String
    let head: GitHubBranchRef?
    let base: GitHubBranchRef?
    /// Present on a single-PR fetch, absent from list endpoints - hence
    /// optional. Absent is not false: it means nobody asked.
    let merged: Bool?
    let merged_at: String?

    /// True only when the forge says the work landed.
    ///
    /// Deliberately not `state == "closed"`. Closing a pull request without
    /// merging is how work gets abandoned, and treating that as success would
    /// archive a task whose changes never reached the branch - the exact
    /// confusion this repository's delegation spec exists to prevent.
    ///
    /// `nil` merged with a `merged_at` timestamp still counts: the timestamp is
    /// only ever written when a merge happened.
    var isMerged: Bool {
        if let merged { return merged }
        return merged_at != nil
    }

    /// Closed with nothing landed. The task should go back to the queue rather
    /// than archive.
    var isClosedUnmerged: Bool { state == "closed" && !isMerged }
}

struct GitHubBranchRef: Codable {
    let ref: String
    let sha: String
    let repo: GitHubRepo?
}
