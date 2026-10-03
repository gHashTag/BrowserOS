# queen-runner

Run the Queen's tasks on your own machine, with your own provider key.

The swarm hands your runner a task: an issue, a brief, and the commit to start
from. The runner checks the repository out locally, runs **your** coding agent
with **your** key, pushes the result to **your** fork, and tells the swarm
which commit it pushed. The swarm fetches that branch and its review judges it
like any other bee's work. Work the review accepts is credited to your runner's
lane on the leaderboard.

Your key never leaves your machine. The swarm never asks for it, and this
script never sends it anywhere.

## Setup

1. Sign in at https://app.t27.ai/queen/, open **My runners**, create a runner
   and copy its `qr_...` token. It is shown once.
2. Fork the project repository on GitHub and keep the fork **public**: the
   swarm fetches your branch from it without credentials.
3. Make sure `git push` to your fork works from this machine, and that your
   agent is installed and has its key (for example, `claude` with
   `ANTHROPIC_API_KEY` set, or signed in).
4. Run it:

```sh
export TRIOS_QUEEN_URL=https://<the swarm server>
export TRIOS_RUNNER_TOKEN=qr_...
export TRIOS_RUNNER_REMOTE=https://github.com/<you>/<fork>.git
node queen-runner.mjs --check   # say hello and exit
node queen-runner.mjs           # take tasks until Ctrl-C
```

Needs Node 20 or newer and git. No packages to install.

## Settings

| Variable | Meaning |
| --- | --- |
| `TRIOS_QUEEN_URL` | The swarm server. Required. |
| `TRIOS_RUNNER_TOKEN` | The runner token from your cabinet. Required. |
| `TRIOS_RUNNER_REMOTE` | Your public fork, as an `https://github.com/...` address. Required. |
| `TRIOS_RUNNER_PUSH_URL` | Where to push, if not the same address (for example an ssh URL). |
| `TRIOS_RUNNER_AGENT` | The agent command. Default: `claude -p --permission-mode acceptEdits`. |
| `TRIOS_RUNNER_HOME` | Where the checkout lives. Default: `~/.trios-runner`. |

The agent command runs in the project directory with the whole prompt on
stdin. What it prints is its answer, and that answer must end with the
`## VERDICT` block the brief asks for, because the review reads it. Anything
the agent leaves uncommitted is committed by the runner before it pushes.

Any agent command that reads its prompt on stdin and prints its answer works.

## What happens to a task

- **Heartbeat.** The runner checks in while idle and every minute while it
  works. A task whose runner goes quiet for 15 minutes goes back to the swarm.
- **Hand back.** Ctrl-C, an agent that fails without changing anything, or a
  branch the swarm cannot fetch gives the task back at once, so another bee
  can take it.
- **Send-backs.** If the review sends the work back, the next attempt starts
  from your previous push, not from scratch.
- **Limits.** One task per runner at a time. A runner holds a task for at most
  six hours.
