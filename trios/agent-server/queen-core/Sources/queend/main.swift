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
    /// For `choose`: each candidate's issue BODY, keyed by issue number as a
    /// string. The boundary is parsed here rather than by the caller, so the
    /// container and the app read a boundary section by the same rule instead
    /// of by two that agree until one is edited.
    let candidateBodies: [String: String]?
    /// For `review`: one entry per acceptance criterion the bee answered, and
    /// the counts the policy needs to tell "not finished" from "finished
    /// badly".
    let verdicts: [Verdict]?
    let totalCriteria: Int?
    let committedFiles: Int?
    let priorSendBacks: Int?
}

struct SpecAnswer: Encodable {
    let delegatable: Bool
    let isSpec: Bool
    let missing: [String]
    let remedy: String
    /// What the issue says "done" looks like, in its author's words.
    ///
    /// Carried out with the verdict because the cloud supervisor is TypeScript
    /// and cannot call the parser. It used to reimplement nothing at all - it
    /// sent an empty criteria list with every task, so `QueenReviewDecision`
    /// answered "nothing to judge it against" and escalated finished work to a
    /// person for every single bee.
    let criteria: [String]
    /// Whether `criteria` came from a Success Criteria section or was stood in
    /// for by the numbered requirements. A board that shows criteria must be
    /// able to say which, or a fallback reads as the author's contract.
    let criteriaSource: String
}

func emitSpecs(_ verdicts: [String: SpecAnswer]) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(["kind": "specs"]),
          let head = String(data: data, encoding: .utf8),
          let body = try? encoder.encode(verdicts),
          let tail = String(data: body, encoding: .utf8)
    else { fail("could not encode the spec verdicts") }
    // Two objects merged by hand rather than a wrapper type: the answer is a
    // map keyed by issue number and a Codable struct cannot have dynamic keys
    // without a container dance that would be longer than this comment.
    print(head.dropLast() + ",\"verdicts\":" + tail + "}")
}

struct Verdict: Decodable {
    let criterion: String
    let met: Bool
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
    /// The chosen candidate's own declared boundary.
    ///
    /// Travels with the choice because the caller has to record it. The tick's
    /// own dispatches are not in the registry mirror - the app writes that -
    /// so the container must feed its in-flight work back into the next round
    /// itself, and a task without its paths cannot hold a boundary against
    /// anyone. Recomputing this in TypeScript would be a second parser, which
    /// is the defect this whole file exists to avoid.
    let chosenPaths: [String]?
    /// For `review`: accept, sendBack, escalate or wait, with the unmet
    /// criteria when there are any. A verdict without its reasons is a verdict
    /// nobody can argue with, which is the opposite of what a review is for.
    let verdict: String?
    let unmet: [String]?
    let note: String?
    let skipped: [String]?
    let error: String?
}

func fail(_ message: String) -> Never {
    let out = Answer(kind: "error", strays: nil, refusal: nil, allowed: nil, chosen: nil, chosenPaths: nil, verdict: nil, unmet: nil, note: nil, skipped: nil, error: message)
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
    emit(Answer(kind: "boundary", strays: strays, refusal: nil, allowed: strays.isEmpty, chosen: nil, chosenPaths: nil, verdict: nil, unmet: nil, note: nil, skipped: nil, error: nil))

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
        emit(Answer(kind: "retry", strays: nil, refusal: reason, allowed: false, chosen: nil, chosenPaths: nil, verdict: nil, unmet: nil, note: nil, skipped: nil, error: nil))
    default:
        emit(Answer(kind: "retry", strays: nil, refusal: nil, allowed: true, chosen: nil, chosenPaths: nil, verdict: nil, unmet: nil, note: nil, skipped: nil, error: nil))
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
                    allowed: false, chosen: nil, chosenPaths: nil, verdict: nil, unmet: nil, note: nil, skipped: nil, error: nil))
        exit(0)
    }
    var skipped: [String] = []
    var pick: Int?
    var pickPaths: [String] = []
    let now = Date()
    for number in candidates {
        if let existing = tasks.first(where: { $0.issue.number == number }) {
            skipped.append("#\(number): a task already exists for it "
                + "(\(existing.state.rawValue))")
            continue
        }

        // What THIS issue says it will touch.
        //
        // The first version of this loop asked about a hardcoded `rings/SR-00`
        // for every candidate, which made the answer independent of the
        // candidate. Measured on the deployment with two unrelated numbers, it
        // produced identical refusals naming identical holders - a reason that
        // had never looked at either issue. An uninformed refusal reads in a log
        // exactly like a careful one, which is what made it worth fixing rather
        // than tuning.
        //
        // No body, or a body with no boundary section, is NOT an empty conflict
        // set. It is an issue that has not said what it will touch, and
        // starting a bee on it means finding out by collision.
        guard let body = question.candidateBodies?[String(number)] else {
            skipped.append("#\(number): no issue body was supplied, so its "
                + "boundary is unknown")
            continue
        }
        // Every task is a spec. The rule is the operator's and this is where it
        // becomes checkable: an issue that is not one is skipped with the list
        // of sections it still needs, so the refusal is a to-do rather than a
        // shrug. Measured when this landed: 24 of 27 open issues were not
        // specs, which is why the swarm had one candidate and looked idle.
        let quality = QueenSpecQuality.judge(body: body)
        guard quality.delegatable,
              let owned = QueenIssueBoundary.paths(from: body), !owned.isEmpty else {
            skipped.append("#\(number): "
                + (QueenSpecQuality.shortfall(quality) ?? "declares no boundary"))
            continue
        }
        if !quality.isSpec {
            // Delegatable but incomplete: it can be worked, and the gap is
            // named so it can be closed. Refusing outright would stall the
            // swarm on paperwork; saying nothing would let a thin task through
            // and blame the bee for the ambiguity.
            skipped.append("#\(number): delegatable but "
                + (QueenSpecQuality.shortfall(quality) ?? ""))
        }

        let holders = QueenDelegationPolicy.conflictingTasks(
            for: owned, among: tasks, now: now
        )
        if !holders.isEmpty {
            skipped.append("#\(number): "
                + owned.joined(separator: ", ")
                + " held by "
                + holders.map(\.issue.slug).joined(separator: ", "))
            continue
        }
        if pick == nil {
            pick = number
            pickPaths = owned
        } else {
            skipped.append("#\(number): not first")
        }
    }
    emit(Answer(kind: "choose", strays: nil,
                refusal: pick == nil ? "nothing to choose" : nil,
                allowed: pick != nil, chosen: pick,
                chosenPaths: pick == nil ? nil : pickPaths,
                verdict: nil, unmet: nil, note: nil,
                skipped: skipped, error: nil))

