# Model Control Center Specification

Issue: T27-EPIC-001
Task: MODEL-CONTROL-001
Owner: Chat Runtime

## Purpose

Make the active provider, model, credentials, available model catalog, and
token usage visible and controllable from the TriOS interface.

## Behavior

- The composer and detailed status bar display the active provider and model.
- The status bar displays cumulative input and output token usage for the
  current conversation.
- Provider-reported usage is authoritative; a visibly approximate local
  estimate is used only when the stream does not expose usage.
- A `Models` tab is placed next to `Chat` and manages provider, model, base URL,
  model discovery, and provider-specific API keys.
- API keys are stored in macOS Keychain and are never persisted in defaults,
  source files, logs, or visible labels.
- OpenAI, Anthropic, and OpenRouter model catalogs are loaded from their model
  APIs. Ollama models are loaded from `/api/tags`. Z.AI uses the current model
  codes documented by its chat API when no discovery endpoint is available.
- A manual model identifier remains available for private, aliased, or newly
  released models.
- Provider, model, base URL, and Keychain key are included in new chat requests.
- Environment variables remain a fallback for existing installations.

## Tests

1. Every provider resolves a valid default model and base URL.
2. Cloud providers require keys while Ollama does not.
3. OpenAI-style, Anthropic, OpenRouter, and Ollama catalogs parse model IDs.
4. Model catalogs are de-duplicated and sorted.
5. Token usage prefers actual counts and marks local fallback as estimated.
6. Compact token formatting remains readable at thousands and millions.
7. Chat requests serialize the selected provider, model, base URL, and key.

## Invariants

- Secrets never enter UserDefaults or rendered text.
- Model selection remains valid when discovery fails.
- Token accounting never blocks streaming.
- Existing Ollama configuration works without a key.
- New Swift and Markdown content is English and ASCII-only.
