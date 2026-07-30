import Foundation

/// Builds GitHub REST paths from a repository and a suffix.
///
/// This exists because the paths used to be assembled inline, and three
/// mistakes lived undetected in the parts of the API that had never been
/// called:
///
/// * The owner was hardcoded into every path while the pull-request callers
///   passed `"owner/repo"`, producing `/repos/gHashTag/gHashTag/trios/pulls`.
///   A client that silently accepts a repository it cannot address is worse
///   than one that refuses.
/// * Two callers passed a suffix without its leading slash, so
///   `pulls/7/merge` glued itself onto the repository name.
/// * Percent-encoding with `.urlPathAllowed` looked like protection against
///   both, and is not: `/` is an allowed path character and passes straight
///   through.
///
/// Pure and free of dependencies on purpose - a path builder that can only be
/// exercised by making a network call is a path builder nobody checks.
enum GitHubEndpoint {
    /// Owner assumed when a caller names a bare repository. Every existing
    /// call site refers to this account; the point of the parameter is that a
    /// caller naming a different one is now honoured rather than mangled.
    static let defaultOwner = "gHashTag"

    enum Failure: Error, Equatable {
        /// More than one slash, or an empty owner or name.
        case malformedRepository(String)
        /// A non-empty suffix that does not begin with "/".
        case suffixMissingLeadingSlash(String)
    }

    /// `repository` is either `"name"` or `"owner/name"`.
    /// `suffix` is empty or begins with `/`, and may carry a query string.
    static func repositoryPath(_ repository: String, _ suffix: String = "") throws -> String {
        let parts = repository.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let owner: String
        let name: String
        switch parts.count {
        case 1:
            owner = defaultOwner
            name = parts[0]
        case 2:
            owner = parts[0]
            name = parts[1]
        default:
            throw Failure.malformedRepository(repository)
        }
        guard !owner.isEmpty, !name.isEmpty else {
            throw Failure.malformedRepository(repository)
        }
        guard suffix.isEmpty || suffix.hasPrefix("/") else {
            throw Failure.suffixMissingLeadingSlash(suffix)
        }
        return "/repos/\(escape(owner))/\(escape(name))\(suffix)"
    }

    /// Encodes a single path component. `.urlPathAllowed` deliberately permits
    /// `/`, which is exactly the character that must not survive here, so the
    /// separator is removed from the set.
    static func escape(_ component: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return component.addingPercentEncoding(withAllowedCharacters: allowed) ?? component
    }
}
