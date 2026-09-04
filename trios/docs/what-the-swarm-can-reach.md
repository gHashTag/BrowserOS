# What the swarm can reach

Answer to #1330. The question: most of the repository's work is unreachable to a
bee, so the nectar runs out long before the backlog does. A swarm that never
stops needs either work it can finish, or a worker that can finish the work.
This document names which, with evidence.

## Method

- Snapshot: 42 open issues (pull requests excluded), listed from the GitHub API
  at 2026-09-03T07:19:30Z and re-checked unchanged at 2026-09-03T07:29:02Z.
  The backlog moves hourly (#1333, #1334), so the count is a moment, not a law.
- Every issue was read in full and placed in exactly one class: the STRONGEST
  capability its own success criteria or "done when" section names, taken at
  face value. Where criteria name a command (`bun test`, `swift test`,
  `make`), the class is what running that command needs. Where criteria observe
  runtime behaviour (a round report, a board, a warm-up log), the class is what
  observing that behaviour needs. Where criteria are file checks (`test -f`,
  `grep`, `wc`, `git diff`), the class is a checkout and a shell.
- The classes, weakest to strongest: **A** none (a checkout and a shell);
  **B** a `bun test` run; **C** a Mac (its toolchain or its runtime);
  **D** a rendered screen; **E** the live production environment, the
  operator's machine, another repository, or a person; **F** a document build
  toolchain. A and B are inside the runtime image today; C through F are not.

## The counts

| Class | Strongest requirement | Count | Issues |
|---|---|---|---|
| A | None - a checkout and a shell | 8 | #1083, #1312, #1322, #1323, #1325, #1326, #1330, #1331 |
| B | A `bun test` run (in the image today) | 4 | #1291, #1308, #1324, #1328 |
| C | A Mac: swift build/test, make, Xcode, Keychain, the app | 14 | #1089, #1127, #1133, #1173, #1174, #1175, #1176, #1240, #1265, #1266, #1273, #1276, #1278, #1286 |
| D | A rendered screen - a person looks at the UI | 4 | #1084, #1085, #1086, #1244 |
| E | Live production, the operator's machine, another repo, or a person | 11 | #380, #1062, #1067, #1090, #1279, #1321, #1327, #1329, #1332, #1333, #1334 |
| F | A document build toolchain (LaTeX + qpdf) | 1 | #957 |

8 + 4 + 14 + 4 + 11 + 1 = 42, the number of open issues examined.

A bee in the current image can finish 12 of 42 as written (A + B). Thirty of 42
need something the image does not carry and cannot get by being larger (see
"What each addition would unlock" - only class F, one issue, is an image
problem at all).

## Why each issue sits in its class

One line each, from the issue's own criteria, not from its title.

- **A** - criteria are shell checks on files: #1330 (grep/wc on this document),
  #1331 (grep counts on `docs/ring00-authority.md`), #1322 (grep counts on
  `docs/queen-priorities.md`), #1323 (SC-001..014 are shell commands; the
  reproduction is `git ls-remote` against 127.0.0.1:1, no network), #1325
  (SC-001..016 are git/grep commands), #1326 (15 numbered sed/grep/wc checks),
  #1312 (`test -f` and grep on `docs/queen-selection.md`), #1083 (an info-drop
  with "No ask"; nothing in this repository to change).
- **B** - criteria name `bun test` or `bun run typecheck`, which the bun-based
  image can run offline: #1291 (`bun test ... queen-issue-language.test.ts`),
  #1308 (`bun test ... queen-dispatch.test.ts ...`), #1324 (offline gate
  scenario is written for "a worker checked out at the current HEAD in the bun
  container"; `bun run typecheck`), #1328 (fixture-shaped report checks plus
  grep on the report writer).
