# Dispatch died on "fatal: protocol 'https' is not supported" (gHashTag/trios#1323)

On 2026-09-02 every dispatch that needed a new worktree died on
`git fetch --quiet origin` with `fatal: protocol 'https' is not supported`,
while dispatches that reused a worktree kept working, because
`prepareWorktree` returns before the fetch on reuse. The same command, run
through `filesystem_bash`, succeeded. The difference was the environment:
`filesystem_bash` builds the child environment from the ten-name allowlist
in `agent-server/apps/server/src/tools/filesystem/bash.ts` (`ENV_ALLOWLIST`,
lines 59-68, applied by `spawnEnv()`, lines 72-82, used at line 202: PATH,
HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, TERM, DEVELOPER_DIR),
while the dispatch spawn passed no `env` at all and inherited the server
container's full environment.

Code as it stands in this worktree (branch queen-1323, checked 2026-09-03):

- `agent-server/apps/server/src/api/services/queen-dispatch.ts:295` -
  `spawn(argv[0], argv.slice(1), { cwd })` in `run()`, no `env` option, so
  whatever the `su` in `shellArgv` passes through reaches git.
- `agent-server/apps/server/src/api/services/queen-dispatch.ts:379-410` -
  the reuse path returns before the fetch.
- `agent-server/apps/server/src/api/services/queen-dispatch.ts:412-417` -
  the `git fetch --quiet origin` whose failure is the subject here.

The issue cites the fix as commit b1f2d5fb4 passing `env: spawnEnv()` at
queen-dispatch.ts:251 with the explaining comment at lines 228-250; that
commit is not in this worktree's history (`git log --all` has no b1f2d5f),
and the line numbers above are this tree's.

This document exists so the knowledge is no longer one comment deep:
`grep -rl "protocol 'https' is not supported" docs/` finds this file, which
names the probe, the control, every candidate tried, and the verdict. It
claims no cause that no row below supports.

## Facts, measured in the container on 2026-09-03

Debian 13 container, Linux 6.18. Every value below is verbatim command
output; the command that produced it follows in the bullet list.

GIT-VERSION: git version 2.47.3
GIT-EXEC-PATH: /usr/lib/git-core
SHELL-USER: bee
PROBE-URL: https://127.0.0.1:1/x.git
CONTROL: fatal: unable to access 'https://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server
SERVER-ENV-READABLE: no
CANDIDATES: 199

- `git --version` printed the GIT-VERSION value; `git --exec-path` printed
  the GIT-EXEC-PATH value; `id -un` printed the SHELL-USER value.
- The probe URL resolves no name and attempts one loopback connection to a
  closed port. The message, when it appears, is printed during transport
  selection, before any socket is opened, so a sweep over every candidate
  costs seconds, needs no network, and needs no credentials.
- The control command. This is the environment `spawnEnv()` builds for this
  user: the ten allowlist names that are unset in this shell (TMPDIR, LANG,
  LC_ALL, DEVELOPER_DIR) contribute nothing, leaving exactly these six.

      env -i PATH="$PATH" HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" TERM="$TERM" git ls-remote https://127.0.0.1:1/x.git

  The CONTROL fact holds that command's first stderr line, taken with
  `2>&1 >/dev/null | head -n 1`. It contains no `is not supported`; that is
  the line every candidate below is measured against.
