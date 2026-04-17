#!/bin/bash
set -e

APP_DIR="/Users/playra/Desktop/TRI.app"
SOURCE="/Users/playra/BrowserOS/assets/trinity-logo-full.jpg"
WORK="/tmp/tri_build_$$"

echo "=== Building TRI App Icon ==="

# Step 1: Convert JPEG to PNG
echo "[1/6] Converting source image to PNG..."
mkdir -p "$WORK"
sips -s format png "$SOURCE" --out "$WORK/source.png" >/dev/null 2>&1
echo "  Source: $(sips -g pixelWidth -g pixelHeight "$WORK/source.png" 2>&1 | tr '\n' ' ')"

# Step 2: Generate iconset with all required sizes
echo "[2/6] Generating icon sizes..."
mkdir -p "$WORK/AppIcon.iconset"
sips -z 16 16   "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_16x16.png"     >/dev/null 2>&1
sips -z 32 32   "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_16x16@2x.png"  >/dev/null 2>&1
sips -z 32 32   "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_32x32.png"     >/dev/null 2>&1
sips -z 64 64   "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_32x32@2x.png"  >/dev/null 2>&1
sips -z 128 128 "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_128x128.png"   >/dev/null 2>&1
sips -z 256 256 "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_128x128@2x.png">/dev/null 2>&1
sips -z 256 256 "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_256x256.png"   >/dev/null 2>&1
sips -z 512 512 "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_256x256@2x.png">/dev/null 2>&1
sips -z 512 512 "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_512x512.png"   >/dev/null 2>&1
sips -z 1024 1024 "$WORK/source.png" --out "$WORK/AppIcon.iconset/icon_512x512@2x.png">/dev/null 2>&1
echo "  Generated $(ls "$WORK/AppIcon.iconset/" | wc -l | tr -d ' ') icon files"

# Step 3: Build .icns
echo "[3/6] Building AppIcon.icns..."
iconutil -c icns "$WORK/AppIcon.iconset" -o "$WORK/AppIcon.icns"
ICNS_SIZE=$(stat -f%z "$WORK/AppIcon.icns")
echo "  Built: AppIcon.icns ($ICNS_SIZE bytes)"

# Step 4: Copy to app bundle
echo "[4/6] Installing icon to app bundle..."
mkdir -p "$APP_DIR/Contents/Resources"
cp "$WORK/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
cp "$WORK/AppIcon.iconset/icon_512x512.png" "$APP_DIR/Contents/Resources/AppIcon.png"

# Step 5: Write Info.plist
echo "[5/6] Writing Info.plist..."
cat > "$APP_DIR/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>tri-launcher</string>
    <key>CFBundleIdentifier</key>
    <string>com.tri.browseros</string>
    <key>CFBundleName</key>
    <string>TRI</string>
    <key>CFBundleDisplayName</key>
    <string>TRI</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIconName</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
EOF

# Step 6: Force icon cache refresh (NO custom icon — let macOS apply squircle mask)
echo "[6/6] Refreshing icon cache..."
touch "$APP_DIR"
touch "$APP_DIR/Contents/Info.plist"

# Remove any stale custom icon (Icon\r file set by NSWorkspace)
rm -f "$APP_DIR/Icon"$'\r'
rm -f "$APP_DIR/Icon"

# Remove custom icon xattrs (so macOS uses CFBundleIconFile with squircle)
xattr -d com.apple.ResourceFork "$APP_DIR" 2>/dev/null || true

# Register with LaunchServices (applies squircle mask from CFBundleIconFile)
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$APP_DIR" 2>/dev/null || true

# Hide .app extension so Finder shows "TRI" not "TRI.app"
osascript -e 'tell application "Finder" to set extension hidden of (POSIX file "/Users/playra/Desktop/TRI.app" as alias) to true' 2>/dev/null || true

# Restart Finder to pick up changes
killall Finder 2>/dev/null || true

# Cleanup
rm -rf "$WORK"

echo ""
echo "=== Done! ==="
echo "App: $APP_DIR"
echo "Name: TRI (macOS hides .app extension)"
echo "Icon: AppIcon.icns ($ICNS_SIZE bytes)"
echo ""
echo "If icon still doesn't show rounded corners, log out/in to clear icon cache."
