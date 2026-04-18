#!/usr/bin/env python3
"""
Apply pure black theme to ALL BrowserOS profiles (not just Default)
"""

import json
import pathlib

BASE_DIR = pathlib.Path.home() / "Library/Application Support/BrowserOS"

# Find all Preferences files
prefs_files = list(BASE_DIR.glob('*'), 'Preferences'))

print(f'Found {len(prefs_files)} profile(s)')

for prefs_file in prefs_files:
    prof_dir = prefs_file.parent
    
    if prof_dir.name == "Default":
        continue  # Skip Default, will handle all others
    
    try:
        with open(prefs_file, 'r') as f:
            data = json.load(f)
            
        # Apply pure black to ALL profiles
        if 'profile' in data:
            profiles = data['profile']
            for profile_name, profile_data in profiles.items():
                prefs = profile_data.get('preferences', {})
                
                # Apply pure black
                prefs['browser']['color_scheme'] = 2  # kDark
                prefs['profile']['preferences']['theme']['user_color'] = 4278190080  # 0xFF000000 = pure black #000000
                prefs['profile']['preferences']['theme']['custom_theme'] = {
                    'frame_active_tab_background': 4278190080,
                    'frame_inactive_tab_background': 4278190080,
                    'toolbar_text': 4294967295,
                }
                
                # Clear cached theme
                data.setdefault('extensions', {})
                data['extensions'].setdefault('theme', {})
                data['extensions']['theme'] = {'id': '', 'pack_hash': ''}
            
            with open(prefs_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            print(f'✅ Fixed: {prefs_file} - pure black applied')
    except Exception as e:
            print(f'❌ Error: {e}')
    
print('✓ All profiles updated successfully')