- `tr '\0' '\n' < /proc/1/environ >/dev/null` exited 2 ("cannot open
  /proc/1/environ: Permission denied"), which is why the fact above reads
  `no`. PID 1 is `bun apps/server/src/index.ts` and belongs to another uid,
  so the live server environment was NOT observable from this bee shell.
  That is the uid split working as designed: bash.ts documents that on
  2026-08-28, when the container ran everything as root, the same read
  printed the server's whole environment. The candidate list below is
  therefore reconstructed from the image and the git binary, not read from
  the live environment, and every probe value is synthetic.
- The CANDIDATES fact is the line count of the union command in the next
  section (`... | sort -u | grep -c .` printed 199).

## Candidate list, produced by command

Four sources, merged and sorted. Paths are relative to the repository root.

1. Names the git binary itself owns. The command from the issue:

       strings "$(command -v git)" | grep -E '^GIT_[A-Z0-9_]+$' | sort -u

   binutils `strings` is absent from this image (`command -v strings` is
   empty), so the equivalent actually used - which extracts the same maximal
   printable runs of minimum length 4 - is:

       grep -aoE '[ -~]{4,}' "$(command -v git)" | grep -E '^GIT_[A-Z0-9_]+$' | sort -u

   This source alone yields 166 names.

2. Names the image declares, from the command in the issue, with the ENV/ARG
   prefix stripped by `cut -d' ' -f2-` (TRIOS_TOOL_SHELL_USER, WORKSPACE_DIR,
   BROWSEROS_SERVER_HOST, PORT):

       grep -hoE '^(ENV|ARG) [A-Z_][A-Z0-9_]*' agent-server/Dockerfile

3. Variables referenced by the entrypoint:

       grep -oE '\$\{?[A-Z_][A-Z0-9_]*' agent-server/docker-entrypoint.sh | tr -d '${' | sort -u

4. Uppercase tokens of the allowlist module, chosen because bash.ts is where
   the historical 52-variable inherited environment was measured
   (2026-08-21: SSH_AUTH_SOCK, DATABASE_URL and KAGGLE_API_TOKEN among the
   inherited names; GITHUB_TOKEN and TRIOS_API_TOKEN appear in the same
   file):

       grep -oE '[A-Z][A-Z0-9_]{2,}' agent-server/apps/server/src/tools/filesystem/bash.ts | sort -u

   This source also yields code constants (ENV_ALLOWLIST, TAIL_WINDOW_CHARS,
   RSS, ...) that are not environment names. They are probed anyway: a name
   that is not an environment variable cannot reproduce the failure and is
   recorded as `no` like any other miss.

Union and count, as the sweep block runs it:

    { grep -aoE '[ -~]{4,}' "$(command -v git)" | grep -E '^GIT_[A-Z0-9_]+$'
      grep -hoE '^(ENV|ARG) [A-Z_][A-Z0-9_]*' agent-server/Dockerfile | cut -d' ' -f2-
      grep -oE '\$\{?[A-Z_][A-Z0-9_]*' agent-server/docker-entrypoint.sh | tr -d '${'
      grep -oE '[A-Z][A-Z0-9_]{2,}' agent-server/apps/server/src/tools/filesystem/bash.ts
    } | grep -E '^[A-Z][A-Z0-9_]*$' | sort -u | grep -c .

## Non-causes re-measured on this git before being quoted

The issue excluded three variables on macOS git and required re-measurement
against the container git before quoting. Each below is the probe run under
the control environment plus that single variable; first stderr line(s),
verbatim, on git 2.47.3.

- GIT_EXEC_PATH=/nonexistent: `git: 'remote-https' is not a git command.
  See 'git --help'.` then `fatal: remote helper 'https' aborted session`.
- GIT_ALLOW_PROTOCOL=file: `fatal: transport 'https' not allowed`.
- PATH=/nonexistent: the ordinary connect failure, identical to the control
  line above (remote helpers are found via GIT-EXEC-PATH, not PATH).

Positive control, proving the probe harness can elicit the message on this
build. A mangled URL with one leading space in the scheme,

    env -i PATH="$PATH" HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" TERM="$TERM" git ls-remote " https://127.0.0.1:1/x.git"

prints `fatal: protocol ' https' is not supported`. The incident message
carried a clean `https`, so the URL was intact and the trigger had to come
from elsewhere. The format string `protocol '%s' is not supported` is
present in /usr/bin/git (grep -c on the binary returns a match).

## Results

One probe per candidate: the control environment plus that single variable,
compared against the full stderr. With the server environment unreadable,
the "Value used" column holds the synthetic probe value: `1` everywhere,
except GIT_EXEC_PATH=/nonexistent and GIT_ALLOW_PROTOCOL=file, which mirror
the re-measured non-causes above. Names in the KEY/TOKEN/SECRET/PASSWORD
families are recorded as `<redacted>` by rule; on this run the probe value
behind every such row was the synthetic `1`, never a live credential.

| Variable | Value used | Outcome |
| --- | --- | --- |
| AS_USER | 1 | no |
| BROWSEROS_SERVER_HOST | 1 | no |
| DATABASE_URL | 1 | no |
| DEFAULT_BASH_TIMEOUT | 1 | no |
| DEVELOPER_DIR | 1 | no |
| ENV_ALLOWLIST | 1 | no |
| GITHUB_TOKEN | <redacted> | no |
| GIT_ADVICE | 1 | no |
| GIT_ALLOC_LIMIT | 1 | no |
| GIT_ALLOW_NULL_SHA1 | 1 | no |
| GIT_ALLOW_PROTOCOL | file | no |
| GIT_ALTERNATE_OBJECT_DIRECTORIES | 1 | no |
| GIT_ASKPASS | 1 | no |
| GIT_ATTR_GLOBAL | 1 | no |
| GIT_ATTR_NOSYSTEM | 1 | no |
| GIT_ATTR_SOURCE | 1 | no |
| GIT_ATTR_SYSTEM | 1 | no |
| GIT_AUTHOR_DATE | 1 | no |
| GIT_AUTHOR_EMAIL | 1 | no |
| GIT_AUTHOR_IDENT | 1 | no |
| GIT_AUTHOR_NAME | 1 | no |
| GIT_BASENAME_FACTOR | 1 | no |
| GIT_CEILING_DIRECTORIES | 1 | no |
| GIT_CHERRY_PICK_HELP | 1 | no |
| GIT_COMMITTER_DATE | 1 | no |
| GIT_COMMITTER_EMAIL | 1 | no |
| GIT_COMMITTER_IDENT | 1 | no |
| GIT_COMMITTER_NAME | 1 | no |
| GIT_COMMIT_GRAPH_PARANOIA | 1 | no |
| GIT_COMMON_DIR | 1 | no |
| GIT_CONFIG | 1 | no |
| GIT_CONFIG_COUNT | 1 | no |
| GIT_CONFIG_GLOBAL | 1 | no |
| GIT_CONFIG_NOSYSTEM | 1 | no |
| GIT_CONFIG_PARAMETERS | 1 | no |
| GIT_CONFIG_SYSTEM | 1 | no |
| GIT_DEFAULT_BRANCH | 1 | no |
| GIT_DEFAULT_HASH | 1 | no |
| GIT_DEFAULT_REF_FORMAT | 1 | no |
| GIT_DIFFTOOL_DIRDIFF | 1 | no |
| GIT_DIFFTOOL_EXTCMD | 1 | no |
| GIT_DIFFTOOL_TRUST_EXIT_CODE | 1 | no |
| GIT_DIFF_OPTS | 1 | no |
| GIT_DIFF_TOOL | 1 | no |
| GIT_DISABLE_UNTRACKED_CACHE | 1 | no |
| GIT_DISCOVERY_ACROSS_FILESYSTEM | 1 | no |
| GIT_EDITOR | 1 | no |
| GIT_EXEC_PATH | /nonexistent | no |
| GIT_EXTERNAL_DIFF | 1 | no |
| GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE | 1 | no |
| GIT_EXT_SERVICE | 1 | no |
| GIT_EXT_SERVICE_NOPREFIX | 1 | no |
| GIT_FLUSH | 1 | no |
| GIT_FORCE_THREADS | 1 | no |
| GIT_FORCE_UNTRACKED_CACHE | 1 | no |
| GIT_GLOB_PATHSPECS | 1 | no |
| GIT_GRAFT_FILE | 1 | no |
| GIT_ICASE_PATHSPECS | 1 | no |
| GIT_IMPLICIT_WORK_TREE | 1 | no |
| GIT_INDEX_FILE | 1 | no |
| GIT_INDEX_VERSION | 1 | no |
| GIT_LITERAL_PATHSPECS | 1 | no |
| GIT_MAN_VIEWER | 1 | no |
| GIT_MERGETOOL_GUI | 1 | no |
| GIT_MERGE_AUTOEDIT | 1 | no |
| GIT_MERGE_VERBOSITY | 1 | no |
| GIT_MMAP_LIMIT | 1 | no |
| GIT_NAMESPACE | 1 | no |
| GIT_NOGLOB_PATHSPECS | 1 | no |
| GIT_NOTES_DISPLAY_REF | 1 | no |
| GIT_NOTES_REF | 1 | no |
| GIT_NOTES_REWRITE_MODE | 1 | no |
| GIT_NOTES_REWRITE_REF | 1 | no |
| GIT_NO_LAZY_FETCH | 1 | no |
| GIT_NO_REPLACE_OBJECTS | 1 | no |
| GIT_OBJECT_DIRECTORY | 1 | no |
| GIT_OPTIONAL_LOCKS | 1 | no |
| GIT_OVERRIDE_VIRTUAL_HOST | 1 | no |
| GIT_PAGER | 1 | no |
| GIT_PAGER_IN_USE | 1 | no |
| GIT_PREFIX | 1 | no |
| GIT_PRINT_SHA1_ELLIPSIS | 1 | no |
| GIT_PROGRESS_DELAY | 1 | no |
| GIT_PROTOCOL_FROM_USER | 1 | no |
| GIT_PROXY_COMMAND | 1 | no |
| GIT_PUSH_OPTION_COUNT | 1 | no |
| GIT_QUARANTINE_PATH | 1 | no |
| GIT_REFLOG_ACTION | 1 | no |
| GIT_REF_PARANOIA | 1 | no |
| GIT_REPLACE_REF_BASE | 1 | no |
| GIT_SEQUENCE_EDITOR | 1 | no |
| GIT_SHALLOW_FILE | 1 | no |
| GIT_SHELL_PATH | 1 | no |
| GIT_SSH | 1 | no |
| GIT_SSH_COMMAND | 1 | no |
| GIT_SSH_VARIANT | 1 | no |
| GIT_TEMPLATE_DIR | 1 | no |
| GIT_TERMINAL_PROMPT | 1 | no |
| GIT_TEST_ASSUME_DIFFERENT_OWNER | 1 | no |
| GIT_TEST_BLOOM_SETTINGS_BITS_PER_ENTRY | 1 | no |
| GIT_TEST_BLOOM_SETTINGS_MAX_CHANGED_PATHS | 1 | no |
| GIT_TEST_BLOOM_SETTINGS_NUM_HASHES | 1 | no |
| GIT_TEST_CAT_FILE_NO_FLUSH_ON_EXIT | 1 | no |
| GIT_TEST_CHECKOUT_WORKERS | 1 | no |
| GIT_TEST_CHECK_CACHE_TREE | 1 | no |
| GIT_TEST_COMMIT_GRAPH | 1 | no |
| GIT_TEST_COMMIT_GRAPH_CHANGED_PATHS | 1 | no |
| GIT_TEST_COMMIT_GRAPH_DIE_ON_PARSE | 1 | no |
| GIT_TEST_DATE_NOW | 1 | no |
| GIT_TEST_DEFAULT_HASH_ALGO | 1 | no |
| GIT_TEST_DEFAULT_INITIAL_BRANCH_NAME | 1 | no |
| GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS | 1 | no |
| GIT_TEST_FATAL_REGISTER_SUBMODULE_ODB | 1 | no |
| GIT_TEST_FSMONITOR | 1 | no |
| GIT_TEST_FSYNC | 1 | no |
| GIT_TEST_FULL_IN_PACK_ARRAY | 1 | no |
| GIT_TEST_INDEX_THREADS | 1 | no |
| GIT_TEST_MAINT_SCHEDULER | 1 | no |
| GIT_TEST_MERGE_ALGORITHM | 1 | no |
| GIT_TEST_MIDX_READ_BTMP | 1 | no |
| GIT_TEST_MIDX_READ_RIDX | 1 | no |
| GIT_TEST_MIDX_WRITE_REV | 1 | no |
| GIT_TEST_MULTI_PACK_INDEX | 1 | no |
| GIT_TEST_MULTI_PACK_INDEX_WRITE_INCREMENTAL | 1 | no |
| GIT_TEST_NO_WRITE_REV_INDEX | 1 | no |
| GIT_TEST_OE_DELTA_SIZE | 1 | no |
| GIT_TEST_OE_SIZE | 1 | no |
| GIT_TEST_PACK_SPARSE | 1 | no |
| GIT_TEST_PACK_USE_BITMAP_BOUNDARY_TRAVERSAL | 1 | no |
| GIT_TEST_PRELOAD_INDEX | 1 | no |
| GIT_TEST_PROTOCOL_VERSION | 1 | no |
| GIT_TEST_READ_COMMIT_TABLE | 1 | no |
| GIT_TEST_REFTABLE_AUTOCOMPACTION | 1 | no |
| GIT_TEST_REV_INDEX_DIE_IN_MEMORY | 1 | no |
| GIT_TEST_REV_INDEX_DIE_ON_DISK | 1 | no |
| GIT_TEST_SIDEBAND_ALL | 1 | no |
| GIT_TEST_SPARSE_INDEX | 1 | no |
| GIT_TEST_SPLIT_INDEX | 1 | no |
| GIT_TEST_UF_DELAY_WARNING | 1 | no |
| GIT_TEST_UPGRADE_BLOOM_FILTERS | 1 | no |
| GIT_TEST_USE_PSEUDO_MERGES | 1 | no |
| GIT_TEST_VALIDATE_INDEX_CACHE_ENTRIES | 1 | no |
| GIT_TEXTDOMAINDIR | 1 | no |
| GIT_TRACE | 1 | no |
| GIT_TRACE2 | 1 | no |
| GIT_TRACE2_BRIEF | 1 | no |
| GIT_TRACE2_CONFIG_PARAMS | 1 | no |
| GIT_TRACE2_DST_DEBUG | 1 | no |
| GIT_TRACE2_ENV_VARS | 1 | no |
| GIT_TRACE2_EVENT | 1 | no |
| GIT_TRACE2_EVENT_BRIEF | 1 | no |
| GIT_TRACE2_EVENT_NESTING | 1 | no |
| GIT_TRACE2_MAX_FILES | 1 | no |
| GIT_TRACE2_PARENT_NAME | 1 | no |
| GIT_TRACE2_PARENT_SID | 1 | no |
| GIT_TRACE2_PERF | 1 | no |
| GIT_TRACE2_PERF_BRIEF | 1 | no |
| GIT_TRACE2_REDACT | 1 | no |
| GIT_TRACE_BARE | 1 | no |
| GIT_TRACE_FSMONITOR | 1 | no |
| GIT_TRACE_PACKET | 1 | no |
| GIT_TRACE_PACKFILE | 1 | no |
| GIT_TRACE_PACK_ACCESS | 1 | no |
| GIT_TRACE_PERFORMANCE | 1 | no |
| GIT_TRACE_REDACT | 1 | no |
| GIT_TRACE_REFS | 1 | no |
| GIT_TRACE_SETUP | 1 | no |
| GIT_TRACE_SHALLOW | 1 | no |
| GIT_TRACE_WORKING_TREE_ENCODING | 1 | no |
| GIT_TRANSLOOP_DEBUG | 1 | no |
| GIT_TRANSPORT_HELPER_DEBUG | 1 | no |
| GIT_USER_AGENT | 1 | no |
| GIT_WORK_TREE | 1 | no |
| HOME | 1 | no |
| KAGGLE_API_TOKEN | <redacted> | no |
| LANG | 1 | no |
| LC_ALL | 1 | no |
| LOGNAME | 1 | no |
| MAX_BASH_TIMEOUT | 1 | no |
| OOM | 1 | no |
| PATH | 1 | no |
| PORT | 1 | no |
| REPO_DIR | 1 | no |
| REPO_NAME | 1 | no |
| RSS | 1 | no |
| SHELL | 1 | no |
| SSH | 1 | no |
| SSH_AUTH_SOCK | 1 | no |
| TAIL_WINDOW_CHARS | 1 | no |
| TERM | 1 | no |
| TMPDIR | 1 | no |
| TOOL_NAME | 1 | no |
| TRIOS_API_TOKEN | <redacted> | no |
| TRIOS_BASH_ENV_ALLOWLIST | 1 | no |
| TRIOS_REPO_REF | 1 | no |
| TRIOS_REPO_URL | 1 | no |
| TRIOS_TOOL_SHELL_USER | 1 | no |
| USER | 1 | no |
| WORKSPACE_DIR | 1 | no |

## What the verdict means

No single variable from the reconstructed list, set to the synthetic value
recorded beside it, makes this git print the message. That excludes the
git binary's whole environment vocabulary (166 names), the image's declared
names, the entrypoint's names, and the names bash.ts records as
historically present in the server environment - under the probe values
used. It does NOT exclude the live server environment: its names and values
were unobservable from this bee shell (the SERVER-ENV-READABLE fact), and a
variable that misbehaves only under its real value would be missed by a
synthetic `1`. The next attempt should run the block below from a context
that can read the server environment (root on the container, or `ps eww`
against the server process as bash.ts did on 2026-08-21); when the file is
readable the block uses the live value for each candidate automatically,
and its final line names the variable if any one reproduces. Until such a
run records a row with REPRODUCED on it, no cause is claimed.

## Re-run the sweep from a clean shell

Run from the repository root; paste the block into sh. It prints the
readability decision, the candidate count, one table row per candidate, and
a final verdict line. When /proc/1/environ is unreadable, expect one shell
redirection warning from the readability probe; it is cosmetic, and the
exit code of the tr command is what the decision is taken from.

```sh
# Re-runs the sweep recorded above. POSIX sh, from the repository root.
URL='https://127.0.0.1:1/x.git'
SERVER_ENV=/proc/1/environ
GIT_BIN=$(command -v git)
TMO=$(command -v timeout)

if tr '\0' '\n' < "$SERVER_ENV" >/dev/null 2>&1; then READABLE=yes; else READABLE=no; fi
printf 'SERVER-ENV-READABLE: %s\n' "$READABLE"

CANDIDATES=$(
  {
    grep -aoE '[ -~]{4,}' "$GIT_BIN" | grep -E '^GIT_[A-Z0-9_]+$'
    grep -hoE '^(ENV|ARG) [A-Z_][A-Z0-9_]*' agent-server/Dockerfile | cut -d' ' -f2-
    grep -oE '\$\{?[A-Z_][A-Z0-9_]*' agent-server/docker-entrypoint.sh | tr -d '${'
    grep -oE '[A-Z][A-Z0-9_]{2,}' agent-server/apps/server/src/tools/filesystem/bash.ts
  } | grep -E '^[A-Z][A-Z0-9_]*$' | sort -u
)
COUNT=$(printf '%s\n' "$CANDIDATES" | grep -c .)
printf 'CANDIDATES: %s\n' "$COUNT"

printf '| Variable | Value used | Outcome |\n'
printf '| --- | --- | --- |\n'
VERDICT=NOT_REPRODUCED
for NAME in $CANDIDATES; do
  case "$NAME" in
    GIT_EXEC_PATH) VALUE=/nonexistent ;;
    GIT_ALLOW_PROTOCOL) VALUE=file ;;
    *)
      VALUE=1
      if [ "$READABLE" = yes ]; then
        LIVE=$(tr '\0' '\n' < "$SERVER_ENV" | sed -n "s/^${NAME}=//p" | head -n 1)
        if [ -n "$LIVE" ]; then VALUE=$LIVE; fi
      fi
      ;;
  esac
  OUT=$(env -i PATH="$PATH" HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" \
    SHELL="$SHELL" TERM="$TERM" "$NAME=$VALUE" \
    "$TMO" 10 "$GIT_BIN" ls-remote "$URL" 2>&1 >/dev/null || true)
  case "$OUT" in
    *"protocol 'https' is not supported"*) OUTCOME=REPRODUCED; VERDICT="$NAME" ;;
    *) OUTCOME=no ;;
  esac
  case "$NAME" in *KEY*|*TOKEN*|*SECRET*|*PASSWD*|*PASSWORD*) SHOWN='<redacted>' ;; *) SHOWN=$VALUE ;; esac
  printf '| %s | %s | %s |\n' "$NAME" "$SHOWN" "$OUTCOME"
done
printf 'VERDICT: %s\n' "$VERDICT"
```

VERDICT: NOT_REPRODUCED
