# The agent-server, running where no browser and no laptop exist.
#
# Two things this image deliberately does NOT contain:
#
#   - A browser. The server starts headless (no --cdp-port) and browser tools
#     fail per-request, exactly as they do when a local browser goes away
#     mid-session. Shipping Chromium here would triple the image to serve a
#     surface nothing in the cloud path uses.
#   - The trios repository. Bees need a checkout to edit, but a checkout baked
#     into an image is a snapshot that rots from the first commit after build.
#     It is cloned at runtime into WORKSPACE_DIR instead.

FROM oven/bun:1.3.6 AS deps
WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the dependency
# graph. Every workspace named by the root `workspaces` globs must have its
# manifest present or the resolver fails, even for the ones nothing imports.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/agent/package.json apps/agent/
COPY apps/eval/package.json apps/eval/
COPY apps/trios-mcp-bridge/package.json apps/trios-mcp-bridge/
COPY packages/shared/package.json packages/shared/
COPY packages/cdp-protocol/package.json packages/cdp-protocol/
COPY packages/build-tools/package.json packages/build-tools/

RUN bun install --frozen-lockfile --production

# Does the Queen's policy actually build on Linux?
#
# `make queen-core` on macOS proves these eleven files compile against
# Foundation alone, and that is a weaker claim than it reads: Combine,
# Security, CryptoKit and AppKit all import fine on a Mac and are absent on a
# server, so a file that quietly acquired one would still pass that gate. This
# stage compiles them with the Linux toolchain, so a regression fails the
# deploy instead of failing a server nobody has written yet.
#
# The artifact is not shipped. It is the compile that is the evidence, and the
# runtime image below carries no Swift.
FROM swift:6.0-jammy AS queen-core
WORKDIR /queen-core
COPY queen-core/Package.swift ./
COPY queen-core/Sources ./Sources
RUN swift build -c release 2>&1 | tail -20
# One file at a known path, because the layout of .build differs between
# platforms and Swift versions and a COPY that guesses fails the deploy for a
# reason that has nothing to do with the code it is meant to check.
RUN find .build -name 'QueenCore.swiftmodule' -print -quit > /queen-core/built.txt \
 && test -s /queen-core/built.txt \
 && echo "QueenCore compiles on Linux: $(cat /queen-core/built.txt)" > /queen-core/PROOF
# The binary itself, at a path that does not depend on the triple.
RUN cp "$(swift build -c release --show-bin-path)/queend" /queen-core/queend \
 && /queen-core/queend </dev/null 2>/dev/null; \
    test -x /queen-core/queend

# RING-00, the .t27 decision core, as a binary the production round can call.
#
# `rings/T27-00/generated/queen_core.rs` is generated from
# `rings/T27-00/queen_core.t27` by t27c, and until this stage existed nothing
# outside `tests/t27/ring00_parity.sh` had ever executed it. Two bare `rustc`
# invocations are its entire build - no cargo, no lockfile, no dependency -
# which is why this stage needs a toolchain and not a package manager.
#
# THE BUILD CONTEXT DOES NOT CONTAIN THE RINGS. MEASURED 2026-09-03, AND THE
# TWO COPY LINES BELOW FAIL UNTIL SOMEONE ACTS ON THIS.
#
# The context root for this service is `trios/agent-server`, not `trios`:
# `railway.json` and `.dockerignore` both sit here, and all nine COPY sources
# already in this file (package.json, bun.lock, apps/server, packages/shared,
# queen-core/Package.swift, queen-core/Sources, docker-entrypoint.sh, ...)
# resolve under `trios/agent-server` and none of them resolve under `trios`.
# The rings live at `trios/rings`, one level ABOVE that root, and a COPY cannot
# reach outside its context.
#
# The obvious fix is the wrong one. Pointing the service root at `trios` would
# send a 9.2 GB context - 3.6 GB of `.worktrees`, 883 MB of `target`, 380 MB of
# `.app` bundles - and `trios/` has no `.dockerignore`, so none of it would be
# filtered. That is precisely the timeout the `.dockerignore` at the top of
# this directory was written about. The two files actually needed total 16 KB.
#
# So the ring sources have to come INTO this context. Either is fine and the
# COPY lines below are already correct for both, which is why they are written
# this way and will not need editing afterwards:
#
#   (a) put the ring sources under `agent-server/rings/T27-00/` - 16 KB, but
#       a second copy of a generated artifact, so it needs a gate that fails
#       when it drifts from `rings/T27-00/generated/queen_core.rs`;
#   (b) move the service root to `trios` AND add a `trios/.dockerignore` that
#       excludes everything except `agent-server` and `rings/T27-00` - no
#       duplication, but every other COPY in this file then needs an
#       `agent-server/` prefix and the Railway root directory must change.
#
# Neither is a change this file can make alone. Until one lands, this build
# stops here with a missing-file error, which is the correct outcome: a ring
# that is silently skipped is the decorative ring we started with.
#
# bookworm on purpose, against a trixie runtime. `oven/bun:1.3.6` is built on
# Debian trixie - read out of the image config, whose first history entry is
# `debian.sh --arch 'amd64' out/ 'trixie'` - so its glibc is 2.41. Building on
# bookworm's 2.36 produces a binary that newer glibc loads; building on the
# newer base and running on the older one is the direction that breaks, so the
# older base is the safe end to pin. No architecture is named anywhere here:
# both images are multi-arch and BuildKit matches the platform.
FROM rust:1-slim-bookworm AS t27core
WORKDIR /ring

