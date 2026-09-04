# browser.ts split survey

Issue: gHashTag/trios#1404
File surveyed: `trios/agent-server/apps/server/src/browser/browser.ts` — 1683 lines, measured during the run below.
Tool: `trios/tools/browser-split-survey.mjs` (Node standard library only; reads and reports, modifies nothing).
Reproduce: `node trios/tools/browser-split-survey.mjs` (from the checkout's parent directory; the output below is that run, unedited).

This document makes no judgement about whether or when to split the file. It is the
enumeration a split would have to be argued from.

## What the file contains

The file is one class plus its supporting types and constants. The class is 93.5% of it.

Top-level declarations found: **25** (7 declarations, 18 import statements), sorted by length:

| lines     | len  | kind       | exported | name                                 | references in this file                                                                              | extractable   |
| --------- | ---- | ---------- | -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------- |
| 113-1683  | 1571 | class      | yes      | `Browser`                            | `PageInfo`, `WindowInfo`, `SetWindowVisibilityResult`, `TabInfo`, `EXCLUDED_URL_PREFIXES`, `ACTIONABLE_SELECTOR` | no |
| 43-63     | 21   | interface  | yes      | `WindowInfo`                         | (none)                                                                                               | yes           |
| 95-111    | 17   | const      | no       | `ACTIONABLE_SELECTOR`                | (none)                                                                                               | yes           |
| 27-41     | 15   | interface  | yes      | `PageInfo`                           | (none)                                                                                               | yes           |
| 71-84     | 14   | interface  | no       | `TabInfo`                            | (none)                                                                                               | yes           |
| 86-93     | 8    | const      | no       | `EXCLUDED_URL_PREFIXES`              | (none)                                                                                               | yes           |
| 7-11      | 5    | import     | —        | `./console-collector`                | —                                                                                                    | n/a (import)  |
| 65-69     | 5    | interface  | yes      | `SetWindowVisibilityResult`          | `WindowInfo`                                                                                         | no            |
| 12-15     | 4    | import     | —        | `./content-markdown`                 | —                                                                                                    | n/a (import)  |
| 1         | 1    | import     | —        | `@browseros/cdp-protocol/protocol-api` | —                                                                                                  | n/a (import)  |
| 2         | 1    | import     | —        | `@browseros/shared/types/acl`        | —                                                                                                    | n/a (import)  |
| 3         | 1    | import     | —        | `../lib/logger`                      | —                                                                                                    | n/a (import)  |
| 4         | 1    | import     | —        | `./backends/types`                   | —                                                                                                    | n/a (import)  |
| 5         | 1    | import     | —        | `./bookmarks`                        | —                                                                                                    | n/a (import)  |
| 6         | 1    | import     | —        | `./bookmarks`                        | —                                                                                                    | n/a (import)  |
| 16        | 1    | import     | —        | `./dom`                              | —                                                                                                    | n/a (import)  |
| 17        | 1    | import     | —        | `./elements`                         | —                                                                                                    | n/a (import)  |
| 18        | 1    | import     | —        | `./history`                          | —                                                                                                    | n/a (import)  |
| 19        | 1    | import     | —        | `./history`                          | —                                                                                                    | n/a (import)  |
| 20        | 1    | import     | —        | `./keyboard`                         | —                                                                                                    | n/a (import)  |
| 21        | 1    | import     | —        | `./mouse`                            | —                                                                                                    | n/a (import)  |
| 22        | 1    | import     | —        | `./snapshot`                         | —                                                                                                    | n/a (import)  |
| 23        | 1    | import     | —        | `./snapshot`                         | —                                                                                                    | n/a (import)  |
| 24        | 1    | import     | —        | `./tab-groups`                       | —                                                                                                    | n/a (import)  |
| 25        | 1    | import     | —        | `./tab-groups`                       | —                                                                                                    | n/a (import)  |

(Lines 1-25 are 18 separate import statements; lines 5/6, 18/19, 22/23, 24/25 are genuine
pairs of separate statements importing type-only and namespace bindings from the same module.)

## Reference graph

Code references only — comments and string contents are excluded by the tool.

- `Browser` → `PageInfo`, `WindowInfo`, `SetWindowVisibilityResult`, `TabInfo`, `EXCLUDED_URL_PREFIXES`, `ACTIONABLE_SELECTOR`
- `SetWindowVisibilityResult` → `WindowInfo` (its `window` field, line 66)
- Everything else references nothing else in this file.

Independently extractable declarations (reference nothing else in the file, could each move
alone): **5 declarations, 75 lines** — `WindowInfo` (21), `ACTIONABLE_SELECTOR` (17),
`PageInfo` (15), `TabInfo` (14), `EXCLUDED_URL_PREFIXES` (8).

`SetWindowVisibilityResult` is not extractable alone: it would drag `WindowInfo` with it.

## Coverage accounting

Every line is accounted for; all numbers measured during the run:

- declaration lines: 25 declarations, **1676** lines
- unparsed lines: **7** (all blank separator lines: 26, 42, 64, 70, 85, 94, 112)
- unparseable declarations (FR-003): **0** — every top-level line was classified
- accounted total: 1676 + 7 = **1683**
- file line count: **1683**
- agreement: **exact**

## The one recommended extraction

The largest set of declarations that can move to another module without dragging anything
else from this file behind them (the tool enumerates all proper subsets and keeps the
largest closed one — `Browser` references all six others, so it must stay; nothing else
references `Browser`, so all six others may go):

**Move 6 declarations, 80 lines:**

| lines   | len | kind      | name                        | exported |
| ------- | --- | --------- | --------------------------- | -------- |
| 43-63   | 21  | interface | `WindowInfo`                | yes      |
| 95-111  | 17  | const     | `ACTIONABLE_SELECTOR`       | no       |
| 27-41   | 15  | interface | `PageInfo`                  | yes      |
| 71-84   | 14  | interface | `TabInfo`                   | no       |
| 86-93   | 8   | const     | `EXCLUDED_URL_PREFIXES`     | no       |
| 65-69   | 5   | interface | `SetWindowVisibilityResult` | yes      |

- Lines removed: 80 declaration lines, plus the 5 blank separator lines inside the moved span.
- `browser.ts` would go from 1683 to about 1598 lines. The 400-line pre-commit threshold
  would still be far away — this extraction alone does not fix that warning; it is simply
  the one move that removes the most lines at the least risk.
- Nothing that stays behind is dragged along; the only internal rewiring is one new import
  in `browser.ts` (the `Browser` class references the moved names).

### Call sites outside this file that would need their import changed

**None.** Measured by scanning every `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs` file under the
repository (excluding `node_modules`, `.git`, build output) for static and dynamic imports
that resolve to `browser.ts`, and intersecting their imported names with the moved names
(`PageInfo`, `SetWindowVisibilityResult`, `WindowInfo` — the only moved names that are
exported today):

- 20 files statically import this module (14 in `src/`, 6 in `tests/`), every one of them
  importing only `Browser`, which stays:
  - `trios/agent-server/apps/server/src/agent/ai-sdk-agent.ts:23`
  - `trios/agent-server/apps/server/src/api/routes/agents.ts:15`
  - `trios/agent-server/apps/server/src/api/routes/chat.ts:4`
  - `trios/agent-server/apps/server/src/api/routes/health.ts:8`
  - `trios/agent-server/apps/server/src/api/routes/mcp.ts:9`
  - `trios/agent-server/apps/server/src/api/routes/status.ts:8`
  - `trios/agent-server/apps/server/src/api/services/chat-service.ts:16`
  - `trios/agent-server/apps/server/src/api/services/mcp/mcp-server.ts:10`
  - `trios/agent-server/apps/server/src/api/types.ts:17`
  - `trios/agent-server/apps/server/src/api/utils/resolve-browser-context-page-ids.ts:8`
  - `trios/agent-server/apps/server/src/main.ts:21`
  - `trios/agent-server/apps/server/src/tools/acl/acl-guard.ts:3`
  - `trios/agent-server/apps/server/src/tools/framework.ts:6`
  - `trios/agent-server/apps/server/src/tools/response.ts:2`
  - `trios/agent-server/apps/server/tests/__helpers__/with-browser.ts:4`
  - `trios/agent-server/apps/server/tests/api/routes/auth-routes.test.ts:27`
  - `trios/agent-server/apps/server/tests/tools/input.test.ts:3`
  - `trios/agent-server/apps/server/tests/tools/page-actions.test.ts:7`
  - `trios/agent-server/apps/server/tests/tools/response.test.ts:3`
  - `trios/agent-server/apps/server/tests/tools/windows.test.ts:3`
- 1 dynamic import exists (`trios/agent-server/apps/server/tests/main.test.ts:119`,
  `import('../src/browser/browser')`); it does not touch any moved name.
- The moved names that are file-private today (`TabInfo`, `EXCLUDED_URL_PREFIXES`,
  `ACTIONABLE_SELECTOR`) cannot have external call sites by construction.

If the new module re-exported the moved names through `browser.ts`, even that single
internal import would be the only wiring change; but whether to re-export or to import
directly is a decision for whoever does the split.

### What this extraction does not do

It does not break up the 1571-line `Browser` class, which is where the bulk of the file
lives and where the real risk would be. The class's ~90 methods share private state
(`this.cdp`, `this.pages`, `this.sessions`, `this.consoleCollector`), so no part of it is
independently extractable by the reference-closure test this survey applies. Splitting the
class itself needs a different argument (state ownership, not reference closure), which is
outside what this issue asked for.

## Determinism

Two consecutive runs with no edit between them produce identical bytes:

```
$ node trios/tools/browser-split-survey.mjs > /tmp/run1.txt
$ node trios/tools/browser-split-survey.mjs > /tmp/run2.txt
$ cmp /tmp/run1.txt /tmp/run2.txt && echo IDENTICAL
IDENTICAL
$ md5sum /tmp/run1.txt /tmp/run2.txt
4369e6cefbeb0b71a3679484270e653a  /tmp/run1.txt
4369e6cefbeb0b71a3679484270e653a  /tmp/run2.txt
```

The output contains no timestamps and no absolute paths, and every list is sorted, so it is
stable across runs and working directories on an unchanged tree.
