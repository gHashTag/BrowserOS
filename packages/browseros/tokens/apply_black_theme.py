#!/usr/bin/env python3
"""
TRIOS: Apply pure black theme to BrowserOS profile without rebuild
"""

import json
from pathlib import Path

# Path to BrowserOS Preferences
PREFS_PATH = Path.home() / 'Library/Application Support/BrowserOS/Default/Preferences'

def main():
    if not PREFS_PATH.exists():
        print(f'❌ BrowserOS preferences not found at: {PREFS_PATH}')
        print('💡 Make sure BrowserOS has been run at least once')
        return 1
    
    # Read current preferences
    with open(PREFS_PATH, 'r') as f:
        prefs = json.load(f)
    
    # Apply TOTAL BLACK theme - pure black seed: 0xFF000000 = 4278190080
    prefs['profile']['preferences'] = {
        **prefs.get('profile', {}).get('preferences', {}),
        'browser.color_scheme': 2,  # 2 = dark
        'browser.color_variant': 3,  # 3 = tonal spot
        'profile.theme_user_color': 4278190080,  # PURE BLACK #000000
        'profile.custom_theme': {
            'frame_active_tab_background': 4278190080,
            'frame_inactive_tab_background': 4278190080,
            'toolbar_text': 4294967295,  # #FFFFFF
        },
    }
    
    # Clear any cached theme data
    prefs.setdefault('extensions', {})
    prefs['extensions'].setdefault('theme', {})
    prefs['extensions']['theme'] = {'id': '', 'pack_hash': ''}
    
    # Write back
    with open(PREFS_PATH, 'w') as f:
        json.dump(prefs, f, indent=2)
    
    print('✅ TOTAL BLACK theme applied!')
    print('🔄 Restart BrowserOS to see the frame color')
    return 0

if __name__ == '__main__':
    exit(main())
