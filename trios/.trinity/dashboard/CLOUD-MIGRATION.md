# The backend in the cloud: what runs there now, and the one thing that cannot

Deployed and measured 2026-08-28 into Railway project `999`
(`564d9ebd-7aa8-44fe-93ec-e0b03c87158d`), environment `production`,
service `trios-agent-server`.

Re-run every command here before acting on it.

## Running now

```
$ curl -s https://trios-agent-server-production.up.railway.app/health
{"status":"ok","pid":1,"cdpConnected":false,
 "state":{"durable":true,"configured":true,"error":null}}
```

| piece | where it runs | proof |
|---|---|---|
| agent-server, 80 tools | Railway container, `0.0.0.0:8080` | `Consolidated HTTP Server started port=8080 host="0.0.0.0"` |
| A2A registry, task queue, conversations | Railway Postgres, schema `trios` | `A2A registry PostgreSQL backend ready`; tables `agents`, `agent_matrix`, `agent_tasks`, `conversations`, `conversationMessages` |
| the repository agents work in | container, `/workspace/BrowserOS` | `[entrypoint] checkout ready: dd58cf89 on feat/queen-supervisor` |
| filesystem and shell tools | container, on that checkout | a branch, a file write and a commit (`1250e224`) executed there over the wire |
| `git` for the commit path | container | the app's own `QueenGitExecutor`, run against the live service |

Nothing on this laptop is required for any of the above. The container was
redeployed four times during this work and came back each time on its own.

## What had to change to make it leave the laptop

Three things, each found by a deploy failing rather than by reading code:

1. **It exited when no CDP port was configured**, while tolerating a configured
   port with nothing behind it. A container has no browser at all, so the
   stricter of the two cases was the one that made it unshippable.
2. **It bound `127.0.0.1` unconditionally.** A platform routes to a container
   from outside; that server accepts nothing while looking healthy from inside.
3. **`serverPort` came only from a flag.** `PORT` is what platforms inject.

And one that only appeared in the image: bun does not hoist workspace links to
the root. Copying `/app/node_modules` alone produced an image that built
cleanly and died on its first import with *Cannot find module
'@browseros/shared/constants/exit-codes'*.

## Four holes, all opened by this migration, all measured

Putting a loopback-assuming server on the internet broke every assumption its
authorisation rested on. Each was found by measurement, and one only because a
review refuted a claim of mine.

| # | what was open | how it was proved | closed by |
|---|---|---|---|
| 1 | any `chrome-extension://` Origin admitted from anywhere | `curl -H 'Origin: chrome-extension://aaaa' .../mcp` returned 80 tools | trusted origins now also need a loopback socket; `TRIOS_API_TOKEN` |
| 2 | `/proc/1/environ` readable by agent shells - container ran as root | `tr '\0' '\n' < /proc/1/environ` printed GITHUB_TOKEN, DATABASE_URL, TRIOS_API_TOKEN | shells dropped to `bee`; the server keeps root |
| 3 | the six filesystem tools run in the **server** process, so the uid split never touched them | `filesystem_read /proc/self/environ` returned the server's environment; `/etc/shadow` too | `TRIOS_FS_ROOT` bounds all six, symlinks resolved |
| 4 | an agent's shell is a loopback client, and loopback was trusted without a token | `bun -e 'fetch("http://127.0.0.1:8080/mcp", ...)'` returned the tool list with no credential | a configured token disables the origin and loopback fallbacks |

**I reported the container sealed after #2 and was wrong.** #3 was still open,
and it was an adversarial review of the design - not my own checking - that
found it. The correction is recorded here rather than quietly fixed, because
the shape of the mistake matters: confining the shell felt like confining the
agent, and six tools that never used a shell were untouched.

#4 gained an attacker nothing on the day it was measured, since the caller
already held those tools. It is listed because the next route added would have
inherited it, and the route under discussion was one meant to hold a
credential that caller must not have.

## The first hole, in full

**Read this part even if you skip the rest.**

Giving the service a public domain made it reachable by anyone. Its entire
authorisation model was *where the request came from*, which is sound for a
server reachable from one machine and meaningless on the internet. Measured,
not reasoned:

```
$ curl -H 'Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
       https://<host>/mcp
{"result":{"tools":[ ... 80 tools ... ]}}
```

`filesystem_write` and `filesystem_bash` among them: remote code execution for
anybody who guessed the hostname. The exemption for extension origins was
written on the reasoning that a browser will not let a page forge that scheme.
True of browsers, irrelevant to `curl`.

The domain was deleted within minutes of measuring this, and the deployment
stayed private until the fix was live. Both directions are now proven:

| request | result |
|---|---|
| spoofed `chrome-extension://` Origin | `{"error":"Forbidden"}` |
| no credentials | `{"error":"Forbidden"}` |
| wrong bearer token | `{"error":"Forbidden"}` |
| correct `Authorization: Bearer $TRIOS_API_TOKEN` | 80 tools |
| `/health` | open, and must stay open - the platform probes it |

Two changes did it. Every trusted origin now also requires a loopback socket -
the guarantee the exemption actually rested on. And `TRIOS_API_TOKEN` admits a
caller by something it knows rather than somewhere it is, compared in constant
time.

`TRIOS_API_TOKEN` was generated inside the command that set it, so its value
never passed through this session. Read it from the Railway dashboard.

## No push credential lives in the container, and that is the design

A checkout the agents can write is a checkout whose `.git/config` and
`.git/hooks` they control. Both `credential.helper` and a `pre-push` hook are
shell commands, so any privileged git run inside that tree executes code of
their choosing with that process's environment attached. Measured in the
review: a planted helper captured root's whole environment; a planted
`pre-push` hook did the same.

So a token placed there to enable `git push` is a token they can take, and no
arrangement inside the container changes that - not an environment allowlist,
not a uid split, not a server-side route. The question is not where to hide it
but what it is worth once taken.

