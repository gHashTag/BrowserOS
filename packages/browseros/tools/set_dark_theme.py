#!/usr/bin/env python3
"""
Set BrowserOS frame to TOTAL BLACK (#000000)
Without rebuild — writes directly to Preferences
"""

import json
from pathlib import Path

# Path to BrowserOS Preferences
PREFS_PATH = Path.home() / "Library/Application Support/BrowserOS/Default/Preferences"

def main():
    if not PREFS_PATH.exists():
        print(f"❌ BrowserOS preferences not found at: {PREFS_PATH}")
        print("💡 Make sure BrowserOS has been run at least once")
        return 1

    # Read current preferences
    with open(PREFS_PATH, 'r') as f:
        prefs = json.load(f)

    # Apply TOTAL BLACK theme to correct locations
    # BrowserOS reads from browser.theme, not profile.preferences
    prefs.setdefault("browser", {})
    prefs["browser"].setdefault("theme", {})
    prefs["browser"]["theme"]["color_scheme2"] = 2  # kDark
    prefs["browser"]["theme"]["user_color2"] = 4278190080  # 0xFF000000 = #000000

    # Also set profile preferences for consistency
    prefs.setdefault("profile", {})
    prefs["profile"].setdefault("preferences", {})
    prefs["profile"]["preferences"]["browser.color_scheme"] = 2
    prefs["profile"]["preferences"]["browser.color_variant"] = 5  # kMonochrome
    prefs["profile"]["preferences"]["profile.theme_user_color"] = 4278190080
    prefs["profile"]["preferences"]["profile.custom_theme"] = {
        'frame_active_tab_background': 4278190080,
        'frame_inactive_tab_background': 4278190080,
        'toolbar_text': 4294967295,
    }

    # Write back
    with open(PREFS_PATH, 'w') as f:
        json.dump(prefs, f, indent=2)

    print("✅ TOTAL BLACK theme applied!")
    print("🔄 Restart BrowserOS to see the frame color")
    return 0

if __name__ == "__main__":
    exit(main())
