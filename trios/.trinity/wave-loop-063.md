# T27 Wave Loop - Plan WAVE-063

Domain: dev/release build separation, so an agent rebuilding cannot break the
running app; plus the unwired Queen delegation core from WAVE-062.
Context: A dev variant already exists - `TRIOS_VARIANT=dev` produces
`trios-dev.app` with its own bundle id, ports, singleton lock and secret store.
The separation is real but incomplete, and its default is the wrong way round.

## Audit - weak spots

| ID | Weak spot | Evidence |
|----|-----------|----------|
| W1 | **The default is unsafe.** `VARIANT="${TRIOS_VARIANT:-prod}"` means a bare `./build.sh` rebuilds *release*, overwriting `trios.app` - the app the user is actually running. Every skill, every agent, and every habit runs the bare command. The safe choice must be the default; shipping must be the deliberate act. | `build.sh:214` |
| W2 | **The standalone binary and Frameworks are shared.** `OUTPUT="$PROJECT_DIR/trios_app"` and `STANDALONE_FRAMEWORKS="$PROJECT_DIR/Frameworks"` are variant-independent, so a dev build still overwrites the release binary and the dylibs it loads. | `build.sh:7`, `build.sh:198` |
| W3 | **Runtime data is shared.** `ProjectPaths.trinity` is `<root>/.trinity` for both variants. Only the singleton lock and PID are separated, so agent memory, the encrypted database, logs and the delegation store are common. A dev build with a schema change can corrupt what the release app is using. | `ProjectPaths.swift:38` vs `:137-147` |
| W4 | **The Queen core is not wired.** `QueenDelegationRegistry` and `QueenBranchPolicy` are tested but nothing calls them: the Queen cannot actually open a worker chat or create its virtual branch. | `grep` finds no caller outside the sidebar |

## Competitor research

- **Copilot desktop / Cursor 2.0** isolate each agent session in its own git
  worktree so parallel agents cannot overwrite each other. Takeaway: isolation
  must be structural, not a convention someone remembers.
- **GitButler virtual branches** achieve the same separation without duplicating
  the checkout - each task's edits are attributed to its own branch in one
  working directory. This is the model the user chose and it is already
  integrated via `GitButlerViewModel`.
- **Supervisor-pattern guidance** warns that the orchestrator is a single point
  of failure and accumulates context from every worker. Takeaway for W4: the
  Queen must hand down a brief, not her history.
- The general multi-agent-workspace advice - partition ownership, enforce a
  single writer on hotspots, verify before merging - is what `ownedPaths` and
  `conflictingTasks` already encode; the missing half is that nothing calls them.

## P0 (critical, must land now)

- W1 -> `build.sh`: default `TRIOS_VARIANT` to `dev`; require an explicit
  `TRIOS_VARIANT=prod` (or `--release`) to touch `trios.app`.
- W2 -> `build.sh`: per-variant standalone binary and Frameworks directory.
- W3 -> `ProjectPaths`: per-variant `.trinity` data root so the dev build cannot
  write the release app's database, logs, or delegation store.
- Guard -> a test asserting the default build cannot target the release bundle.

## P1 (high, next wave)

- W4 -> wire `QueenDelegationRegistry` into the Queen's tooling: open a child
  chat, create its GitButler virtual branch, brief the worker.

## P2 (medium)

- Release checklist command that diffs dev against release before promoting.
- Show the running variant in the title bar, so the user always knows which app
  they are looking at.

## P3-P5 (backlog / research)

- Per-worker model tiers: a capable model for the Queen, cheaper ones for bees.
- Automatic promotion of a green dev build to release behind the clade gates.
