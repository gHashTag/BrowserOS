import Foundation
import QueenCore
import QueenPolicy

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
    /// For `choose`: the open issues on the table, and the registry as it
    /// stands. The registry arrives as the app writes it, so the container
    /// judges the same record rather than a summary of it.
    let candidates: [Int]?
    let tasks: [DelegatedTask]?
}

struct Answer: Encodable {
    let kind: String
    let strays: [String]?
    /// A refusal is a sentence, and its absence is the permission. Both are
    /// answers, so the field is present either way rather than the caller
    /// inferring consent from a missing key.
    let refusal: String?
    let allowed: Bool?
    /// For `choose`: the issue to delegate, and why each of the others was
    /// passed over. A choice without the passed-over reasons is a choice
    /// nobody can audit - eight of them in one tick once read as a busy swarm
    /// when five tasks were escalated and holding their paths.
    let chosen: Int?
    let skipped: [String]?
    let error: String?
}

func fail(_ message: String) -> Never {
    let out = Answer(kind: "error", strays: nil, refusal: nil, allowed: nil, chosen: nil, skipped: nil, error: message)
    if let data = try? JSONEncoder().encode(out) {
        FileHandle.standardOutput.write(data)
    }
    exit(1)
}

func emit(_ answer: Answer) {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    guard let data = try? encoder.encode(answer) else { fail("could not encode") }
    FileHandle.standardOutput.write(data)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty else { fail("no question on stdin") }
// The registry writes dates as ISO 8601 strings, and JSONDecoder defaults to
// a numeric interval. Without this the whole question fails to decode and the
// answer is "could not decode", which says nothing about which field or why -
// the registry's own reader sets the same strategy, and reading its output
// with a different one is how the two come to disagree about a record neither
// of them changed.
let decoder = JSONDecoder()
decoder.dateDecodingStrategy = .iso8601
guard let question = try? decoder.decode(Question.self, from: input) else {
    // Say what failed, not merely that something did.
    do { _ = try decoder.decode(Question.self, from: input) }
    catch { fail("could not decode the question: \(error)") }
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
    emit(Answer(kind: "boundary", strays: strays, refusal: nil, allowed: strays.isEmpty, chosen: nil, skipped: nil, error: nil))

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
        emit(Answer(kind: "retry", strays: nil, refusal: reason, allowed: false, chosen: nil, skipped: nil, error: nil))
    default:
        emit(Answer(kind: "retry", strays: nil, refusal: nil, allowed: true, chosen: nil, skipped: nil, error: nil))
    }

case "choose":
    // The tick's own decision, made where the work is.
    //
    // Capacity, then boundaries, then order. The three rules that decide which
    // bee starts next were the last part of the supervision loop still
    // reasoning on a laptop about a filesystem it cannot see.
    guard let candidates = question.candidates, let tasks = question.tasks else {
        fail("choose needs candidates and tasks")
    }
    let running = tasks.filter { $0.state == .running }.count
    guard QueenDelegationPolicy.canStartAnother(running: running) else {
        emit(Answer(kind: "choose", strays: nil,
                    refusal: "\(running) workers already running "
                        + "(limit \(QueenDelegationPolicy.maximumConcurrentWorkers))",
                    allowed: false, chosen: nil, skipped: nil, error: nil))
        exit(0)
    }
    var skipped: [String] = []
    var pick: Int?
    let now = Date()
    for number in candidates {
        if let existing = tasks.first(where: { $0.issue.number == number }) {
            skipped.append("#\(number): a task already exists for it "
                + "(\(existing.state.rawValue))")
            continue
        }
        // A candidate with no task of its own can still be held by another
        // task's boundary, and that is the rule this whole exercise is about.
        let holders = QueenDelegationPolicy.conflictingTasks(
            for: ["rings/SR-00"], among: tasks, now: now
        )
        if !holders.isEmpty, pick == nil {
            skipped.append("#\(number): its files are held by "
                + holders.map(\.issue.slug).joined(separator: ", "))
            continue
        }
        if pick == nil { pick = number } else { skipped.append("#\(number): not first") }
    }
    emit(Answer(kind: "choose", strays: nil,
                refusal: pick == nil ? "nothing to choose" : nil,
                allowed: pick != nil, chosen: pick, skipped: skipped, error: nil))

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
    emit(Answer(kind: "language", strays: nil, refusal: refusal, allowed: refusal == nil, chosen: nil, skipped: nil, error: nil))

default:
    fail("unknown question kind: \(question.kind)")
}
