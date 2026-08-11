#!/bin/bash
set -e

# Derive project dir from the script location so the build is portable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${TRIOS_ROOT:-$SCRIPT_DIR}"
# Variant resolution happens before anything is written.
#
# The default is DEV on purpose. Every skill, cron job and agent runs a bare
# `./build.sh`, and when that rebuilt the release bundle it overwrote the app
# the user was actually running. Shipping has to be a deliberate act, so
# touching trios.app now requires an explicit TRIOS_VARIANT=prod or --release.
case "${1:-}" in
    --release) TRIOS_VARIANT="prod" ;;
    --dev) TRIOS_VARIANT="dev" ;;
    --vendored) TRIOS_VENDORED=1 ;;
esac
VARIANT="${TRIOS_VARIANT:-dev}"
# --vendored: use pre-built dylibs from Frameworks-dev/ instead of compiling
# QueenUILib from the trinity repo. Makes the build work without trinity.
TRIOS_VENDORED="${TRIOS_VENDORED:-}"
if [ "$VARIANT" != "dev" ] && [ "$VARIANT" != "prod" ]; then
    echo "[FAIL] TRIOS_VARIANT must be 'dev' or 'prod', got '$VARIANT'"
    exit 1
fi

# W2: per-variant binary and Frameworks, so a dev build cannot overwrite the
# release binary or the dylibs it loads.
if [ "$VARIANT" = "dev" ]; then
    OUTPUT="$PROJECT_DIR/trios_dev_app"
    STANDALONE_FRAMEWORKS="$PROJECT_DIR/Frameworks-dev"
else
    OUTPUT="$PROJECT_DIR/trios_app"
    STANDALONE_FRAMEWORKS="$PROJECT_DIR/Frameworks"
fi

# Persistent build directory: the objects, the output file map and the
# dependency graph survive between runs so swiftc can compile incrementally
# instead of rebuilding all 185 files every time.
#
# The variant is the LAST path component and is appended even to an explicit
# TRIOS_BUILD_DIR, so two variants cannot resolve to one object directory. That
# separation is real but it is not what protects the release binary; the
# toolchain does. Measured, not assumed:
#   - swiftc takes the module name from the output binary's basename, so all
#     185 dev objects export $s13trios_dev_app* and all 185 prod objects export
#     $s9trios_app*. Not one object of either set carries the other's prefix.
#   - the driver records the compiler arguments, and -o differs between the
#     variants. Planting a complete dev build directory (objects, swiftdeps and
#     the dependency graph) under a forged prod stamp does not link dev code and
#     does not fail; the driver prints "Incremental compilation has been
#     disabled, because different arguments were passed to the compiler" and
#     recompiles every file over the top. The binary that came out had zero
#     trios_dev_app symbols.
# So a mixed binary is not something the directory layout is holding back.
# Signing, bundle identity and ports are decided after the compile and never
# reach an object either. Set TRIOS_BUILD_CLEAN=1 to start from scratch; point
# TRIOS_BUILD_DIR somewhere private for A/B measurements or parallel checkouts.
# The object directory records its variant (see below) to catch the failure that
# IS silent: two variants sharing one directory and recompiling in full forever.
BUILD_DIR="${TRIOS_BUILD_DIR:-$PROJECT_DIR/.trinity/build}/$VARIANT"
OBJ_DIR="$BUILD_DIR/obj"
SWIFT_OPTIMIZATION="${TRIOS_SWIFT_OPTIMIZATION:--Onone}"
LOG_DIR="$PROJECT_DIR/.trinity/logs"
LOG_FILE="$LOG_DIR/build_$(date +%s).log"
USER_ROOT_DIR="$(cd "$PROJECT_DIR/../.." && pwd)"

# Keep artifact log families small and fresh. Inline rotation caps the main repo
# at 5 files per family, and a shared backstop cleaner also removes logs older
# than 7 days and scans git worktrees under .worktrees/.
CLEANUP_SCRIPT="$SCRIPT_DIR/scripts/cleanup_artifact_logs.sh"
if [ -x "$CLEANUP_SCRIPT" ]; then
    "$CLEANUP_SCRIPT" --apply --days 7 --cap 5 >/dev/null 2>&1 || true
