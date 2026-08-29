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

**The SwiftPM split was attempted and reverted.** A `QueenCore` target
containing those thirteen files **builds** - proven, 149 s, 16 compile steps.
`TriOSKit` then does not: across a module boundary the types need `public` and
the consumers need `import QueenCore`. Measured cost:

| | count |
|---|---:|
| top-level declarations needing `public` | 19 (0 already public) |
| members needing `public` | ~132 |
| files needing `import QueenCore` | 18 |
| errors after a mechanical `public` pass | 133, all "parameter uses an internal type" |

That last row is the tail: nested types must be opened too, and each one opens
the next. It is a real refactor with a converging but long cascade, not a
manifest edit, and it was reverted rather than half-landed - the tree is
byte-identical and `make` is green.

The next session starts from a number instead of an estimate: ~150 visibility
annotations and 18 imports, verifiable at each step with
`swift build --target TriOSKit`.
