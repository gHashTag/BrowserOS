# Contributor keys and XP

Tracks gHashTag/999-multibots-telegraf#3251 and gHashTag/t27#5472.
The contract is `specs/automation/queen-contributor-keys.t27`, mirrored from
the canonical spec in gHashTag/t27#5473. Regenerate the host policy with
`t27c gen-ts specs/automation/queen-contributor-keys.t27` and save its output
as `apps/server/src/api/services/queen-contributor-policy.gen.ts`; never edit
the generated module. SQL, cryptography and HTTP are explicit host adapters.
The formatter excludes this one generated file so commit hooks preserve the
compiler's bytes. TypeScript and the compiler-AST parity test still check it.

The personal account can list, check, add, enable and disable its own Queen
provider keys. XP comes from the existing dispatch and dispatch-history rows.
This feature never writes to the application's token wallet.

## Deployment

Deploy the reviewed commit explicitly to the actual Queen service. The PR
base is `feat/queen-supervisor`; at the 2026-10-01 rollout preparation, Railway
was configured to build `fix/queen-worker-provider-and-prompt-size`. Merging
the PR base alone does not establish that the live service runs this change.

The management API is off until `QUEEN_CONTRIBUTOR_PROXY_TOKEN` contains at least
32 bytes. Configure a separate random service capability in the Queen and
the app render proxy. Never send it to the browser. It is deliberately
different from `TRIOS_API_TOKEN` and from a user's app session.

The render proxy verifies its normal app session, then sets
`X-Queen-Contributor-Id: telegram:<verified-id>` on the server-to-server
request. It must discard any subject/header the browser supplied.

Set `QUEEN_CONTRIBUTOR_IDENTITIES` to an operator-verified JSON map from
these subjects to GitHub logins. A browser cannot assert a GitHub login.
An unmapped account receives a stable pseudonym in the public XP table.

For existing environment credentials, `TRIOS_KEY_OWNERS` maps the Queen's
actual durable indices to `@github-login`. Verify the active pool ordering
before changing that map; environment suffix numbers and dashboard row
numbers are not interchangeable. The primary pool starts at zero and pool
two starts at 10000. The map is the explicit authority for the existing
history. No automatic ownership migration or foreign key claiming occurs.

Adding new keys also requires `QUEEN_CONTRIBUTOR_ENCRYPTION_KEY`: canonical
base64 encoding of 32 cryptographically random bytes. Preserve this key
across releases and database backups. Losing it makes stored managed keys
unreadable. Existing environment-key listing and checks do not require it.

The Queen database role needs permission to create the optional
`queen_contributor_keys` table and `queen_contributor_key_index` sequence in
the configured Queen schema. Setup runs on first use, and before scheduling
when the feature is enabled. Storage/auth failures return a closed error;
they do not silently substitute empty data or expose provider errors.
An unreadable managed credential is excluded individually from allocation and
logged by index only. Its owner can still disable it without the master key;
other credentials and existing disable directives remain effective.
Once the registry exists, persisted consent and owner snapshots remain in
force even if the management capability is removed. An old deployment with
no registry keeps its legacy allocation; a registry lookup failure is closed.

## API

All routes require `Authorization: Bearer <proxy capability>` and the
verified contributor header. Responses use `Cache-Control: no-store`.

- `GET /queen/contributor-keys`: own keys, provider options, per-key and
  total XP, verified attribution, and the existing public XP formula.
- `POST /queen/contributor-keys`: `{provider, apiKey, label?}`. Providers
  are `nvidia` and `zai`; URLs and models are server-controlled.
- `POST /queen/contributor-keys/:id/probe`: check an owned key.
- `POST /queen/contributor-keys/:id/enable`: check and enable on success.
- `POST /queen/contributor-keys/:id/disable`: stop assigning new work.
- `GET /queen/contributor-keys/models/:provider`: the provider's model ids
  (its `/models` catalog read with one of the owner's keys, cached ten
  minutes) and the model the owner's keys of that provider run now.
- `POST /queen/contributor-keys/model`: `{provider, model}` sets one model for
  every key the owner holds of that provider and returns the account.

## One model for all of an owner's keys

The model switch is all-or-nothing for that owner and that provider, and the
evidence comes first. One of the owner's keys of the provider is handed the
model with a single `ping` tool; only a tool call counts. 400/404/410/422 is
`model_unavailable`, an answer without a tool call is `model_without_tools`,
and a refused or busy key passes the check to the next key, at most
`MODEL_CHECK_ATTEMPTS` times, before `model_check_failed` (504). Nothing is
written unless the check passed.

On success the owner's environment keys are bound (the same binding a probe
creates) and every owned row of the provider gets `model` plus
`model_chosen = true`. Allocation, reviews and probes then use that model for
those keys. Other owners' keys and the operator's pool variables are
untouched. A key the owner adds later joins the chosen model.

`model_chosen` exists because a binding row has always recorded the model it
was bound under. Without the flag, a key probed on 2026-10-01 under
`nemotron-3-ultra` would keep that model after the operator moved the pool to
another one. An environment row overrides its pool's model only while the
flag is set. If the owner also holds a managed copy of a secret that the
environment later received, the copy cannot be bound twice (fingerprints are
unique); its choice applies to the environment key instead.

The Queen's model ranking (`TRIOS_QUEEN_WORKER_MODEL_CANDIDATES`) reroutes
only requests that already name one of its candidates. An owner model outside
that list is sent as chosen.

Successful mutations return `{key}` with the same metadata and actual
contribution fields as GET. Secrets, ciphertext, provider response bodies,
upstream error messages and operator configuration are never returned.
Errors are `{error: <closed code>}`. Foreign/absent keys both return 404.

A probe performs one bounded chat-completion request, waiting up to
`PROBE_TIMEOUT_MS` (90 s since v2: on 2026-10-02 `z-ai/glm-5.3` on NVIDIA took
20-46 s for a short answer and `glm-4.5-flash` on Z.ai up to 87 s). An HTTP 200 with no
model output is not a successful check. Invalid credentials are disabled;
temporary rate limits or network failures do not revoke prior consent.
Each key allows one explicit check per minute, and the process caps concurrent
explicit checks at four. A provider may charge for these small requests.

Disabling stops future worker/review/model-probe assignment; a turn already
running keeps the credential it was given. A late enable response cannot
undo a later disable. Model-probe scheduling rereads consent before each
new model probe.

## Stable identity

Existing environment keys retain their current positive/zero indices.
Overrides bind index, SHA-256 fingerprint and immutable owner. Filtering
happens after legacy indexing, so disabling key zero does not rename key one.
An environment replacement at a bound index is a conflict, not a transfer.

New keys use immutable negative database indices, unique fingerprints and
AES-256-GCM ciphertext authenticated with owner and fingerprint. There is
no ownership-update or hard-delete endpoint. Disabled keys keep their XP.
Public attribution reads the saved owner name for registered keys; changing
an environment mapping cannot reassign a registered credential.

## Verification

Run the API tests with Bun 1.3.6:

```text
bun test tests/api/queen-contributor-keys.test.ts
```

From `apps/server`, set `QUEEN_CONTRIBUTOR_TEST_DATABASE_URL` to a disposable
PostgreSQL database and run `tests/pglive/queen-contributor-keys-live.test.ts`.
The existing CI's `TRIOS_PG_TEST_URL` is also accepted; production
`DATABASE_URL` is never used by these tests.
It creates and drops an isolated schema. These checks cover real SQL owner
filters, duplicate races, encryption at rest, disable/enable races, malformed
requests, provider failure classification, negative-ID history and unchanged
legacy XP. Without the database variable the live tests explicitly skip.