- **C** - criteria require compiling or running Swift on macOS, or its runtime:
  #1089 (25 test files must compile and run under XCTest), #1127 (verdicts
  visible in the log of the running app), #1133 ("proven by a run" of the
  supervisor), #1173-#1176 (the narrowing "measurements" require executing the
  chooser in `rings/SR-00`), #1240 (a real user key added to the macOS
  Keychain, warm-up success in the log), #1265 (`TRIOS_VENDORED=1` must
  build), #1266 (run `make check-selftest` with a planted mutation), #1273
  (parse ten `swift test` failures, gate on `swift test`), #1276 (`make
  cassettes` passes 4/4 with a live sentinel; fix already landed, criteria
  still name the Mac harness), #1278 (triage verified by full and isolated
  `swift test` runs), #1286 (`QueenReviewDecision` behaviour proven by a test
  that "breaks if the marker parsing is removed").
- **D** - criteria are comparative statements about appearance: #1244 (tabs,
  order, titles, icons, hotkeys "the same as they were"), #1084 (chips and a
  toggle menu in the LOGS tab), #1085 (Import/Export buttons with status
  feedback), #1086 (suggestions "shown inside the noise-profile sheet").
- **E** - criteria live outside any image: #1334 and #1090 (epics whose
  children include E-class work), #1327/#1329/#1332/#1333 (criteria observe
  the live round - see the caveat below), #1321 (Wave B demands HTTP 200 from
  t27.ai; Wave C a production capacity report), #1279 (the t27 repository and
  physical FPGA boards owned by another agent), #1062 and #1067 (the
  operator's machine: `/Users/playra/trios`, the menu-bar app, Console.app),
  #380 (the Neon SSOT database, a Zenodo DOI, and a human defense).
- **F** - #957: the rule is edited into `.tex` files, but the QA baseline
  ("150 A4 pages; `qpdf --check` clean") requires building the PDF.

### Caveat: four issues carry a document Boundary but runtime criteria

#1327, #1329, #1332 and #1333 each name a single document as their Boundary,
and each is counted in E above because their success criteria, as written,
observe the live round ("the round's own summary states...", "a dispatch ...
appears again in the following round's started list"). Read as spec-writing -
which their Boundary suggests - they are class A, and the reachable count
becomes 16 of 42. The table keeps the criteria-as-written reading because that
is what a reviewer judges against; #1326 exists precisely because "met" must
not be claimed without the run. The clean fix is on the issue side, and #1332
already names it: these four read like the "issue-defective" kind.

## What the image actually carries (quoted, not described)

From `agent-server/Dockerfile` at HEAD `01e16a13`:

> `FROM oven/bun:1.3.6 AS runtime`

> `RUN apt-get update \`
> ` && apt-get install -y --no-install-recommends git ca-certificates openssh-client \`
> ` && rm -rf /var/lib/apt/lists/*`

> `# The artifact is not shipped. It is the compile that is the evidence, and the`
> `# runtime image below carries no Swift.`

> `# Forces the Swift stage to run: BuildKit builds only what the final image`
> `# depends on, so a stage nothing copies from is a stage that never compiles`

and, four lines later, "The module itself is the evidence and it is tiny; the
Swift toolchain stays behind in that stage.", followed by:

> `COPY --from=queen-core /queen-core/queend /usr/local/bin/queend`
> `COPY --from=queen-core /usr/lib/swift/linux /usr/lib/swift/linux`

> `# No --cdp-port on purpose. See the header.` - and the header: "A browser.
> The server starts headless... Shipping Chromium here would triple the image
> to serve a surface nothing in the cloud path uses."

So: bun 1.3.6, git, ca-certificates, openssh-client, the production install
tree, `queend`, the Swift runtime libraries, no Swift compiler, no `make`, no
Xcode, no simulator, no screen, no browser. #1331 records that the deployed
image also carries `t27core` since 2026-09-03; the Dockerfile in this checkout
does not name it yet, and it changes no classification - it is a binary, not a
toolchain.

The machine writing this document is itself the evidence: Debian 13, bun 1.3.6,
and `which swift make gcc xcodebuild docker` prints nothing (measured
2026-09-03T07:18Z). This document was produced from inside class A.

## What each addition would unlock, and what it costs

Measured from the Docker Hub registry API on 2026-09-03; no docker binary
exists on a worker, so the registry's own numbers are the instrument. No
addition is recommended below; the costs are stated so the decision does not
have to be made by taste.

| Addition | Measured cost | Unlocks, of 42 |
|---|---|---|
| Swift toolchain (`swift:6.0-jammy`) into the runtime stage | +960 MiB compressed (1,007,144,563 bytes, `swift:6.0-jammy`, pushed 2026-08-18); 11.4x the 84 MiB `oven/bun:1.3.6` base (88,468,905 bytes). Build time is already paid: the queen-core stage pulls and compiles this exact image on every build today. | 0 issues fully. It compiles the eleven Foundation-only queen-core files - the build proves that already - but every class-C criterion needs AppKit, SwiftUI, XCTest app targets, `make`, or `build.sh` on macOS. The Dockerfile's own comment (lines 33-35, wrapped across three lines there) is the measured reason: "Combine, Security, CryptoKit and AppKit all import fine on a Mac and are absent on a server" (the file's sentence continues ", so a file that quietly acquired one would still pass that gate"). |
| Xcode, or any Mac | Not an image addition at any size: a search of Docker Official Images for "xcode" returns count 0 (measured 2026-09-03), and every `library/swift` image is linux-only. The Dockerfile's `FROM` lines are all Linux bases. | The 14 class-C issues - by a macOS runner, a different machine class, not a bigger image. |
| A screen | Not an image addition; the image is deliberately browser-free (quoted above), and the class-D criteria are comparative ("the same as they were") - written to a person's eye, not a screenshot diff. | The 4 class-D issues, only with screenshot tooling AND a Mac to render on; by an image alone, 0. |
| `texlive` + `qpdf` | +2,601 MiB compressed (2,726,851,513 bytes, `texlive/texlive:latest`, pushed 2026-08-30) - roughly tripling the runtime image. | 1 issue: #957. |
| Network beyond the model | ~0 MiB; the real cost is credentials and blast radius, and `ca-certificates` is already shipped for the server's own calls. | 0 on its own: the E-class issues need a production deploy (#1321, #1327-#1334), the operator's machine (#1062, #1067), another repository and boards (#1279), or a person (#380). |

The row that matters is Xcode: the biggest class in the backlog cannot be
bought with image size at all, on Linux, from this Dockerfile.

## The alternative, stated plainly (FR-005)

Write issues a bee can already finish. That means: every criterion names its
own proof command - a `grep`, a `wc`, a `bun test` - the shape #1322, #1325,
#1326 and this issue already use. The swarm's work then narrows to what reading
can verify: documents, specs, TypeScript, triage, contract-writing. 12 of 42
open issues are already in that shape; 4 more arrive by rewriting the criteria
of #1327, #1329, #1332, #1333 to match their document boundaries.

What it costs in the kind of work the swarm can do: the Swift application, the
UI, the PhD renderer, and the live loop stay human work, or wait for a macOS
runner. The backlog supply (#1327) must be written against that ceiling, or
the swarm starves again the moment the file-verifiable issues run out (#1333)
- the nectar runs out before the backlog does, exactly as measured. And a
swarm that only ever reads must be given criteria that carry their own
evidence, or its verdicts decay into claims - which is the failure #1326
documents and the reason this document's every number can be re-derived by
shell.

## Reconciling with the 2026-09-01 triage (7 of 23)

The 23 of that triage are, on today's data, the 21 issues open on 2026-09-01
that are still open now, plus #1291 and #1308 filed that morning. Under the
triage's three shapes - "these tests pass", "the build is green", "look at the
rendering" - the seven it could not hand to a worker are #1244, #1265, #1266,
#1273, #1276, #1278, #1089. The count matches; this document does not dispute
it. The difference is method: the triage asked what the criteria literally
say; this document asks what VERIFYING them requires. Under the stricter
question the same 23 split A:1, B:2, C:14, D:4, E:2 (= 23), and twenty need
what no bee has - because issues like #1240, #1133 or #1173-#1176 can be
*edited* by a bee but not *proven* by one. Both numbers are true; the decision
in #1330 should be taken against the stricter one, because a finished task
whose criteria were never checked is the one-attempt problem of #1329 wearing
a green tick.

## How every number here can be re-derived

- Issue set: `GET /repos/gHashTag/trios/issues?state=open&per_page=100`
  (GitHub API), exclude `pull_request`, count and classify.
- Image contents: `agent-server/Dockerfile` at HEAD `01e16a13`
  (`git rev-parse HEAD` in this worktree).
- Registry sizes: `GET /v2/repositories/{repo}/tags/{tag}` on hub.docker.com,
  field `full_size`, read 2026-09-03.
- Worker poverty: `which swift make gcc xcodebuild docker` on any bee - this
  one printed nothing.
