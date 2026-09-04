# agents.ts split survey — what is actually in the file

Issue gHashTag/trios#1412 asks for a survey of
`trios/agent-server/apps/server/src/api/routes/agents.ts` (960 lines on
`origin/feat/queen-supervisor`): what the file contains, which parts have no
dependency on the rest, and which single extraction would remove the most
lines for the least risk. The survey below is the verbatim stdout of the tool
written for this purpose, `trios/tools/agents-split-survey.mjs`. It is
reproduced with:

    node trios/tools/agents-split-survey.mjs

Facts about the run: the surveyed file is identical to
`origin/feat/queen-supervisor` (`git diff --stat origin/feat/queen-supervisor
HEAD -- <file>` is empty at the commit this document was added); every number
in the report was measured by that run, not copied from the issue; two
consecutive runs produce byte-identical output (`cmp` clean, equal SHA-1
`6e827413ee774a0aa39e832a9430ffd7d1abb659`). The tool reads and reports only —
it modifies no source file, invokes no compiler, no make, no build, and uses
the Node standard library alone. It exports a function named `splitAgents`
for programmatic use.

---

# Split survey — trios/agent-server/apps/server/src/api/routes/agents.ts

Measured by `node trios/tools/agents-split-survey.mjs` at run time; no number in this report is copied from an issue or a prior run.

## Measured facts

- File line count (measured this run): **960**
- Top-level declarations found: **27** named declarations, plus 18 import statements (45 classified top-level items in total)
- Unparsed (unclassified code) statements: **0**
- Accounting: declaration/import lines 887 + unaccounted lines 73 = 960; file line count 960. **They agree.**
- Unaccounted breakdown: 48 comment-only lines, 25 blank lines, 0 unparsed code lines

## Top-level declarations (sorted by length, longest first)

| # | lines | start–end | kind | exported | name | references (same file) | referenced by |
|---|------:|-----------|------|----------|------|------------------------|---------------|
| 1 | 346 | 159–504 | function | yes | `createAgentRoutes` | AgentRouteDeps, encodeRfc6266Filename, handleAgentRouteError ×14, parseAgentFilesLimit, parseAgentPatchBody, parseChatBody, parseCreateAgentBody, parseEnqueueBody, parseLastSeq, parseSidepanelAgentChatBody, readJsonBody, streamTurnFrames ×2, turnFramesToAgentEvents | — |
| 2 | 68 | 643–710 | function | no | `parseCreateAgentBody` | readJsonBody, readOptionalTrimmedString ×4 | createAgentRoutes |
| 3 | 66 | 54–119 | type | no | `AgentRouteService` | — | AgentRouteDeps |
| 4 | 61 | 762–822 | function | no | `parseChatBody` | ALLOWED_IMAGE_MEDIA_TYPES, InboundImageAttachment ×2, MAX_CHAT_ATTACHMENTS ×2, MAX_IMAGE_BYTES, MAX_IMAGE_DATA_URL_LENGTH, readJsonBody, readOptionalTrimmedString ×2 | createAgentRoutes, parseEnqueueBody |
| 5 | 44 | 542–585 | function | no | `turnFramesToAgentEvents` | — | createAgentRoutes |
| 6 | 37 | 597–633 | function | no | `streamTurnFrames` | — | createAgentRoutes ×2 |
| 7 | 32 | 824–855 | function | no | `parseSidepanelAgentChatBody` | isUuid, parseBrowserContext, parseSelectedTextSource, readJsonBody, readOptionalString ×2, readOptionalTrimmedString ×3, SidepanelAgentChatRequest | createAgentRoutes |
| 8 | 27 | 121–147 | type | no | `AgentRouteDeps` | AgentRouteService | createAgentRoutes |
| 9 | 24 | 937–960 | function | no | `parseAgentPatchBody` | readJsonBody | createAgentRoutes |
| 10 | 19 | 917–935 | function | no | `handleAgentRouteError` | — | createAgentRoutes ×14 |
| 11 | 15 | 901–915 | function | no | `readJsonBody` | — | createAgentRoutes, parseAgentPatchBody, parseChatBody, parseCreateAgentBody, parseSidepanelAgentChatBody |
| 12 | 14 | 747–760 | function | no | `parseEnqueueBody` | InboundImageAttachment, parseChatBody | createAgentRoutes |
| 13 | 12 | 867–878 | function | no | `parseSelectedTextSource` | — | parseSidepanelAgentChatBody |
| 14 | 10 | 531–540 | function | no | `encodeRfc6266Filename` | — | createAgentRoutes |
| 15 | 9 | 149–157 | type | no | `SidepanelAgentChatRequest` | — | parseSidepanelAgentChatBody |
| 16 | 9 | 857–865 | function | no | `parseBrowserContext` | — | parseSidepanelAgentChatBody |
| 17 | 8 | 515–522 | function | no | `parseAgentFilesLimit` | MAX_FILES_LIMIT | createAgentRoutes |
| 18 | 7 | 635–641 | function | no | `parseLastSeq` | — | createAgentRoutes |
| 19 | 7 | 733–739 | variable | no | `ALLOWED_IMAGE_MEDIA_TYPES` | — | parseChatBody |
| 20 | 7 | 887–893 | function | no | `readOptionalTrimmedString` | readOptionalString | parseChatBody ×2, parseCreateAgentBody ×4, parseSidepanelAgentChatBody ×3 |
| 21 | 6 | 880–885 | function | no | `readOptionalString` | — | parseSidepanelAgentChatBody ×2, readOptionalTrimmedString |
| 22 | 5 | 895–899 | function | no | `isUuid` | — | parseSidepanelAgentChatBody |
| 23 | 4 | 718–721 | interface | yes | `InboundImageAttachment` | — | parseChatBody ×2, parseEnqueueBody |
| 24 | 1 | 508–508 | variable | no | `MAX_FILES_LIMIT` | — | parseAgentFilesLimit |
| 25 | 1 | 727–727 | variable | no | `MAX_CHAT_ATTACHMENTS` | — | parseChatBody ×2 |
| 26 | 1 | 728–728 | variable | no | `MAX_IMAGE_BYTES` | — | MAX_IMAGE_DATA_URL_LENGTH, parseChatBody |
| 27 | 1 | 732–732 | variable | no | `MAX_IMAGE_DATA_URL_LENGTH` | MAX_IMAGE_BYTES | parseChatBody |

