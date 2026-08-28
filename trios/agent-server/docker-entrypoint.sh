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

set -e

if [ -z "$TRIOS_REPO_URL" ]; then
  echo "[entrypoint] TRIOS_REPO_URL unset; starting without a checkout"
  exec "$@"
fi

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
TRIOS_REPO_REF="${TRIOS_REPO_REF:-dev}"
REPO_NAME="$(basename "$TRIOS_REPO_URL" .git)"
REPO_DIR="$WORKSPACE_DIR/$REPO_NAME"

if [ -d "$REPO_DIR/.git" ]; then
  echo "[entrypoint] checkout present at $REPO_DIR; fetching $TRIOS_REPO_REF"
  # A failed fetch is not a reason to refuse to serve. The checkout on disk is
  # still a checkout, and a server that will not start because GitHub was
  # briefly unreachable is worse than one working from a slightly old tree -
  # which is a state anyone can see and fix, unlike a container that exits.
  git -C "$REPO_DIR" fetch --depth 1 origin "$TRIOS_REPO_REF" \
    && git -C "$REPO_DIR" checkout -f FETCH_HEAD \
    || echo "[entrypoint] fetch failed; continuing on the existing checkout"
else
  echo "[entrypoint] cloning $TRIOS_REPO_URL@$TRIOS_REPO_REF into $REPO_DIR"
  mkdir -p "$WORKSPACE_DIR"
  # Blobless rather than shallow: agents need real history for `git log` and
  # `git blame`, but not every blob ever committed. This repository carries
  # 1.2 GB of .git and a full clone would dominate both boot time and disk.
  # Missing blobs are fetched on demand, so a file an agent actually opens
  # still arrives.
  git clone --filter=blob:none --branch "$TRIOS_REPO_REF" \
    "$TRIOS_REPO_URL" "$REPO_DIR" \
    || { echo "[entrypoint] clone FAILED; starting without a checkout"; exec "$@"; }
fi

# An agent that commits needs an author. Without one git refuses the commit
# with a message about --global config, which reads as a broken tool rather
# than a missing setting.
git -C "$REPO_DIR" config user.name "${GIT_AUTHOR_NAME:-Trinity Bee}"
git -C "$REPO_DIR" config user.email "${GIT_AUTHOR_EMAIL:-bee@trinity.local}"

# Pushing needs a credential; cloning a public repository does not. Without
# GITHUB_TOKEN a push fails with "could not read Username for
# 'https://github.com': terminal prompts disabled" - which is the correct
# failure, and is why prompts are disabled rather than left to hang forever
# on a terminal nobody is watching.
#
# The helper reads the token from the environment at the moment git asks, so
# it is never written into .git/config. Putting it in the remote URL would
# persist it on the volume and leak it into every `git remote -v`.
if [ -n "$GITHUB_TOKEN" ]; then
  git -C "$REPO_DIR" config credential.helper \
    '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'
  echo "[entrypoint] push credential configured from GITHUB_TOKEN"
else
  echo "[entrypoint] GITHUB_TOKEN unset; this checkout can read but not push"
fi

# Hand the working tree to the account the agents' shells run as, so they can
# edit and commit, while the server's own environment - and the credential in
# it - stays root's and out of their reach. Without this the agents inherit a
# root-owned checkout and every write fails.
if [ -n "$TRIOS_TOOL_SHELL_USER" ] && id "$TRIOS_TOOL_SHELL_USER" >/dev/null 2>&1; then
  chown -R "$TRIOS_TOOL_SHELL_USER" "$WORKSPACE_DIR"
  # git refuses to operate in a tree owned by someone else; both accounts touch
  # this one, so both are told it is expected.
  git config --global --add safe.directory "$REPO_DIR"
  su -s /bin/sh "$TRIOS_TOOL_SHELL_USER" -c \
    "git config --global --add safe.directory '$REPO_DIR'" || true
  echo "[entrypoint] workspace handed to $TRIOS_TOOL_SHELL_USER; server keeps its own environment"
fi

echo "[entrypoint] checkout ready: $(git -C "$REPO_DIR" rev-parse --short HEAD) on $TRIOS_REPO_REF"
exec "$@"