The answer is to not put one there. The agents commit; the Mac publishes. The
Mac is already load-bearing for `swift build`, so this adds no machine to the
trust chain. What is missing is the transfer that carries a branch out of the
container, and until it exists
`QueenDelegationPolicy.unpublishableWorkRefusal` refuses a remote delegation
rather than letting work be committed into a container the next deploy wipes.

If the Mac ever must leave the loop, the fallback is a deploy key or a
fine-grained token scoped to **one repository**, `Contents: write`, no
Workflows, pushing to a namespace a stolen credential can only cost. A classic
`ghp_` token reaches every repository its owner can, and must never be here.

## The boundary that is not a refactor

The Queen's acceptance path runs `swift build` on the combined tree
(`QueenBranchCommitter.swift:1155`). trios is an AppKit/SwiftUI application.
**That step cannot run on Linux at all** - not with more work, not with a
bigger container.

So the honest architecture is not "everything in the cloud" but a split along
a real line:

- **cloud** - the server, the state, the checkout, the agents' edits, and the
  git that turns those edits into a branch;
- **macOS** - compiling and verifying a macOS application, which is the client
  checking the work rather than a backend doing it.

A macOS CI runner is where that half belongs. It is a different cloud and a
different piece of work, and this document does not start it.

## git runs where the files are

The committer spawned `/usr/bin/git` directly, which is right exactly while
the server writing a bee's files runs here too. With that server in a
container the two parted company: the bee wrote there, the committer read
here, found an unchanged tree, and would have filed the task as *the worker
did nothing* - work reported as never having happened.

Location is a parameter now. `QueenGitExecutor` has a local implementation -
the committer's own `Process` code, unchanged - and a remote one that runs git
through the server's `filesystem_bash`, where the files already are. Four of
the committer's five spawns route through it.

Proven with the same binary, switched only by an environment variable:

```
local   isLocal=true   repositoryRoot=/Users/playra/BrowserOS
remote  isLocal=false  repositoryRoot=/workspace/BrowserOS
                       projectRoot=/workspace/BrowserOS/trios
```

`git log` and `rev-parse` answer from the container; an argument carrying a
quote and a semicolon survives quoting as data; a failing command is reported
as failed rather than as a broken transport.

`QueenDelegationPolicy.splitExecutionRefusal` still exists and still refuses
before spending a token, but it is keyed on the **split** rather than on being
remote, and asks `QueenGit.runsLocally` rather than assuming. With git remote
it no longer fires - it stopped by itself, instead of having to be found and
deleted.

What remains for delegation to run in the cloud end to end:

| step | state |
|---|---|
| bee edits files | in the container |
| `git` for branch and commit | in the container |
| pushing a branch | **needs `GITHUB_TOKEN` as a Railway variable** - the operator's act, like the DSN |
| `swift build` verification | cannot move; needs a macOS host |

The push credential is already wired: the entrypoint installs a git helper
that reads `GITHUB_TOKEN` from the environment at the moment git asks, so it
is never written into `.git/config` and never appears in `git remote -v`.
Unset, the boot log says so plainly:

```
[entrypoint] GITHUB_TOKEN unset; this checkout can read but not push
```

Cloning needs no credential - the repository is public - which is why reading
works today and pushing does not.

## Pointing the app at the cloud

`ProjectPaths.mcpBaseURL` takes `TRIOS_AGENT_SERVER_URL` from the environment,
then Info.plist, then falls back to loopback. Trailing slashes are stripped.
Proven both ways:

```
unset            -> http://127.0.0.1:9105        agentServerIsRemote = false
set to the cloud -> https://<host>                agentServerIsRemote = true
```

`AgentServerLauncher.startIfNeeded` refuses to spawn a local server when the
configured one is remote. Without that it would bind a port nothing talks to
and then read the remote's health as proof the spawn had worked.

## What is NOT measured

- Cost. Nothing here estimates Railway spend, and a container plus a schema in
  an existing database is not free.
- Latency from the app to the cloud on a real delegation. Every measurement
  above is a health check or a single tool call.
- Whether Redis, `Bucket` or `postgrest` should carry any trios load. Only
  Postgres was used.
- The `trios` schema shares a database with inngest's 14 tables. Separate
  schemas, no name collisions, and a restore of one would still take the other.
  A dedicated Postgres service is the cleaner answer and costs money.
- `railway.json` is deprecated in favour of `.railway/railway.ts` and keeps
  working until 2026-12-01. Not migrated.
- `.railwayignore` did not exclude what it names. `browseros-server.log` grew
  to 234 MB from local server runs and `railway up` timed out three times
  against `backboard.railway.com` while `*.log` sat in that file. Deploying
  from an rsync'd copy with the log excluded worked first try. The log is a
  live file two processes hold open and the LOGS tab reads, so it was left
  alone rather than truncated.
- One log line is misleading and was left alone: `PgAgentStore pool connected`
  is emitted even when the connection is refused, because `pg`'s Pool is lazy.
  `/health` carries the truth now.

## What a headless Queen actually costs, measured 2026-08-29

The plan said the target split was "3 import edits + 3 misfiled view files",
on the strength of a build that compiled without SwiftUI. That build was on
macOS, and compiling without SwiftUI is not compiling on Linux: Combine appears
in 10 ring files, Security in 4, CryptoKit in 7, AppKit in 3, Cocoa in 2.

**Portable today: 13 files, 3,778 lines.** All 25 `rings/SR-00/Queen*.swift`
import Foundation and nothing else - 7,168 lines - but 12 of them reference
types declared elsewhere, and the dependency closure walks from policy through
transport and auth into `KeychainSecrets.swift`, which imports Security. The
closure reached 54 files and 14,085 lines without converging. `make queen-core`
compiles the thirteen that do stand alone, as a ratchet.