fi
if command -v find >/dev/null 2>&1; then
    rotate_family() {
        local pattern="$1"
        find "$LOG_DIR" -maxdepth 1 -type f -name "$pattern" -print0 \
            | xargs -0 ls -t 2>/dev/null \
            | tail -n +6 \
            | xargs -I {} rm -f {}
    }
    rotate_family 'build_*.log'
    rotate_family 'clade-build*.log'
    rotate_family 'queen_autonomous_test_*.log'
    rotate_family '*.stdout.log'
    rotate_family '*.stderr.log'
fi
TRINITY_SOURCE_ROOT="${TRINITY_ROOT:-$USER_ROOT_DIR/trinity}"
QUEEN_PACKAGE_ROOT="$TRINITY_SOURCE_ROOT/apps/queen"

mkdir -p "$LOG_DIR"

# --- QueenUILib resolution: compile from source or use vendored dylib ---
if [ -n "$TRIOS_VENDORED" ]; then
    # Use the pre-built QueenUILib from Frameworks-dev/ or Frameworks/.
    #
    # QueenUILib has two halves and the vendored build needs BOTH: the dylib
    # satisfies the linker, and the swiftmodule satisfies `import QueenUILib`
    # at compile time. Vendoring only the dylib is what made this path dead on
    # arrival - the module search path pointed at the Frameworks directory,
    # which holds dylibs and no interface, so every importing file failed with
    # "no such module 'QueenUILib'" before the linker was ever reached. A
    # normal build now vendors the interface next to the dylib (see
    # "vendored escape hatch" below).
    QUEEN_DYLIB="$STANDALONE_FRAMEWORKS/libQueenUILib.dylib"
    QUEEN_MODULE_DIR="$STANDALONE_FRAMEWORKS/Modules"
    if [ ! -f "$QUEEN_DYLIB" ]; then
        echo "[FAIL] Vendored QueenUILib not found: $QUEEN_DYLIB"
        echo "       Run a normal build first, or unset TRIOS_VENDORED."
        exit 1
    fi
    if [ ! -f "$QUEEN_MODULE_DIR/QueenUILib.swiftmodule" ]; then
        echo "[FAIL] Vendored QueenUILib interface not found:"
        echo "       $QUEEN_MODULE_DIR/QueenUILib.swiftmodule"
        echo "       The dylib alone only satisfies the linker; swiftc needs the"
        echo "       swiftmodule or every 'import QueenUILib' fails to compile."
        echo "       Run a normal build first (it vendors both halves),"
        echo "       or unset TRIOS_VENDORED."
        exit 1
    fi
    QUEEN_BIN_DIR="$STANDALONE_FRAMEWORKS"
    echo "[VENDORED] Using pre-built QueenUILib: $QUEEN_DYLIB"
    echo "[VENDORED] Using pre-built interface: $QUEEN_MODULE_DIR/QueenUILib.swiftmodule"
else
    if [ ! -f "$QUEEN_PACKAGE_ROOT/Package.swift" ]; then
        echo "[FAIL] Canonical Queen package not found: $QUEEN_PACKAGE_ROOT"
        echo "       Set TRINITY_ROOT to the gHashTag/trinity checkout,"
        echo "       or use TRIOS_VENDORED=1 to build with pre-built dylibs."
        exit 1
    fi

    echo "Building canonical Trinity Queen interface..."
    if [ -n "${TRIOS_REUSE_QUEEN_BUILD:-}" ]; then
        QUEEN_BIN_DIR="$QUEEN_PACKAGE_ROOT/.build/arm64-apple-macosx/debug"
        echo "[REUSE] Using existing QueenUILib build: $QUEEN_BIN_DIR"
    else
        swift build --package-path "$QUEEN_PACKAGE_ROOT" --target QueenUILib
        QUEEN_BIN_DIR="$(swift build --package-path "$QUEEN_PACKAGE_ROOT" --show-bin-path)"
    fi
    QUEEN_DYLIB="$QUEEN_BIN_DIR/libQueenUILib.dylib"
    # SwiftPM writes the interfaces to a Modules/ subdirectory of the bin dir.
    QUEEN_MODULE_DIR="$QUEEN_BIN_DIR/Modules"
    if [ ! -f "$QUEEN_DYLIB" ]; then
        echo "[FAIL] QueenUILib was not produced: $QUEEN_DYLIB"
        exit 1
    fi
    if [ ! -f "$QUEEN_MODULE_DIR/QueenUILib.swiftmodule" ]; then
        echo "[FAIL] QueenUILib interface was not produced:"
        echo "       $QUEEN_MODULE_DIR/QueenUILib.swiftmodule"
        exit 1
    fi
fi

