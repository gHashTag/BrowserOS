# Release map - what stands between here and an autonomous Queen

Status: assessment, 2026-07-31. Numbers are measured, not estimated; where a
thing has not been measured this says so rather than guessing.

There was no such map before this one. `TRIOS_RELEASE_MANIFEST.md` records a
landing that happened on 2026-07-26, `.trinity/NIGHT_LOG.md` is a diary, and
`queen-spec-driven-delegation.md` covers one slice. None of them answers "what is
left".

## What autonomy has to mean before it can be called done

The Queen opens a chat per task, hands the worker a contract, watches the work
against that contract, corrects it while it runs, and closes the chat when the
forge says the work landed. Each clause is a thing that can be true or false.

## Done, and how it is known

| Capability | Evidence |
|---|---|
| Worker runs in its own chat on its own transport | `QueenWorkerRunner`; cassette `worker-happy-path` |
| Edits attributed to a per-task branch without moving HEAD | `QueenBranchCommitter`; 4 checks in the SSE suite |
| Looping, out-of-bounds writes and overspend detected | `QueenObserver`; 3 cassettes |
| A silent worker is restarted twice before being written off | R3; 8 checks |
| A merged pull request settles the task; a closed one returns it | R5; 18 checks |
| Live worker state reaches the supervisor pills | R6; observability is structural - removing @Published no longer compiles |
| Delegation lifecycle cannot dead-end | 17 checks, stated as a rule over `allCases` |

## Blocked on one answer from the repository owner

R1, R2 and R4 of the delegation spec - the contract itself. A task carries
acceptance criteria; a worker cannot declare itself done; the Queen corrects
against the criteria while the work runs.

All three wait on the same question: **who writes the acceptance criteria?** The
Queen drafting them from an issue is fast and is also how a misread issue becomes
a confidently wrong contract. The alternative is that no task starts until a
person approves its criteria.

This is not a large amount of code. It is one decision that changes what the code
should be, and guessing it produces something worse than the current state,
because a wrong contract is more convincing than no contract.

## Known debt, measured

- **XCTest: 55 compile errors across 10 files.** Was 76 across 17 four cycles
  ago. Mostly actor isolation, which is mechanical; the tail is protocol drift in
  mocks, which is not. Reported as 1651 until the counter was fixed to count
  errors rather than lines mentioning one.
- **Prototype budget: 16.** All sixteen compile. They are unwired features, not
  broken files, so lowering the number means deciding a feature is unwanted.
- **`TRINITY_ROOT` is a hard prerequisite.** The private Trinity Queen package
  lives in another repository; a clone cannot build without it.

## Not measured, and that is the honest gap

**Nothing here proves the Queen works against a live provider.** Every claim
above rests on cassettes, headless assertions and code reading. `make
delegate-probe` exists and has not been run this session. A cassette proves the
parser and everything above it; it cannot prove what the server does, and the
orphaned-tool-call repair lives in the server's prompt assembly.

So the single largest unknown before release is not on this list of tasks. It is
that the whole chain has been verified in pieces and not once end to end with a
real model, a real branch and a real pull request.

## The order that follows from the above

1. Run the live probe. Everything else is planning against unverified ground.
2. Answer the criteria question; implement R1, R2, R4.
3. Clear the XCTest debt, or decide out loud that it stays.
4. Decide the sixteen prototypes: wire or delete, one at a time.

Steps 2 and 4 need the owner. Steps 1 and 3 do not.
