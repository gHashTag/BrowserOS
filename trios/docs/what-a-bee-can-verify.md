# What a bee can verify

Issue: gHashTag/trios#1290

## What this document is

A list, by name, of what a worker in the cloud container can and cannot
verify, so that an author writing Success Criteria can tell, before the
Queen delegates, whether each criterion is settleable by a bee at all.

The failure it prevents is silent and expensive. The issue looks complete,
the Queen delegates it, a bee spends a turn, and the verdict comes back
"could not check" -- or worse, a criterion is marked met on faith. Both
outcomes trace to one cause: the criterion asked for evidence the container
cannot produce.

## The measurement that produced it

Measured on 2026-08-31 by triaging every open issue with no boundary: 7 of 23
were unworkable for exactly this reason. Their success criteria read "these
tests pass", "the build is green", or "look at the rendering" -- and the
runtime image carries none of what settling any of those needs.

## What the container has

Source: `agent-server/Dockerfile`, the runtime stage that begins
`FROM oven/bun:1.3.6 AS runtime`. Each item below names where in that file
it comes from.

- bun 1.3.6 -- the base image. TypeScript under `agent-server` can be
  edited, typechecked and tested; `bun test` on a workspace runs.
- git, plus ca-certificates and openssh-client -- the only apt packages
  the runtime stage installs. A bee's whole output is a branch and a
  commit, and the certificates are what makes every TLS handshake possible.
- the compiled `queend` binary, copied to `/usr/local/bin/queend` from the
  `queen-core` build stage.
- the Swift runtime libraries, copied to `/usr/lib/swift/linux` -- enough
  for `queend` to run, not enough to build anything.

Measured again in this container's own shell on 2026-08-31: `bun`, `git`
and `queend` resolve on PATH; `make`, `swift` and `xcodebuild` are not
found.

The Dockerfile's own header adds one more absence by design: no browser.
The server starts headless, and browser tools fail per-request.

## What the container does not have

- No Swift compiler. The Dockerfile says so in its own words: "the runtime
  image below carries no Swift". The toolchain stays behind in the
  `queen-core` build stage, which compiles once at deploy and ships only
  its artifacts. No Swift file can be compiled or tested here.
- No make. The runtime stage installs only git, ca-certificates and
  openssh-client, so `make` itself is absent and every gate behind
  `make check` in the root Makefile is unreachable.
- No Xcode and no simulator. The image is Linux; Xcode does not exist on
  it, and there is no device or simulator to launch.
- No screen. Nothing visual can be confirmed: no rendering, no screenshot,
  no "look at it and see".
- No push credential, by design. The delegation brief says so itself: the
  machine holds none, and the work is carried out as a patch by the
  operator. A commit is the deliverable.

## Criteria that CAN be settled in the container

1. `test -f agent-server/Dockerfile` exits 0 -- a file exists where the
   issue says it does. Plain file inspection settles it.
2. `bun test packages/shared` passes -- a TypeScript suite under
   `agent-server` runs on the bun the image ships.
3. `git show --stat` lists exactly the owned files -- the diff is what the
   worker claims it is.

## Criteria that CANNOT be settled in the container

1. "The build is green" or "`make check` passes" -- there is no make and no
   Swift compiler, so nothing behind that gate can run at all.
2. "The rendering shows the change" or "a screenshot shows it" -- there is
   no screen, no simulator and no browser, so there is nothing to look at.
3. "The branch is pushed" -- there is no push credential, by design.

## The rule, and where the rest goes

A criterion is settleable by a bee if settling it needs nothing beyond bun,
git, and reading, writing and committing files. If it needs the Swift
compiler, `make`, Xcode, a simulator, a screen or a push, it is not
settleable in the container. A criterion that needs `make check` or a
screen cannot be settled by a bee; it must be verified on the Mac instead.

That is a routing fact, not a verdict on the work. Nothing here says any of
the seven issues counted on 2026-08-31 is wrong, or should be closed. They
are real work. They are work for a machine with a build -- a Mac with
Xcode, `make` and a screen. Write the criterion, name where it must be
settled, and let it be sent there.