**The SwiftPM split was attempted twice and reverted twice.** The second
attempt got much further, and the wall it found is not where either plan said
it would be.

What was PROVEN to work:

| step | result |
|---|---|
| `QueenCore` target holding eleven of the thirteen | **builds**, 187 s |
| `TriOSKit` depending on it | **builds, zero errors** |
| visibility pass | ~250 annotations, driven by the compiler as an oracle in both directions - adding `public` where it said "must be", stripping it where it said "non-local scope" |
| `import QueenCore` | 9 files, added by the same loop |
| `make sources-drift` | stayed green - the gate unions every `sources:` block, so naming files twice is not a divergence |

Two of the thirteen could not move: `QueenSelfAudit` and `QueenT27Acceptance`
are **constructed** from outside, and a public struct's memberwise initializer
stays internal in Swift. Moving them needs hand-written public initialisers -
API design, not a move.

**What actually stopped it: `build.sh`.** It compiles every source as ONE
module with a single `swiftc` invocation, so `import QueenCore` fails there and
the app cannot build at all - SwiftPM being happy is not the same as the app
building. Landing the split means teaching `build.sh` to compile QueenCore
first and pass `-I`, the way it already does for QueenUILib. That pattern
exists in the same file and is woven through ~200 lines of vendoring and
probing, in the script that is the list of record for `sources-drift`.

Reverted rather than half-landed: the tree is byte-identical apart from two
foreign edits that predate the session, `make` is green, `make queen-core` is
green, `make sources-drift` agrees on 198 sources.

The next session starts from a proven path and one named obstacle, instead of
an estimate: the module boundary works, and `build.sh` is what has to learn
about it.
---

## The tick moves: a lease, and a supervisor that wakes without a laptop

2026-08-29. Everything a round needs had been in the container for days - the
checkout, the tools, git, the registry, and the policy itself as a Linux
binary. What stayed on the Mac was the thing that *wakes up*. The apparatus was
cloud-resident and still could not start a round unless a laptop was open.

The obstacle was never the timer. It was that switching one on would create a
**second Queen**: a round reads the board, finds an issue unclaimed, and starts
a bee. Two rounds reading the same board both find it unclaimed. The boundary
system cannot arbitrate that - it is the thing being raced.

### Exclusion, measured

| | |
|---|---|
| where | `queen_lease` in Postgres, the one thing both sides can see |
| acquire | ONE statement. `SELECT then UPDATE` has a window where both read "free" |
| loser gets | zero rows, plus the incumbent's name - not an error, a normal outcome |
| stale holder | fence token, incremented every term; a write from an ended term is refused by the database, not by the caller's goodwill |
| release | expires the row, never deletes it - a reset counter lets term 5 outrank term 1 |

Proven on the deployment, against the real database, through the real route:

```
  6 contenders, fired together, at a free lease
    acquired=False holder=contender-4    fence=2
    acquired=False holder=contender-4    fence=2
    acquired=True  holder=contender-4    fence=2
    acquired=False holder=contender-4    fence=2
    acquired=False holder=contender-4    fence=2
    acquired=False holder=contender-4    fence=2
  VERDICT: exactly one Queen
```

The five losers all name the winner. That is the property that matters: a
supervisor that cannot say who displaced it produces an operator who cannot
tell a quiet hive from a broken one.

### The round, running in the container

```
  lease  : held by 9680f61f-5649-41bf-ada3-484b53618805:1  fence=1
  tick   : same holder, fence=1, at 2026-08-29T12:22:43
  decided: allowed=False chosen=None refusal=nothing to choose
```

Nobody asked for that round. It fired on its own interval, took its own lease,
read the registry out of Postgres, asked GitHub what was open, and handed the
decision to `queend` - the same eleven Swift files the app uses, compiled for
Linux.

The refusal is correct and was checked rather than assumed, by two independent
methods: the issues endpoint returned 10 items of which 0 were issues, and the
search API independently reports **0 open issues, 10 open PRs**. There is
genuinely nothing to delegate. A tick that had invented something to do would
have been the more alarming result.

### The Mac contends too

Exclusion between cloud replicas is the easy half and not the half with two
Queens in it. `QueenLease` (SR-01) takes the same lease over HTTP before the
app's autonomous round runs, and covers the resume as well as the choice -
a resumed task starts a worker exactly like a new one.

When the lease cannot be reached, it **refuses**. A round not run costs half an
hour. Two Queens running costs a board nobody can untangle, discovered later by
whoever reads the merge conflict.

### What is still on the Mac, named

Dispatch. The tick chooses and records; starting the bee is still driven by the
app. The container can cut a worktree and run a worker - that is proven - but
the two halves are not yet joined. This is written into the source file itself
rather than left for a reader to discover, because a loop that appears to run
and quietly does half the job is the failure this record keeps documenting.

### Three reds that were mine

`make check` had not been run since the `queen-core` work landed, and all three
failures came from it:

1. `make-dollars` failed on the real Makefile - `$(QUEEN_CORE_FILES)`,
   `$(QUEEN_CORE_FLOOR)` and the two `*_LINUX_FILES` lists were never added to
   `MAKE_DOLLAR_VARS`.
2. A Sendable warning: making `QueenCriterionVerdict` public for the module
   un-Sendable'd it, because a public enum is not implicitly Sendable. Four
   cases, no associated values - nothing about the type changed, only what the
   compiler is allowed to assume.
3. The `QueenDelegation` suite reported **compile failed** and had done since
   the module split. `QueenDelegation.swift` now opens with `import QueenCore`,
   and the e2e runner hands swiftc a list of files with no `-I`. The commit
   that caused it claimed "120 delegation checks against the real module" - the
   checks had stopped running. They run again now, and there are 120 of them.