# Build tracked production sources. BR-OUTPUT is also used for local prototypes,
# so compiling every untracked Swift file makes unrelated drafts break the app.
SWIFT_FILES=(
    "$PROJECT_DIR/main.swift"
    $(find "$PROJECT_DIR/rings" -name "*.swift" | sort)
)

# Compile the application dependency closure by default. Set
# TRIOS_INCLUDE_PROTOTYPES=1 only when validating every standalone BR-OUTPUT
# experiment; those prototypes are not reachable from the shipped interface.
if [ -z "${TRIOS_INCLUDE_PROTOTYPES:-}" ]; then
    LEAN_BR_OUTPUT=(
        "A2AMessageRouter.swift"
        "BrowserOSChatViewModel.swift"
        "ChatLogic.swift"
        "ChatPanelView.swift"
        "ChatSidebarView.swift"
        "CladeGuard.swift"
        "FullscreenChatWorkspace.swift"
        "GitButlerPanelView.swift"
        "GitButlerViewModel.swift"
        "GitHubAPIClient.swift"
        "GitHubDashboardView.swift"
        "GitHubModels.swift"
        "GitWorkspaceView.swift"
        "GlassmorphismBackground.swift"
        "HotkeyBar.swift"
        "LLMClient.swift"
        "LogsTabView.swift"
        "MenuBuilder.swift"
        "MeshAuth.swift"
        "MeshChatListView.swift"
        "MeshChatModels.swift"
        "MeshChatThreadView.swift"
        "MeshChatView.swift"
        "MeshChatViewModel.swift"
        "MeshModels.swift"
        "MeshStatusViewModel.swift"
        "MeshTabView.swift"
        "MessageBubbleView.swift"
        "ModelsTabView.swift"
        "ProjectPaths.swift"
        "QueenCompactSupervisorBar.swift"
        "QueenDashboardView.swift"
        "QueenTaskStatusView.swift"
        "QueenStatusViewModel.swift"
        "QueenStatusBadge.swift"
        "QueenQuickActionsSheet.swift"
        "QueenTabView.swift"
        "RecursionGuard.swift"
        "RichTextRenderer.swift"
        "ServerManager.swift"
        "SkillsTabView.swift"
        "SessionGuard.swift"
        "SmoothStreamingEnhancements.swift"
        "TODOAnimations.swift"
        "TODOListView.swift"
        "TerminalTabView.swift"
        "ToolCallCardView.swift"
        "TriosMCPClient.swift"
        "TriosTabView.swift"
        "TriosTheme.swift"
        "TypingIndicatorView.swift"
        "WindowManager.swift"
    )
    for swift_file in "${LEAN_BR_OUTPUT[@]}"; do
        SWIFT_FILES+=("$PROJECT_DIR/BR-OUTPUT/$swift_file")
    done
else
    while IFS= read -r swift_file; do
        relative_file="${swift_file#$PROJECT_DIR/}"
        if git -C "$PROJECT_DIR" ls-files --error-unmatch "$relative_file" >/dev/null 2>&1; then
            SWIFT_FILES+=("$swift_file")
        elif [ "$relative_file" = "BR-OUTPUT/FullscreenChatWorkspace.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/HotkeyBar.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/SmoothStreamingEnhancements.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/ModelsTabView.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/TODOAnimations.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/TODOListView.swift" ]; then
            SWIFT_FILES+=("$swift_file")
        fi
    done < <(find "$PROJECT_DIR/BR-OUTPUT" -name "*.swift" | sort)
fi

# SQLCipher is required for encrypted agent-memory I/O. Use pkg-config when
# available; fall back to the standard Homebrew Cellar layout on Apple Silicon.
SQLCIPHER_INCLUDE="${SQLCIPHER_INCLUDE:-$(pkg-config --variable=includedir sqlcipher 2>/dev/null)}"
SQLCIPHER_LIB="${SQLCIPHER_LIB:-$(pkg-config --variable=libdir sqlcipher 2>/dev/null)}"
# The module map is one directory up in the BrowserOS checkout, but this app
# also lives at apps/trios-macos in the trios monorepo, where that path resolves
# to apps/Sources and does not exist. Search the candidates instead of assuming
# one layout, so the build works from either checkout.
CSQLCIPHER_MODULEMAP_DIR="${CSQLCIPHER_MODULEMAP_DIR:-}"
if [ -z "$CSQLCIPHER_MODULEMAP_DIR" ]; then
    for candidate in \
        "$PROJECT_DIR/../Sources/CSQLCipher" \
        "$PROJECT_DIR/../../Sources/CSQLCipher" \
        "$PROJECT_DIR/Sources/CSQLCipher"
    do
        if [ -f "$candidate/module.modulemap" ]; then
            CSQLCIPHER_MODULEMAP_DIR="$candidate"
            break
        fi
    done
