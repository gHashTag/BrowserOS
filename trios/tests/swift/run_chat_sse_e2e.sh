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
OUTPUT="/tmp/trios_chat_sse_e2e_test"
LOG_DIR="$PROJECT_DIR/.trinity-test/logs"
LOG_FILE="$LOG_DIR/chat_sse_e2e_build_$(date +%s).log"
SWIFT_TEST_OPTIMIZATION="${TRIOS_TEST_OPTIMIZATION:--Onone}"

mkdir -p "$LOG_DIR"

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

echo "Compiling ${#PROD_FILES[@]} Swift files with SQLCipher..."

swiftc -j 1 -disable-batch-mode "$SWIFT_TEST_OPTIMIZATION" -o "$OUTPUT" \
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
