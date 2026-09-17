# BrowserOS Internal Docs

Private team docs for `browseros-ai`. Mounted as a submodule into the public OSS repo at `.internal-docs/`.

If you are reading this from a public clone of BrowserOS without team access — this submodule is for the BrowserOS internal team. Nothing here is required to build or use BrowserOS.

## How to find what you need

- Setup task ("how do I X locally") → look in [`setup/`](setup/)
- Recently shipped feature → look in [`features/`](features/)
- Cross-cutting subsystem → look in [`architecture/`](architecture/)
- A design decision or RFC → look in [`designs/`](designs/)

Or run `/ask-internal "<your question>"` from any BrowserOS checkout. The skill greps these docs and the codebase, then synthesizes an answer with citations.

## How to add a doc

Run `/document-internal` from a feature branch. The skill drafts a 1-pager from your branch's diff, asks four sharp questions, enforces voice rules, and opens a PR back to this repo.

## Index

### Setup
<!-- one line per setup runbook: -->
<!-- - [Dev environment](setup/dev-environment.md): first-time machine setup -->

### Features
<!-- one line per shipped feature, newest first: -->
<!-- - [Cowork MCP](features/2026-04-cowork-mcp.md): bring outside MCPs into the BrowserOS agent -->

### Architecture
<!-- one line per cross-cutting subsystem: -->
<!-- - [Chrome fork overview](architecture/chrome-fork-overview.md): what we patched and why -->

### Designs
<!-- one line per design spec, newest first: -->
<!-- - [Internal docs submodule](designs/2026-04-30-internal-docs-submodule.md): this system -->

## Templates

When `/document-internal` runs, it reads from [`_templates/`](_templates/). Edit the templates here when the team's preferred shape changes.

## Voice

Docs in this repo follow these rules. The `/document-internal` skill enforces them; humans editing by hand should match.

- Lead with the point.
- Concrete nouns. Name files, functions, commands.
- Short sentences, active voice, no em dashes.
- No filler words: delve, crucial, robust, comprehensive, nuanced, multifaceted, leverage, utilize, etc.
- Empty sections stay empty. Do not write "N/A" or fake content.
- Feature notes target one screen, body 60 lines max.
