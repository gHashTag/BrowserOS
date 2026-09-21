#!/bin/sh
# Ensures the container has a checkout for agents to work in, then starts the
# server.
#
# The clone is at runtime rather than in the image on purpose: a checkout baked
# into a layer is a snapshot that is stale from the first commit after build,
# and it would be rebuilt only when the Dockerfile changes - which is exactly
# when it is least likely to be noticed.
#
# Doing nothing is the default. With TRIOS_REPO_URL unset this is a no-op and
# the server starts as if this script were not here, so the image stays usable
# for anything that brings its own working directory.
#
# NO PUSH CREDENTIAL LIVES HERE, and that is a decision rather than an
# omission. Measured 2026-08-28: a checkout the agents can write is a checkout
# whose `.git/config` and `.git/hooks` they control, so any git command a
# privileged process later runs inside it executes code of their choosing with
# that process's environment. A token placed here to enable `git push` is
# therefore a token they can take. Publishing happens from a machine they
# cannot write to.

set -e

# ---------------------------------------------------------------------------
# LIVENESS: a server that stops answering is ended, so the platform restarts it.
#
# Measured 2026-09-20/21: the agent server twice stopped answering HTTP WITHOUT
# EXITING - the edge said `Application failed to respond` - and Railway's
# restart policy never fired, because a restart policy fires on an exit and
# there was none. The first time it stayed down for nine hours. Raising
# restartPolicyMaxRetries to 10000 did not help the second time, for the same
# reason. An outside watchdog can redeploy, but only with a platform token; a
# process inside the container needs nothing but the loopback interface.
#
# So the entrypoint no longer `exec`s the server. It starts it, and a second
# process asks `/health` on loopback every LIVENESS_INTERVAL seconds after a
# LIVENESS_GRACE boot allowance. LIVENESS_FAILS answers in a row missing and the
# server is sent SIGTERM, then SIGKILL; the entrypoint then exits non-zero and
# `restartPolicyType: ON_FAILURE` brings the container back - with the boot
# clean-up that frees the disk. python3 does the asking because the image
# declares it; curl is not installed here.
#
# One healthy answer resets the count: a slow minute is not a dead server.
#
# BUSY IS NOT DEAD. The first version allowed four misses of a ten-second probe,
# and measured 2026-09-21 it killed the server itself - twice, at fourteen lanes
# and at twenty, each time about two minutes after the lanes filled. With every
# lane working, the event loop is saturated and /health takes longer than ten
# seconds; the server was alive and making progress, and ending it destroyed
# every bee's turn in flight. So a probe now waits LIVENESS_TIMEOUT (30 s) and
# twelve misses in a row are needed: roughly twelve minutes of silence. A hang
# of the kind this exists for - nine hours of `Application failed to respond`
# - is caught all the same; a busy stretch is not.
run_supervised() {
  "$@" &
  server=$!
  trap 'kill -TERM "$server" 2>/dev/null' TERM INT
  (
    port="${PORT:-8080}"
    interval="${LIVENESS_INTERVAL:-30}"
    fails_allowed="${LIVENESS_FAILS:-12}"
    probe_timeout="${LIVENESS_TIMEOUT:-30}"
    sleep "${LIVENESS_GRACE:-240}"
    fails=0
    while kill -0 "$server" 2>/dev/null; do
      if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$port/health', timeout=$probe_timeout)" >/dev/null 2>&1; then
        fails=0
      else
        fails=$((fails + 1))
        echo "[liveness] /health did not answer ($fails of $fails_allowed)"
      fi
      if [ "$fails" -ge "$fails_allowed" ]; then
        echo "[liveness] the server stopped answering; ending it so the platform restarts the container"
        kill -TERM "$server" 2>/dev/null || true
        sleep 15
        kill -KILL "$server" 2>/dev/null || true
        break
      fi
      sleep "$interval"
    done
  ) &
  set +e
  wait "$server"
  code=$?
  # A server that was ended for not answering exits by signal, which `wait`
  # reports as 128+N. Anything but a clean 0 must read as a failure to the
  # platform, or ON_FAILURE would not restart it.
  [ "$code" -eq 0 ] && code=1
  echo "[liveness] the server exited ($code); exiting so the platform restarts the container"
  exit "$code"
}

