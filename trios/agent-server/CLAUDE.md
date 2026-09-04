# CLAUDE.md — instructions for agents working in trios/agent-server

This is the BrowserOS agent-server monorepo: the HTTP/MCP server, the
browser extension agent, the shared packages and the services around them.
Bun is the runtime and the package manager (`bun@1.3.6`, per the `engines`
field — `npm`, `yarn` and `pnpm` are explicitly refused). Read this file
before running anything. The extension workspace has its own instructions
in `apps/agent/CLAUDE.md`.

## Layout

- `apps/agent` — the browser extension (WXT + React + GraphQL codegen)
- `apps/server` — the HTTP + MCP server
- `apps/trios-mcp-bridge` — the TriOS MCP bridge service
- `apps/eval` — evaluation harness
- `apps/cli` — the Go CLI (built with `go`, not bun; no package.json)
- `packages/build-tools`, `packages/cdp-protocol`, `packages/shared` —
  shared workspace packages
- `scripts/` — repo-level build and codegen entry points, e.g.
  `scripts/build/server.ts`
- `docs/` — longer reference docs: `docs/tool-reference.md`,
  `docs/llm-providers.md`, `docs/events.md`

## Common Commands

Run the commands below from the monorepo root (`trios/agent-server`) unless
the line itself says otherwise:

- `bun run dev:watch` — watch build of server + agent
- `bun run generate:models` — regenerate API models
- `bun run lint` — biome check over the monorepo
- `bun run lint:fix` — biome check with --write
- `bun run test` — full test suite
- `bun run typecheck` — typecheck every workspace
- `bun run start` — start the server in watch mode; the script is defined in `apps/server` (run it from that workspace)
- `bun run test:integration` — integration test group; defined in `apps/server` (run it from that workspace)
- `bun run test:tools` — tools test group; defined in `apps/server` (run it from that workspace)

## Configuration

Copy `config.sample.json` to `config.dev.json` for local runs;
`config.dev.json` is gitignored. The server workspaces read
`.env.development` through bun's `--env-file` flag.

## Testing

The granular server test groups (`test:agent`, `test:api`, `test:browser`,
`test:cdp`, `test:core`, `test:lib`, `test:root`, `test:skills`) are
scripts of the server workspace, not of this root; see Common Commands for
the groups reachable from here.

## Release gating

The OpenClaw container runtime is release-gated: any change to
`apps/server/src/api/services/openclaw/container-runtime.ts` or
`apps/server/src/api/services/openclaw/container-runtime-factory.ts`
requires a full tools-and-integration pass before it lands.

## Further reading

`README.md` at this root, and `apps/agent/CLAUDE.md` for the extension
workspace.
