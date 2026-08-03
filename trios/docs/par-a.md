# Parallel Work

Parallel work is the practice of multiple agents or contributors operating on the same codebase simultaneously, each within a clearly scoped boundary. The key principle is isolation: every worker owns a specific set of files and never edits outside that set. This prevents merge conflicts and keeps reviews focused.

## Why Parallel Work Matters

When tasks are independent, running them in parallel reduces wall-clock time dramatically. Instead of serialising every change through a single queue, the system distributes work across agents that each handle their slice. The Queen then attributes and integrates results.

## How It Works

1. **Scoping** — Each task defines exact file paths a worker may touch.
2. **Isolation** — Workers never cross into another's territory.
3. **Attribution** — The Queen maps edits back to the originating task branch.
4. **Integration** — Results land together after review.

## Guidelines

- Keep boundaries narrow. Smaller scope means fewer conflicts.
- Communicate scope violations immediately rather than silently expanding.
- Treat unstated work as a discussion item, not a hidden action.
- Verify your own criteria before stopping.

## Anti-patterns

- Editing files outside your declared boundary.
- Expanding scope because something "seems obviously needed."
- Committing or switching branches — the checkout is shared and must remain stable.