# ---------------------------------------------------------------------------
# HOW MANY BEES: derived from what is connected, not typed by hand.
#
# TRIOS_QUEEN_MAX_WORKERS was a number somebody set. It read 8 on 2026-09-20
# while ten credentials were connected at two lanes each - twenty lanes paid
# for and twelve of them unusable - and nothing anywhere said so, because a
# constant cannot notice that the thing it stands for has changed. The same
# variable had been 4, then 16, then 8 again, with no commit in either
# repository to show for any of it.
#
# So it is computed here, once, before either reader is started, and both the
# TypeScript that reports capacity and the Swift policy that enforces it then
# read the same number out of the same environment. That is the drift this
# repository has already paid for twice: capacity 12 reported while every tick
# refused with "4 workers already running (limit 4)".
#
#   lanes = distinct worker credentials x TRIOS_QUEEN_WORKER_LANES_PER_KEY
#   bees  = min(lanes, container memory / TRIOS_QUEEN_BEE_MEMORY_MB)
#
# The memory term is not decoration. The dispatch resource guard already
# refuses to start a bee when memory is short, so a lane count above what the
# container can hold is telemetry promising what the guard will refuse - which
# sends an operator hunting a bug in dispatch. Both terms are printed.
#
# Adding a credential now raises the swarm by itself. Nothing has to be edited.
#
# TRIOS_QUEEN_MAX_WORKERS, if it is still set, is honoured as a CEILING and
# said so out loud: an operator who deliberately set a small number keeps it,
# and an operator who set a large one does not get a swarm the credentials
# cannot feed. Unset it to let the derivation govern.

# Distinct, non-empty worker credentials, counted WITHOUT any value reaching a
# log, a file or an argument list: each is hashed and only the digest is
# compared. Two variables holding the same key are one credential.
worker_credentials() {
  if [ "${TRIOS_QUEEN_WORKER_PROVIDER:-}" = "ollama" ]; then
    # One measured inference server, however many names its token has.
    echo 1
    return
  fi
  seen=""
  count=0
  for suffix in "" 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \
                21 22 23 24 25 26 27 28 29 30 31 32; do
    if [ -z "$suffix" ]; then
      value=$(printenv TRIOS_QUEEN_WORKER_API_KEY 2>/dev/null || echo "")
    else
      value=$(printenv "TRIOS_QUEEN_WORKER_API_KEY_$suffix" 2>/dev/null || echo "")
    fi
    [ -n "$value" ] || continue
    # A missing hasher must NOT read as a missing credential: the failure mode
    # of "skip what I cannot hash" is a swarm of one, which is worse than
    # counting a duplicated key twice.
    digest=$(printf '%s' "$value" | sha256sum 2>/dev/null | cut -c1-16)
    if [ -z "$digest" ]; then
      count=$((count + 1))
      continue
    fi
    case " $seen " in
      *" $digest "*) continue ;;
    esac
    seen="$seen $digest"
    count=$((count + 1))
  done
  echo "$count"
}

# The container's own memory limit, or empty when it has none to read. cgroup
# v1 writes "no limit" as a number near 2^63, and v2 writes the word max.
container_memory_bytes() {
  for file in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    [ -r "$file" ] || continue
    value=$(cat "$file" 2>/dev/null || echo "")
    case "$value" in
      ''|max|922337203685477*|-1) continue ;;
    esac
    echo "$value"
    return
  done
  echo ""
}

