# The Queen's scheduler: crons and skills as one Inngest app

Status: implemented in `apps/server/src/inngest/`, served at `/api/inngest`;
registration with the Inngest server is pending the four env vars below
(measured 2026-09-13: 59 functions built from 59 cards, 0 refused, tests
`tests/api/queen-inngest.test.ts` 9 pass).

## What it is

Every cron card under `specs/crons/` and every skill card under `specs/skills/`
of gHashTag/t27 is one Inngest function of the app `t27-queen`. The contract is
`specs/automation/inngest-queen-scheduler.t27` (gHashTag/t27#3595); the tool the
Queen holds for it is `specs/tools/mcp/inngest-dev.t27` (agent `T`, the Queen).
The server reads the cards at start-up with the real compiler
(`specs/t27_compiler.wasm`, the bytes t27.ai serves, sha256 in `specs/PIN`) and
never with a regex.

| card | function | triggers | when it fires |
|---|---|---|---|
| cron, HOST github-actions, ENABLED, five-field SCHEDULE | `cron-<slug>` | `cron` (SCHEDULE, `TZ=` prefix when not UTC) + `cron/<ID>.tick` | `workflow_dispatch` of the workflow named by SERVICE on the repo's default branch (read from the API) |
| cron, HOST inngest / timer / railway-cron | `cron-<slug>` | `cron/<ID>.tick` only | records the tick; the 999 app or process keeps its own schedule (no double fire) |
| cron, ENABLED false or empty SCHEDULE | `cron-<slug>` | `cron/<ID>.tick` only | records the tick |
| skill | `skill-<slug>` | `skill/<ID>.run` | opens the issue `[skill] <ID>` (label `queen-skill`, sections `## Success Criteria` / `## Boundary`) in `gHashTag/<REPO>`, reusing an open one with the same title |

A cron card with a non-empty `RUNS` fans out one `skill/<ID>.run` per listed
skill after its own dispatch (`RUNS_FANOUT = true`). Today no vendored cron card
lists a skill, so the fan-out path is covered by tests only.

## The derivation

`spec-catalog.ts` reads the cards (wasm), applies the schema (`KIND` first, then
every required field with its shape), refuses a bad card and serves the rest
(`ON_BAD_CARD = "refuse-card-serve-rest"`). `plan.ts` is pure and turns a card
into a plan with a `reason` quoting the constant that decided it. `dispatch.ts`
is the GitHub side. `functions.ts` builds the Inngest functions; `route.ts`
serves them and the read-only projection. `index.ts` is what `server.ts` calls.

Measured lenience of the wasm analyzer: `pub const ID : str = ;` and
`pub const ID : str = 12;` both come back `typecheck ok` - the first drops the
declaration, the second keeps the number. The schema check is therefore the
gate that refuses such a card here; `t27c` in t27's CI is the stronger judge
upstream. Recorded in the tests rather than papered over.

## Routes

- `PUT|POST|GET /api/inngest` - the Inngest SDK handler (`inngest/hono`). Not
  behind `requireTrustedAppOrigin`: the caller is the Inngest server and every
  request is signed with `INNGEST_SIGNING_KEY` (v4 verifies with the CLIENT's
  key; an unsigned invocation is refused with 4xx, measured).
- `GET /queen/scheduler` - counts, each function with its trigger, dispatch and
  reason, refused cards, the pin, and WHICH env vars are set (never values).
  Public-read CORS like the other `/queen/public-*` projections; nothing in it
  is not already in the public t27 specs.

## Env (the contract's `ENV` + `TOKEN_ENV`)

| var | value on Railway | purpose |
|---|---|---|
| `INNGEST_BASE_URL` | `http://inngestinngest.railway.internal:8288` | where the SDK sends events and registers |
| `INNGEST_EVENT_KEY` | event key of the self-hosted Inngest | `step.sendEvent` for RUNS fan-out |
| `INNGEST_SIGNING_KEY` | signing key of the self-hosted Inngest | request verification on `/api/inngest` |
| `INNGEST_SERVE_HOST` | public URL of this server | the origin the Inngest server calls back |
| `TRIOS_GITHUB_API_TOKEN` | already set for the Queen | `workflow_dispatch` (needs `actions:write`) and issues |

Values are set by the operator in Railway's own UI; no token is stored in this
repository or handed to an agent (policy: Railway only via the owner's login).

## The move (MOVE_STEPS = 3, CONTROL_AFTER_MOVE = inngest)

1. Deploy this server with the env above; check `GET /queen/scheduler` and the
   Inngest MCP `list_functions appId=t27-queen` reports 59 functions.
2. Let both run for one cycle of the slowest github-actions card (weekly:
   `security.yml`, `formal-mutation.yml`); confirm the dispatched runs on the
   Actions tab carry `event: workflow_dispatch`.
3. Remove `schedule:` from the 12 github-actions workflows (add
   `workflow_dispatch:` to the 3 that lack it: 999 `ci.yml`, 999 `security.yml`,
   t27 `formal-mutation.yml`) and set `CONTROL = "inngest"` on their cards.
   The 6 cards with HOST inngest keep their schedule inside the 999 app - the
   Queen's function for them is tick-only by contract, so nothing fires twice.

## For bees

The brief (`queen-tick.ts`, section "The Queen's scheduler") tells a bee that
the scheduler is the Queen's tool, that a `[skill] <ID>` issue came from
`skill/<ID>.run`, that WHEN something runs is changed on its card and nowhere
else, and that it must not send events or call the Inngest MCP (no key on the
machine by design).

## Refreshing the vendored cards

`T27_ROOT=... TRINITY_ROOT=... scripts/sync-t27-specs.sh`, then the tests. The
pin records the t27 sha and the wasm sha256 that were copied.

## Functions built from the vendored cards (2026-09-13)

| function | cron trigger | dispatch | repo | service |
|---|---|---|---|---|
| `cron-timer-999-multibots-telegraf-agent-autopilot-l1118` | - | tick-only | 999-multibots-telegraf | agent-autopilot.ts:1118 |
| `cron-timer-999-multibots-telegraf-bot-owner-billing-l474` | - | tick-only | 999-multibots-telegraf | bot-owner-billing.ts:474 |
| `cron-inngest-999-multibots-telegraf-check-stuck-trainings` | - | tick-only | 999-multibots-telegraf | checkStuckTrainings.ts |
| `cron-github-actions-999-multibots-telegraf-ci` | `0 2 * * *` | workflow-dispatch | 999-multibots-telegraf | ci.yml |
| `cron-timer-999-multibots-telegraf-crmproactive-l375` | - | tick-only | 999-multibots-telegraf | crmProactive.ts:375 |
| `cron-inngest-999-multibots-telegraf-daily-sales-advisor` | - | tick-only | 999-multibots-telegraf | dailySalesAdvisor.ts |
| `cron-timer-999-multibots-telegraf-generate-jobs-l164` | - | tick-only | 999-multibots-telegraf | generate-jobs.ts:164 |
| `cron-inngest-999-multibots-telegraf-health-check` | - | tick-only | 999-multibots-telegraf | criticalErrorMonitor.ts |
| `cron-inngest-999-multibots-telegraf-log-monitor` | - | tick-only | 999-multibots-telegraf | logMonitor.ts |
| `cron-timer-999-multibots-telegraf-notificationhandler-l318` | - | tick-only | 999-multibots-telegraf | notificationHandler.ts:318 |
| `cron-timer-999-multibots-telegraf-notificationhandler-l324` | - | tick-only | 999-multibots-telegraf | notificationHandler.ts:324 |
| `cron-inngest-999-multibots-telegraf-periodic-webhook-health-check` | - | tick-only | 999-multibots-telegraf | webhookHealthGuard.ts |
| `cron-timer-999-multibots-telegraf-production-monitor-l80` | - | tick-only | 999-multibots-telegraf | production-monitor.ts:80 |
| `cron-timer-999-multibots-telegraf-provider-health-monitor-l344` | - | tick-only | 999-multibots-telegraf | provider-health-monitor.ts:344 |
| `cron-timer-999-multibots-telegraf-render-server-l10845` | - | tick-only | 999-multibots-telegraf | render-server.ts:10845 |
| `cron-timer-999-multibots-telegraf-render-server-l2301` | - | tick-only | 999-multibots-telegraf | render-server.ts:2301 |
| `cron-timer-999-multibots-telegraf-render-server-l2325` | - | tick-only | 999-multibots-telegraf | render-server.ts:2325 |
| `cron-timer-999-multibots-telegraf-render-server-l919` | - | tick-only | 999-multibots-telegraf | render-server.ts:919 |
| `cron-github-actions-999-multibots-telegraf-security` | `0 3 * * 0` | workflow-dispatch | 999-multibots-telegraf | security.yml |
| `cron-inngest-999-multibots-telegraf-skill-detector` | - | tick-only | 999-multibots-telegraf | skillDetector.ts |
| `cron-timer-999-multibots-telegraf-taskcache-l27` | - | tick-only | 999-multibots-telegraf | taskCache.ts:27 |
| `cron-timer-999-multibots-telegraf-video-task-store-l156` | - | tick-only | 999-multibots-telegraf | video-task-store.ts:156 |
| `cron-railway-cron-999-jobsearch-cron` | - | tick-only | railway | jobsearch-cron |
| `cron-github-actions-t27-formal-mutation` | `0 5 * * 1` | workflow-dispatch | t27 | formal-mutation.yml |
| `cron-github-actions-t27-pr-dashboard` | `0 * * * *` | workflow-dispatch | t27 | pr-dashboard.yml |
| `cron-github-actions-trinity-agent-cron-cleanup` | `0 */2 * * *` | workflow-dispatch | trinity | agent-cron-cleanup.yml |
| `cron-github-actions-trinity-agent-queue-drain` | `*/5 * * * *` | workflow-dispatch | trinity | agent-queue-drain.yml |
| `cron-github-actions-trinity-brain-ci` | `0 0 * * 0` | workflow-dispatch | trinity | brain-ci.yml |
| `cron-github-actions-trinity-codegen` | `0 0 * * *` | workflow-dispatch | trinity | codegen.yml |
| `cron-github-actions-trinity-discover-callers` | `41 5 * * *` | workflow-dispatch | trinity | discover-callers.yml |
| `cron-github-actions-trinity-pages-health-check` | `*/15 * * * *` | workflow-dispatch | trinity | pages-health-check.yml |
| `cron-github-actions-trinity-signal-health-self` | `23 4 * * *` | workflow-dispatch | trinity | signal-health-self.yml |
| `cron-github-actions-trinity-site-live-gate` | `17 6 * * *` | workflow-dispatch | trinity | site-live-gate.yml |

skills: `skill-t27-measure-corpus`, `skill-t27-phi-loop`, `skill-t27-tri-pipeline`, `skill-t27-tri`, `skill-t27-wave-audit`, `skill-t27-wrap-up`, `skill-trinity-blog-post`, `skill-trinity-board-sync`, `skill-trinity-cloud`, `skill-trinity-doctor`, `skill-trinity-farm-garden`, `skill-trinity-fpga-synth`, `skill-trinity-god-mode`, `skill-trinity-implement-issue`, `skill-trinity-queen-hive-visuals`, `skill-trinity-review-code`, `skill-trinity-run-tests`, `skill-trinity-scholar`, `skill-trinity-status`, `skill-trinity-tech-tree`, `skill-trinity-tri`, `skill-trinity-trinity-test`, `skill-trinity-ux-wave`, `skill-trinity-vibee-gen`, `skill-trinity-vsa-verify`, `skill-trinity-wave`

