# Credential reporting: the round must say when it cannot pay

Issue #1328. Two of the four configured Z.AI credentials could not pay, the
swarm's real ceiling fell from four bees to two, and nothing told the operator.
This document is the specification for the one sentence that fixes that: what
the round report must carry about credentials, what it must say when no key can
pay, how a refusal may be attributed, and where the write-off may live.

The one-paragraph version:

    The dispatch path is to probe a key before it spends an issue on it and
    write off one that refuses; the board separates configured credentials
    from usable ones. What neither does is tell a human. The round report -
    the one surface the operator reads without opening anything - must
    therefore carry three counts every round (configured, usable, refused),
    name the index of any key that refused in this process, and when usable is
    zero must say the swarm cannot pay instead of the ordinary "nothing to
    choose", because the two are opposite problems and the second reads as
    normal.

## The measurement that opened this

Measured 2026-09-03, by asking the provider directly on the Coding Plan path
every dispatch actually uses -
`https://api.z.ai/api/coding/paas/v4`, the same base URL
`providerTemplates.ts` maps for `zai`:

    ZAI_API_KEY     HTTP 200  live
    ZAI_API_KEY_2   HTTP 429  code 1113  "Insufficient balance or no resource package"
    ZAI_API_KEY_3   HTTP 200  live
    ZAI_API_KEY_4   HTTP 429  code 1113

`1113` on this path means the package is spent. The endpoint was checked
before the keys were blamed: this repository has already mistaken a wrong host
for an expired key once, and a host error and a balance error read identically
in a log.

What the silence cost: the ceiling halved and the only evidence was three
issues consumed against dead keys and a line in a log nobody opens. A ceiling
that halves itself in silence looks exactly like a swarm that is merely slow.

## Status: what exists, what this specifies

Three layers, named so nobody has to grep to learn which is real:

- **The probe and the write-off are the issue's premise** ("The dispatch path
  now probes a key before spending an issue on it and writes off one that
  refuses"). They are the deployment lineage's work, specified on their own
  issues. On the branch this document was written for they are not present:
  `queen-dispatch.ts` here has the credential-first ordering, `keysFor()` and
  the quota classification (#1293, #1301), and no probe. This document takes
  the premise as given and specifies the one interface the write-off must
  expose - the health book below - so the reporting half and the probing half
  cannot be built to disagree.
- **The board separates configured from usable** on the same lineage
  (#1303, #1307, #1308). Out of scope here.
- **The round report carries nothing, and that is the gap.** `report()` in
  `agent-server/apps/server/src/api/services/queen-tick.ts` - the report
  writer - writes which bees started, what was reviewed, what strayed, and,
  when nothing started, the Queen's refusal verbatim. No credential count, no
  refusal attribution, no distinction between money and candidates. Verified
  on this branch: the writer carries no credential field at all.

This document specifies that missing piece and nothing else. Every grep below
names the file it must pass in and fails until the change lands. A
specification that pretended to be an implementation would be worse than none,
so this is said once, plainly, here.

## Two opposite problems that read the same

"Nothing to choose" is `queend`'s sentence about **candidates**: there was no
delegatable issue on the table. That is an ordinary state, and the ordinary
response is to write better issues.

"The swarm cannot pay" is about **money**: there were issues on the table and
no credential that could start one. The response is a top-up or a replacement
key - an action only the operator can take.

A report that prints "nothing to choose" while every key is dead reports
normalcy about the opposite problem. That is the defect this document exists
to close, and it is why the distinction lives in the report writer and not in
`queend`: `queend` never sees keys, must not see them (its question travels as
JSON on a pipe, and adding a credential to that pipe puts a credential in a
place the boundary design keeps secret-free), and its vocabulary stays closed.
Only the round's report writer is the place where the candidate verdict and
the credential facts meet, so only it can say which of the two ended the
round.

## FR-001 - the counts, every round

Every round report, started or not, carries the three counts in one sentence:

    Credentials: 4 configured, 2 can pay; refused in this process: ZAI_API_KEY key 2 (zai code 1113), ZAI_API_KEY key 4 (zai code 1113).

With no refusal recorded:

    Credentials: 4 configured, 4 can pay.

Definitions, so two readers cannot disagree:

- **configured** counts DISTINCT, non-empty keys per provider family -
  `ZAI_API_KEY`, then `_2`, `_3`, ... - under the same rules as `keysFor()`
  (#1293): an empty string is not a key, and a duplicated value is one key
  with one rate limit, counted once. The count must come from that one
  authority or the report will disagree with the board's `providerKeyCount()`
  and the public capacity breakdown about the same environment.
- **usable** is configured minus refused-in-this-process. Busy is not refused:
  a key carrying a bee is still a key that can pay.
- **refused** names each written-off key by its **index**, displayed 1-based
  to match the dispatch detail lines (`key 2/4`), qualified by the family
  (`ZAI_API_KEY key 2`) because an index alone is ambiguous once more than one
  provider family is configured.

The report writer reads these from a typed book, not by re-parsing anything:

    interface CredentialHealth {
      /** Non-empty, deduplicated keys (#1293), summed across provider families. */
      configuredCredentials: number
      /** configured minus refused-in-this-process. */
      usableCredentials: number
      /** Each key the provider refused in this process, index never value. */
      refusedKeyIndices: Array<{ envVar: string; index: number; reason: string }>
    }

One authority function in `queen-dispatch.ts` - `credentialHealth()`, reading
the per-process write-off set the probing half keeps - supplies it. The tick
passes it to `report()`; no second counter is added anywhere, because two
counters about one environment is how a board and a report come to disagree.

## FR-002 - the cannot-pay sentence

When `usableCredentials` is 0 and `configuredCredentials` is greater than 0,
the report leads with money and the ordinary template disappears:

    The swarm cannot pay: every configured credential refused the provider check (zai code 1113) - 4 configured, 0 can pay. No bee can start until a key is topped up or replaced and the process restarts; the write-off does not survive a restart.

Three rules make it checkable:

1. The lead replaces the `Started nothing. ${choice.refusal}` clause. The
   refusal is not printed verbatim in this case, because the refusal it would
   print - "nothing to choose" - is the sentence about the opposite problem.
2. The report body must not contain the string `nothing to choose` anywhere in
   this case, headline included. The headline falls back to
   `choice.refusal ?? 'nothing to do'` today; under usable 0 it is the
   cannot-pay lead instead.
3. Co-occurrence resolves to cannot pay. When every key refuses AND there
   were also no delegatable candidates, both sentences are true, but only one
   names an action the operator can take tonight - and a board full of
   non-specs is a fact the operator already knows from the board.

When `configuredCredentials` is 0 the deployment has no key at all, and the
existing `missingProviderRefusal()` sentence already says so; that case is not
"cannot pay" and must not be relabelled.

## FR-003 - index, never value

A refusal is attributed to a key INDEX, qualified by its variable family, and
never to a key value. No report line, log line, database column, test fixture
or JSON field may contain a credential.

- The reason comes from the closed vocabulary the classification already uses
  (`zai code 1113`, from the `ZAI_QUOTA_EXHAUSTED_CODES` list, #1301) - the
  documented, enumerable token a person can look up. Provider response prose
  stays off the sentence the same way it stays off the outcome column: the
  prose names accounts, windows and reset times, and none of that belongs on a
  page.
- Only `queen-dispatch.ts` ever holds values. The health function exports
  counts and indices; the tick, the report, the board and `queend` consume
  only those.
- Test fixtures follow the suite's sanctioned patterns, and the sweep below
  must come back clean of anything that looks like a REAL credential. Two
  patterns already exist and are both allowed, because a value that could not
  be typed by an operator's paste is not a leak: a synthetic placeholder
  (`sk-or-v1-test-key`, `sk-openai-test` in `agent-harness-service.test.ts` -
  feature-fixture input, obviously fake), and a leak probe - a synthetic value
  planted ONLY together with the assertion that it never reaches an output
  (`sk-zai-1234-example` in `queen-dispatch.test.ts`, `sk-trios-...` in
  `queen-public-status.test.ts`). New work for this issue uses the probe seam
  and the closed code vocabulary to simulate a refused key; it never needs a
  key-shaped string at all. A hit that could plausibly be a live credential is
  a failure, whatever it is paired with.

## FR-004 - per-process, never persisted

The write-off set lives in module scope in the dispatch path and nowhere else.
Not in `queen_dispatch`, not in `queen_tick`, not in the registry, not in a
file: a persisted write-off would require someone to EDIT state after a
top-up, and the top-up must take effect on restart with nobody doing that.

The restart rule is the one this repository already applies to dispatch rows
(`reapDispatchesFromPreviousBoot` treats a container boundary as the end of
every prior process's opinion, because a phantom opinion holds work for
hours). A previous process's belief about a key is exactly that kind of
opinion: stale, unfixable from outside, and cheaper to discard than to
disprove.

## Where each change lands

| File | Change |
|------|--------|
| `agent-server/apps/server/src/api/services/queen-dispatch.ts` | `credentialHealth()` - one authority reading the per-process write-off set and `keysFor()`; consulted by provider resolution so a written-off key is skipped, and read by the tick for the report. |
| `agent-server/apps/server/src/api/services/queen-tick.ts` | The report writer: accept `CredentialHealth`, write the counts sentence (FR-001), apply the cannot-pay override (FR-002). The grep `usableCredentials` lands here and must be at least 1. |
| `agent-server/apps/server/tests/api/queen-round.test.ts` | The two scenarios below, asserted against the `INSERT INTO queen_report` params the recording fake pool already captures. |
| `agent-server/apps/server/tests/api/queen-dispatch.test.ts` | `credentialHealth()` counts, index attribution, per-process reset. |
| `agent-server/queen-core/Sources/queend/main.swift` | **Unchanged.** `queend` keeps "nothing to choose" as its closed candidate sentence; money is not its vocabulary and credentials are not its input. |

## The two scenarios, as tests

**Scenario 1 - one key refused.** With four keys configured and the probe seam
recording index 1 (displayed `key 2`) as refused with `zai code 1113`, the
round writes its report. The report body names the counts and the index:
`4 configured`, `3 can pay`, `ZAI_API_KEY key 2`, `zai code 1113`.

**Scenario 2 - every key refused.** With all four keys written off, the report
body contains `The swarm cannot pay` and does NOT contain
`nothing to choose`, and the headline is the cannot-pay lead rather than the
Queen's refusal.

Both run under the round test's existing discipline: the real `queend` binary,
a recording fake pool, GitHub stubbed at `fetch` - and, per FR-003, no fixture
anywhere in the suite carries a value that could plausibly be a live
credential.

## Verification

    # 1. The report writer carries the field.
    grep -c 'usableCredentials' agent-server/apps/server/src/api/services/queen-tick.ts
    #    must print at least 1.

    # 2. A report with one refused key names the index and the counts.
    #    Run the round suite; the Scenario 1 test must pass.

    # 3. No fixture or log line contains a credential-looking value.
    grep -rEn '\bsk-[A-Za-z0-9][A-Za-z0-9-]{7,}' \
        agent-server/apps/server/tests agent-server/apps/server/src
    #    Every hit must be one of the sanctioned synthetic patterns named
    #    under FR-003 - obviously fake placeholders and planted leak probes.
    #    A hit that could plausibly be a live credential is a failure.

    # 4. Every key refused: the phrase about being unable to pay, and no
    #    "nothing to choose". Run the round suite; Scenario 2 must pass.

## Out of scope

The board's configured/usable separation, the public status capacity
breakdown, and the health reader are each specified on their own issues
(#1303, #1307, #1308 lineage). This document governs the round report alone -
the one sentence that reaches the operator without opening anything.