The runner detects the need from the sources rather than a per-suite table: a
table entry is a second statement of a fact the file already makes, and the two
go out of step the first time a suite gains the import.

### The two targets that would not run, measured

`make check` is green through `dev`, `warnings` (0 across 195 files) and `test`
(the e2e report includes `[OK] Swift logic tests (QueenDelegation): passed`).
`cassettes` and `mutants-changed` did not run.

Not a new failure: the Makefile documents this wedge across waves 069-082, and
`TRIOS_SKIP_LOCK` exists as its bypass. What is new is where it wedges. The
recipe's FIRST statement is `echo "[SKIP-LOCK probe] seen=..."`, before any
branch and before any lock call. With the lock directory confirmed absent and
zero processes driving the test bundle:

```
  lock directory exists? NO
  a real replay driving the bundle? 0 process(es)
[OK] harness bundle built: .../trios-test.app
[cassettes] acquiring the harness lock (/tmp/trios_harness.lock)
   <nothing, for twenty minutes>
```

The probe line never appears. So the recipe shell is not wedging in the
acquire loop - it is not reaching its own first command. `TRIOS_SKIP_LOCK`
cannot help, because the branch it controls is downstream of an echo that never
runs. Any future work on this should start at exec, not at the lock.

---

## Dispatch: written, wired, and unreachable for two measured reasons

The tick chose and stopped. This is the other half - worktree, briefing, agent
turn - plus two defects the attempt to prove it uncovered.

### The heartbeat, because my first TTL reasoning was wrong

I set the lease TTL to three times the tick interval and renewed it only when a
round ran, on the reasoning that "the TTL must outlive a round". That is sound
only if renewal and work are the same event. They are not, and the deployment
showed it within the hour:

```
14:36:18 Queen tick starting        holder="f2375165-...:1"
14:36:18 Queen lease held elsewhere  holder="9680f61f-...:1"
         self="f2375165-...:1" expiresAt="15:52:42"
```

A deploy replaced the container; the old holder died without releasing; its
lease went on holding the hive for **ninety minutes** while the new one
correctly stood down every round. Nothing was malfunctioning - the lease was
faithfully describing a process that no longer existed.

The TTL is a LIVENESS window, not a work window. A heartbeat now renews every
60s against a 180s TTL, so a dead holder frees the hive in under three minutes
and a round may take as long as it likes. Measured after the fix: **149s of
remaining TTL** where there had been 5400.

### The refusal that had never looked at the issue

`queend`'s `choose` asked about a hardcoded `rings/SR-00` for every candidate,
because the boundary parser lived in the app's view model and the container had
no way to read one. Two unrelated numbers, on the live deployment:

```
#9999: its files are held by trios#1286, trios#1127, trios#1174
#8888: its files are held by trios#1286, trios#1127, trios#1174
```

Identical reasons for issues with nothing in common, because the reasoning never
looked at either. **An uninformed refusal reads in a log exactly like a careful
one**, which is what made it worth fixing rather than tuning.

`QueenIssueBoundary` (SR-00, and in QueenCore) now owns that rule for both the
app and the container - the view model forwards to it. After the fix, same call:

```
#9999: no issue body was supplied, so its boundary is unknown
#8888: no issue body was supplied, so its boundary is unknown
```

True: neither number exists. The reason now describes the candidate.

Three answers are kept distinct on purpose, and are pinned by 8 new checks in
the QueenDelegation suite (120 -> 128): paths, **nil** for no section at all,
and **[]** for an empty one. An issue that has not said what it will touch has
not said it touches nothing.

### Why dispatch has not run, exactly

Two stacked reasons, each measured, neither of them a coding gap:

1. **Nothing to choose.** 0 open issues (confirmed twice: the issues endpoint
   returns 10 items of which 0 are issues; the search API independently reports
   0 issues / 10 PRs). And all 67 closed issues without a task: **zero** - every
   closed issue already has one, so no real candidate can pass the first guard.
2. **No provider credential.** The live `/chat`, asked directly:
   `{"message":"z.ai provider requires apiKey"}`. The deployment's whole
   variable list contains no provider key.

So dispatch refuses at its first step, and that step is FIRST by design: the
credential is checked before git is touched, because a worktree cut for a bee
that cannot run is litter, and a refusal after side effects is one somebody must
clean up before they can read it.

The refusal names every variable that would fix it and says who may set it. Not
me: entering an API key is not something I do, whoever asks.

**Unproven, stated plainly:** no bee has been started by the container's own
tick. The worktree step and the turn step have not executed. Everything before
them has.

---

## The monopoly, and the three secrets

### A lease held forever is not exclusion

The heartbeat fixed the dead-holder problem and created a worse one: a healthy
container renewed the lease for the life of the process, so a second supervisor
asking for it would be refused **every time it ever asked**. That is not
exclusion, it is a monopoly - and it is the real reason the Mac's address could
not be switched on. Configuring it would have configured the app to stand down
permanently.

A lease is for the duration of the WORK. Acquire at the start of a round,
heartbeat through it, release at the end - including when the round throws,
because a round that fails still had its turn. Between rounds the lease belongs
to nobody.

Proven on the live deployment, the full alternation:

```
1. a Mac-shaped contender takes the free lease   acquired=True
2. the container's round while it is held         ran=False  held by mac-standin
3. the Mac hands it back                          released=True
4. the container's next round                     ran=True
5. afterwards                                     FREE
```

Step 2 is the one that matters: the container did not queue, did not fail, did
not force its way in. It said whose turn it was and skipped its own.

### Where the token can live now

`QueenGit.remoteToken` read only `TRIOS_API_TOKEN` from the environment, and a
GUI app launched by `open` inherits no shell - the watchdog relaunches it with
none either. So the variable was never going to be set in the process that
needed it, and every remote call the app could have made was unauthenticated
forever. It now falls back to the Keychain, with `allowsInteraction: false` so a
missing ACL answers "absent" instead of blocking a headless round on a dialog
nobody is there to click.

