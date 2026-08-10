## E2E Testing Skill for trios

### Enable Accessibility (Required)
1. System Settings > Privacy & Security > Accessibility
2. Add /Users/playra/BrowserOS/trios/trios_app
3. Enable checkbox
4. Restart trios_app

### Test via MCP API (No UI needed)
```
curl -s http://127.0.0.1:9105/health
curl -X POST http://127.0.0.1:9105/mcp -H "Content-Type: application/json" -d JSON_RPC_PAYLOAD
```

### CGEvent Mouse Simulation (Swift)
Use CoreGraphics CGEvent for low-level mouse events

### E2E Test Scenarios
1. Launch trios > verify status bar icon
2. Click status bar > verify panel opens
3. Type message > verify ViewModel receives it
4. Send command > verify MCP health passes
5. Switch to BrowserOS tab > verify view renders
## A break test that does not break is not a passed break test

The rule "when an assertion passes, break what it guards and confirm it fails"
has a failure mode that reads exactly like success: you break the code, re-run,
and everything still passes. That is not the guard proving itself robust. That
is your break missing.

Worked example (#1247, #1248). Two bees running in parallel; a worker that had
finished 0.7 s earlier was being restarted as "silent" — 20 of 37 restarts in
the whole log were this. Two fixes went in: a guard (`completedTurns > 0` is not
an orphan) and an ordering change (record the completed turn synchronously in
the finish callback, not inside the deferred `Task` that queues behind the other
bee's review).

- Breaking the **guard** — deleting one line — reproduced the defect at once:
  3 finishes and 1 restart, against 2 and 0 with the line present. Proven.
- Breaking the **ordering** — putting the mark back inside a `Task` — changed
  nothing: 2 finishes, 0 restarts. The two bees happened to finish six seconds
  apart that run and the window never opened.

The honest conclusion is not "the ordering fix is confirmed". It is: the pair is
proven together, and the ordering half is traced through the code and the
timestamps but has no falsifying run behind it. That sentence went into the
issue verbatim.

**Timing defects need a break that forces the timing, not one that hopes for
it.** If you cannot force it — a fake slow reviewer, a stalled main actor, a
cassette that replays the exact interleaving — then say the fix is unproven
rather than counting the quiet run as evidence. A green run under a break you
could not aim is silence, and silence is what this whole class of bug looks
like from the outside.

Corollary for measuring: define the failure numerically before you fix anything.
Here it was "restarts within ten seconds of a clean finish", counted straight
off the JSONL — 20 of 37. Without that number, "it seems better now" would have
been the whole report, and the second, subtler race would never have surfaced.

## When the forge lies quietly: filters that are ignored, not refused

`GET /repos/{o}/{r}/pulls?head=<branch>` looks like it works. It returns 200 and
a JSON array. It is also *completely unfiltered* unless the value is in
`owner:branch` form — GitHub silently ignores a bare ref rather than rejecting
it. Take `.first` of that array and you have adopted a stranger's pull request
with no error anywhere in the log.

This cost the Queen sixteen merge refusals out of twenty-one attempts before
anyone noticed, because under a single worker the array's first element usually
*is* the right PR. It only became visible with two bees running at once.

Two rules fall out of it, and they generalise past GitHub:

1. **An API filter you cannot see failing is not a filter.** After narrowing a
   query, verify the result actually matches what you asked for — here,
   `pr.head.ref == branch`. If it does not match, that is an error to throw, not
   a result to use. The check costs one comparison and turns a silent
   misattribution into a loud one.
2. **Percent-encode query values whose content you do not control.** Branch
   names contain slashes; an unencoded slash in a query value injects a path
   segment. Remove `:` and `/` from `urlQueryAllowed` before encoding, or the
   colon that makes the filter work gets mangled too.

Diagnostic habit that found it: count the log's own verbs against each other.
`21 pr.attempt, 14 pr.opened, 2 pr.refused` does not add up, and the missing
five are where the truth is. Ratios between event names cost nothing to compute
and point straight at the gap; reading any single line would not have.
