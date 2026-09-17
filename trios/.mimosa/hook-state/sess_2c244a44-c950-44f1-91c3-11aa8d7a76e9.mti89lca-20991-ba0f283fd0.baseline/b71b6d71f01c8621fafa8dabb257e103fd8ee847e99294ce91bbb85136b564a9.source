#!/bin/bash
# Standalone verification of QueenBackgroundService autonomous chat and A2A ops.
# Usage: bash tests/swift/run_queen_autonomous_test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT="/tmp/trios_queen_autonomous_test"
LOG_DIR="$PROJECT_DIR/.trinity/logs"
LOG_FILE="$LOG_DIR/queen_autonomous_test_$(date +%s).log"
SWIFT_TEST_OPTIMIZATION="${TRIOS_TEST_OPTIMIZATION:--Onone}"

mkdir -p "$LOG_DIR"

# Keep artifact log families small and fresh. Cap queen_autonomous_test logs at 5
# and remove logs older than 7 days.
CLEANUP_SCRIPT="$PROJECT_DIR/scripts/cleanup_artifact_logs.sh"
if [ -x "$CLEANUP_SCRIPT" ]; then
    "$CLEANUP_SCRIPT" --apply --days 7 --cap 5 >/dev/null 2>&1 || true
fi
if command -v find >/dev/null 2>&1; then
    find "$LOG_DIR" -maxdepth 1 -type f -name 'queen_autonomous_test_*.log' -print0 \
        | xargs -0 ls -t 2>/dev/null \
        | tail -n +6 \
        | xargs -I {} rm -f {}
fi

# All rings sources include the persistence, A2A, and Queen service layers.
PROD_FILES=(
    $(find "$PROJECT_DIR/rings" -name "*.swift" | sort)
)

# BR-OUTPUT files referenced by rings (ProjectPaths, A2A router, theme).
PROD_FILES+=(
    "$PROJECT_DIR/BR-OUTPUT/ProjectPaths.swift"
    "$PROJECT_DIR/BR-OUTPUT/QueenStatusViewModel.swift"
    "$PROJECT_DIR/BR-OUTPUT/A2AMessageRouter.swift"
    "$PROJECT_DIR/BR-OUTPUT/TriosTheme.swift"
    "$PROJECT_DIR/BR-OUTPUT/GitHubModels.swift"
    "$PROJECT_DIR/BR-OUTPUT/GitHubAPIClient.swift"
)

# Reuse the in-memory persister / transport mocks from the SSE test harness.
PROD_FILES+=(
    "$SCRIPT_DIR/ChatSSETestMocks.swift"
)

# The Queen autonomous test entry point.
PROD_FILES+=(
    "$SCRIPT_DIR/QueenAutonomousTest.swift"
)

echo "Compiling ${#PROD_FILES[@]} Swift files..."

swiftc -j 1 -disable-batch-mode "$SWIFT_TEST_OPTIMIZATION" -o "$OUTPUT" \
    -framework SwiftUI \
    -framework AppKit \
    -framework WebKit \
    -framework Combine \
    -framework Security \
    -lsqlite3 \
    "${PROD_FILES[@]}" 2>&1 | tee "$LOG_FILE"

if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo "[OK] Build successful: $OUTPUT"
    chmod +x "$OUTPUT"
    echo "Running $OUTPUT..."
    TRIOS_A2A_URL="${TRIOS_A2A_URL:-http://127.0.0.1:9105}" TRIOS_DISABLE_STATUS_MONITORING=1 "$OUTPUT"
else
    echo "[FAIL] Build failed (log: $LOG_FILE)"
    exit 1
fi
