# TriOS — Trinity Queen Supervisor

A native macOS menu-bar app that runs an autonomous engineering supervisor:
a **Queen** agent that decomposes work into GitHub issues, delegates them to
worker agents ("bees") with strict file boundaries, reviews their diffs,
accepts or sends back, and reports everything it does to an observable,
replayable log — locally, with your own API keys, encrypted at rest.

## What it does

- **Delegation loop** — the Queen picks a candidate issue, opens a dedicated
  chat for the worker, constrains it to a file boundary, watches the stream,
  and judges the result. Settled work is accepted or sent back with a
  correction; nothing merges itself past the operator's review ceiling.
- **Multi-provider LLM routing** — per-model reliability scoring, latency-aware
  ranking, circuit breakers with Retry-After, cross-provider failover,
  context-length-aware trimming, pre-send output-budget routing, and
  per-conversation budget pinning.
- **Observability** — a LOGS workspace (Cmd+3) with structured search
  (`level:` / `source:` / `event:`), saved searches, live tail, correlated
  timeline across sources, noise profiles, and retention dashboards. OTLP
  export for external collectors.
- **Deterministic replay** — worker streams are recorded as SSE cassettes and
  replayed in CI (`make cassettes`), so orchestration bugs reproduce instead
  of flaking.
- **Local-first privacy** — conversations are AES-256-GCM encrypted at rest
  with keys in the macOS Keychain; SQLCipher for the memory store; API keys
  never leave the machine.

## Requirements

- macOS 14+, Apple Silicon or Intel
- Xcode Command Line Tools (`xcode-select --install`)
- A sibling `trinity` checkout (for QueenUILib) next to this repository —
  see `docs/INSTALLATION_README.md`

## Quick start (from source)

```bash
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS/trios
DEVELOPER_DIR=/Library/Developer/CommandLineTools make release
open trios.app
```

`make` alone builds the DEV variant (`trios-dev.app`) and never touches the
release app. `make help` lists every target; `make check` runs the full gate
suite (build, logic suites, cassettes, mutation checks) before you trust a
change.

## First run: add a provider key

The app starts with no credentials. Open **Models & API keys** (the Models
tab), add a key for your provider, and press **Test** — the tab shows the
exact HTTP diagnosis per key. Keys are resolved from three sources in order:

1. macOS Keychain (service `com.browseros.trios.model-keys`) — what the UI
   writes; the recommended place
2. `~/.trios/config.json` — values must be non-empty; an empty string reads
   as configured and supplies nothing
3. `TRIOS_<PROVIDER>_API_KEY` environment variables

## Known limits of a source build

- The app is signed with a local development identity; Gatekeeper will not
  accept a copy downloaded from elsewhere. Build from source on the machine
  that runs it.
- The default chat provider expects an endpoint you actually have; if you run
  no local model server, configure a hosted provider first in the Models tab.

## Development

- `make check` — the gate; run it before and after a change
- `make verify` — build, relaunch, and prove the chat answers end to end
- `make dashboard` — regenerate the measured status page under
  `.trinity/dashboard/`
- `make doctor` — report the state of both app variants (never fails)
- Repository law lives in `CLAUDE.md` and `AGENTS.md`: everything is written
  in English, no code merges without an issue, generated artifacts are not
  hand-edited.

## License

MIT — see [LICENSE](LICENSE).

φ² + 1/φ² = 3 · TRINITY
