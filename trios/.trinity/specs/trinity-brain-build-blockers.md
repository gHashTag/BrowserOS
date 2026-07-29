# Trinity S3AI brain: why it does not build here, and what it needs

Investigated 2026-07-29 with zig 0.16.0. Nothing in this document has been
applied to `gHashTag/trinity` - the working tree there was restored.

## Three layers, found in order

### 1. The test target had no module graph (fixable, patch ready)

`build/build.brain.zig` declared `addTest` with only a root source file, so the
build died on the first `@import("basal_ganglia")` in `brain.zig`. A module map
that lists two dozen siblings has to be built, not implied.

Fix: create a module per region and `addImport` each onto the root. Twenty-five
modules, listed explicitly rather than globbed so adding a region is a
deliberate act and a stray file cannot join the graph by accident.

### 2. One file belonged to two modules (fixable, one file)

    error: file exists in modules 'basal_ganglia' and 'perf_dashboard'

`perf_dashboard.zig` imported four siblings by *path* (`@import("x.zig")`) while
those siblings were also named modules. Zig forbids a file belonging to two
modules. Fifteen other files under `src/brain/` use path imports, but none of
them are in the module graph, so only this one conflicts.

Fix: four lines in `perf_dashboard.zig`, path imports to named imports.

### 3. The source targets an older Zig (not fixable without a migration)

With 1 and 2 applied, four errors remain and three are stdlib API surface:

| Location | Symbol | State in zig 0.16 |
|----------|--------|-------------------|
| `basal_ganglia.zig:640` | `std.Thread.Mutex` | absent |
| `metrics_dashboard.zig:181` | `std.time.milliTimestamp` | absent |
| `metrics_dashboard.zig:306` | `std.time.milliTimestamp` | absent |
| `intraparietal_sulcus.zig:142` | `hslm` | undeclared - a module the graph does not provide |

Verified against the installed stdlib: neither `pub const Mutex` in
`std/Thread.zig` nor `pub fn milliTimestamp` in `std/time.zig` exists.

## What this means for trios

The `brain-atlas` skill stays a map rather than a link, and says so. Connecting
the two would need a Zig version migration across `src/brain/`, which is work in
another repository and not something to start uninvited.

There is a second reason to be careful: the `tri` binary the brain CLI documents
collides on PATH with the Railway CLI on this machine, so even a working build
would need renaming or an absolute path before trios could call it.

## The patch

`/tmp/brain-graph-fix.zig` holds the corrected `build/build.brain.zig`. It gets
the build from "no module graph" to "four version errors", which is the useful
half of the diagnosis.
