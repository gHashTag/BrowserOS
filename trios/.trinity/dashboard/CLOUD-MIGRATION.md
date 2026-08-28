# Moving the backend to Railway: what moves, what cannot, and what is proven

Measured 2026-08-28 against Railway project `999`
(`564d9ebd-7aa8-44fe-93ec-e0b03c87158d`, environment `production`).
Re-run every command here before acting on it.

## The short answer

The backend splits in two, and only one half can go to the cloud.

| half | can it move | why |
|---|---|---|
| **State** — A2A agent registry, task queue, conversations | **yes, today** | already coded, proven on the wire against Railway Postgres |
| **Tool execution** — `filesystem_write`, `filesystem_bash`, `edit` | **no** | the tools act on the filesystem of the process that runs them |

Moving the whole `agent-server` into a container does not move the work. It
moves the *place the work happens*, and the work is editing this repository.

## What is already in the cloud

`railway status` on project `999`:

```
Services   inngest/inngest        Online   https://inngestinngest-production-6a21.up.railway.app
           999-multibots-telegraf Online
           Bucket                 Online   bucket-volume
           supabase-gateway       Online
           Console                Online
           vibee-render           Online
           vibee-editor           Online   https://app.t27.ai
Databases  postgrest              Online
           Postgres-NFrq          Online   postgres-volume        (vibee app: 28 tables)
           Redis                  Online   redis-volume
           Postgres               Online   postgres-volume-wu0l   (inngest: 14 tables)
```

A separate project `trios-railway` runs one service at
`https://trios-railway-production-12cf.up.railway.app`. It answers `/healthz`
with *"trios-railway-mcp: public MCP server for the IGLA project"* — it is not
the agent-server, and nothing of this repository's backend has moved yet.

## The state half: already written, never fed

The Postgres path is not a proposal. It exists:

| file | role |
|---|---|
| `apps/server/src/lib/db/pg-migrate.ts` | Postgres DDL for `agent_tasks`, `conversations`, `conversationMessages` |
| `apps/server/src/api/services/a2a/pg-agent-store.ts` | the durable A2A store |
| `apps/server/src/api/services/a2a/a2a-registry-service.ts:56` | picks it when a DSN is present |
| `apps/server/src/api/server.ts:128` | reads `DATABASE_URL` or `RAILWAY_SSOT_URL` |

It has simply never been given a DSN. Measured on the running server (pid 1422,
port 9105): **zero** `DATABASE_URL` or `RAILWAY_SSOT_URL` variables in its
environment. It has been on the in-memory store the whole time.

`.env` does define `DATABASE_URL`, 40 characters, host `localhost` — but the
start script is `bun --watch --env-file=.env.development`, and that file does
not define it. The variable that exists is not the variable that is read.

### Proven, not assumed

Ran the real server against the real Railway Postgres, DSN supplied in the
environment only and scoped to a throwaway schema:

```
t+6s  {"status":"ok","state":{"durable":false,"configured":true,"error":null}}
t+8s  {"status":"ok","state":{"durable":true, "configured":true,"error":null}}
```

and in the cloud database, created by the server itself:

```
agent_matrix  agent_tasks  agents  conversationMessages  conversations
```

The probe schema was dropped afterwards; the database is back to its 14
inngest tables. Nothing was left behind.

### The one step that is not mine to take

The DSN is a secret. It does not go in a file in this repository, so the move
is the operator's single act:

```bash
railway variables --service Postgres --kv | grep DATABASE_PUBLIC_URL
```

and that value set as `DATABASE_URL` in the environment the server actually
reads. Confirm it took:

```bash
curl -s http://127.0.0.1:9105/health
```

`"state":{"durable":true,...}` means the Queen's registry is in the cloud.
`"durable":false` with an `error` means it is not, and says why. Before the
commit below, `/health` had no `state` field at all and both cases looked
identical.

### Which database

Neither existing Postgres is a natural home: one is inngest's, one is the
vibee app's. Trios tables collide with neither by name, but sharing is still
a decision. Two clean options, and this document does not pick one:

1. **A dedicated `trios` schema** in the existing `Postgres`. Free, isolated,
   and how the proof above was run — set `?options=-c%20search_path%3Dtrios`
   on the DSN.
2. **A new Postgres service** in project `999`. Cleaner boundary, costs money.

## The half that cannot move

`apps/server/src/tools/filesystem-registry.ts:26`

```ts
function getCwd(ctx: { directories: { workingDir?: string } }): string {
  return ctx.directories.workingDir ?? process.cwd()
}
```

`workingDir` is a path, and the `fs` calls behind it run in the server's own
process. In a Railway container `/Users/playra/BrowserOS` does not exist. Move
the agent-server there and `filesystem_write`, `edit` and `filesystem_bash`
start editing the container. The bees stop editing this repository.

There is no switch for this: filesystem tools are registered unconditionally
in `apps/server/src/tools/registry.ts:25`, and no environment variable gates
them. Splitting the server into a cloud half and a local half is a refactor,
not a configuration change.

Also absent: there is no `Dockerfile`, `railway.json`, `nixpacks.toml` or
`Procfile` anywhere in this tree. Nothing here is deployable as-is.

## What was changed today

`88e6e452f` — `/health` now reports `state: {durable, configured, error}`.

The fallback to memory was deliberate and stays: a registry that refuses to
start because a database is unreachable is worse than one that keeps working
locally. What was wrong is that it was *silent*. A wrong DSN and no DSN
produced the same running server, distinguishable only by one `warn` line
emitted once at startup.

Three states are now distinguishable on the wire, each measured:

| state | `configured` | `durable` | `error` | how it was measured |
|---|---|---|---|---|
| no DSN | false | false | null | unit test |
| unreachable DSN | true | false | `connect ECONNREFUSED …` | unit test |
| connecting | true | false | null | live, t+6s |
| in the cloud | true | true | null | live, t+8s |

## What is NOT measured

- Whether Redis, `Bucket` or `postgrest` should carry any trios load. Only
  Postgres was probed.
- Whether the `trios-railway` MCP service overlaps with anything here.
- Cost. Nothing in this document estimates Railway spend.
- Latency. Every measurement above used `DATABASE_PUBLIC_URL` through
  `mainline.proxy.rlwy.net`, from this laptop. A cloud-resident client would
  use the private URL and see different numbers.
- One log line is misleading and was left alone: `PgAgentStore pool connected`
  is emitted even when the connection is refused, because `pg`'s Pool is lazy.
  It is not load-bearing now that `/health` carries the truth.
