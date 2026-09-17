# TriOS Chat Provider/Balance Failure — Research + Implementation Report

**Date:** 2026-07-24  
**Branch:** `dev` (landed on `dev`, previously `feat/zai-provider`)  
**Commits:**
- `cb27078d7` fix(clade-build): explicit dylib mode to satisfy clippy permissions lint
- `ae9e33859` fix(trios): classify provider errors, add model fallback, and support /doctor --model

---

## 1. Weak spots researched

The observed failure had two faces:

| # | Weak spot | Where it lives | Impact |
|---|---|---|---|
| 1 | **Fatal provider errors are retried blindly** | `rings/SR-01/SSETransport.swift:25-36` | 402 balance, 401 auth, and invalid-model 400s were lumped into the same retry path as transient 5xx. Burning 3 attempts on a balance error produced the user-facing "failed after 3 attempts" noise and delayed actionable feedback. |
| 2 | **Error text is raw provider HTML/JSON** | `rings/SR-02/ChatViewModel.swift:698-717` | `formatRequestError()` just stringified `RetryError`/`TransportError`. Users saw raw body samples instead of guidance like "pick a different model" or "recharge". |
| 3 | **No model fallback chain in the UI or config layer** | `rings/SR-00/ModelConfigurationStore.swift` | `selectedModel` is persisted but there is no `fallbackModels`, `selectNextModel()`, or hint text to help the user recover from a model-specific failure. |
| 4 | **`/doctor` has no model-selection path** | `rings/SR-02/QueenCommandParser.swift:89`, `BR-OUTPUT/QueenStatusViewModel.swift:694`, `.claude/skills/doctor/SKILL.md` | The parser only produced `.doctor`. The skill runner hardcoded `task.arguments = [name]`, so the advice "Run --model to pick a different model" from the failure screenshot was not actionable inside TriOS. |
| 5 | **Doctor skill inherited the broken default model** | `.claude/skills/doctor/SKILL.md` | With no `model:` frontmatter, the skill used the Claude CLI default (`claude-opus-4-6` in the reported environment), which is exactly the model that failed. |

---

## 2. Competitor / best-practice snapshot