case "review":
    // The verdict, made where the work is.
    //
    // `QueenReviewDecision` has compiled for Linux since the module split and
    // was reachable by nothing: `queend` exposed four decisions and this was
    // not one of them, so the container could start a bee and had no way to
    // judge what came back. A supervisor that can only dispatch is half a
    // supervisor, and the missing half was already in the binary.
    guard let verdicts = question.verdicts, let total = question.totalCriteria else {
        fail("review needs verdicts and totalCriteria")
    }
    let decision = QueenReviewDecision.decide(
        verdicts: verdicts.map { (criterion: $0.criterion, met: $0.met) },
        totalCriteria: total,
        committedFiles: question.committedFiles,
        priorSendBacks: question.priorSendBacks ?? 0
    )
    switch decision {
    case .accept:
        emit(Answer(kind: "review", strays: nil, refusal: nil, allowed: true,
                    chosen: nil, chosenPaths: nil, verdict: "accept",
                    unmet: nil, note: nil, skipped: nil, error: nil))
    case .sendBack(let unmet):
        emit(Answer(kind: "review", strays: nil, refusal: nil, allowed: false,
                    chosen: nil, chosenPaths: nil, verdict: "sendBack",
                    unmet: unmet,
                    // +1, the same as the Mac's call site: `attempt` is the
                    // number of the pass being ASKED FOR, so a task with zero
                    // prior send-backs is being returned for its second pass.
                    // Passing the raw count produced "Returning this for a 1th
                    // pass" - which is how this was noticed.
                    note: QueenReviewDecision.sendBackNote(
                        unmet: unmet, attempt: (question.priorSendBacks ?? 0) + 1
                    ),
                    skipped: nil, error: nil))
    case .escalate(let reason):
        emit(Answer(kind: "review", strays: nil, refusal: reason, allowed: false,
                    chosen: nil, chosenPaths: nil, verdict: "escalate",
                    unmet: nil, note: reason, skipped: nil, error: nil))
    case .wait(let reason):
        emit(Answer(kind: "review", strays: nil, refusal: reason, allowed: false,
                    chosen: nil, chosenPaths: nil, verdict: "wait",
                    unmet: nil, note: reason, skipped: nil, error: nil))
    }

case "spec":
    // Judge one issue body against the spec rule, on demand.
    //
    // The board needs this per issue and cannot spawn a process per card, so
    // it is here for tooling and for a person asking "what does #1279 still
    // need" without reading the parser.
    guard let bodies = question.candidateBodies, !bodies.isEmpty else {
        fail("spec needs candidateBodies")
    }
    // Every body in one call. The board wants a verdict per issue and a
    // process per card would be forty processes a round; the rule is cheap and
    // the spawn is not.
    var verdicts: [String: SpecAnswer] = [:]
    for (key, body) in bodies {
        let q = QueenSpecQuality.judge(body: body)
        let criteria = QueenSpecQuality.criteriaWithSource(from: body)
        verdicts[key] = SpecAnswer(
            delegatable: q.delegatable,
            isSpec: q.isSpec,
            missing: q.missing,
            remedy: q.checks.filter { !$0.met }.map(\.remedy).joined(separator: " "),
            criteria: criteria.items,
            criteriaSource: criteria.source
        )
    }
    emitSpecs(verdicts)

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
    emit(Answer(kind: "language", strays: nil, refusal: refusal, allowed: refusal == nil, chosen: nil, chosenPaths: nil, verdict: nil, unmet: nil, note: nil, skipped: nil, error: nil))

default:
    fail("unknown question kind: \(question.kind)")
}