`build.sh` can bake `TRIOS_QUEEN_LEASE_URL` into the bundle, the way the ports
and the variant already travel. A public hostname, not a secret; the token that
goes with it is a secret and is why it is not there.

**Baked, then deliberately un-baked.** With the address set and no token, the
lease gate correctly reads "a supervisor address is set but no token is" and
refuses - so the app stood down on every autonomous round. That is a regression
the operator did not ask for, and shipping it to satisfy a checklist would trade
a race that cannot currently happen for a supervisor that certainly stops. The
address goes in when the token does, in that order, with one command each.

### The three secrets, and why none of them are mine to install

The backend is in the cloud. What is not in the cloud is credential material,
and that is an authorization boundary rather than a location problem:

| secret | what it unblocks | who |
|---|---|---|
| a provider key on Railway | a bee can think at all | operator |
| a push credential | work leaves the container without the Mac | operator |
| `TRIOS_API_TOKEN` in the Mac Keychain | the Mac contends for the lease | operator |

Each is one paste. None is a paste I make: entering an API key or token into a
field is not something I do, whoever asks and however the value arrives.

---

## The tick reached dispatch, and my "empty board" was the wrong repository

### A correction

I reported "0 open issues, confirmed twice, by two independent methods". Both
methods were pointed at **`gHashTag/BrowserOS`** - the git remote of the
monorepo. The Queen's issues live in **`gHashTag/trios`**, which every slug in
her own registry says plainly: `gHashTag/trios#1286`. Two independent methods
against the same wrong repository are not two confirmations; they are one
mistake, checked twice.

The right repository has **40 open issues**.

What gave it away was `issue 1090 -> 404` from inside the container, on an epic
that certainly exists. A 404 for something known to exist is worth more than a
0 for something assumed absent.

### The round, end to end

```
  #1244  branch=queen-1244  started=False   at 15:13:02
    no provider credential in this deployment - set one of ZAI_API_KEY,
    ANTHROPIC_API_KEY, OPENROUTER_API_KEY, MOONSHOT_API_KEY, OPENAI_API_KEY.
    Only the operator can.
```

Everything before the credential ran: the lease was taken, the registry read,
40 candidates fetched, and `queend` picked #1244 - *QueenTabView написан под
удалённый API trinity* - because its declared boundary,
`BR-OUTPUT/QueenTabView.swift`, is held by nobody. The choice was made by the
Queen's own policy, compiled for Linux, against a boundary parsed by the rule
the app uses.

And the ordering claim is now measured rather than read:

```
/workspace/BrowserOS  338a8c6f [feat/queen-supervisor]
branches: 0
.worktrees: 0
```

A refusal that leaves no branch and no directory behind. The credential check
runs before git is touched, so the round costs nothing when it cannot proceed.

### The board the container decides against

The registry mirror is written by the app and knows nothing about what the tick
started. Without feeding its own dispatches back, a round would choose an issue,
dispatch a bee, and thirty minutes later find the same issue unclaimed and
dispatch another - forever, each new bee cutting a branch over the last one's.
The symptom would be a swarm that looks busy beside a registry that never grows.

In-flight dispatches are now shaped as running tasks and merged into the board,
so BOTH guards apply: "a task already exists for it" and the boundary conflict
check. That is why `queend` now returns `chosenPaths` and the dispatch row
stores them - a task holding no paths holds nothing against anyone.

### One line left

The single remaining step for a bee to run in the cloud is a provider key on the
deployment. The refusal names every variable that would do it. Not a paste I
make.

Noted in passing: the container's anonymous GitHub budget is 60/hour and a burst
of diagnostic rounds spent 33 of them, with one round failing `GitHub returned
403`. The normal path costs one request per round; the diagnostic override costs
one per candidate.

---

## A dispatch that could not end, and two self-inflicted outages

### The defect I reproduced in my own code

`dispatchBee` recorded `started=true` and there it stopped. Nothing wrote an
ending, so the row stayed in flight for ever - and the in-flight query fed it
back into every future round as a running task holding
`BR-OUTPUT/QueenTabView.swift`. That issue could never be chosen again.

Which is precisely the defect this session named as **what actually binds the
swarm**: `awaitingReview` is not terminal, so a parked task holds its boundary
permanently and #1286 held one for five days. I read that, wrote it down, and
then built the same thing again one layer down.

Three fixes:

- the stream's end writes the outcome, **including on the error path** - a bee
  whose connection dropped is a bee that is not working, and calling it running
  is how the boundary leaks;
- a reaper releases dispatches with no completion after two hours, because a
  container redeployed mid-turn takes its streams with it and leaves nobody to
  write the ending. It runs **before** the board is read: a board read first is
  a board with phantom work on it;
- a refusal is recorded as already ended. "Refused an hour ago" and "running for
  an hour" are the two states an operator most needs to tell apart.

```
#1244  started=False  ended=2026-08-29T15:43:46
   no provider credential in this deployment - set one of ZAI_API_KEY, ...
```

### Two outages, both mine

**A backtick in a comment.** The migration SQL is a JavaScript template literal.
I wrote `` `awaitingReview` `` inside a SQL comment, which ended the literal:

```
ReferenceError: awaitingReview is not defined
  at /app/apps/server/src/lib/db/pg-migrate.ts:133:1
```

The server 502'd on deploy. A note *about* a stuck boundary took the whole
service down. The comment now says so, in the string, so the next person writing
prose in there knows it is code.

**A silent no-op, twice.** I patch files with Python `.replace()`. Twice I
omitted the assertion, the anchor had been reformatted by biome, and the edit
did nothing while the surrounding edits landed - producing, first, a `drain()`
called with four arguments and defined with two, and second, a route that
SELECTed `finished_at` and never put it in the response. The second cost two
deploys of debugging a column that was correct the whole time, because a missing
key and a null value look identical from outside.

