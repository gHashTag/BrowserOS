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

# The T27 compiler, for the bees and for the review of the bees.
#
# MEASURED 2026-09-10 (gHashTag/t27#3560): 34 finished bee branches harvested
# from this container, every one reviewed as "met" on the bee's own verdict
# block. Run through `t27c` on a Mac: 20 did not parse, 4 parsed with DISCARDED
# tokens, 1 regressed typecheck, 9 held. Neither the bee nor the reviewer had
# the compiler; both were guessing, and the review had no way to say so.
#
# Built the way t27's own Dockerfile builds it: `bootstrap/` alone, standalone,
# with the repository's root Cargo.lock (bootstrap/Cargo.lock is stale against
# bootstrap/Cargo.toml and fails `--locked`). A sparse, blob-less clone of two
# directories, not the 400 MB repository. The commit that was built is written
# to /usr/local/share/t27c/REF and shipped, so a review can say WHICH compiler
# it measured with.
#
# T27_REF is an ARG, not a pin: the bees work against t27 master and the
# compiler that judges them should be the one master builds. The cost is that
# a cached layer serves the sha it recorded, not today's - the REF file is the
# truth, not the ARG. Bump the ARG to rebuild.
#
# Build time: 15 min on 2 vCPU (sandbox, cold cache, 2026-09-13). Nothing here
# is parallel with the Swift stage by BuildKit's choice, not ours.
FROM rust:1-bookworm AS t27c
ARG T27_REF=master
WORKDIR /src
RUN git clone --depth 1 --filter=blob:none --sparse --branch "${T27_REF}" \
        https://github.com/gHashTag/t27.git t27 \
 && cd t27 \
 && git sparse-checkout set bootstrap gen specs \
 && git rev-parse HEAD > /src/REF \
 && echo "t27c built from gHashTag/t27@$(cat /src/REF) (ref ${T27_REF})"
# Standalone: the root Cargo.toml names workspace members the sparse checkout
# does not have, so `bootstrap/` is copied out from under it and built alone.
RUN cp -r t27/bootstrap /build && cp t27/Cargo.lock /build/Cargo.lock \
 && rm -rf /build/target \
 && cd /build && cargo build --release \
 && strip /build/target/release/t27c \
 && /build/target/release/t27c --version

# The oracle's dependency tree, generated HERE because this is the stage that
# holds the corpus. The runtime stage's own specs/ is the agent server's, sixty
# files; the 946 the oracle measures live in gHashTag/t27 and arrive only in
# this sparse checkout. Baking it from the runtime stage produced a 60-file
# tree, and a tree missing a spec's imports fails it with FileNotFound --
# indistinguishable, from the outside, from the spec being broken.
RUN set -e; \
    mkdir -p /oracle-tree; \
    cd /src/t27; \
    find specs -name '*.t27' | while read -r f; do \
      d="/oracle-tree/$(printf '%s' "$f" | sed -e 's|^specs/||' -e 's|\.t27$|.zig|')"; \
      mkdir -p "$(dirname "$d")"; \
      /build/target/release/t27c gen "$f" > "$d" 2>/dev/null || rm -f "$d"; \
    done; \
    echo "oracle tree: $(find /oracle-tree -name '*.zig' | wc -l) generated"

# The oracle's compiler.
#
# t27c says whether a spec PARSES. Only Zig says whether what it generates RUNS,
# and until this stage existed nothing in the review could tell those apart: a
# bee could satisfy every stated criterion with code that does not compile, and
# did, 384 times out of 946.
#
# RING-00, the command-line face the round already calls.
#
# `crossCheckRing00Capacity` has been calling /usr/local/bin/t27core every
# round since it was written, and every round the container answered ENOENT
# and logged "Ring-00 cross-check did not run" - a check that was dead in
# production while reading, from the outside, like a check that had run.
#
# Bare rustc, no cargo and no dependencies: that is the contract stated in
# rings/T27-00/queen_core.t27's header, and it is the same two invocations
# tests/t27/ring00_parity.sh uses. The generated half is built first as a
# library, then the hand-written shim against it.
#
# The two sources are copied from agent-server/t27-core/ because the build
# context is this directory and rings/ sits above it. That mirror is not a
# second copy anybody may edit: tests/t27/ring00_generated_is_current.sh
# fails if it drifts from rings/T27-00/.
FROM rust:1-bookworm AS t27core
WORKDIR /build
# The shim reads the generated file with `include_str!("../generated/...")`, so
# the two halves have to sit in the same shape they have in rings/T27-00/ -
# flat beside each other and the build fails at the include, not at the link.
COPY t27-core/queen_core.rs generated/queen_core.rs
COPY t27-core/t27core.rs shim/t27core.rs
RUN rustc --edition 2021 --crate-type lib generated/queen_core.rs -o libqueen_core.rlib \
 && rustc --edition 2021 -O shim/t27core.rs --extern queen_core=libqueen_core.rlib -o t27core \
 && strip t27core \
 && ./t27core constants > /dev/null

