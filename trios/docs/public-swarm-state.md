# Public Swarm State - The `/queen/status` Consumer Contract

Issue: gHashTag/trios#1297

## What this document is

The contract for anyone rendering `GET /queen/status`: the closed set of
values `swarmState` can carry, which value wins when facts overlap, what
`dispatches.unreviewed` counts, and what this endpoint will never
publish. It mirrors `classifySwarmState` in
`agent-server/apps/server/src/api/routes/queen-public-status.ts`; that
function is the only writer of the vocabulary, and this document is its
public face.

## Zero running bees is not a verdict

A dashboard that reads `dispatches.running: 0` has learned exactly one
fact: no dispatch is unfinished at this moment. That is not a health
reading, and this document never claims that zero running bees is always
healthy. The same zero splits into three different swarms:

- work still owed (`waiting_for_review`),
- health the latest decision explicitly vouches for (`healthy_idle`),
- silence nobody vouches for (`unavailable`).

`swarmState` is the one closed word that says which of those the zero is.
The set of values is closed on purpose: a public consumer can rely on
every value it will ever read, and new values will not appear without a
change to this contract.

## The states, their precedence, the aggregate, and the boundary

One compact table. The first column is the precedence: when more than
one row's condition holds, the row with the smaller number wins. Every
state, the aggregate, and the boundary are named exactly once in this
table; the sections that follow elaborate.

| # | Value | What a consumer may conclude |
|---|-------|------------------------------|
| 1 | `working` | A dispatch is unfinished right now. The dispatch table itself vouches for the work, so no other signal outranks it - not a disabled scheduler, not a missing tick. |
| 2 | `waiting_for_review` | Nothing is running, but a finished dispatch still owes its verdict. A swarm that looks empty but owes a review is not idle. |
| 3 | `unavailable` | Nothing is running and nothing is owed, yet nothing vouches for the quiet: the scheduler is disabled, or the latest tick is missing or unreadable, or its decision claims chosen work that no dispatch shows. This page cannot say why the swarm is quiet. |
| 4 | `healthy_idle` | Nothing is running and nothing is owed, the scheduler is enabled, and the latest decision explicitly found no eligible candidate. The quiet is health, not failure. |
| - | `dispatches.unreviewed` | The aggregate count of finished dispatches whose verdict is still owed, summed across the whole dispatch table. It is a number, never a per-issue or per-bee breakdown. |
| - | Privacy boundary | Raw issue text, file paths, branch names, conversations, providers, models, tokens, and credentials are not public and never leave the endpoint; only counts and closed identifiers do. |

## `healthy_idle` in detail

Given `dispatches.running: 0` and `swarmState` of `healthy_idle`, three
things are all true at once, and a dashboard may print all three:

1. the scheduler is enabled (`scheduler.enabled: true` with a positive
   `intervalSeconds`),
2. no verdict is owed (`dispatches.unreviewed` is 0),
3. the latest decision explicitly found no eligible work - on the
   production base this reads as `lastTick.allowed: false` with the
   refusal "nothing to choose". That refusal is the voucher, not a
   failure report: the round ran, looked at every candidate, and found
   none it could start. Green is correct here.

## `unavailable` in detail - and the race that makes it exist

`unavailable` is not a softer green. A consumer MUST NOT render it as
healthy, print it in the success color, or fold it into an "all good"
roll-up. It means the page cannot explain the quiet, and the honest
rendering is a neutral or warning tone with the reason a human needs.

One cause deserves its own name: the allowed-decision/no-dispatch race.
Between the tick recording an allowed decision (`lastTick.allowed:
true`, an issue chosen) and the dispatch row being written, there is a
real window where the table shows `running: 0` while the latest
decision says it chose work. Calling that snapshot healthy would
conceal a failed dispatch write. So `healthy_idle` requires an explicit
no-choice decision; an allowed decision with no observable dispatch
reads as `unavailable` until the row appears or a no-choice tick
supersedes it.

The other causes are simpler: the scheduler is disabled
(`scheduler.enabled: false`), or there is no readable tick decision at
all. In every case the rule is the same - nobody vouches for the
present, so nobody gets to call it healthy.

## What is not public

The endpoint's whole shape is the response a consumer may render:
`status`, `swarmState`, `scheduler`, `lastTick` (closed fields, with
skip reasons reduced to the closed-category counts of `skipSummary`),
and `dispatches` (counts plus the latest dispatch's issue number and
timestamps). Everything else the supervisor knows stays behind
`/queen/lease`. Raw issue text, paths, branches, conversations,
providers, models, tokens, and credentials do not appear in any field,
are not carried in skip reasons or refusal strings, and are not implied
by any count. A consumer that wants them is asking for a different,
private endpoint.

## How a bilingual UI should render it

Map each state to a localized label through fixed translation keys, and
ship the localized strings in the UI bundle - not here. One worked
example; the Russian column is ASCII transliteration of the shipped
string, kept non-Cyrillic so this document stays pure ASCII:

```text
translation key            en                  ru (transliterated)
status.state.unavailable   Status unavailable  Status nedostupen
```

A consumer following this table keeps `working` and `healthy_idle` in
its success tone, `waiting_for_review` in a pending tone, and
`unavailable` in a neutral or warning tone - never green.