fi
if [ ! -f "$CSQLCIPHER_MODULEMAP_DIR/module.modulemap" ]; then
    echo "[FAIL] CSQLCipher module map not found. Looked beside the project, one"
    echo "       level further up, and inside it. Set CSQLCIPHER_MODULEMAP_DIR to"
    echo "       the directory holding module.modulemap."
    exit 1
fi
SQLCIPHER_DYLIB_NAME="libsqlcipher.dylib"

if [ -z "$SQLCIPHER_INCLUDE" ] || [ -z "$SQLCIPHER_LIB" ] || [ ! -d "$SQLCIPHER_INCLUDE" ]; then
    echo "[FAIL] SQLCipher headers not found. Install with: brew install sqlcipher"
    exit 1
fi

SQLCIPHER_DYLIB=$(find "$SQLCIPHER_LIB" -maxdepth 1 -type f -name 'libsqlcipher.*.dylib' | head -n1)
if [ -z "$SQLCIPHER_DYLIB" ] || [ ! -f "$SQLCIPHER_DYLIB" ]; then
    echo "[FAIL] SQLCipher dynamic library not found in $SQLCIPHER_LIB"
    exit 1
fi

# The build directory is shared mutable state - 185 objects plus a dependency
# graph, not a single binary. Two concurrent builds of the same variant would
# have two frontends writing the same .o, and a truncated object links as a
# build failure. Serialize on an atomic mkdir lock, reclaiming it when the
# recorded owner is gone. The lock covers only the compile: everything after it
# (bundle assembly, signing, tests) touches no shared object.
BUILD_LOCK="$BUILD_DIR.lock"
LOCK_HELD=0
release_build_lock() {
    if [ "$LOCK_HELD" = "1" ]; then
        LOCK_HELD=0
        rm -rf "$BUILD_LOCK"
    fi
}
LOCK_WAIT="${TRIOS_BUILD_LOCK_WAIT:-900}"
lock_waited=0
mkdir -p "$(dirname "$BUILD_LOCK")"
while [ "$LOCK_HELD" = "0" ]; do
    if mkdir "$BUILD_LOCK" 2>/dev/null; then
        LOCK_HELD=1
        trap 'release_build_lock' EXIT
        trap 'release_build_lock; exit 130' INT
        trap 'release_build_lock; exit 143' TERM
        echo $$ > "$BUILD_LOCK/pid"
        break
    fi
    lock_owner="$(cat "$BUILD_LOCK/pid" 2>/dev/null || true)"
    if [ -z "$lock_owner" ] || ! kill -0 "$lock_owner" 2>/dev/null; then
        echo "Reclaiming stale build lock $BUILD_LOCK (owner ${lock_owner:-unknown} is gone)."
        rm -rf "$BUILD_LOCK"
        continue
    fi
    if [ "$lock_waited" -ge "$LOCK_WAIT" ]; then
        echo "[FAIL] another $VARIANT build holds $BUILD_LOCK (pid $lock_owner) after ${lock_waited}s."
        echo "       Set TRIOS_BUILD_DIR to build in a private directory."
        exit 1
    fi
    if [ "$lock_waited" = "0" ]; then
        echo "Waiting for the $VARIANT build lock held by pid $lock_owner..."
    fi
    sleep 2
    lock_waited=$((lock_waited + 2))
done

if [ -n "${TRIOS_BUILD_CLEAN:-}" ]; then
    rm -rf "$BUILD_DIR"
fi
mkdir -p "$OBJ_DIR"

# Stamp the object directory with the variant that owns it, and refuse to
# compile into objects that belong to the other one.
#
# This is not a guard against shipping dev code as the release: the paragraph at
# the top of this file records the experiment showing swiftc cannot reuse the
# other variant's objects at all. It guards the failure that leaves no trace. A
# restored CI cache under the wrong key, a hand copy of one variant's directory
# onto the other, or a future edit that drops the "/$VARIANT" from BUILD_DIR all
# end with two variants writing one directory - and the only symptom is that
# every build recompiles all ${#SWIFT_FILES[@]} files, forever, while still
# printing success. The incremental build quietly stops being incremental. Here
# that is one line before any compile instead of a minute nobody attributes.
#
# The stamp lives inside OBJ_DIR, not beside it, so it travels with the objects
# it describes: copying just obj/ into the other variant's directory would leave
# an outer stamp telling the truth about a directory whose contents are foreign.
VARIANT_STAMP="$OBJ_DIR/.variant"
LEGACY_VARIANT_STAMP="$BUILD_DIR/variant"
if [ -f "$LEGACY_VARIANT_STAMP" ] && [ ! -f "$VARIANT_STAMP" ]; then
    mv "$LEGACY_VARIANT_STAMP" "$VARIANT_STAMP"
