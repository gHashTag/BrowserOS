# CLAUDE.md — instructions for agents working in apps/agent

This is the BrowserOS extension workspace: a WXT-based browser extension
(React, GraphQL codegen) that talks to the server built from `apps/server`.
Every command below is a script of THIS workspace's package.json — run it
from `apps/agent`, not from the monorepo root.

## Commands

- `bun run dev` — run the extension against a dev browser (wxt, dev mode)
- `bun run build` — codegen + production build
- `bun run build:dev` — development build
- `bun run zip` — package the extension for the store
- `bun run codegen` — regenerate `generated/graphql` from the schema
- `bun run codegen:watch` — codegen in watch mode
- `bun run test` — run this workspace's tests
- `bun run compile` — wxt prepare + tsgo --noEmit
- `bun run typecheck` — typecheck only (same as compile)
- `bun run lint` — biome check
- `bun run lint:fix` — biome check with --write
- `bun run clean:cache` — clear wxt and biome caches

## Notes

- WXT drives the build; the configuration lives in `wxt.config.ts` and the
  entrypoints in `entrypoints/`.
- Telemetry events funnel through `lib/metrics/track.ts`; add new events
  there rather than inventing a second pipeline.
- Shared constants (ports, limits, urls) come from the shared package, e.g.
  `@browseros/shared/constants/ports` — a package specifier, not a
  repository path; the sources live under `../../packages/shared`.
- The workspace reads `.env.development` (via bun's `--env-file`) for
  local dev credentials and endpoints.
