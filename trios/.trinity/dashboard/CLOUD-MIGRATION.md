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
