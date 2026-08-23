// The hand-written policy, printing the same grid as the generated ring.
// If these two outputs ever differ, the spec and the code have drifted and
// the chain is broken - which is the only thing this file is for.
import Foundation

func retryVerdict(_ attempts: Int) -> Int {
    let kinds = Array(repeating: QueenFailureKind.workedButFailed, count: attempts)
    if case .escalate = QueenRetryPolicy.decision(priorAttempts: kinds) { return 1 }
    return 0
}

for a in 0..<5 { print("retry \(a) -> \(retryVerdict(a))") }
let kindOrder: [QueenFailureKind] = [.interrupted, .producedNothing, .workedButFailed]
for k in 0..<3 {
    print("counts \(k) -> \(kindOrder[k].countsAgainstTheIssue)")
}
for total in [0, 1, 3] {
  for judged in [0, 1, 3] {
    for unmet in [0, 1] {
      for files in [0, 2] {
        for sb in [0, 2] {
          // Build the verdict list the Swift API takes: `judged` answers, of
          // which `unmet` are false. The ring takes the counts directly, so
          // this is the only shape difference between the two callers.
          var verdicts: [(criterion: String, met: Bool)] = []
          for i in 0..<judged {
              verdicts.append((criterion: "c\(i)", met: i >= unmet))
          }
          let d = QueenReviewDecision.decide(
              verdicts: verdicts, totalCriteria: total,
              committedFiles: files, priorSendBacks: sb
          )
          let code: Int
          switch d {
          case .wait: code = 0
          case .accept: code = 1
          case .sendBack: code = 2
          case .escalate: code = 3
          }
          print("review \(total) \(judged) \(unmet) \(files) \(sb) -> \(code)")
        }
      }
    }
  }
}
