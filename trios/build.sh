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
    # Use pre-built dylib from Frameworks-dev/ or Frameworks/
    QUEEN_DYLIB="$STANDALONE_FRAMEWORKS/libQueenUILib.dylib"
    if [ ! -f "$QUEEN_DYLIB" ]; then
        echo "[FAIL] Vendored QueenUILib not found: $QUEEN_DYLIB"
        echo "       Run a normal build first, or unset TRIOS_VENDORED."
        exit 1
    fi
    QUEEN_BIN_DIR="$STANDALONE_FRAMEWORKS"
    echo "[VENDORED] Using pre-built QueenUILib: $QUEEN_DYLIB"
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
        swift build --package-path "$QUEEN_PACKAGE_ROOT" --product QueenUILib
        QUEEN_BIN_DIR="$(swift build --package-path "$QUEEN_PACKAGE_ROOT" --show-bin-path)"
    fi
    QUEEN_DYLIB="$QUEEN_BIN_DIR/libQueenUILib.dylib"
    if [ ! -f "$QUEEN_DYLIB" ]; then
        echo "[FAIL] QueenUILib was not produced: $QUEEN_DYLIB"
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

echo "Compiling ${#SWIFT_FILES[@]} Swift files with SQLCipher..."

# Build with swiftc. CSQLCipher.modulemap re-exports the SQLCipher sqlite3 API
# and links -lsqlcipher; we still pass the include/L paths for the C headers
# and runtime library resolution.
swiftc -j 1 \
    -disable-batch-mode \
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
    -I "$QUEEN_BIN_DIR/Modules" \
    -L "$QUEEN_BIN_DIR" \
    -lQueenUILib \
    -Xlinker -rpath \
    -Xlinker @executable_path/Frameworks \
    -Xlinker -rpath \
    -Xlinker @executable_path/../Frameworks \
    "${SWIFT_FILES[@]}" 2>&1 | tee "$LOG_FILE"

if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo "[OK] Build successful: $OUTPUT"
    chmod +x "$OUTPUT"

    # Keep the standalone development binary runnable as well as the app bundle.
    mkdir -p "$STANDALONE_FRAMEWORKS"
    cp "$QUEEN_DYLIB" "$STANDALONE_FRAMEWORKS/libQueenUILib.dylib"
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
    # macOS terminates the app in dyld before main() runs. Apply an ad-hoc
    # development signature after the bundle is complete.
    # An ad-hoc signature has no stable identity, so every rebuild looks like a
    # different app to macOS and the login keychain re-prompts for every stored
    # secret. Set TRIOS_SIGN_IDENTITY to a stable certificate to stop that;
    # scripts/create_dev_signing_identity.sh creates a suitable self-signed one.
    # Default to the local development identity when one exists. Requiring an
    # environment variable meant the remedy was documented but never applied:
    # every plain ./build.sh fell back to ad-hoc and the prompts came back.
    SIGN_IDENTITY="${TRIOS_SIGN_IDENTITY:-TriOS Development}"
    # Deliberately not `find-identity -v`. A self-signed development
    # certificate is untrusted, so -v ("valid identities only") lists zero and
    # this guard would reject an identity that codesign signs and verifies
    # perfectly well - a check that silently matches nothing and costs the user
    # a password dialog per secret.
    if [ "$SIGN_IDENTITY" != "-" ] && ! security find-identity -p codesigning | grep -q "$SIGN_IDENTITY"; then
        echo "[WARN] Signing identity '$SIGN_IDENTITY' not found; falling back to ad-hoc."
        echo "[WARN] Expect repeated keychain password prompts after each rebuild."
        echo "[WARN] Create one once with: bash scripts/create_dev_signing_identity.sh"
        SIGN_IDENTITY="-"
    fi
    codesign --force --deep --sign "$SIGN_IDENTITY" "$APP_BUNDLE"
    codesign --verify --deep --strict "$APP_BUNDLE"
    echo "[OK] Copied and signed $APP_BUNDLE (variant: $VARIANT, bundle ID: $BUNDLE_ID)"

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
