# Queued: cancel four looked-at failures (next quiet window)

Written 2026-08-21 ~18:35Z. The reconcile pass surfaces four FAILED records
whose branches hold parked commits. `failed` is deliberately not archivable
("a failure nobody has looked at is still work"); all four have now been
looked at, with measurements. `(.failed, .cancelled)` is a legal transition,
and cancelled records archive on the next sweep, which retires the reconcile
noise through archivedRecordDrift - no new code needed.

Apply at the next zero-running window via the command channel:

pkill -f "BrowserOS/trios/trios.app/Contents/MacOS"; sleep 2; open
/Users/playra/BrowserOS/trios/trios.app --env TRIOS_E2E_QUEEN_COMMAND=\
'/cancel gHashTag/trios#1132 looked at: r2 content is line-subsumed in HEAD (81 of 88 added lines verbatim, rest comment rewording) and r1 five commits re-implement a topic HEAD fixed as c9de822c9; branches keep the history;;\
/cancel gHashTag/trios#1138 looked at: both drafts are Russian (L3 forbids landing); branches queen/1138 and queen/1138-r2 preserve them; the issue needs an English re-delegation or operator closure'

Note: /cancel keys on the issue, so one command per ISSUE settles its
current record; if only one of the two records per issue settles, repeat at
the following window for the sibling. Verify afterwards: the next archive
sweep stamps them, and `queen.reconcile` moves the four from urgent to the
stale bucket.

Also decided this round, already applied:
- queen/1173-r3 DELETED (measured: zero non-doc-comment changed lines vs
  HEAD; content lives in HEAD via 20cc6fe825). Its cancelled record is
  archived, so reconcile reads archivedRecordDrift - silent.
- #1138 drafts must NOT land as-is: r2 measured at 37 Cyrillic lines with a
  Russian commit title; the HARD RULES name this exact file's Russian
  rewrite as an L3 violation to report, never to land.

## Measured 2026-08-21 ~19:15Z: the queued commands were the wrong shape

Executed and refused, correctly, by the machine:
- `/cancel` on #1132/#1138 answered "has no open task to stop" -
  task(forIssue:) deliberately hides TERMINAL records, so failed records
  are unreachable by every Queen command. The legal (.failed,.cancelled)
  transition exists in the table and nothing drives it.
- Bare `/cancel` on awaitingReview #1131 was refused (illegal transition);
  the working shape is the two-step `/review reject` then `/cancel`,
  which succeeded at 19:1xZ - #1131 is cancelled, code preserved on
  queen/1131-r5 (3 commits), boundaries freed for tomorrow's budget.

NEXT CYCLE ITEM: a narrow `/dismiss <issue> <why>` command that finds the
newest FAILED record for the issue and drives failed -> cancelled, existing
precisely for "looked at, filing away" - the disposition this file records
for #1132 and #1138. Until then their reconcile lines stay, honestly.
