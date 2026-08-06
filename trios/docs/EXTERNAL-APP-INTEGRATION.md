# TriOS as an external app for BrowserOS

Goal: a user downloads `trios.app`, launches it, and it works with their existing
BrowserOS install. Zero patches to BrowserOS, no rebuild of the browser, no
custom fork.

## Principle

TriOS is a **client**, BrowserOS is a **server it discovers**. Every interaction
crosses a versioned localhost boundary that already exists. Nothing in
`packages/browseros` or the BrowserOS Chromium tree is edited to make this work.

```
   trios.app  (SwiftUI + agent runtime, self-contained)
       |
       |  HTTP / SSE / MCP over 127.0.0.1  -- the only coupling
       v
   BrowserOS  (unmodified; already exposes these endpoints)
```

## What TriOS may rely on

Only the endpoints BrowserOS already serves, exactly as documented in
`INTEGRATION.md`:

| Port | Surface | Used for |
|------|---------|----------|
| 9200 | BrowserClaw MCP | browser automation, isolated agent tabs, audit, replay |
| 9105 | Legacy BrowserOS MCP | backward-compatible automation |
| 9203 | TriOS aggregation bridge | vision + GitButler orchestration |

These are treated as a **public contract**. If a capability is missing, TriOS
adapts on its own side or degrades - it never asks for a BrowserOS patch.

## Three rules that keep it external

1. **Discovery, not assumption.** TriOS probes the ports on launch and records
   what answered. A missing BrowserOS is a supported state: the app opens, shows
   "browser not detected", and every non-browser feature keeps working.
2. **Capability negotiation, not version pinning.** Ask the MCP endpoint for its
   tool catalog and enable features from what is actually present. This is why
   the same `trios.app` can face several BrowserOS builds.
3. **Own the agent runtime.** Chat, providers, routing, and retries belong to
   TriOS. BrowserOS is only asked to drive a browser. This is the part that
   removes the `packages/browseros-agent` dependency.

## Migration: folding the agent server into TriOS - DONE

The agent runtime used to live in the BrowserOS monorepo at
`packages/browseros-agent`, which meant chat depended on a sibling project. It
now lives at `trios/agent-server/` and is the only copy.

What was done, in order:

1. **Copied** the source across (1567 files, 37 MB). `node_modules` and `dist`
   were left behind as regenerable; `bun install` restores them.
2. **Repointed** `ProjectPaths.browserOSAgentRoot`. `ServerManager` derives the
   entrypoint, working directory, and both resource dirs from that one property,
   so a single change moved everything.
3. **Verified** the app launches the relocated server (`ps` shows
   `trios/agent-server/apps/server/src/index.ts`), health returns
   `{"status":"ok","cdpConnected":true}`, and A2A registration succeeds.
4. **Removed** the original, and repointed the BrowserOS repo's own references to
   it: two `lefthook.yml` pre-commit hooks plus `README.md`, `CONTRIBUTING.md`,
   and `TRIOS_RELEASE_MANIFEST.md`.

Browser-driving logic did not move. It stays behind the MCP boundary and is
called, never embedded - that is what keeps TriOS an external app.

Historical references to the old path remain in `.trinity/experience/*.json` and
`.llm/specs/*.md` on purpose: those are dated records of what was true when they
were written, not live configuration.

## Packaging for users

- **Distribution**: a signed, notarized `trios.app` in a DMG. No installer script,
  no Homebrew tap required for the basic path.
- **First launch**: detect BrowserOS; if absent, link to it and keep working in
  degraded mode.
- **Config**: `~/.trios/config.json` plus Keychain for secrets. Nothing is written
  inside the BrowserOS install directory.
- **Uninstall**: delete the app plus `~/.trios`. Nothing is left behind in
  BrowserOS.

## What this explicitly rules out

- Patching the Chromium tree or `packages/browseros`.
- Requiring a BrowserOS build from source.
- Writing into the BrowserOS app bundle or its profile directory.
- Depending on any endpoint that is not in the table above.
