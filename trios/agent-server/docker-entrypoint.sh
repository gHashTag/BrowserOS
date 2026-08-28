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

if [ -z "$TRIOS_REPO_URL" ]; then
  echo "[entrypoint] TRIOS_REPO_URL unset; starting without a checkout"
  exec "$@"
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
  chown -R "$TRIOS_TOOL_SHELL_USER" "$WORKSPACE_DIR"
  echo "[entrypoint] git runs as $TRIOS_TOOL_SHELL_USER; root does not enter the checkout"
else
  AS_USER="sh -c"
  echo "[entrypoint] no unprivileged account configured; git runs as the current user"
fi

if [ -d "$REPO_DIR/.git" ]; then
  echo "[entrypoint] checkout present at $REPO_DIR; fetching $TRIOS_REPO_REF"
  # A failed fetch is not a reason to refuse to serve. The checkout on disk is
  # still a checkout, and a server that will not start because GitHub was
  # briefly unreachable is worse than one working from a slightly old tree -
  # which is a state anyone can see and fix, unlike a container that exits.
  $AS_USER "git -C '$REPO_DIR' fetch --depth 1 origin '$TRIOS_REPO_REF' \
    && git -C '$REPO_DIR' checkout -f FETCH_HEAD" \
    || echo "[entrypoint] fetch failed; continuing on the existing checkout"
else
  echo "[entrypoint] cloning $TRIOS_REPO_URL@$TRIOS_REPO_REF into $REPO_DIR"
  # Blobless rather than shallow: agents need real history for `git log` and
  # `git blame`, but not every blob ever committed. This repository carries
  # 1.2 GB of .git and a full clone would dominate both boot time and disk.
  # Missing blobs are fetched on demand, so a file an agent actually opens
  # still arrives.
  $AS_USER "git clone --filter=blob:none --branch '$TRIOS_REPO_REF' \
    '$TRIOS_REPO_URL' '$REPO_DIR'" \
    || { echo "[entrypoint] clone FAILED; starting without a checkout"; exec "$@"; }
fi

# An agent that commits needs an author. Without one git refuses the commit
# with a message about --global config, which reads as a broken tool rather
# than a missing setting.
$AS_USER "git -C '$REPO_DIR' config user.name '${GIT_AUTHOR_NAME:-Trinity Bee}' \
  && git -C '$REPO_DIR' config user.email '${GIT_AUTHOR_EMAIL:-bee@trinity.local}'"

echo "[entrypoint] checkout ready: $($AS_USER "git -C '$REPO_DIR' rev-parse --short HEAD") on $TRIOS_REPO_REF"
echo "[entrypoint] this checkout can read and commit; it cannot push, by design"
exec "$@"