# The repository layout is reproduced rather than flattened, and that is load
# bearing. The shim embeds the generated file with
# `include_str!("../generated/queen_core.rs")` so `t27core constants` lists
# what the .t27 actually declares instead of a table someone maintains by
# hand. Copy the two files into one directory and that include stops
# resolving - measured while writing this stage, not guessed.
COPY t27-core/queen_core.rs rings/T27-00/generated/queen_core.rs
COPY t27-core/t27core.rs                 rings/T27-00/shim/t27core.rs

# The generated artifact alone first. Its stated contract is that it compiles
# under bare `rustc --crate-type lib --edition 2021`, and this is that claim
# executed on Linux rather than read.
RUN rustc --edition 2021 --crate-type lib \
      rings/T27-00/generated/queen_core.rs -o libqueen_core.rlib

# The shim as its own crate, linked against it - the same two-step build the
# parity harness uses. Warnings are deliberately not errors: the generated
# file carries redundant-parenthesis warnings that belong to the code
# generator, and failing a deploy on them would put a style rule between the
# Queen and her ring.
RUN rustc --edition 2021 -O rings/T27-00/shim/t27core.rs \
      --extern queen_core=libqueen_core.rlib -o /ring/t27core

# A binary that exists is not a binary that answers. One row per subcommand,
# each the answer the Swift policy gives for the same input, plus the refusal
# path - because a decision core that guesses at its input is the single
# failure this contract exists to prevent.
#
# The constant count is derived from the artifact on both sides rather than
# written here as a number. A hand-copied count is the defect this ring exists
# to end; it would also go stale the first time the .t27 gains a constant.
RUN set -e; \
    t=/ring/t27core; \
    "$t" capacity 0       | grep -qx 'can_start_another=true'; \
    "$t" capacity 0       | grep -qx 'free_slots=4'; \
    "$t" capacity 4       | grep -qx 'can_start_another=false'; \
    "$t" review 3 2 0 2 0 | grep -qx 'name=wait'; \
    "$t" review 3 3 0 2 0 | grep -qx 'name=accept'; \
    "$t" review 3 3 1 2 0 | grep -qx 'name=send_back'; \
    "$t" review 3 3 1 2 2 | grep -qx 'name=escalate'; \
    "$t" retry 1          | grep -qx 'name=attempt'; \
    "$t" retry 2          | grep -qx 'name=escalate'; \
    "$t" merge 2 1 0 1    | grep -qx 'name=approve'; \
    "$t" merge 1 1 0 1    | grep -qx 'name=wait'; \
    "$t" merge 3 1 0 1    | grep -qx 'name=wake_worker'; \
    "$t" merge 2 1 1 1    | grep -qx 'name=refuse'; \
    "$t" counts 0         | grep -qx 'counts_against_issue=false'; \
    "$t" counts 1         | grep -qx 'counts_against_issue=true'; \
    "$t" constants        | grep -qx 'REVIEW_SEND_BACK=2'; \
    test "$("$t" constants | wc -l)" \
       -eq "$(grep -c '^pub const' rings/T27-00/generated/queen_core.rs)"; \
    if "$t" capacity abc 2>/dev/null; then \
      echo "t27core accepted a non-integer instead of refusing"; exit 1; fi; \
    echo "RING-00 answers on Linux"

FROM oven/bun:1.3.6 AS runtime
WORKDIR /app

# git is not a convenience here: a bee's whole output is a branch and a push.
# ca-certificates is what makes the Postgres TLS handshake and every provider
# call possible.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