Every anchor gets an assert. A patch that cannot fail is a patch that cannot be
trusted to have happened.

---

## The "system-layer exec anomaly" was a backtick in a comment

Fourteen waves of `make cassettes` wedging, a documented bypass that never
worked, and a note in my own memory saying the fix "starts at exec, not the
lock". All of it wrong, and the cause fits on one line:

```make
	: "Several agents share this tree and each runs `make check`. Two"; \
```

A `: "..."` line reads exactly like a comment. It is not. Backticks inside a
double-quoted shell word are **command substitution**, so bash ran `make check`
- a target that depends on `cassettes`, which ran the line again. A recursion,
terminated only by whatever the lock did that day. When the lock was changed
from fail-fast to *wait*, the terminator went with it and the recursion became a
permanent hang.

Everything that looked inexplicable follows:

| symptom | why |
|---|---|
| the recipe's first `echo` never printed | the shell was still in the `:` line before it |
| "wedges with the lock free" | it was never waiting on the lock |
| `TRIOS_SKIP_LOCK` did nothing | the branch it controls is downstream of the line that never returns |
| a wedged line "carrying no sleep child" | the child was a nested `make`, not the watchdog |

Measured, three ways:

```
bash -c ': "each runs `echo COMMAND-SUBSTITUTION-RAN >&2`. Two"'
  -> COMMAND-SUBSTITUTION-RAN

pgrep during a wedged run:
  20721 make cassettes
  21179 make check          <- spawned by the "comment"
  30195 make check
```

And with the two backticked notes rewritten, running to a file rather than a
pipe so nothing could be blamed on buffering:

```
t+20s   [SKIP-LOCK probe] seen=        <- has never printed since wave 069
t+180s  make: *** [cassettes] Error 1  <- a verdict, at last
nested_make=0 throughout
```

### What the suite says now that it runs

Four failures, **newly visible rather than newly caused** - nobody has seen this
target's output in fourteen waves:

```
FAIL - commits the file its cassette declares
       (alive 126s, log grew nothing for 120s, queen.branch.committed absent)
FAIL - notices a bee repeating one call        (exited after 4s, no queen.observer.looping)
FAIL - notices a write outside the boundary    (exited after 2s, no queen.observer.outOfBounds)
FAIL - names a tool call the stream never answered
ok   - the branch sweep spares work it did not create
```

Not fixed here. They are real findings and deserve their own attention rather
than being folded into a migration commit.

### The guard

`make recipe-backticks` fails on any backtick surviving in a recipe line after
shell comments and single-quoted spans are removed. Same shape as
`make-dollars`, same reason: prose in a recipe is code, and this repository has
now been bitten by that twice in one day - once in a Makefile `:` note, once in
a JavaScript template literal holding SQL. Proven both ways: clean on the tree,
red when the offending line is put back, clean again when it is removed.

---

## The four cassette failures are one cause, and it is not in the cassettes

With the backtick gone the suite runs, so its failures can be read for the first
time since wave 069. All four are the same thing.

The harness launches `trios-test.app` with `TRIOS_E2E_DELEGATE` and
`TRIOS_REPLAY_CASSETTE` and waits for a marker. Measured directly, bypassing
LaunchServices so `open --env` could not be blamed, and watched for 75s:

```
t+15s..t+75s   alive=0   lines=9   server.launch=0   queen.selftest=0

events emitted, in full:
  skills.loaded
  queen.key.warmup
  queen.delegate            <- gHashTag/trios#1151, to "drill"
  queen.transition
  conversation.persist.heal_sweep
  queen.review.characterCount
```

Two things are absent and both matter. `queen.selftest.start` never fires -
`runDelegationSelfTestIfRequested` logs it unconditionally once the spec parses,
and logs `queen.selftest.failed` if it does not, so neither line means the
function was never reached. And `server.launch` never fires either, which places
the stall earlier still: in `main.swift` the self-test sits inside the same
`Task` as `AgentServerLauncher.startIfNeeded()`, `server.launch` and
`QueenBackgroundService.start()`, and none of them logged.

Meanwhile a delegation DID happen - #1151, chosen by the app itself, worker
"drill" - which is the ChatViewModel launch bootstrap on a different path. So the
app is not crashing. It does its own autonomous round and exits before the Task
carrying the self-test gets anywhere.

**One cause, four symptoms.** No cassette is ever replayed, so no marker can
ever appear, and each of the four reads as its own broken observer:

```
FAIL - commits the file its cassette declares
FAIL - notices a bee repeating one call
FAIL - notices a write outside the boundary
FAIL - names a tool call the stream never answered
```

Nothing here says the observers are broken. It says they were never asked.