fi
if [ -f "$VARIANT_STAMP" ]; then
    STAMPED_VARIANT="$(cat "$VARIANT_STAMP")"
    if [ "$STAMPED_VARIANT" != "$VARIANT" ]; then
        echo "[FAIL] $OBJ_DIR holds objects built as variant '$STAMPED_VARIANT', not '$VARIANT'."
        echo "       Swift objects carry the variant in every symbol, so none of them can be"
        echo "       reused: this build would recompile all ${#SWIFT_FILES[@]} files and say nothing."
        echo "       Delete that directory, or point TRIOS_BUILD_DIR somewhere private."
        exit 1
    fi
else
    if [ -n "$(ls -A "$OBJ_DIR" 2>/dev/null)" ]; then
        echo "[NOTE] Adopting existing unstamped object directory as variant '$VARIANT'."
    fi
    printf '%s\n' "$VARIANT" > "$VARIANT_STAMP"
fi

# Object stems are the repo-relative path with "/" turned into "_", not the
# basename: two files named the same in different rings would otherwise share
# one .o and one of them would silently vanish from the binary. Assert it.
STEMS=()
for swift_file in "${SWIFT_FILES[@]}"; do
    case "$swift_file" in
        *'"'*|*'\'*)
            echo "[FAIL] source path contains a quote or backslash and cannot be written into the output file map: $swift_file"
            exit 1
            ;;
    esac
    stem="${swift_file#$PROJECT_DIR/}"
    stem="${stem//\//_}"
    STEMS+=("${stem%.swift}")
done
DUPLICATE_STEMS="$(printf '%s\n' "${STEMS[@]}" | sort | uniq -d)"
if [ -n "$DUPLICATE_STEMS" ]; then
    echo "[FAIL] duplicate object name for: $DUPLICATE_STEMS"
    exit 1
fi

# The output file map is what makes -incremental possible: it names a persistent
# .o and .swiftdeps per input, and the "" entry tells the driver where to keep
# the whole-build dependency graph. This toolchain's driver writes that graph
# beside the named path as master.priors rather than master.swiftdeps, so look
# for either when inspecting the directory by hand.
OFM="$BUILD_DIR/output-file-map.json"
{
    printf '{\n'
    printf '  "": {\n    "swift-dependencies": "%s/master.swiftdeps"\n  }' "$BUILD_DIR"
    i=0
    while [ "$i" -lt "${#SWIFT_FILES[@]}" ]; do
        printf ',\n  "%s": {\n    "object": "%s/%s.o",\n    "swift-dependencies": "%s/%s.swiftdeps"\n  }' \
            "${SWIFT_FILES[$i]}" "$OBJ_DIR" "${STEMS[$i]}" "$OBJ_DIR" "${STEMS[$i]}"
        i=$((i + 1))
    done
    printf '\n}\n'
} > "$OFM"

SWIFTC_INCREMENTAL_FLAGS=(-incremental -output-file-map "$OFM")
if [ -n "${TRIOS_BUILD_SHOW_INCREMENTAL:-}" ]; then
    SWIFTC_INCREMENTAL_FLAGS+=(-driver-show-incremental -driver-show-job-lifecycle)
fi

echo "Compiling ${#SWIFT_FILES[@]} Swift files with SQLCipher..."

