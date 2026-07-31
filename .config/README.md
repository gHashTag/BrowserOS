# Worktrunk Setup

This repo uses [Worktrunk](https://github.com/max-sixty/worktrunk) for running multiple Claude Code agents in parallel on different branches.

## Install Worktrunk

```bash
brew install max-sixty/worktrunk/wt
wt config shell install
# restart terminal
```

## Quick Commands

| Task | Command |
|------|---------|
| Create worktree + start Claude | `wt switch -c -x claude feat-name` |
| Switch to existing worktree | `wt switch feat-name` |
| List all worktrees | `wt list` |
| Create PR | `gh pr create` |
| Remove worktree | `wt remove feat-name` |

## What happens on `wt switch -c`

1. Creates new worktree at `../browseros-main.feat-name/`
2. Runs `bun install` in `trios/agent-server/`
3. Copies `.env.*` files from main worktree's `trios/agent-server/apps/`

## Hooks

Hooks are configured in `.config/wt.toml`:

- **post-create**: Runs `bun install` in the agent package, copies env files and `.llm/` from the main worktree
- **pre-remove**: Syncs `.llm/` back to the main worktree before deletion