derive_worker_cap() {
  credentials=$(worker_credentials)
  # Nothing to derive from. Say so and leave whatever was set alone, because a
  # derived 1 here would be a swarm of one built out of an empty measurement.
  if [ "$credentials" -lt 1 ]; then
    echo "[entrypoint] no worker credential is set, so the lane count cannot be derived" >&2
    echo "${TRIOS_QUEEN_MAX_WORKERS_CEILING:-4}"
    return
  fi
  lanes=${TRIOS_QUEEN_WORKER_LANES_PER_KEY:-1}
  case "$lanes" in
    ''|*[!0-9]*) lanes=1 ;;
  esac
  [ "$lanes" -ge 1 ] || lanes=1
  # The same bound the TypeScript applies, for the same reason: one typo must
  # not turn a credential pool into a request fan-out.
  [ "$lanes" -le 4 ] || lanes=4

  from_keys=$((credentials * lanes))
  bee_mb=${TRIOS_QUEEN_BEE_MEMORY_MB:-1024}
  case "$bee_mb" in
    ''|*[!0-9]*) bee_mb=1024 ;;
  esac
  [ "$bee_mb" -ge 128 ] || bee_mb=1024

  memory_bytes=$(container_memory_bytes)
  if [ -n "$memory_bytes" ] && [ "$bee_mb" -gt 0 ]; then
    from_memory=$((memory_bytes / 1048576 / bee_mb))
  else
    from_memory=0
  fi

  derived=$from_keys
  if [ "$from_memory" -gt 0 ] && [ "$from_memory" -lt "$derived" ]; then
    derived=$from_memory
  fi
  [ "$derived" -ge 1 ] || derived=1

  echo "[entrypoint] lanes: $credentials credential(s) x $lanes = $from_keys" >&2
  if [ "$from_memory" -gt 0 ]; then
    echo "[entrypoint] memory: $((memory_bytes / 1048576)) MiB / $bee_mb MiB per bee = $from_memory" >&2
  else
    echo "[entrypoint] memory: no container limit readable, so it does not bind" >&2
  fi

  # ONLY the explicitly named ceiling caps the derivation. A bare
  # TRIOS_QUEEN_MAX_WORKERS is the old static number and is IGNORED, loudly:
  # measured 2026-09-20, something outside both repositories rewrote it to 9
  # twice within ten minutes of it being set to 20, and a derived cap that
  # honours whatever is in that variable inherits the same problem it was
  # written to end. An operator who wants a lower ceiling names it as one.
  legacy=${TRIOS_QUEEN_MAX_WORKERS:-}
  if [ -n "$legacy" ] && [ "$legacy" != "$derived" ]; then
    echo "[entrypoint] TRIOS_QUEEN_MAX_WORKERS=$legacy is ignored; the lane count is derived. Use TRIOS_QUEEN_MAX_WORKERS_CEILING to cap it." >&2
  fi
  ceiling=${TRIOS_QUEEN_MAX_WORKERS_CEILING:-}
  case "$ceiling" in
    ''|*[!0-9]*) ceiling="" ;;
  esac
  if [ -n "$ceiling" ] && [ "$ceiling" -ge 1 ] && [ "$ceiling" -lt "$derived" ]; then
    echo "[entrypoint] an operator ceiling of $ceiling is lower than the derived $derived; using $ceiling" >&2
    derived=$ceiling
  fi

  echo "$derived"
}

TRIOS_QUEEN_MAX_WORKERS=$(derive_worker_cap)
export TRIOS_QUEEN_MAX_WORKERS
echo "[entrypoint] TRIOS_QUEEN_MAX_WORKERS=$TRIOS_QUEEN_MAX_WORKERS (derived)"

if [ -z "$TRIOS_REPO_URL" ]; then
  echo "[entrypoint] TRIOS_REPO_URL unset; starting without a checkout"
  run_supervised "$@"
fi

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
TRIOS_REPO_REF="${TRIOS_REPO_REF:-dev}"
REPO_NAME="$(basename "$TRIOS_REPO_URL" .git)"
REPO_DIR="$WORKSPACE_DIR/$REPO_NAME"