# An unprivileged account for the agents' shell commands.
#
# The server keeps running as root, and the two being DIFFERENT is the whole
# point. Measured 2026-08-28 on this deployment when everything shared uid 0:
# `tr '\0' '\n' < /proc/1/environ` inside a tool command printed the server's
# entire environment - GITHUB_TOKEN, DATABASE_URL, and the server's own
# TRIOS_API_TOKEN. The environment allowlist in bash.ts was scrubbing the
# child's copy while the original sat readable one directory away in /proc.
#
# Making them one non-root user instead would not have helped: /proc/1/environ
# is readable by the process owner, so any shared uid re-opens it.
RUN useradd --system --create-home --home-dir /home/bee --shell /usr/sbin/nologin bee
ENV TRIOS_TOOL_SHELL_USER=bee

# The whole install tree, not just /app/node_modules.
#
# bun does not hoist workspace links to the root: `@browseros/shared` is
# resolved through `apps/server/node_modules/@browseros/shared`, a per-package
# directory. Copying only the root node_modules produces an image that builds
# cleanly and then dies on its first import with "Cannot find module
# '@browseros/shared/constants/exit-codes'" - measured, not guessed.
COPY --from=deps /app /app

# Source last. The context excludes every node_modules, so these copies merge
# into the install tree above rather than replacing it.
COPY apps/server apps/server
COPY packages/shared packages/shared
COPY packages/cdp-protocol packages/cdp-protocol

# Where bees check out and work.
#
# THIS COMMENT USED TO SAY "A volume mounts here in production so a redeploy
# does not throw away an in-flight worktree." No volume was ever created.
# Measured 2026-08-31 inside the running container:
#
#   df -h /workspace   -> overlay (the container's own layer)
#   mount | grep workspace -> nothing
#   git reflog         -> "clone: from https://github.com/..."
#   railway volume list -> one volume, redis-volume, on the Redis service
#
# So every redeploy re-clones and every bee's branch, worktree and COMMIT is
# destroyed. It has already cost one: e52f41ad, a real seal written by a real
# model, gone with the deploy that followed it.
#
# The comment described an intention and read as a fact, which is the whole
# reason it is worth this many lines now. Until a volume exists, treat any work
# in here as lost at the next deploy:
#
#   railway volume add --service trios-agent-server --mount-path /workspace
ENV WORKSPACE_DIR=/workspace
RUN mkdir -p /workspace
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Forces the Swift stage to run: BuildKit builds only what the final image
# depends on, so a stage nothing copies from is a stage that never compiles and
# therefore never fails. The module itself is the evidence and it is tiny; the
# Swift toolchain stays behind in that stage.
COPY --from=queen-core /queen-core/PROOF /app/queen-core-linux.proof
# The Queen's first decision-maker to run in the cloud rather than on a laptop.
# Statically what it needs from Swift comes with it; the toolchain stays behind.
COPY --from=queen-core /queen-core/queend /usr/local/bin/queend
COPY --from=queen-core /usr/lib/swift/linux /usr/lib/swift/linux

# RING-00 itself, on PATH. This COPY is also what forces the t27core stage to
# run at all - the same BuildKit rule the `queen-core-linux.proof` copy above
# exists for, and the same trap: a stage nothing copies from never compiles
# and so never fails. The Rust toolchain stays behind in that stage exactly as
# the Swift one does; what ships is one small binary with no dependency beyond
# libc.
COPY --from=t27core /ring/t27core /usr/local/bin/t27core

# And it answers HERE, in the image that actually ships, not only in the stage
# that built it. This is the check the `queend` copy above does not have: a
# binary compiled on one Debian and copied onto another is exactly where a
# glibc mismatch appears, and it appears at runtime, silently, on whichever
# round first asks the ring a question. Running it during the build turns that
# into a failed deploy instead.
RUN t27core constants | grep -q '^MAX_CONCURRENT_WORKERS=' \
 && t27core capacity 0 > /dev/null \
 && echo "RING-00 executes in the runtime image"

# Bind wide, because the platform routes to this container from outside and a
# server on loopback accepts nothing while looking perfectly healthy from
# inside. PORT is injected by the platform at deploy time; 8080 is only the
# fallback for `docker run` with nothing set.
ENV BROWSEROS_SERVER_HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# NODE_ENV is deliberately NOT set to production.
#
# `validateInlinedEnv` reads NODE_ENV=production as "this is a shipped
# BrowserOS distribution" and refuses to start without SENTRY_DSN,
# POSTHOG_API_KEY, CODEGEN_SERVICE_URL and BROWSEROS_CONFIG_URL baked in.
# For BrowserOS's own binary that is a sound release check. This image is a
# self-hosted backend: those services do not exist for it, and setting the
# variables to satisfy the check would be claiming a telemetry pipeline that
# is not there. Not claiming to be a distribution build is the honest answer.

# No --cdp-port on purpose. See the header.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "apps/server/src/index.ts"]