Imports (top-level statements, not declarations; listed for completeness):

| start–end | lines | module |
|-----------|------:|--------|
| 7–7 | 1 | `import @browseros/shared/constants/limits` |
| 8–11 | 4 | `import @browseros/shared/schemas/browser-context` |
| 12–12 | 1 | `import hono` |
| 13–13 | 1 | `import hono/streaming` |
| 14–14 | 1 | `import ../../agent/format-message` |
| 15–15 | 1 | `import ../../browser/browser` |
| 16–16 | 1 | `import ../../lib/agents/acp-ui-message-stream` |
| 17–17 | 1 | `import ../../lib/agents/acpx-runtime` |
| 18–21 | 4 | `import ../../lib/agents/active-turn-registry` |
| 22–22 | 1 | `import ../../lib/agents/adapter-health` |
| 23–28 | 6 | `import ../../lib/agents/agent-catalog` |
| 29–32 | 4 | `import ../../lib/agents/agent-types` |
| 33–33 | 1 | `import ../../lib/agents/types` |
| 34–48 | 15 | `import ../services/agents/agent-harness-service` |
| 49–49 | 1 | `import ../services/openclaw/file-preview` |
| 50–50 | 1 | `import ../types` |
| 51–51 | 1 | `import ../utils/require-local-auth` |
| 52–52 | 1 | `import ../utils/resolve-browser-context-page-ids` |

## Independently extractable declarations

A declaration is independently extractable when it references no other top-level declaration in this file (imported names travel with it as imports, so they do not block extraction).

| lines | start–end | kind | exported | name |
|------:|-----------|------|----------|------|
| 66 | 54–119 | type | no | `AgentRouteService` |
| 44 | 542–585 | function | no | `turnFramesToAgentEvents` |
| 37 | 597–633 | function | no | `streamTurnFrames` |
| 19 | 917–935 | function | no | `handleAgentRouteError` |
| 15 | 901–915 | function | no | `readJsonBody` |
| 12 | 867–878 | function | no | `parseSelectedTextSource` |
| 10 | 531–540 | function | no | `encodeRfc6266Filename` |
| 9 | 149–157 | type | no | `SidepanelAgentChatRequest` |
| 9 | 857–865 | function | no | `parseBrowserContext` |
| 7 | 635–641 | function | no | `parseLastSeq` |
| 7 | 733–739 | variable | no | `ALLOWED_IMAGE_MEDIA_TYPES` |
| 6 | 880–885 | function | no | `readOptionalString` |
| 5 | 895–899 | function | no | `isUuid` |
| 4 | 718–721 | interface | yes | `InboundImageAttachment` |
| 1 | 508–508 | variable | no | `MAX_FILES_LIMIT` |
| 1 | 727–727 | variable | no | `MAX_CHAT_ATTACHMENTS` |
| 1 | 728–728 | variable | no | `MAX_IMAGE_BYTES` |

**17 declarations, 253 lines (26.4% of the file) are independently extractable.**

## Recommended extraction (exactly one)

Move all 17 independently extractable declarations into one new module. They reference nothing left behind, so they can travel together in a single move.

