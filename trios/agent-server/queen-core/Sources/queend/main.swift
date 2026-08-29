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
}

struct Answer: Encodable {
    let kind: String
    let strays: [String]?
    let error: String?
}

func fail(_ message: String) -> Never {
    let out = Answer(kind: "error", strays: nil, error: message)
    if let data = try? JSONEncoder().encode(out) {
        FileHandle.standardOutput.write(data)
    }
    exit(1)
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
    let answer = Answer(kind: "boundary", strays: strays, error: nil)
    guard let data = try? JSONEncoder().encode(answer) else { fail("could not encode") }
    FileHandle.standardOutput.write(data)
default:
    fail("unknown question kind: \(question.kind)")
}
