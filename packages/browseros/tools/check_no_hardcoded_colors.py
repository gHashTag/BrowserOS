#!/usr/bin/env python3
"""CI check: no hardcoded SkColorSetRGB in BrowserOS patches (except trios_tokens.h)."""

import re
import sys
from pathlib import Path

PATCHES_DIR = Path('packages/browseros/chromium_patches')
ALLOWED_FILES = {'trios_tokens.h'}

COLOR_PATTERNS = [
    re.compile(r'SkColorSetRGB\('),
    re.compile(r'SkColorSetARGB\('),
    re.compile(r'SK_ColorBLACK'),
    re.compile(r'SK_ColorWHITE'),
]

violations = []
for f in PATCHES_DIR.rglob('*.cc'):
    if f.name in ALLOWED_FILES:
        continue
    src = f.read_text()
    for pattern in COLOR_PATTERNS:
        if pattern.search(src):
            violations.append(f'{f.name}: {pattern.pattern}')

if violations:
    print('❌ Hardcoded colors found:')
    for v in violations:
        print(f'  {v}')
    print('\nFix: use trios::k* constants from trios_tokens.h')
    sys.exit(1)

print('✓ No hardcoded colors found')