**Not fixed, deliberately.** The fix belongs in `main.swift`, which carries
another agent's uncommitted work. Editing it would land their half-finished
change with mine. Their diff is unrelated (an answer-preview string in a probe
verdict, #1162), so this is not their defect either - it is simply their file
today.

---

## A bee ran in the container, under the Queen, with no credential anywhere

The dispatch chain had never once executed. It has now - three times, in
parallel - and nothing secret was installed to do it.

### How, without a key

`openai-compatible` is the one provider whose factory requires a `baseUrl` and
**no** `apiKey`. And this repository already proves worker behaviour by replaying
a recorded stream instead of calling a model: that is what
`TRIOS_REPLAY_CASSETTE` does on the Mac. Putting those two together, a route
inside the container speaks OpenAI chat-completions and streams a scripted
reply, and the worker provider points at it over loopback.

Guarded like everything else. The in-container client presents **this server's
own token** as its `apiKey`, which `openai-compatible` puts in the Authorization
header - the same door, used by the process itself, not a new one.

Off unless `TRIOS_QUEEN_REHEARSAL` is set, and never the silent fallback on a
deployment that has a real key: a hive that quietly rehearses instead of working
is worse than one that stops, because it reports success.

### What ran

```
16:13:06  Queen dispatch        issue=1244 branch="queen-1244" started=true
                                cut from feat/queen-supervisor
16:16:32  Queen rehearsal turn  model="rehearsal"
16:16:32  Queen worker turn finished  conversationId=f20e33b7-…  issue=1244
```

Lease taken, stalled dispatches reaped, board read from Postgres, 40 candidates
fetched, `queend` chose #1244 by its own declared boundary, a worktree cut on
its own branch, a turn opened, the stream consumed, the dispatch recorded
finished.

**Say plainly what this is not.** No bee thought. The reply is scripted; nothing
read the issue or wrote code. What is proven is the plumbing - the part that had
no evidence at all, only code review.

### Two defects found by making it run

**`userWorkingDir`, not `workingDirectory`.** The chat schema names it the first
way and ignores unknown keys, so my wrong name was accepted in silence and every
bee would have worked in the shared checkout while its branch lived in a
worktree - edits and branch in different trees, the exact failure the worktree
exists to prevent.

**git ran as root.** The image splits uids deliberately and the entrypoint says
"git runs as bee; root does not enter the checkout". Mine did:

```
git fetch failed: fatal: detected dubious ownership in repository at
'/workspace/BrowserOS'
```

The tempting fix is `safe.directory`; it is the wrong one, because it tells git
to stop minding exactly what the uid split exists to enforce. Dropping to bee
through the same helper every agent shell command uses keeps the split and
satisfies git for the real reason.

### Parallel bees under the Queen, measured

```
#1240 -> started    (rings/SR-02/ChatViewModel.swift, free)
#1216 -> started    (docs/queen-choice.md, free)
#1176 -> REFUSED    rings/SR-00/QueenLocalisation.swift held by trios#1174
#1286 -> REFUSED    a task already exists for it (cancelled)
```

Two started, two refused - for **different, issue-specific, correct** reasons.

```
/workspace/BrowserOS/.worktrees/queen-1216  [queen-1216]  owner bee
/workspace/BrowserOS/.worktrees/queen-1240  [queen-1240]  owner bee
/workspace/BrowserOS/.worktrees/queen-1244  [queen-1244]  owner bee
```

### The answer to "how many in parallel"

Three numbers, and only the smallest one matters:

| bound | value |
|---|---|
| container capacity | dozens - 96 concurrent calls with no degradation, 200/200 in 3.1s, 24 vCPU / 24 GB / 1000 pids at 5-10% under load |
| the Queen's policy | **4** - `QueenDelegationPolicy.maximumConcurrentWorkers` |
| what actually binds | **boundaries** - 16 of 40 open issues declare one, and #1174's parked review holds `rings/SR-00/QueenLocalisation.swift` against four of them at once |

The hardware was never the limit. It is the boundary ledger, and a review nobody
has given a verdict on.

---

## A real bee, a real model, a real commit - and the boundary it stepped over

The operator set `ZAI_API_KEY` and removed the rehearsal flag. The first round
after that failed, and the failure was mine:

```
chat answered 500: {"message":"z.ai provider requires apiKey"}
```

The key WAS in the deployment. `/chat` resolves a provider from what the CALLER
supplies - its usual caller is an app on somebody's laptop holding its own
credentials - and the server does not go looking in its own environment. My
`resolveWorkerProvider` found the key and then did not hand it over, so the
round got past the credential precheck and died at the chat route with the exact
sentence that precheck exists to prevent. A key that was never passed reads
identically to a key that is not there.

With the key travelling alongside the choice:

```
выбрана : 1244 ['BR-OUTPUT/QueenTabView.swift']
started : True
detail  : reused an existing worktree; zai/glm-4.6
```

And four minutes later, in the container, on the bee's own branch:

```
e52f41ad Trinity Bee <bee@trinity.local>
feat: seal QueenTabView.swift against embedded-trinity-queen-ui spec

 trios/.trinity/seals/QueenTabView.json | 16 ++++++++++++
 trios/BR-OUTPUT/QueenTabView.swift     | 30 +++++++++++++---
```

A bee chose by the Queen, briefed by the Queen, running a real model in a
container with no laptop involved, writing real code and committing it.

### And it wrote outside its boundary

#1244 declares exactly one path: `BR-OUTPUT/QueenTabView.swift`. The commit
carries two. `trios/.trinity/seals/QueenTabView.json` is a new file nobody
reserved for it - defensible work, and outside the boundary all the same.

**Nothing noticed.** The log has no `queen.observer.outOfBounds` for it. That
observer's cassette is one of the four that has never run since wave 069 - so
the very first real cloud bee did the thing those cassettes exist to catch, and
the catching is the part that is still broken.

That is the honest state to end on: the loop runs, and its supervision has a
measured hole in it.

---

## The prompts were computed and never sent

The largest defect this session found, and it had been there the whole time.

`ChatRequestBuilder.build()` assembles a `messages` array - the system prompt,
the conversation history, the current turn - and puts it in the request body
under the key `messages`. **The server has no such field.**
`grep -c messages` on `agent-server/apps/server/src/api/types.ts` returns **0**,
`ChatRequestSchema` is a plain `z.object` with no `.passthrough()`, so zod
strips the key before any handler sees it.

The server accepts, and has always accepted, exactly the two fields that were
being thrown away:

```
types.ts:42   userSystemPrompt: z.string().optional()      -> prompt.ts:649
types.ts:82   previousConversation: ...                     -> chat-service.ts:378
```

So on every send, for as long as this has been here:

| computed | arrived |
|---|---|
| the Queen's own prompt - her commands, her skills, her voice | nothing |
| every bee's prompt - who it is, which issue, which checkout, its boundary | nothing |
| the reviewer's prompt | nothing |
| the conversation history | nothing |

All three ran as the generic assistant with an empty preferences block. Which
explains a thing that had no other explanation: a bee behaves like a stranger to
this project no matter how carefully its briefing is written, because the part
that told it what it was never left the laptop.

The codebase had already recorded the cost without naming the cause - a comment
at `ChatViewModel.swift:12320` describes a bee that "found an unrelated old
checkout under ~/gitbutler and edited that instead, so its branch here stayed
empty." The sentence that would have prevented it was computed on every send and
dropped on every send.

Fixed by sending them in the fields the server reads.

## The cloud bee was worse off than that

Three things it never got, each one variable away in the same function:

- **its boundary.** `queend` computed it per candidate and refused three other
  issues on the strength of it, then never told the bee it constrains.
- **the issue body.** The brief opened with "Read the issue first" - impossible
  in that container: the image has git, ca-certificates and openssh-client, no
  `gh`, and the agent shell's environment is scrubbed to ten entries with
  GITHUB_TOKEN deliberately excluded. The only description of the task it
  received was the number.
- **an identity.** No `userSystemPrompt` at all.

All three now travel with the dispatch.

## And the work does not survive a deploy

The Dockerfile said "A volume mounts here in production so a redeploy does not
throw away an in-flight worktree." No volume was ever created. Measured inside
the running container:

```
df -h /workspace        -> overlay (the container's own layer)
mount | grep workspace  -> nothing
git reflog              -> "clone: from https://github.com/gHashTag/BrowserOS.git"
railway volume list     -> one volume, redis-volume, on the Redis service
```

Every redeploy re-clones. It has already cost a real commit: `e52f41ad`, the
seal a real model wrote for #1244, gone with the deploy that followed it. The
comment described an intention and read as a fact, which is exactly the defect
class this repository keeps writing skills about. It now states what is true and
names the command that would make it false.

## Four bees, at the Queen's own ceiling

```
#1176 РАБОТАЕТ  zai/glm-5.3
#1216 РАБОТАЕТ  zai/glm-5.3
#1240 РАБОТАЕТ  zai/glm-5.3
#1244 РАБОТАЕТ  zai/glm-4.6

next round -> refusal: "4 workers already running (limit 4)"
```

Not a hardware limit and not an error: `QueenDelegationPolicy.
maximumConcurrentWorkers`. The container measured 96 concurrent calls without
degradation; the Queen allows four. glm-5.3 is confirmed live rather than
assumed - three bees are running on it.

## The dashboard

`/queen/dashboard` on the deployment, in t27.ai's own palette: black, #00FF88,
#FFD700, and a type and spacing scale on phi - which here is the L5 identity
law rather than decoration.

The shell is unguarded and holds no state; every byte it shows comes from
`/queen/lease`, which stays guarded. The obvious alternative - a token in the
URL - is the one thing that must not happen, because query strings end up in
logs, proxies, history and shared links. The operator pastes the token into the
page, the browser keeps it for the tab, and it travels in an Authorization
header like every other caller's.

```
shell, no token  -> HTTP 200
data,  no token  -> HTTP 403
data,  token     -> HTTP 200
```

---

## The volume, and two things it revealed

`railway volume add --mount-path /workspace` — `trios-agent-server-volume`, 50 GB.

Proven the only way that counts, across a real redeploy:

```
before   echo "проба-персистентности 09:05:48" > /workspace/PERSIST-PROBE.txt
redeploy
after    проба-персистентности 09:05:48
         /dev/zd29056  46G  /workspace          <- a block device, not overlay
         git reflog -1: "checkout: moving from feat/queen-supervisor"
```

That last line is the one to read twice. Before the volume the reflog said
`clone:` on every boot; now the entrypoint finds the checkout already there. A
bee's branch, its worktree and its commits survive a deploy.

### The board was describing bees that no longer existed

Mounting it surfaced something worse than the lost work. The dispatch board
reported **four bees running** while the container held one worktree and zero
commits: three of the four had been killed by redeploys, and nothing told the
board. Those rows went on holding their boundaries against every overlapping
issue, and the two-hour stall sweep would not have noticed for two hours.

A container that has just booted is not running any turn it dispatched before -
the stream, the session and the process all died with the old container. So the
tick now clears them on the way up, and said so on the first boot after:

```
Queen tick reaped dispatches from a previous boot  issues=[1244,1240,1216,1176]
```

A supervisor whose board says "busy" about work that does not exist will refuse
real work on its behalf. That is worse than an empty board.

## Key rotation: a key per bee, not a key per swarm

Four bees on one credential share one rate limit, so the swarm's real ceiling
becomes whatever that key allows rather than what the Queen permits - and the
429 arrives blamed on the work.

`ZAI_API_KEY`, then `ZAI_API_KEY_2`, `_3`, `_4`. The unsuffixed name stays index
0, so a one-key deployment needs no migration.

**Assignment is by SLOT, not by issue number**, and that is the whole design.
The four issues in flight when this was written were 1176, 1216, 1240 and 1244 -
every one of them 0 mod 4. A hash of the issue number would have put all four
bees on the same key and looked exactly like rotation while doing nothing. So
the round passes the indices already in use and the lowest free one is handed
out; the index is stored with the dispatch, which is what makes a retry return
to the same key and a bad key visible as a key rather than as four unlucky
tasks.

An empty string is not a key. A platform variable saved with an empty box leaves
the NAME behind, which is the trap `~/.trios/config.json` has been sitting in
for months.

When every key is busy the refusal says so by name - `all N provider key(s) are
already in use ... add another with ZAI_API_KEY_N+1` - because the fix for that
is one more key, not a first one.

Five checks pin it, including one that asserts the mod-4 collision directly so
nobody re-derives the broken version.
