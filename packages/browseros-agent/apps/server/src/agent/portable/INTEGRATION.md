# ⚠️ WORKSPACE BOUNDARY - READ FIRST

## CORRECT WORKING DIRECTORY

For ALL Trinity A2A + relay-observer + experience hooks work:

**YOU MUST BE IN**: `/Users/playra/BrowserOS/packages/browseros-agent`

## FORBIDDEN DIRECTORY

**NEVER work in**: `/Users/playra/BrowserOS` (root)

Root `/Users/playra/BrowserOS` is for:
- Package-level configuration
- Dependencies
- Build scripts

Do NOT edit root files for Trinity A2A work. Stay in `packages/browseros-agent/`.

## PORT SSOT (Single Source of Truth)

All port configurations are defined in:
- `/Users/playra/BrowserOS/packages/browseros-agent/packages/shared/src/constants/ports.ts`

A2A WebSocket port: **9001** (not 3000, not 9100)

## AGENT COMMANDS — FOLLOW STRICTLY

1. **Work ONLY inside** `packages/browseros-agent/` — never in root
2. **DO NOT use** `localhost:3000` — this is NOT the A2A port
3. **DO NOT take ports from**: old logs, old INTEGRATION.md copies, ~/t27 duplicates, or guesses
4. **ALWAYS read** `packages/shared/src/constants/ports.ts` before ANY run
5. **Port 3001 is DEPRECATED** — A2A WebSocket is **9001** only

### Pre-Flight Checklist
Before running any A2A/Trinity task:
```bash
# 1. Verify you're in the right directory
pwd  # Must output: .../BrowserOS/packages/browseros-agent

# 2. Read actual ports
cat packages/shared/src/constants/ports.ts

# 3. Use ONLY those values — no assumptions
```

---

## Multi-Agent A2A Scenarios

### Status
`Implemented, awaiting scenario runs`

### Infrastructure
✅ `a2a-types.ts` — Strict types from .t27
✅ `relay-observer.ts` — State machine, exponential backoff, error handling
✅ `test-agent-factory.ts` — TestAgent wrapper
✅ `message-router.test.ts` — MessageRouter for routing
✅ `sse-fanout-harness.ts` — SSE fanout testing
✅ `state-recovery-helpers.ts` — State recovery helpers

### Scenarios
🟡 `directed-routing.test.ts` — Agent1 → Agent2 directed routing
🟡 `event-fanout.test.ts` — SSE fanout to multiple subscribers
🟡 `reconnect-correctness.test.ts` — Reconnect sequence, backoff, state preservation
🟡 `late-join.test.ts` — Late agent joins without history
🟡 `mixed-traffic.test.ts` — Control/data message separation

---
**Status:** Infrastructure ready, scenarios implemented, awaiting scenario runs.

*This is integration documentation for reference during implementation.*