# Build with swiftc. CSQLCipher.modulemap re-exports the SQLCipher sqlite3 API
# and links -lsqlcipher; we still pass the include/L paths for the C headers
# and runtime library resolution.
# Batch mode is what pays for incrementality on a cold build. -incremental makes
# every frontend job also emit a .swiftdeps, and with one job per file that cost
# is paid 185 times: measured here, a cold build went 171s -> 262s. Batching the
# primary files into one job per worker loads SwiftUI/AppKit once instead of
# once per file and brings the same cold build to 136s - faster than the
# non-incremental build it replaces. Rebuild granularity is unchanged: on a
# later build only the files the dependency graph marks stale become primaries.
# -j 1 stays: jobs still run one at a time, as before.
swiftc "${SWIFTC_INCREMENTAL_FLAGS[@]}" \
    -j 1 \
    -enable-batch-mode \
    "$SWIFT_OPTIMIZATION" \
    -o "$OUTPUT" \
    -framework SwiftUI \
    -framework AppKit \
    -framework WebKit \
    -framework Combine \
    -framework Security \
    -I "$CSQLCIPHER_MODULEMAP_DIR" \
    -I "$SQLCIPHER_INCLUDE" \
    -L "$SQLCIPHER_LIB" \
    -lsqlcipher \
    -I "$QUEEN_MODULE_DIR" \
    -L "$QUEEN_BIN_DIR" \
    -lQueenUILib \
    -Xlinker -rpath \
    -Xlinker @executable_path/Frameworks \
    -Xlinker -rpath \
    -Xlinker @executable_path/../Frameworks \
    "${SWIFT_FILES[@]}" 2>&1 | tee "$LOG_FILE"
COMPILE_STATUS=${PIPESTATUS[0]}
# The objects and the dependency graph are written; bundle assembly, signing
# and the test suites below touch no shared build state, so another agent's
# build of this variant can start now.
release_build_lock

if [ "$COMPILE_STATUS" -eq 0 ]; then
    echo "[OK] Build successful: $OUTPUT"
    chmod +x "$OUTPUT"

    # Keep the standalone development binary runnable as well as the app bundle.
    mkdir -p "$STANDALONE_FRAMEWORKS"
    # --- BEGIN vendor-halves ---
    # Everything between this marker and END vendor-halves is what makes
    # TRIOS_VENDORED=1 possible on a machine with no trinity checkout: the dylib
    # for the linker and the swiftmodule for `import QueenUILib`. Deleting it
    # breaks that build path silently - the probe further down only reads the
    # Modules directory as it stands, so an artifact an EARLIER build left there
    # keeps it printing [OK]. `make vendor-step` reads THIS region and is the
    # check that can see the deletion. Keep the markers with the code.
    # In vendored mode the source IS the destination, and `cp x x` exits 1,
    # which under `set -e` would abort a build that had already succeeded.
    if [ "$QUEEN_DYLIB" != "$STANDALONE_FRAMEWORKS/libQueenUILib.dylib" ]; then
        cp "$QUEEN_DYLIB" "$STANDALONE_FRAMEWORKS/libQueenUILib.dylib"
    fi

    # --- vendored escape hatch ---
    # TRIOS_VENDORED=1 is the documented way to build on a machine without the
    # neighbouring trinity checkout. It can only work if a normal build leaves
    # the compile-time half of QueenUILib behind too, so vendor the interface
    # next to the dylib every time we build from source.
    if [ -z "$TRIOS_VENDORED" ]; then
        mkdir -p "$STANDALONE_FRAMEWORKS/Modules"
        for queen_module_artifact in QueenUILib.swiftmodule QueenUILib.swiftdoc; do
            if [ -f "$QUEEN_MODULE_DIR/$queen_module_artifact" ]; then
                cp "$QUEEN_MODULE_DIR/$queen_module_artifact" \
                    "$STANDALONE_FRAMEWORKS/Modules/$queen_module_artifact"
            fi
        done
    fi
    # --- END vendor-halves ---
    rm -f "$STANDALONE_FRAMEWORKS/$SQLCIPHER_DYLIB_NAME"
    cp -L "$SQLCIPHER_DYLIB" "$STANDALONE_FRAMEWORKS/$SQLCIPHER_DYLIB_NAME"
    chmod +w "$STANDALONE_FRAMEWORKS/$SQLCIPHER_DYLIB_NAME"
    install_name_tool -id "@rpath/$SQLCIPHER_DYLIB_NAME" \
        "$STANDALONE_FRAMEWORKS/$SQLCIPHER_DYLIB_NAME"

    # Ensure .app bundle structure and a correct Info.plist. A missing or
    # stale plist disables macOS single-instance activation by bundle ID and is a
    # known cause of recursive self-launch cascades when `open trios.app` is
    # invoked repeatedly.
    # Two variants can coexist. The dev build carries its own bundle id, ports
    # and data directory, so an agent rebuilding it cannot disturb a release
    # instance the user is actually using. TRIOS_VARIANT=dev selects it.
    if [ "$VARIANT" = "dev" ]; then
        APP_BUNDLE="$PROJECT_DIR/trios-dev.app"
        BUNDLE_ID="com.browseros.trios.dev"
        BUNDLE_NAME="TriOS Dev"
        VARIANT_MCP_PORT="9205"
        VARIANT_A2A_PORT="9210"
        VARIANT_MESH_PORT="9515"
    else
        APP_BUNDLE="$PROJECT_DIR/trios.app"
        BUNDLE_ID="com.browseros.trios"
        BUNDLE_NAME="Trios"
        VARIANT_MCP_PORT="9105"
        VARIANT_A2A_PORT="9200"
        VARIANT_MESH_PORT="9505"
    fi
    MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
    RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"
    FRAMEWORKS_DIR="$APP_BUNDLE/Contents/Frameworks"
    PLIST="$APP_BUNDLE/Contents/Info.plist"
    mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$FRAMEWORKS_DIR"
    cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>trios</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleName</key><string>${BUNDLE_NAME}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>TRIOS_MESH_PORT</key><string>${VARIANT_MESH_PORT}</string>
    <key>TRIOS_MCP_PORT</key><string>${VARIANT_MCP_PORT}</string>
    <key>TRIOS_A2A_PORT</key><string>${VARIANT_A2A_PORT}</string>
    <key>TRIOS_CANARY_MCP_PORT</key><string>9205</string>
    <key>TRIOS_VARIANT</key><string>${VARIANT}</string>