# Every git command below runs as the unprivileged account, never as root.
#
# The tree belongs to that account, and git reads configuration and runs hooks
# from the tree it operates on. Root running `git fetch` here on a redeploy
# would execute whatever the previous occupant left in `.git/config` -
# `credential.helper` is a shell command, and so is a `pre-push` hook - with
# root's environment attached. So root prepares the directory and then steps
# out of the way.
if [ -n "$TRIOS_TOOL_SHELL_USER" ] && id "$TRIOS_TOOL_SHELL_USER" >/dev/null 2>&1; then
  AS_USER="su -s /bin/sh $TRIOS_TOOL_SHELL_USER -c"
  mkdir -p "$WORKSPACE_DIR"
  # Ownership is settled once, not re-walked on every start. On 2026-09-03 the
  # volume held 41 bee worktrees - 45 GB, three million inodes - and the
  # unconditional `chown -R` took longer than the 300 s healthcheck, so the
  # deploy reported success while the server had not yet been started and the
  # edge answered 502 for ten minutes. Only files root created since the last
  # start can have the wrong owner, and root creates none here; a fresh volume
  # is the one case that needs the walk, and it is empty then.
  if [ "$(stat -c %U "$WORKSPACE_DIR" 2>/dev/null)" != "$TRIOS_TOOL_SHELL_USER" ]; then
    echo "[entrypoint] $WORKSPACE_DIR is not owned by $TRIOS_TOOL_SHELL_USER; settling ownership once"
    chown -R "$TRIOS_TOOL_SHELL_USER" "$WORKSPACE_DIR"
  fi
  # AND INSIDE THE CHECKOUT, which the test above cannot see. Measured on the
  # running deployment 2026-09-20:
  #
  #   error: Your local changes to the following files would be overwritten by checkout:
  #   error: unable to create file specs/port/tools/gft_deep_demo.t27: Permission denied
  #
  # $WORKSPACE_DIR was owned by the bee, so the walk above was skipped, while
  # files underneath were not - left by a root-run git from an older image. A
  # bee that cannot write the checkout produces an EMPTY branch and a turn that
  # looks like a model failure: 80 of 101 stuck issues on that day had one.
  #
  # `find ! -user -print -quit` stops at the FIRST wrong file, so the healthy
  # case costs one stat and the 45 GB walk that once outlasted the 300 s
  # healthcheck (2026-09-03) cannot come back. The repair walks the checkout
  # only - never the worktrees beside it - and changes only what is wrong.
  if [ -d "$REPO_DIR" ] && [ -n "$(find "$REPO_DIR" ! -user "$TRIOS_TOOL_SHELL_USER" -print -quit 2>/dev/null)" ]; then
    echo "[entrypoint] files inside $REPO_DIR are not owned by $TRIOS_TOOL_SHELL_USER; repairing those"
    find "$REPO_DIR" ! -user "$TRIOS_TOOL_SHELL_USER" -exec chown "$TRIOS_TOOL_SHELL_USER" {} + 2>/dev/null || true
  fi
  # BEE WORKTREES FROM A PREVIOUS LIFE. At entrypoint time no bee is running -
  # this process is what starts the server that starts them - so every
  # directory under .worktrees/ belongs to a container that is already gone.
  #
  # They are not free. Measured on the running deployment 2026-09-20: every
  # tick for six minutes chose an issue and then refused to start it -
  #
  #   Queen tick chose an issue but the container cannot carry another bee
  #     issue=4438 resource="disk"
  #
  # - with twenty lanes open and 684 candidates waiting. The volume had filled
  # with worktrees nobody could use; an earlier reading of the same volume
  # found 41 of them holding 45 GB and three million inodes.
  #
  # `git worktree prune` alone does not do it: it drops the ADMIN records for
  # directories that are already gone, and these directories are still there.
  if [ -d "$REPO_DIR/.worktrees" ]; then
    stale=$(ls -1 "$REPO_DIR/.worktrees" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$stale" != "0" ]; then
      free_before=$(df -Pm "$REPO_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
      echo "[entrypoint] removing $stale bee worktree(s) left by a previous container (${free_before:-?} MiB free)"
      $AS_USER "rm -rf '$REPO_DIR/.worktrees'/* '$REPO_DIR/.worktrees'/.[!.]*" 2>/dev/null || true
      $AS_USER "git -C '$REPO_DIR' worktree prune" >/dev/null 2>&1 || true
      free_after=$(df -Pm "$REPO_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
      echo "[entrypoint] worktrees cleared; ${free_after:-?} MiB free now"
    fi
  fi
  echo "[entrypoint] git runs as $TRIOS_TOOL_SHELL_USER; root does not enter the checkout"
else
  AS_USER="sh -c"
  echo "[entrypoint] no unprivileged account configured; git runs as the current user"
fi

# An agent that commits needs an author. Without one git refuses the commit
# with a message about --global config, which reads as a broken tool rather
# than a missing setting.
#
# BEFORE the fetch, not after: `git stash` writes a commit too, so with the
# identity still unset it printed "Aborting" and left the tree dirty, which is
# how eleven paths survived a stash that had just said it saved them.
if [ -d "$REPO_DIR/.git" ]; then
  $AS_USER "git -C '$REPO_DIR' config user.name '${GIT_AUTHOR_NAME:-Trinity Bee}' \
    && git -C '$REPO_DIR' config user.email '${GIT_AUTHOR_EMAIL:-bee@trinity.local}'"
fi

if [ -d "$REPO_DIR/.git" ]; then
  echo "[entrypoint] checkout present at $REPO_DIR; fetching $TRIOS_REPO_REF"
  # A failed fetch is not a reason to refuse to serve. The checkout on disk is
  # still a checkout, and a server that will not start because GitHub was
  # briefly unreachable is worse than one working from a slightly old tree -
  # which is a state anyone can see and fix, unlike a container that exits.
  #
  # NOT --depth 1, and NOT a detached FETCH_HEAD. The Queen's committer asks
  # git for both: `baseBranch()` reads the current branch and returns nil on a
  # detached head, which refuses every acceptance, and `merge-base` needs
  # history that a depth of one does not have. The clone below is blobless
  # rather than shallow for the same reason - agents need `log` and `blame`.
  # TWO STEPS, NOT ONE `&&`. Joined, the failure of either printed "fetch
  # failed", and for three days it was the OTHER one: the fetch succeeded, the
  # checkout refused with "Your local changes to the following files would be
  # overwritten", and the tree sat on 0ad96968 while origin/master moved 366
  # commits ahead. A message that names the wrong half of a command sends every
  # reader to the wrong place.
  if $AS_USER "git -C '$REPO_DIR' fetch origin '$TRIOS_REPO_REF'"; then
    if ! $AS_USER "git -C '$REPO_DIR' checkout -B '$TRIOS_REPO_REF' FETCH_HEAD"; then
      # Uncommitted files an earlier turn left in the ROOT checkout (bees work
      # in worktrees; this tree is only ever read). They are set aside, never
      # discarded: `git stash` keeps them recoverable, `reset --hard` would not,
      # and nothing here is allowed to destroy work it did not write.
      dirty=$($AS_USER "git -C '$REPO_DIR' status --porcelain --untracked-files=no" | wc -l | tr -d ' ')
      echo "[entrypoint] checkout blocked by $dirty uncommitted path(s); stashing them"
      # The exit code of the stash is not the question - the first run of this
      # said "stash failed" under a "Saved working directory" line. What matters
      # is whether the tree came out CLEAN, so that is what is read, and when it
      # did not, the paths still in the way are printed instead of guessed at.
      # TRACKED FILES ONLY. `--include-untracked` made git try to stash
      # `.worktrees/`, the directory every bee's worktree lives in, and it
      # answered "Aborting" - so the stash saved nothing and the retry refused
      # with the same paths. Untracked files never block `checkout -B` anyway.
      $AS_USER "git -C '$REPO_DIR' stash push \
        --message 'entrypoint stashed a dirty root checkout'" >/dev/null 2>&1 || true
      left=$($AS_USER "git -C '$REPO_DIR' status --porcelain --untracked-files=no" | wc -l | tr -d ' ')
      if [ "$left" != "0" ]; then
        echo "[entrypoint] $left tracked path(s) still dirty after the stash:"
        $AS_USER "git -C '$REPO_DIR' status --porcelain --untracked-files=no" | head -10
      fi
      $AS_USER "git -C '$REPO_DIR' checkout -B '$TRIOS_REPO_REF' FETCH_HEAD" \
        || echo "[entrypoint] checkout still failed; continuing on the existing tree"
    fi
  else
    echo "[entrypoint] fetch FAILED; continuing on the existing checkout"
  fi
else
  echo "[entrypoint] cloning $TRIOS_REPO_URL@$TRIOS_REPO_REF into $REPO_DIR"
  # Blobless rather than shallow: agents need real history for `git log` and
  # `git blame`, but not every blob ever committed. This repository carries
  # 1.2 GB of .git and a full clone would dominate both boot time and disk.
  # Missing blobs are fetched on demand, so a file an agent actually opens
  # still arrives.
  $AS_USER "git clone --filter=blob:none --branch '$TRIOS_REPO_REF' \
    '$TRIOS_REPO_URL' '$REPO_DIR'" \
    || { echo "[entrypoint] clone FAILED; starting without a checkout"; run_supervised "$@"; }
fi

$AS_USER "git -C '$REPO_DIR' config user.name '${GIT_AUTHOR_NAME:-Trinity Bee}' \
  && git -C '$REPO_DIR' config user.email '${GIT_AUTHOR_EMAIL:-bee@trinity.local}'"

echo "[entrypoint] checkout ready: $($AS_USER "git -C '$REPO_DIR' rev-parse --short HEAD") on $TRIOS_REPO_REF"
echo "[entrypoint] this checkout can read and commit; it cannot push, by design"
run_supervised "$@"
