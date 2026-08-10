#!/bin/bash
# Compile and run the ChatViewModel SSE end-to-end test.
# Usage: bash tests/swift/run_chat_sse_e2e.sh

set -euo pipefail

# The SSE end-to-end test exercises ChatViewModel in-process and must not make
# real A2A registration calls to the BrowserOS server.
export TRIOS_SKIP_A2A_STARTUP=1
export TRIOS_VARIANT=test
# Keep the run independent of which models this machine happens to have.
export TRIOS_E2E_DISABLE_WARMUP=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Persistent build directory: objects, the output file map and the dependency
# graph survive between runs so swiftc can compile incrementally. Override with
# TRIOS_E2E_BUILD_DIR to build somewhere private (A/B measurements, parallel
# checkouts); set TRIOS_E2E_CLEAN=1 to start from scratch.
BUILD_DIR="${TRIOS_E2E_BUILD_DIR:-$PROJECT_DIR/.trinity-test/e2e-build}"
OBJ_DIR="$BUILD_DIR/obj"
OUTPUT="$BUILD_DIR/trios_chat_sse_e2e_test"
LOG_DIR="$PROJECT_DIR/.trinity-test/logs"
LOG_FILE="$LOG_DIR/chat_sse_e2e_build_$(date +%s).log"
SWIFT_TEST_OPTIMIZATION="${TRIOS_TEST_OPTIMIZATION:--Onone}"

# The build directory is shared mutable state - 142 objects plus a dependency
# graph, not a single binary in /tmp. Two concurrent runs would have two
# frontends writing the same .o, and a truncated object links as a build
# failure, which `make mutants` would score as "mutation caught". Serialize on
# an atomic mkdir lock, reclaiming it when the recorded owner is gone.
BUILD_LOCK="$BUILD_DIR.lock"
LOCK_HELD=0
release_build_lock() {
    if [ "$LOCK_HELD" = "1" ]; then
        LOCK_HELD=0
        rm -rf "$BUILD_LOCK"
    fi
}
LOCK_WAIT="${TRIOS_E2E_LOCK_WAIT:-900}"
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
        echo "[FAIL] another e2e build holds $BUILD_LOCK (pid $lock_owner) after ${lock_waited}s."
        echo "       Set TRIOS_E2E_BUILD_DIR to build in a private directory."
        exit 1
    fi
    if [ "$lock_waited" = "0" ]; then
        echo "Waiting for the e2e build lock held by pid $lock_owner..."
    fi
    sleep 2
    lock_waited=$((lock_waited + 2))
done

if [ -n "${TRIOS_E2E_CLEAN:-}" ]; then
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$LOG_DIR" "$OBJ_DIR"

# Keep artifact log families small and fresh. Cap chat_sse_e2e_build logs at 5
# and remove logs older than 7 days.
CLEANUP_SCRIPT="$PROJECT_DIR/scripts/cleanup_artifact_logs.sh"
if [ -x "$CLEANUP_SCRIPT" ]; then
    "$CLEANUP_SCRIPT" --apply --days 7 --cap 5 >/dev/null 2>&1 || true
fi
if command -v find >/dev/null 2>&1; then
    find "$LOG_DIR" -maxdepth 1 -type f -name 'chat_sse_e2e_build_*.log' -print0 \
        | xargs -0 ls -t 2>/dev/null \
        | tail -n +6 \
        | xargs -I {} rm -f {}
fi

# All rings sources contain the chat protocols, parser, state machine,
# request builder, and ChatViewModel.
PROD_FILES=(
    $(find "$PROJECT_DIR/rings" -name "*.swift" | sort)
)

# Only the BR-OUTPUT files that rings actually references are needed for this
# test. Including the whole BR-OUTPUT directory pulls in MenuBuilder and
# WindowManager, which depend on AppDelegate/TriosScreenManager defined in
# main.swift (and main.swift must stay excluded because the test has its own
# @main entry point).
PROD_FILES+=(
    "$PROJECT_DIR/BR-OUTPUT/ProjectPaths.swift"
    "$PROJECT_DIR/BR-OUTPUT/QueenStatusViewModel.swift"
    "$PROJECT_DIR/BR-OUTPUT/A2AMessageRouter.swift"
    "$PROJECT_DIR/BR-OUTPUT/TriosTheme.swift"
    "$PROJECT_DIR/BR-OUTPUT/GitHubModels.swift"
    "$PROJECT_DIR/BR-OUTPUT/GitHubAPIClient.swift"
    # Reached from rings/SR-00/CompositionRoot.swift. Both are ordinary shipped
    # sources - build.sh compiles them for the app - and the harness simply had
    # never needed them until something under rings started referring to them.
    "$PROJECT_DIR/BR-OUTPUT/SessionGuard.swift"
    "$PROJECT_DIR/BR-OUTPUT/CladeGuard.swift"
)

