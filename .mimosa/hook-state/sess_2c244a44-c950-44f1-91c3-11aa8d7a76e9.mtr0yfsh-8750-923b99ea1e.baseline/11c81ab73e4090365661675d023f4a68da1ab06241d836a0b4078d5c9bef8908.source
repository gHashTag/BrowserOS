# Cycle 11 Plan: Secure Unauthenticated BrowserOS Server Routes

## Issue anchor
browseros-ai/BrowserOS#2023 (security hardening continuation)

## Problem
Several BrowserOS HTTP API routes are mounted without `requireTrustedAppOrigin()` in `packages/browseros-agent/apps/server/src/api/server.ts`:
- `/agents` — list/create/delete/update agents and start agent turns
- `/soul` — read/write system persona
- `/monitoring` — runtime monitoring
- `/acl-rules` — access-control policy
- `/claw` — tool/execution gateway

These endpoints accept requests from any CORS-allowed/loopback-looking origin and can be reached by malicious web pages, browser extensions, or remote clients spoofing `Origin`. This turns a local assistant into an open RCE/policy-modification surface.

## Evidence
`server.ts` lines 256, 261–262, 312, 331 mount the routes directly without a preceding `.use(..., requireTrustedAppOrigin())` call, while neighboring routes (`/status`, `/memory`, `/skills`, `/test-provider`, `/refine-prompt`, `/oauth`, `/klavis`, `/credits`, `/mcp`, `/chat`, `/a2a`, `/chats`, `/tasks`) already have the wrapper.

## Scope
1. Add `requireTrustedAppOrigin()` middleware to `/agents`, `/soul`, `/monitoring`, `/acl-rules`, and `/claw` in `server.ts`.
2. Verify `/health` remains open (it is intentionally public).
3. Ensure nested Hono routers inside `/chats` and `/tasks` keep their auth wrappers (already present).
4. Add regression tests in `packages/browseros-agent/apps/server/tests/api/routes/auth-routes.test.ts` that assert 403 for untrusted origins and 200/expected behavior for trusted loopback/extension origins on each newly-secured route.
5. Run `bun tsc --noEmit` and `bun test` for the server.
6. Run `cargo run --bin clade-build`, `cargo run --bin clade-e2e`, `bash e2e/trios_e2e_flow.sh`.
7. Relaunch `trios.app` and verify `curl /health` still returns ok.
8. Save episode to `.trinity/experience/` and append to `event_log.jsonl`.

## Non-goals
- Do not change route behavior beyond adding auth.
- Do not address `rejectUnauthorized: false` for PostgreSQL in this cycle (it affects local-dev connection strings and needs separate env-based handling).
- Do not refactor route internals.

## T27 law alignment
- L4 TESTABILITY: every newly-secured route gets a regression test.
- L1 TRACEABILITY: commit message must include `Closes browseros-ai/BrowserOS#2023`.
- L7 UNITY: use existing `build.sh` / `clade-build` / `clade-e2e` gates; no new shell scripts on critical path.

## Verification gates
- `bun tsc --noEmit` in `packages/browseros-agent/apps/server` — PASS
- `bun test` targeted auth tests — PASS
- `cargo run --bin clade-build` — PASS
- `cargo run --bin clade-e2e` — PASS
- `bash e2e/trios_e2e_flow.sh` — PASS
- `curl -s http://127.0.0.1:9105/health` — ok
- menu-bar logo present after relaunch
