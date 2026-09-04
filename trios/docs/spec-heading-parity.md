# spec-heading-parity - one list, stated twice, and the comma that split them

Issue: gHashTag/trios#1390
Gate: `trios/tools/spec-heading-parity.mjs` (the identifier `criteriaHeadingParity` lives there)
Date: 2026-09-04, measured against `origin/feat/queen-supervisor` (`87f4fd324`)

## The defect

`QueenSpecQuality.swift` states the headings that open a success-criteria
section twice. The judge decides with an inline list inside the `met:`
expression of the `Check` whose `name:` is `"success criteria"` (the old line
146). The criteria extractor reads with `criteriaHeadings` (the old line 178).
The two lists drifted: the inline one knew only the comma-less spelling of
the legacy done-when heading, while `criteriaHeadings` - and the file's own
comment above it - spell it with a comma. In the escapes this file uses
everywhere because it is ASCII-only, that heading is
`\u0433\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430`.

`hasSection` looks for `"## " + heading` as a substring, so four of the five
textual differences cost nothing: `## acceptance criteria` already contains
`## acceptance`, and the three longer legacy criteria spellings already
contain the bare legacy criteria heading. Exactly one heading was genuinely
unreachable by the deciding expression: the comma spelling.

The cost was a board that contradicted itself. Nine of the 89 open issues
open their criteria section with `## \u0413\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430`
(capital first letter, comma in the middle):

```
1127  1133  1173  1174  1175  1176  1240  1244  1286
```

For each of them `QueenSpecQuality.criteriaWithSource` returned
`source: "stated"` with 4-5 criteria read out of that very section, while
`QueenSpecQuality.judge` put `success criteria` into `missing`. The verdict
sentence became `#1127: delegatable but not yet a spec - missing requirements,
success criteria`, `queen-tick.ts` wrote the same contradiction into the
`queen_issues` row, and `queen-public-status.ts` filed it under
`incompleteSpec`. The operator was told to add a section the issue already
had - over a comma. The honest shortfalls are untouched by the fix: issues
380 and 957 state nothing judgeable, their `criteriaSource` is `none`, and
they keep `success criteria` in `missing` for exactly that reason.

## The fix

One line per copy, the line the file already wrote for itself:

```
met: hasSection(body, criteriaHeadings) && hasMeasurableOutcome(body),
```

The separate `|| hasSection(body, ["Acceptance"])` arm is subsumed, because
`criteriaHeadings` contains `acceptance`, and it went with the inline list.
Both copies received the identical edit in the same commit:

- `trios/rings/SR-00/QueenSpecQuality.swift`
- `trios/agent-server/queen-core/Sources/QueenCore/QueenSpecQuality.swift`

`cmp` over the two paths exits 0. The non-ASCII line count of each copy went
from 13 to 12, because old line 146 - the only line the edit removed - was
one of them. `criteriaHeadings` itself was not reordered, extended, shortened
or reformatted, and the comment block above it, including the prose that
quotes the comma spelling, is byte-for-byte what it was.

## The gate

`node trios/tools/spec-heading-parity.mjs` parses both heading lists out of
the Swift source text - it holds no copy of its own, so it cannot become a
third copy of the defect it removes. It:

- reads both lists from the two Swift files, resolving their paths from its
  own file location, so the command behaves the same from any directory;
- understands the bare-identifier end state
  `hasSection(body, criteriaHeadings)` as contributing the whole
  `criteriaHeadings` list to the deciding set;
- exits non-zero naming any other identifier passed to `hasSection` inside
  the `"success criteria"` check, rather than silently deciding with an
  empty set;
- exits non-zero naming both paths when the two copies of the file are not
  byte-identical;
- applies the substring rule `hasSection` actually uses
  (`lower.contains("## " + name)`): a reader heading is unreachable only when
  no check heading is a prefix of it;
- prints only ASCII: every heading outside 0x20-0x7e is printed as `\uXXXX`
  escapes, and the tool source itself is ASCII-only.

### FIRST RUN - the tool written, no Swift file edited yet

The red result is the finding, not a failure:

```
$ node trios/tools/spec-heading-parity.mjs; echo "exit=$?"
check  headings (5): success criteria | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 | done when | \u0433\u043e\u0442\u043e\u0432\u043e \u043a\u043e\u0433\u0434\u0430 | acceptance
reader headings (10): success criteria | acceptance criteria | acceptance | done when | \u0433\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430 | \u0433\u043e\u0442\u043e\u0432\u043e \u043a\u043e\u0433\u0434\u0430 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0443\u0441\u043f\u0435\u0445\u0430 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0451\u043c\u043a\u0438 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0435\u043c\u043a\u0438 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438
only in criteriaHeadings: 5
only in the check       : 0
unreachable by the check: 1  \u0433\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430
reader heading the check does not name: acceptance criteria
reader heading the check does not name: \u0433\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430
reader heading the check does not name: \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0443\u0441\u043f\u0435\u0445\u0430
reader heading the check does not name: \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0451\u043c\u043a\u0438
reader heading the check does not name: \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0435\u043c\u043a\u0438
exit=1
```

### SECOND RUN - after the one-line edit landed in both copies

```
$ node trios/tools/spec-heading-parity.mjs; echo "exit=$?"
check  headings (10): success criteria | acceptance criteria | acceptance | done when | \u0433\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430 | \u0433\u043e\u0442\u043e\u0432\u043e \u043a\u043e\u0433\u0434\u0430 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0443\u0441\u043f\u0435\u0445\u0430 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0451\u043c\u043a\u0438 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0435\u043c\u043a\u0438 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438
reader headings (10): success criteria | acceptance criteria | acceptance | done when | \u0433\u043e\u0442\u043e\u0432\u043e, \u043a\u043e\u0433\u0434\u0430 | \u0433\u043e\u0442\u043e\u0432\u043e \u043a\u043e\u0433\u0434\u0430 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0443\u0441\u043f\u0435\u0445\u0430 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0451\u043c\u043a\u0438 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u043f\u0440\u0438\u0435\u043c\u043a\u0438 | \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438
only in criteriaHeadings: 0
only in the check       : 0
unreachable by the check: 0
exit=0
```

## What the gate is invoked by

Nothing. The gate is invoked by nothing yet, and that is a known, deliberate
remainder, not something this task papered over:

- The Makefile is outside this task's boundary, so no target calls the tool.
  `make queen-core-sync` (Makefile:1067-1108) is the existing gate that
  forbids drift between the two copies of `QueenSpecQuality.swift`, and it
  could not be invoked here either, because the worker container has no
  `make`. The tool re-implements its byte comparison for these two paths so
  this task cannot create the drift that gate exists to catch.
- The shape is the same as the three sleeping checkers already recorded in
  `.trinity/dashboard/tech-tree.json`: a gate that exists, is runnable by
  hand, and waits for wiring that a later task owns.

## What was not verified

No Swift compiler is present in the worker container (only `sh`, `bash`,
`node`, `bun` and `git`), so the edited Swift files were not compiled and no
`swift test` was run. This document claims source-text parity only, which is
what the 89-issue replay on the host showed to be the cause. The nine issues
above are evidence; none was edited, commented on or closed.