# Add the test files.
PROD_FILES+=(
    "$SCRIPT_DIR/ChatSSETestMocks.swift"
    "$SCRIPT_DIR/ChatSSEEndToEndTest.swift"
)

# SQLCipher is required for encrypted agent-memory I/O. Use pkg-config when
# available; fall back to the standard Homebrew Cellar layout on Apple Silicon.
SQLCIPHER_INCLUDE="${SQLCIPHER_INCLUDE:-$(pkg-config --variable=includedir sqlcipher 2>/dev/null)}"
SQLCIPHER_LIB="${SQLCIPHER_LIB:-$(pkg-config --variable=libdir sqlcipher 2>/dev/null)}"
CSQLCIPHER_MODULEMAP_DIR="$PROJECT_DIR/../Sources/CSQLCipher"

if [ -z "$SQLCIPHER_INCLUDE" ] || [ -z "$SQLCIPHER_LIB" ] || [ ! -d "$SQLCIPHER_INCLUDE" ]; then
    echo "[FAIL] SQLCipher headers not found. Install with: brew install sqlcipher"
    exit 1
fi

# Object stems are the repo-relative path with "/" turned into "_", not the
# basename: two files named the same in different rings would otherwise share
# one .o and one of them would silently vanish from the binary. Assert it.
STEMS=()
for f in "${PROD_FILES[@]}"; do
    case "$f" in
        *'"'*|*'\'*)
            echo "[FAIL] source path contains a quote or backslash and cannot be written into the output file map: $f"
            exit 1
            ;;
    esac
    stem="${f#$PROJECT_DIR/}"
    stem="${stem//\//_}"
    STEMS+=("${stem%.swift}")
done
DUPLICATE_STEMS="$(printf '%s\n' "${STEMS[@]}" | sort | uniq -d)"
if [ -n "$DUPLICATE_STEMS" ]; then
    echo "[FAIL] duplicate object name for: $DUPLICATE_STEMS"
    exit 1
fi

# The output file map is what makes -incremental possible: it names a persistent
# .o and .swiftdeps per input, and the "" entry is where the driver keeps the
# whole-build dependency graph.
OFM="$BUILD_DIR/output-file-map.json"
{
    printf '{\n'
    printf '  "": {\n    "swift-dependencies": "%s/master.swiftdeps"\n  }' "$BUILD_DIR"
    i=0
    while [ "$i" -lt "${#PROD_FILES[@]}" ]; do
        printf ',\n  "%s": {\n    "object": "%s/%s.o",\n    "swift-dependencies": "%s/%s.swiftdeps"\n  }' \
            "${PROD_FILES[$i]}" "$OBJ_DIR" "${STEMS[$i]}" "$OBJ_DIR" "${STEMS[$i]}"
        i=$((i + 1))
    done
    printf '\n}\n'
} > "$OFM"

SWIFTC_INCREMENTAL_FLAGS=(-incremental -output-file-map "$OFM")
if [ -n "${TRIOS_E2E_SHOW_INCREMENTAL:-}" ]; then
    SWIFTC_INCREMENTAL_FLAGS+=(-driver-show-incremental -driver-show-job-lifecycle)
fi

echo "Compiling ${#PROD_FILES[@]} Swift files with SQLCipher..."

swiftc "${SWIFTC_INCREMENTAL_FLAGS[@]}" -j 1 -disable-batch-mode "$SWIFT_TEST_OPTIMIZATION" -o "$OUTPUT" \
    -framework SwiftUI \
    -framework AppKit \
    -framework WebKit \
    -framework Combine \
    -framework Security \
    -I "$CSQLCIPHER_MODULEMAP_DIR" \
    -I "$SQLCIPHER_INCLUDE" \
    -L "$SQLCIPHER_LIB" \
    -lsqlcipher \
    "${PROD_FILES[@]}" 2>&1 | tee "$LOG_FILE"

if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo "[OK] Build successful: $OUTPUT"
    chmod +x "$OUTPUT"
    echo "Running $OUTPUT..."
    TRIOS_DISABLE_STATUS_MONITORING=1 TRIOS_E2E_DISABLE_KEYCHAIN=1 TRIOS_E2E_DISABLE_WARMUP=1 "$OUTPUT"
else
    echo "[FAIL] Build failed (log: $LOG_FILE)"
    exit 1
fi
