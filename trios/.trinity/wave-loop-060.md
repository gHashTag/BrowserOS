# T27 Wave Loop - Plan WAVE-060

Domain: trios chat reliability, unified observability, credential management, three-tab UX
Context: Chat is dead (z.ai zero balance + A2A 403), the LOGS tab shows only server-side
files and none of the app's own 225 NSLog call sites, and each provider can hold exactly
one API key with no way to add or delete keys individually.

## Audit - weak spots found (evidence-backed)

| ID | Weak spot | Evidence |
|----|-----------|----------|
| W1 | No single source of truth for logs. 225 `NSLog` call sites across 29 Swift files go to the macOS unified log; `LogParser.loadLogSources` only reads `.trinity/*.log` and `.trinity/logs/*.log`. The app's own events are invisible in its own LOGS tab. | `grep -c NSLog` = 225; `LogParser.swift:1031-1104` |
| W2 | One key per provider. Keychain account is `provider.rawValue`, so `save()` deletes the previous key first. No list, no per-key delete, no labels. | `ModelConfigurationStore.swift:35-48` |
| W3 | z.ai health probe hits a 404 URL. `baseURL` is already `.../paas/v4`, code appends `/v1/chat/completions` -> `/v4/v1/chat/completions`. Verified HTTP 404 live. | `ModelHealthService.swift:1068` |
| W4 | Key validation is false-green for z.ai. `GET /models` returns 200 with zero balance, so Test says "Key valid" while every completion returns 1113. | `ModelHealthService.swift:681`; live probe |
| W5 | `glm-5.2` exists in the z.ai catalog but is absent from the model list, context profiles, and cost table, so it cannot be selected. | `ModelProvider.swift:66`, `ModelContextService.swift:42-63`, `ModelCostService.swift:124-129` |
| W6 | Balance exhaustion is retried 3x. The server marks 1113 `isRetryable: true`, so one dead send becomes three upstream failures and three log bursts. | `browseros-companion.log`; chat banner "Failed after 3 attempts" |
| W7 | A2A failure message is misleading. Registry is up (`GET /a2a/agents` -> 200 `{"agents":[]}`); the real cause is `403 Local authorization required`. The banner blames startup timing and drops `\(error)` entirely. | `QueenBackgroundService.swift:237`; live probe |
| W8 | Duplicate banners. `registerA2A()` appends a system message with no dedup, producing three identical rows in one transcript. | screenshot; `QueenBackgroundService.swift:238` |
| W9 | Log noise floor. `browseros-companion.log` carries 207 errors, dominated by `password authentication failed for user "postgres"` every 30s from the stale-lease reclaimer. | `browseros-companion.log` tail |

## Competitor research

- **Cherry Studio** is the only mainstream desktop client with native multi-key support: comma-separated keys per provider with round-robin rotation, and a dedicated "API Key Rotation" module. Its open issues show the ceiling of the comma-string design - users cannot bind a specific key to a specific model and are told to duplicate the whole provider instead. Takeaway: model keys as **first-class records with identity**, not as a delimited string.
- **LM Studio** and **Jan** treat the key as a formality (local inference first); neither rotates. Rotation there means putting a gateway upstream. Takeaway: not a competitive threat, but confirms per-key health tracking is an open niche.
- **OpenTelemetry log data model / structured logging guidance**: emit structure at the source rather than reconstructing it downstream with a collector; use NDJSON; carry timestamp, severity, resource/subsystem, and correlation ids on every record. Takeaway: the bus writes OTel-shaped JSONL directly, so the LOGS tab never has to regex-scrape its own app.
- **Client-side buffering pattern**: bounded in-memory ring buffer -> periodic flush -> durable local file. Takeaway: ring buffer + immediate append, so a crash cannot swallow the last events.

## P0 (critical, must land now)

- W1 -> `rings/SR-01/TriosLogBus.swift` (new): OTel-shaped JSONL sink at
  `.trinity/logs/trios-app.jsonl`, subsystem tagging, bounded ring buffer, NSLog mirror.
- W1 -> `rings/SR-02/LogParser.swift`: parse the bus as a first-class source with a
  dedicated parser kind; expose `subsystem` on `ParsedLogLine`.
- W1 -> `BR-OUTPUT/LogsTabView.swift`: subsystem filter chips + deep-link focus.
- W2 -> `rings/SR-00/ModelConfigurationStore.swift`: multi-entry keychain records
  (`provider#uuid`) with label, created date, masked suffix, active selection,
  individual delete, legacy single-key migration.
- W2 -> `BR-OUTPUT/ModelsTabView.swift`: key list with per-row Test/Delete and Add field.
- W3/W4/W5 -> `rings/SR-00/ModelHealthService.swift`, `ModelProvider.swift`,
  `ModelContextService.swift`, `ModelCostService.swift`.
- W6 -> non-retryable classification for balance/quota exhaustion.
- W7/W8 -> `rings/SR-02/QueenBackgroundService.swift`: real error text + dedup.

## P1 (high, this wave if P0 verifies)

- Per-tab Logs affordance in Chat and Models that opens LOGS filtered to that subsystem.
- Models tab: quota/balance badge distinct from reachability.

## P2 (medium)

- Per-key health and quota tracking (which of N keys is depleted).
- Automatic key rotation on 1113/402 within a provider.

## P3-P5 (backlog / research)

- Postgres credential repair for the stale-lease reclaimer (W9, server-side repo).
- OTLP export of the bus to an external collector.
- Trace/span correlation ids across Swift -> companion -> provider.