- **Lines removed from this file:** 253 of 960 (26.4%), plus 29 associated comment lines that would travel with them
- **Declarations that move:**
  - `AgentRouteService` (type, 66 lines, 54–119)
  - `turnFramesToAgentEvents` (function, 44 lines, 542–585)
  - `streamTurnFrames` (function, 37 lines, 597–633)
  - `handleAgentRouteError` (function, 19 lines, 917–935)
  - `readJsonBody` (function, 15 lines, 901–915)
  - `parseSelectedTextSource` (function, 12 lines, 867–878)
  - `encodeRfc6266Filename` (function, 10 lines, 531–540)
  - `SidepanelAgentChatRequest` (type, 9 lines, 149–157)
  - `parseBrowserContext` (function, 9 lines, 857–865)
  - `parseLastSeq` (function, 7 lines, 635–641)
  - `ALLOWED_IMAGE_MEDIA_TYPES` (variable, 7 lines, 733–739)
  - `readOptionalString` (function, 6 lines, 880–885)
  - `isUuid` (function, 5 lines, 895–899)
  - `InboundImageAttachment` (interface, 4 lines, 718–721, exported)
  - `MAX_FILES_LIMIT` (variable, 1 line, 508–508)
  - `MAX_CHAT_ATTACHMENTS` (variable, 1 line, 727–727)
  - `MAX_IMAGE_BYTES` (variable, 1 line, 728–728)
- **Imports that travel with them:** `../../lib/agents/active-turn-registry`, `../../lib/agents/agent-types`, `../../lib/agents/types`, `../services/agents/agent-harness-service`, `../services/openclaw/file-preview`, `../types`, `@browseros/shared/schemas/browser-context`, `hono`, `hono/streaming`
- **Remaining declarations in this file that reference a moved declaration** (they would add one import of the new module): `AgentRouteDeps`, `MAX_IMAGE_DATA_URL_LENGTH`, `createAgentRoutes`, `parseAgentFilesLimit`, `parseAgentPatchBody`, `parseChatBody`, `parseCreateAgentBody`, `parseEnqueueBody`, `parseSidepanelAgentChatBody`, `readOptionalTrimmedString`
- **Call sites outside this file that would need their import changed:**
  - **None.** 1170 files under the project root were scanned (excluding 2 skipped directories such as node_modules); no file outside this module imports any moved declaration. (Files that import this module are listed below for the record.)
- **Files that import this module but are unaffected** (they import only declarations that stay): 
  - `agent-server/apps/server/src/api/server.ts:29` — `import { createAgentRoutes } from './routes/agents'`
  - `agent-server/apps/server/tests/api/routes/agents.test.ts:9` — `import { createAgentRoutes } from '../../../src/api/routes/agents'`

## Unparsed and unaccounted lines

No unparsed code lines: every top-level line was classified as part of a declaration, an import statement, a comment, or blank. (48 comment-only lines and 25 blank lines sit between declarations; they are listed in the accounting above.)

## Method

- Declarations are found by parsing the source text (string/comment/regex-aware masking, then bracket-depth statement termination), not from any list written into this tool. Re-run it after the file changes.
- References are word-boundary matches of each declaration's name inside the other declarations' code (comments and string literals excluded via masking). Shadowed local identifiers would still count as references; none occur in this file today.
- External call sites were found by scanning 1170 source files under trios/ (directories named node_modules, .git, dist, build, out, … are skipped), resolving every relative import/export-from/dynamic-import specifier and matching it against this module's path, and flagging bare specifiers that end in `routes/agents`.
- Read-only: this tool writes nothing and modifies no source file. Node standard library only; no TypeScript compiler, no make, no build.
- Deterministic: no clocks or randomness; two runs over an unchanged tree produce byte-identical output.

Reproduce: `node trios/tools/agents-split-survey.mjs`

---

## Reading the survey (not part of the tool output)

**The one recommended extraction** is the group of 17 independently
extractable declarations — 253 code lines plus 29 comment lines that sit
directly on top of them. Its cost is unusually low: no file outside this
module imports any of them, so **zero external import changes** are required;
the only two files that import this module at all (`api/server.ts` and
`tests/api/routes/agents.test.ts`) import `createAgentRoutes`, which stays.
The internal cost is one new import statement in this file, used by the 10
remaining declarations that call into the moved code.

**What this does not solve:** `createAgentRoutes` itself — 346 lines, 36% of
the file, the route table plus its inline handlers — stays put. It references
13 of the 27 top-level declarations, so it cannot move without dragging most
of the file behind it. Cutting that knot (for example by moving handler
closures out with the parsers they call, or by grouping routes by resource)
is a design decision with real regression surface; this survey records the
edges so that decision can be argued from evidence rather than intuition.

**Caveat the tool states in its method section:** references are word-boundary
identifier matches in code (comments and strings excluded). Shadowing inside
a moved function would be missed; none exists in this file today. The
unparsed bucket is empty for this file, which the accounting line makes
checkable: 887 declaration/import lines + 73 unaccounted lines = 960.