| Source | Pattern | How TriOS now mirrors it |
|---|---|---|
| **OpenRouter errors & debugging** ([openrouter.ai](https://openrouter.ai/docs/api/reference/errors-and-debugging.mdx)) | `402 Payment Required` = insufficient credits; `503` = no available model provider; `502` = model down. | `TransportError` now exposes `isBalanceError`, `isModelUnavailableError`, `isRetryableServerError`. |
| **OpenRouter model fallbacks** ([openrouter.ai](https://openrouter.ai/docs/guides/routing/model-fallbacks)) | Provide an ordered `models` array; put a reliable floor model last. | `ModelConfigurationStore.fallbackModels` / `selectNextModel()` exposes the provider's suggested list as an ordered fallback chain. |
| **OpenClaw issue #56053** ([github.com](https://github.com/openclaw/openclaw/issues/56053)) | HTTP 402 must be classified as a `quota` failover reason or the fallback chain stops. | SSETransport's `extraShouldRetry` no longer retries 402/401/400; `ChatViewModel` suggests `/doctor --model <model>` instead. |
| **Claude Code `/model` picker** ([anthropics/claude-code#65782](https://github.com/anthropics/claude-code/issues/65782)) | `fallbackModel` ordered list + `/model` alias; status line shows current model. | Queen chat now parses `/doctor --model <model>` and the skill frontmatter pins a safe default model. |
| **Claude Code model flag docs** ([code.claude.com](https://code.claude.com/docs/en/cli-reference)) | Start a session with `claude --model sonnet`, then run skill. | `QueenStatusViewModel.runSkillReturningOutput(name:arguments:)` passes `["--model", model, name]` so the skill runs under the requested model. |

---

## 3. Decomposed plan — what was implemented

### A. Transport-layer error classification
- **File:** `rings/SR-01/SSETransport.swift`
- **Changes:**
  - Restricted retrier `extraShouldRetry` to transient errors only: `429`, `502`, `503`, `504`.
  - Added `TransportError.providerErrorMessage` that parses OpenRouter-style `{ error: { message } }` or a plain `message` field.
  - Added boolean classifiers: `isBalanceError`, `isAuthError`, `isInvalidModelError`, `isRateLimitError`, `isModelUnavailableError`, `isRetryableServerError`.

### B. Actionable chat error messages
- **File:** `rings/SR-02/ChatViewModel.swift`
- **Changes:**
  - Rewrote `formatRequestError(_:)` to pattern-match on `TransportError` and emit provider-specific, actionable text.
  - Balance error now says: "Insufficient balance or no resource package. … Pick a different model (`/doctor --model <model>`) or recharge your provider account."
  - Invalid-model error now suggests switching models or running `/doctor --model`.
  - Rate-limit / provider-unavailable errors include the provider message and a fallback suggestion.

### C. Model fallback helpers
- **File:** `rings/SR-00/ModelConfigurationStore.swift`
- **Changes:**
  - Added `fallbackModels: [String]` (current model excluded).
  - Added `selectNextModel() -> String?` to advance to the provider's next suggested model.
  - Added `fallbackSuggestion: String` for inline hints.

### D. `/doctor --model` support
- **Files:** `rings/SR-02/QueenCommandParser.swift`, `rings/SR-02/ChatViewModel.swift`, `BR-OUTPUT/QueenStatusViewModel.swift`, `.claude/skills/doctor/SKILL.md`
- **Changes:**
  - `QueenCommand.doctor` now carries `model: String?`.
  - Parser accepts `/doctor [--model <model>]` and rejects a trailing bare `--model`.
  - `ChatViewModel.executeQueenCommand` persists the requested model via `modelStore.selectModel(_:)` before running the skill.
  - `QueenStatusViewModel.runSkillReturningOutput(name:arguments:)` passes `arguments + [name]` to the `claude` process.
  - `doctor/SKILL.md` frontmatter now pins `model: claude-sonnet-4-6` and documents the `--model` override.

### E. Tests
- **File:** `trios/tests/TriOSKitTests/ChatFailureTests.swift`
- **Coverage:**
  - Balance/auth/invalid-model/rate-limit/provider-unavailable classification.
  - JSON and plain-text provider message extraction.
  - `ModelConfigurationStore` fallback models and `selectNextModel()`.
  - `QueenCommandParser` `/doctor`, `/doctor --model <model>`, and empty `--model` rejection.

---

## 4. Verification gates

| Gate | Result |
|---|---|
| `cargo test --workspace` | ✅ pass (all 304 Rust tests) |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | ✅ clean |
| `swift build` | ✅ pass |
| `bash trios/build.sh` | ✅ pass (ChatSSEEndToEnd tests passed; XCTest unavailable in this toolchain) |

---

## 5. Three cooperation options for the next loop

### Option 1 — Automatic model failover (resilience)
Wire `ChatViewModel.sendMessage` to catch `TransportError.isInvalidModelError`/`.isModelUnavailableError` and transparently call `modelStore.selectNextModel()` for one automatic retry before surfacing the error. Add a UI banner "Temporarily switched to `<model>` because `<previous>` failed." This closes the gap between "we know the model failed" and "the user has to type a command."

### Option 2 — Runtime model health / status dashboard (observability)
Add a lightweight preflight check that probes the provider/model endpoint (e.g., OpenRouter `/models` or a small HEAD/chat request) and shows a status badge in the model picker. When a model is flagged unavailable, the picker disables it and auto-selects the first healthy fallback. This mirrors Cursor's status badges and Claude Code's `/model` picker availability flags.

### Option 3 — Provider-side native fallback (cost/quality optimization)
For providers that support it (OpenRouter), send an ordered `models` array in the chat request body and let the provider handle model failover internally. Combine this with client-side balance/quota detection so that 402 still surfaces immediately while 502/503 are silently routed to the next model. This is the most scalable solution but requires provider-specific request shaping and spend tracking.

**Recommendation:** start the next loop with **Option 1** — it uses the fallback helpers already landed and gives the biggest user-experience win with the smallest blast radius. Then layer Option 2's status badges once auto-failover is proven.

---

## Sources

- [OpenRouter Errors and Debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging.mdx)
- [OpenRouter Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- [OpenRouter Failover blog post](https://openrouter.ai/blog/insights/reliability-failover/)
- [OpenClaw issue #56053 — 402 fallback handling](https://github.com/openclaw/openclaw/issues/56053)
- [Claude Code fallback model docs issue #65782](https://github.com/anthropics/claude-code/issues/65782)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
