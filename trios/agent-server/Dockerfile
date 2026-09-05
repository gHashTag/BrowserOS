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

FROM oven/bun:1.3.6 AS runtime
WORKDIR /app

# git is not a convenience here: a bee's whole output is a branch and a push.
# ca-certificates is what makes the Postgres TLS handshake and every provider
# call possible.
# tini is here because PID 1 in this container is an application, not an init.
#
# MEASURED 2026-09-05, on the running deployment, after it had crashed:
#
#   pid 1 is: bun
#   50 processes, 37 zombies
#   zombies whose parent is PID 1: 37   with another parent: 0
#   top commands among them: git (21), esbuild (16)
#
# The bash tool spawns `sh -c <command>` and awaits it, so the direct child is
# reaped. Its GRANDCHILDREN are not: when the shell exits, git and esbuild are
# orphaned and reparented to PID 1, which must call wait() for them. bun does
# not, so they stay zombies for the life of the container.
#
# The pid table fills, `posix_spawn` starts returning EAGAIN - the deployment
# log carried `error="EAGAIN: resource temporarily unavailable"` for forty
# minutes - and then the service crashes, which is how it was found.
#
# tini as PID 1 reaps orphans and forwards signals. It is what `docker run
# --init` installs, and it is the standard answer to exactly this.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
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
# tini first, then the entrypoint, which ends in `exec "$@"` so the server still
# becomes the process that receives signals - with an init above it to bury the
# orphans it leaves behind.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "apps/server/src/index.ts"]
