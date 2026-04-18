#!/usr/bin/env python3
"""
CI Guard: check_naming.py
Blocks PR if "BrowserOS" string found in new .ts files
Excludes: package.json, node_modules, dist, generated, .git
"""

import sys
import subprocess
from pathlib import Path

# Files that are allowed to have "BrowserOS" (existing files)
ALLOWED_PATTERNS = [
    "package.json",  # package names
    ".git",          # git history
    "node_modules",  # dependencies
    "dist",          # build output
    "generated",      # auto-generated files
    "browseros",     # browseros directory name itself
]

# Search patterns for NEW files (not allowed)
# Note: browserosId (legacy variable) is ALLOWED in existing files
# Only block NEW import paths: "@browseros/" in newly created files
SEARCH_PATTERNS = [
    'BrowserOS Server',  # log message
    'BrowserOS ID',   # log message
    'Starting BrowserOS',  # log message
    '"@browseros/',   # import path in NEW files (block these!)
    'from.*browseros',  # import from
]

def check_file(filepath):
    """Check single file for violations"""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        filepath_str = str(filepath)
        
        violations = []
        
        for pattern in SEARCH_PATTERNS:
            if pattern in content:
                # Skip if in allowed context
                skip = False
                for allowed in ALLOWED_PATTERNS:
                    if allowed in filepath_str:
                        skip = True
                        break
                
                if not skip:
                    # Find line number
                    for i, line in enumerate(content.split('\n'), 1):
                        if pattern in line:
                            violations.append({
                                'pattern': pattern,
                                'line': i,
                                'text': line.strip()[:100],
                                'file': filepath_str,
                            })
                            break
        
        return violations

def main():
    # Search only .ts files, excluding directories
    ts_files = []
    for path in Path('.').rglob('**/*.ts'):
        if path.is_file():
            # Skip allowed paths
            skip = False
            for pattern in ALLOWED_PATTERNS:
                if pattern in str(path):
                    skip = True
                    break
            if not skip:
                ts_files.append(path)
    
    print(f"🔍 Checking {len(ts_files)} .ts files for 'BrowserOS' violations...")
    
    total_violations = 0
    violation_details = []
    
    for filepath in ts_files:
        violations = check_file(filepath)
        if violations:
            total_violations += len(violations)
            violation_details.extend(violations)
    
    if total_violations > 0:
        print(f"❌ Found {total_violations} violations:")
        print()
        # Group by file
        files = {}
        for v in violation_details:
            file = v['file']
            if file not in files:
                files[file] = []
            files[file].append(v)
        
        for file, violations in files.items():
            print(f"  {file}:")
            for v in violations:
                print(f"    Line {v['line']}: {v['pattern']}")
                print(f"    {v['text']}")
        
        print()
        print("🚫 BLOCKING PR — Fix violations before merging")
        sys.exit(1)
    else:
        print(f"✅ No 'BrowserOS' violations found in {len(ts_files)} .ts files")
        sys.exit(0)

if __name__ == "__main__":
    main()