</dict>
</plist>
EOF

    # Copy to .app bundle
    cp "$OUTPUT" "$MACOS_DIR/trios"
    cp "$QUEEN_DYLIB" "$FRAMEWORKS_DIR/libQueenUILib.dylib"
    rm -f "$FRAMEWORKS_DIR/$SQLCIPHER_DYLIB_NAME"
    cp -L "$SQLCIPHER_DYLIB" "$FRAMEWORKS_DIR/$SQLCIPHER_DYLIB_NAME"
    chmod +w "$FRAMEWORKS_DIR/$SQLCIPHER_DYLIB_NAME"
    install_name_tool -id "@rpath/$SQLCIPHER_DYLIB_NAME" \
        "$FRAMEWORKS_DIR/$SQLCIPHER_DYLIB_NAME"
    install_name_tool -change "/opt/homebrew/opt/sqlcipher/lib/$SQLCIPHER_DYLIB_NAME" \
        "@rpath/$SQLCIPHER_DYLIB_NAME" "$MACOS_DIR/trios"
    # Replacing any file inside a signed bundle invalidates its signature and
    # macOS terminates the app in dyld before main() runs. A signature is
    # required after the bundle is complete.
    #
    # Variant policy:
    #   dev  → ad-hoc sign ("-"). Never touches the keychain, never prompts
    #          for a password. An ad-hoc identity changes every rebuild, but
    #          that is harmless for local development.
    #   prod → sign with a persistent certificate (default "TriOS Development")
    #          so the binary carries a stable identity across builds.
    if [ "$VARIANT" = "dev" ]; then
        SIGN_IDENTITY="-"
    else
        SIGN_IDENTITY="${TRIOS_SIGN_IDENTITY:-TriOS Development}"
        # Deliberately not `find-identity -v`. A self-signed development
        # certificate is untrusted, so -v ("valid identities only") lists zero
        # and this guard would reject an identity that codesign signs and
        # verifies perfectly well - a check that silently matches nothing.
        if [ "$SIGN_IDENTITY" != "-" ] && ! security find-identity -p codesigning | grep -q "$SIGN_IDENTITY"; then
            echo "[WARN] Signing identity '$SIGN_IDENTITY' not found; falling back to ad-hoc."
            echo "[WARN] Create one once with: bash scripts/create_dev_signing_identity.sh"
            SIGN_IDENTITY="-"
        fi

        # Unlock the signing keychain so codesign never prompts for a password.
        # The keychain name and password are read from the create script — the
        # single source of truth — so the two can never drift apart.
        #
        # This unlock is mandatory. On a locked keychain codesign blocks on a
        # GUI dialog, which is the exact failure mode this code prevents. The
        # if-guard makes a failed unlock a hard build error, not a silent
        # fallback: removing the unlock line causes codesign to hang on a locked
        # keychain, which is the regression signal.
        if [ "$SIGN_IDENTITY" != "-" ]; then
            SIGN_SCRIPT="$PROJECT_DIR/scripts/create_dev_signing_identity.sh"
            # shellcheck disable=SC1090
            eval "$(grep -E '^(KEYCHAIN_NAME|KEYCHAIN_PASSWORD)=' "$SIGN_SCRIPT")"
            if security list-keychains -d user | grep -q "$KEYCHAIN_NAME"; then
                if ! security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" 2>/dev/null; then
                    echo "[FAIL] Could not unlock signing keychain '$KEYCHAIN_NAME'"
                    exit 1
                fi
            fi
        fi
    fi
    # Remove stale codesign temp files left by an interrupted build. A leftover
    # *.cstemp inside the bundle causes the next codesign to produce a signature
    # that fails verification, leaving an unlaunchable app.
    find "$APP_BUNDLE" -name '*.cstemp' -delete 2>/dev/null || true
    codesign --force --deep --sign "$SIGN_IDENTITY" "$APP_BUNDLE"
    codesign --verify --deep --strict "$APP_BUNDLE"
    echo "[OK] Copied and signed $APP_BUNDLE (variant: $VARIANT, identity: $SIGN_IDENTITY)"

    # Prove the vendored escape hatch still works, on the build that produces
    # it. A documented fallback that fails is worse than none, and this one WAS
    # broken and unnoticed: -I pointed at a directory of dylibs with no
    # interface in it. Typechecking a one-line `import QueenUILib` against the
    # vendored Modules directory alone exercises exactly the resolution a
    # TRIOS_VENDORED=1 build depends on, and costs under a second.
    if [ -n "$TRIOS_VENDORED" ]; then
        echo "[SKIP] Vendored build in progress; the compile above already proved resolution"
    elif [ -n "${TRIOS_SKIP_VENDOR_CHECK:-}" ]; then
        echo "[SKIP] TRIOS_SKIP_VENDOR_CHECK is set; not verifying the vendored interface"
    else
        VENDOR_PROBE_DIR="$BUILD_DIR/vendor-probe"
        mkdir -p "$VENDOR_PROBE_DIR"
        printf 'import QueenUILib\n' > "$VENDOR_PROBE_DIR/probe.swift"
        if swiftc -typecheck -I "$STANDALONE_FRAMEWORKS/Modules" \
            "$VENDOR_PROBE_DIR/probe.swift" > "$VENDOR_PROBE_DIR/probe.log" 2>&1; then
            echo "[OK] Vendored QueenUILib resolves from $STANDALONE_FRAMEWORKS/Modules (TRIOS_VENDORED=1 is buildable)"
        else
            echo "[FAIL] Vendored QueenUILib does NOT resolve from $STANDALONE_FRAMEWORKS/Modules"
            echo "       A TRIOS_VENDORED=1 build on a machine without trinity would fail."
            sed 's/^/       /' "$VENDOR_PROBE_DIR/probe.log"
            echo "       Set TRIOS_SKIP_VENDOR_CHECK=1 to build without this check."
            exit 1
        fi
    fi

    # The app-level memory, planner, streaming, cancellation, and persistence
    # contracts live in the existing standalone integration harness because the
    # Swift package target does not compile the AppKit application graph.
    if [ -n "${TRIOS_SKIP_CHAT_E2E:-}" ]; then
        echo "[SKIP] TRIOS_SKIP_CHAT_E2E is set; skipping chat integration tests"
    else
        echo "Running chat integration tests..."
        bash "$PROJECT_DIR/tests/swift/run_chat_sse_e2e.sh"
        echo "[OK] Chat integration tests passed"
    fi

    # Run Swift XCTest harness when Xcode is present. Package.swift lives at
    # the repository root, one directory above the trios project folder.
    if [ -n "${TRIOS_SKIP_SWIFT_TEST:-}" ]; then
        echo "[SKIP] TRIOS_SKIP_SWIFT_TEST is set; skipping swift test"
    elif ! xcrun --find xctest >/dev/null 2>&1; then
        echo "[SKIP] XCTest not available in this toolchain (install Xcode to run swift test)"
    else
        echo "Running swift test..."
        swift test --package-path "$PROJECT_DIR/.." 2>&1 | tee -a "$LOG_FILE"
        if [ ${PIPESTATUS[0]} -ne 0 ]; then
            echo "[FAIL] swift test failed (log: $LOG_FILE)"
            exit 1
        fi
        echo "[OK] swift test passed"
    fi
else
    echo "[FAIL] Build failed (log: $LOG_FILE)"
    exit 1
fi
