#!/bin/bash
set -e

# Derive project dir from the script location so the build is portable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${TRIOS_ROOT:-$SCRIPT_DIR}"
OUTPUT="$PROJECT_DIR/trios_app"
SWIFT_OPTIMIZATION="${TRIOS_SWIFT_OPTIMIZATION:--Onone}"
LOG_DIR="$PROJECT_DIR/.trinity/logs"
LOG_FILE="$LOG_DIR/build_$(date +%s).log"
USER_ROOT_DIR="$(cd "$PROJECT_DIR/../.." && pwd)"
TRINITY_SOURCE_ROOT="${TRINITY_ROOT:-$USER_ROOT_DIR/trinity}"
QUEEN_PACKAGE_ROOT="$TRINITY_SOURCE_ROOT/apps/queen"

mkdir -p "$LOG_DIR"

if [ ! -f "$QUEEN_PACKAGE_ROOT/Package.swift" ]; then
    echo "[FAIL] Canonical Queen package not found: $QUEEN_PACKAGE_ROOT"
    echo "Set TRINITY_ROOT to the gHashTag/trinity checkout."
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
        "QueenStatusViewModel.swift"
        "QueenTabView.swift"
        "RecursionGuard.swift"
        "RichTextRenderer.swift"
        "ServerManager.swift"
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
             [ "$relative_file" = "BR-OUTPUT/QueenMasterViewModel.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/QueenIntelligenceEngine.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/TaskDelegator.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/PredictiveOrchestrator.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/TeamQueenManager.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/QueenPermissions.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/QueenAuditLog.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/QueenIntegrationsHub.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/SlackIntegration.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/EmailIntegration.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/CalendarIntegration.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/TODOAnimations.swift" ] || \
             [ "$relative_file" = "BR-OUTPUT/TODOListView.swift" ]; then
            SWIFT_FILES+=("$swift_file")
        fi
    done < <(find "$PROJECT_DIR/BR-OUTPUT" -name "*.swift" | sort)
fi

echo "Compiling ${#SWIFT_FILES[@]} Swift files..."

# Build with swiftc
swiftc -j 1 \
    -disable-batch-mode \
    "$SWIFT_OPTIMIZATION" \
    -o "$OUTPUT" \
    -framework SwiftUI \
    -framework AppKit \
    -framework WebKit \
    -framework Combine \
    -framework Security \
    -lsqlite3 \
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
    STANDALONE_FRAMEWORKS="$PROJECT_DIR/Frameworks"
    mkdir -p "$STANDALONE_FRAMEWORKS"
    cp "$QUEEN_DYLIB" "$STANDALONE_FRAMEWORKS/libQueenUILib.dylib"

    # Ensure .app bundle structure and a correct Info.plist. A missing or
    # stale plist disables macOS single-instance activation by bundle ID and is a
    # known cause of recursive self-launch cascades when `open trios.app` is
    # invoked repeatedly.
    APP_BUNDLE="$PROJECT_DIR/trios.app"
    MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
    RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"
    FRAMEWORKS_DIR="$APP_BUNDLE/Contents/Frameworks"
    PLIST="$APP_BUNDLE/Contents/Info.plist"
    mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$FRAMEWORKS_DIR"
    cat > "$PLIST" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>trios</string>
    <key>CFBundleIdentifier</key><string>com.browseros.trios</string>
    <key>CFBundleName</key><string>Trios</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>TRIOS_MESH_PORT</key><string>9505</string>
    <key>TRIOS_MCP_PORT</key><string>9105</string>
    <key>TRIOS_A2A_PORT</key><string>9200</string>
    <key>TRIOS_CANARY_MCP_PORT</key><string>9205</string>
    <key>TRIOS_VARIANT</key><string>prod</string>
</dict>
</plist>
EOF

    # Copy to .app bundle
    cp "$OUTPUT" "$MACOS_DIR/trios"
    cp "$QUEEN_DYLIB" "$FRAMEWORKS_DIR/libQueenUILib.dylib"
    # Replacing any file inside a signed bundle invalidates its signature and
    # macOS terminates the app in dyld before main() runs. Apply an ad-hoc
    # development signature after the bundle is complete.
    codesign --force --deep --sign - "$APP_BUNDLE"
    codesign --verify --deep --strict "$APP_BUNDLE"
    echo "[OK] Copied and signed .app bundle (bundle ID: com.browseros.trios)"

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
