# Every task is a spec

The rule, set by the operator: an issue the Queen may delegate is a
specification, written to [github/spec-kit][spec-kit] practice.

This document is the shape. `QueenSpecQuality` is the same rule as a check, so
an issue that does not follow it is refused with the list of what it still
needs rather than with silence.

[spec-kit]: https://github.com/github/spec-kit

## Why this is enforced and not merely encouraged

Measured on the live board the day the rule landed: **24 of 27** open issues
could not be given to anyone. Not because the swarm was busy - because they
never said which files they touch. The Queen allocates files to concurrent
workers, so an issue with no declared boundary cannot be reserved, and any bee
sent at one would collide with whatever else is running.

The swarm was not slow. It was starved, and the cause sat upstream of every
scheduler, in the issues themselves.

## The four sections

Three come from spec-kit's own template, where they are marked *(mandatory)*.
The fourth is ours, and spec-kit has no reason to have it: it assumes one author
on one feature branch, while this repository has a supervisor handing files to
several workers at once.

### `## User Scenarios & Testing`

At least one scenario in Given/When/Then form. Prioritise them P1, P2, P3 as
user journeys, and for each say **why** that priority and how it can be tested
**independently**.

```
### User Story 1 - The warm-up survives the launch gate (P1)

**Why this priority**: without it the first send after every launch fails, and
the failure blames the provider.

**Independent Test**: launch with a key present, watch for queen.key.warmup in
the log within 100 s.

**Acceptance Scenarios**:
1. **Given** a key in the Keychain and the launch gate raised,
   **When** the warm-up starts,
   **Then** it waits rather than spending an attempt.
2. **Given** the gate has lowered,
   **When** the warm-up retries,
   **Then** the key resolves and the log says so.
```

A task with no scenario cannot be shown to work. It can only be declared
finished.

### `## Requirements`

Numbered obligations, spec-kit's form:

```
- **FR-001**: The warm-up MUST wait for the launch gate before its first attempt.
- **FR-002**: Attempts MUST be spaced beyond the 60-second stall cooldown.
```

**MUST**, not "should" and not "would be nice". An obligation can be judged met
or unmet; a preference cannot, so a reviewer cannot close it and a bee cannot
know when it has finished.

Where something is genuinely undecided, write `[NEEDS CLARIFICATION: ...]`
rather than guessing. spec-kit's own instruction, and it is the honest move.

### `## Success Criteria`

Outcomes something can settle: a number, a file, a command and its exit code, a
log line to grep for.

```
- `make check` exits 0.
- The log carries queen.key.warmup with outcome=resolved within 100 s of launch.
- Zero occurrences of `QueenUI/Integration` remain in any Swift file.
```

Adjectives close tasks that were never done. "Faster", "cleaner" and "more
robust" have all been used in this repository to close work nobody measured.

### `## Boundary`

Every file this task may touch, one per line, backticked:

```
## Boundary

`rings/SR-02/ChatViewModel.swift`
`docs/queen-verdicts.md`
```

This is the one that decides whether the task exists for the Queen at all. It
is compared against every non-terminal task's paths; an overlap means the issue
waits rather than colliding.

Name files, not directories. A directory is a region, and a task that claims a
region holds everything under it against everyone.

Not every file name parses as a path. A token, once backticks and
punctuation are stripped, is accepted only when it contains a `/` or ends
in a dotted extension such as `.swift`, `.md` or `.json`. That test is the
whole of `QueenIssueBoundary.pathToken`, and its purpose is to keep prose
out of the boundary: to the parser, `Makefile` is a word. A name with
neither a slash nor a dot is not a wrong path that gets corrected - it is a
word that is dropped, and nothing says so.

The names this bites are root files with no extension: `Makefile`,
`Dockerfile`, `LICENSE`, `Justfile`. Written bare, the token carries no
slash and no dot, so it is discarded and the boundary comes out empty. The
failure is silent - no warning, no error - and the issue then parses as
having no boundary at all. The author sees a `## Boundary` section they
wrote; the Queen sees an issue she may not start, and the round's refusal
says "not yet a spec - missing boundary" about an issue whose boundary is
right there. Measured against the shipped binary, with the bodies identical
apart from the boundary line:

    `Makefile`     ->  delegatable = false
    `./Makefile`   ->  delegatable = true

The spelling that works puts a slash in the token, so a root file is
claimed by its directory prefix:

```
## Boundary

`docs/issue-spec-template.md`
`./Makefile`
```

This already cost a round: #1272 had to be written `./Makefile` for the
Queen to take it, and that spelling was found by testing the binary rather
than by reading anything. The parser has not been fixed and still drops the
bare spelling - only this document changed. Run the `queend` recipe below
before you file, or the next round learns it the same way.

## What the checker does and does not do

It checks that the parts a machine can check are **present**. It does not judge
whether the spec is any good: a shallow one with all four sections passes here
and fails at review, which is the right place for a judgement about substance.

Two outcomes, and they are different:

| | |
|---|---|
| **not delegatable** | no boundary. The Queen cannot give it to anyone. |
| **delegatable but not a spec** | it can be worked, and the gap is named. |

Refusing the second outright would stall the swarm on paperwork. Saying nothing
would let a thin task through and then blame the bee for the ambiguity.

## Checking one before you file it

The checker is `queend`, the executable SwiftPM product of `agent-server/queen-core`.
Nothing in `build.sh` or the `Makefile` builds it, and the image build at
`agent-server/Dockerfile` is the only place that ships it. Build it in
place, then pipe the issue body to it:

```bash
cd agent-server/queen-core
swift build -c release
echo '{"kind":"spec","candidateBodies":{"1":"<the body>"}}' \
  | "$(swift build -c release --show-bin-path)/queend"
```

Building it requires `swift`; a machine without the Swift toolchain
cannot run this check. (An earlier revision of this section piped the
spec into a build-output path that no build in this repository ever
wrote, so the command failed on every machine that tried it.)

It answers with what is missing and, for each gap, a sentence you can paste into
the issue.
