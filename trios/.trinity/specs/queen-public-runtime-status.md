# Queen public runtime status

## Boundary

Expose read-only, sanitized status and Kanban projections of the Railway Queen
supervisor for the public T27 dashboard. The endpoints must not expose
credentials, lease holder identities, file paths, worker/provider identities,
branch names, conversation IDs, dispatch detail, transcripts, token counts,
internal refusal text, or any control that can start or alter a Queen round.

## Contract

- `GET /queen/status` is public and returns JSON without an API token.
- `GET /queen/public-board` is public and returns only GitHub issue identity,
  Queen workflow column, acceptance-criteria count, missing public spec
  sections, and aggregate 24-hour activity.
- If the Queen database is not configured, it returns HTTP 503.
- It reports the configured scheduler interval, latest decision time and
  verdict, plus aggregate dispatch counts and the latest public issue outcome.
- It sends `Cache-Control: no-store` so operational state is not served stale.
- All mutation and detailed Queen routes remain behind the existing bearer
  guard.

## Success criteria

1. Route tests prove the response shape and absence of sensitive fields.
2. The existing Queen test suite remains green.
3. The detailed `/queen/board` route remains guarded.
4. Production returns both sanitized JSON projections to an unauthenticated
   caller from `https://t27.ai` with an allowlisted CORS header.