# 0.16.0 exactly, because that is the version the corpus baseline in
# tools/oracle/baseline.tsv was measured against. A different Zig is a different
# verdict, and a ratchet that moves because the compiler moved is not a ratchet.
# Fetched as a tarball rather than apt because Debian has no zig package.
FROM debian:bookworm-slim AS zig
ARG ZIG_VERSION=0.16.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
      -o /tmp/zig.tar.xz \
 && mkdir -p /opt/zig \
 && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 \
 && rm /tmp/zig.tar.xz \
 && /opt/zig/zig version

FROM oven/bun:1.3.6 AS runtime
WORKDIR /app

# perl-base is declared, not assumed. The review witness forces Zig to analyse
# every function body with a perl one-liner (force_bodies), and if perl were
# missing it would fall back silently -- no false failures, but no protection
# either, the same way `cp -al` once left the oracle inert in production while
# every signal said it worked. Debian marks perl-base Essential, so this should
# be a no-op; naming it makes that a fact rather than a belief.
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
#
# python3 is here for the same reason perl-base is: declared, not assumed.
# Every gate that decides whether a bee's pull request lands is a Python
# script -- tools/dupe_scan.py is the Duplicate Body Ratchet,
# tools/check_assertionless_spec_tests.py is the corpus ratchet,
# tools/ci/check_specs_still_parse.py is the required Spec Parse Ratchet, and
# the twenty-one reporting helpers under scripts/tri_loop/ are Python too. A
# bee that cannot run the gate that will fail it is a bee guessing, and the
# brief has been telling it to run `python3 tools/dupe_scan.py --name <fn>`
# since 2026-09-20.
#
# `python3`, not `python3-minimal`: those scripts import json, hashlib,
# difflib and subprocess, and Debian's minimal package carries a subset of the
# standard library chosen for dpkg's maintainer scripts. Nothing here needs a
# module from outside the standard library, so there is no pip and no venv.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini perl-base python3 \
 && rm -rf /var/lib/apt/lists/* \
 && python3 --version

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

# The Queen's scheduler reads its cards and the compiler from here at start-up
# (apps/server/src/inngest/spec-catalog.ts, DEFAULT_SPECS_ROOT = ../../../../specs
# = /app/specs). The first GitHub deploy of #480 (Railway, 2026-09-13) came up
# with GET /queen/scheduler -> 503 "ENOENT /app/specs/t27_compiler.wasm": the
# route told the truth, the image simply did not carry the directory. The check
# below fails the build if the wasm is not the bytes specs/PIN names, so a
# drifted pin is caught here and not at the first request.
COPY specs specs
RUN test -f specs/t27_compiler.wasm \
 && want="$(sed -n 's/.*sha256 \([0-9a-f]\{64\}\).*/\1/p' specs/PIN | head -n1)" \
 && have="$(sha256sum specs/t27_compiler.wasm | cut -d' ' -f1)" \
 && test -n "$want" && test "$want" = "$have" \
 && echo "specs/t27_compiler.wasm sha256 $have matches specs/PIN"

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

# The compiler, on PATH for the bee (su resets PATH to the login default, which
# includes /usr/local/bin) and for the review, which runs it as the bee. Built
# against bookworm's glibc 2.36; the binary links only libc, libm and libgcc_s
# (ldd, 2026-09-13), so it loads on bookworm or anything newer that oven/bun
# ships on. `--version` below is the proof that it loads, taken at build time
# rather than at the first review.
COPY --from=t27c /build/target/release/t27c /usr/local/bin/t27c
COPY --from=t27c /src/REF /usr/local/share/t27c/REF
RUN /usr/local/bin/t27c --version && echo "t27c from gHashTag/t27@$(cat /usr/local/share/t27c/REF)"

# RING-00's face, on PATH at the exact path crossCheckRing00Capacity spawns.
# `constants` is the proof it loads, taken at build time rather than at the
# first round - which is where the ENOENT used to be discovered, in a log line
# nobody read.
COPY --from=t27core /build/t27core /usr/local/bin/t27core
RUN /usr/local/bin/t27core constants

# Zig ships as a binary plus a lib/ tree it reads at run time, so both come
# across and the binary is reached through a symlink rather than being moved
# away from its lib.
COPY --from=zig /opt/zig /opt/zig
RUN ln -s /opt/zig/zig /usr/local/bin/zig && zig version

# The oracle's dependency tree, built in the t27c stage from the real corpus.
#
# A generated file imports its neighbours by a path relative to where the SPEC
# sits, so the Zig has to mirror specs/ for anything to resolve. Building that
# mirror is ~950 t27c runs; on a 2 vCPU container that is minutes, and the
# witness is killed at 120s -- on timeout its script exits non-zero and the
# review records `parses: false`, which is a spec failed for a defect it does
# not have. Baking it makes the per-review cost a hardlink copy.
#
# The tree holds the DEPENDENCIES, never the verdict: the reviewed file is
# always regenerated from the bee's own commit before anything is compiled.
COPY --from=t27c /oracle-tree /usr/local/share/t27-oracle-tree
RUN echo "oracle tree: $(find /usr/local/share/t27-oracle-tree -name '*.zig' | wc -l) specs"

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
