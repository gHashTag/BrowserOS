import Foundation
import QueenCore

/// The Queen's decisions, computed where the work happens.
///
/// The supervision loop still runs on a Mac, and every decision it makes is
/// made there - including decisions about files that live in a container the
/// Mac cannot see. This binary is the first piece of that loop to move: it
/// takes a question as JSON on stdin and answers on stdout, running the SAME
/// QueenCore module the app links, compiled by the Linux toolchain.
///
/// Deliberately stdin/stdout rather than HTTP. The server that would host an
/// endpoint is already in this container and can spawn a process; adding a
/// second listening port would mean a second authentication story for a
/// boundary that does not exist. A pipe has neither.
///
/// One decision per invocation, no state. A policy that remembers is a policy
/// two callers can disagree with.
struct Question: Decodable {
    let kind: String
    let writes: [String]?
    let ownedPaths: [String]?
    let root: String?
    /// For `retry`: the kinds of the attempts already made.
    let priorAttempts: [String]?
    /// For `language`: a rewrite the Queen is judging.
    let path: String?
    let before: String?
    let after: String?
}

struct Answer: Encodable {
    let kind: String
    let strays: [String]?
    /// A refusal is a sentence, and its absence is the permission. Both are
    /// answers, so the field is present either way rather than the caller
    /// inferring consent from a missing key.
    let refusal: String?
    let allowed: Bool?
    let error: String?
}

func fail(_ message: String) -> Never {
    let out = Answer(kind: "error", strays: nil, refusal: nil, allowed: nil, error: message)
    if let data = try? JSONEncoder().encode(out) {
        FileHandle.standardOutput.write(data)
    }
    exit(1)
}

func emit(_ answer: Answer) {
    guard let data = try? JSONEncoder().encode(answer) else { fail("could not encode") }
    FileHandle.standardOutput.write(data)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty else { fail("no question on stdin") }
guard let question = try? JSONDecoder().decode(Question.self, from: input) else {
    fail("could not decode the question")
}

switch question.kind {
case "boundary":
    // Which paths a worker touched that lie outside what it owns. The rule
    // that keeps two bees off each other's files, asked in the container where
    // the files are rather than on a laptop reasoning about them.
    guard let writes = question.writes, let owned = question.ownedPaths else {
        fail("boundary needs writes and ownedPaths")
    }
    let strays = QueenBoundaryPaths.strays(
        among: writes, ownedPaths: owned, root: question.root ?? "/workspace/BrowserOS"
    )
    emit(Answer(kind: "boundary", strays: strays, refusal: nil,
                allowed: strays.isEmpty, error: nil))

case "retry":
    // Whether an issue is worth another bee, and why not when it is not. The
    // policy that decides this reads the KINDS of the prior failures rather
    // than their count, because an attempt the server refused is not an
    // attempt the work failed.
    guard let raw = question.priorAttempts else { fail("retry needs priorAttempts") }
    let kinds = raw.compactMap(QueenFailureKind.init(rawValue:))
    guard kinds.count == raw.count else {
        fail("retry: unknown failure kind among \(raw)")
    }
    switch QueenRetryPolicy.decision(priorAttempts: kinds) {
    case .escalate(let reason):
        emit(Answer(kind: "retry", strays: nil, refusal: reason,
                    allowed: false, error: nil))
    default:
        emit(Answer(kind: "retry", strays: nil, refusal: nil,
                    allowed: true, error: nil))
    }

case "language":
    // L3: everything written here is English. Judged on the rewrite rather
    // than on the file, because a file that was always Russian is a fact and a
    // file being TURNED Russian is a violation.
    guard let path = question.path,
          let before = question.before,
          let after = question.after else {
        fail("language needs path, before and after")
    }
    let refusal = QueenLanguagePolicy.rewriteRefusal(
        path: path, before: before, after: after
    )
    emit(Answer(kind: "language", strays: nil, refusal: refusal,
                allowed: refusal == nil, error: nil))

default:
    fail("unknown question kind: \(question.kind)")
}
