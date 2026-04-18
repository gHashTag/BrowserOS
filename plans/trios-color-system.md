# TRIOS Centralized Color Management Plan

## Issue: #500 — TRIOS Color System

## Executive Summary

The TRIOS/BrowserOS project has **three independent color layers** that don't communicate. This plan creates a single source of truth (`trios_theme.h`) that feeds all three layers, plus a runtime script for instant color changes without Chromium rebuild.

---

## Current State Analysis

### Layer 1: Chromium C++ Frame (requires rebuild)

| File | What it controls | Current color |
|------|-----------------|---------------|
| [`theme_service.cc`](../packages/browseros/chromium_patches/chrome/browser/themes/theme_service.cc) | Default browser color scheme | `kDark` (forced dark mode) |
| [`browseros_prefs.cc`](../packages/browseros/chromium_patches/chrome/browser/browseros/core/browseros_prefs.cc:65) | First-run theme sync | `kNeutral` variant, no custom user color |
| [`pinned_action_toolbar_button.cc`](../packages/browseros/chromium_patches/chrome/browser/ui/views/toolbar/pinned_action_toolbar_button.cc:103) | Toolbar icon colors (Clash of GPTs, LLM) | **`SkColorSetRGB(0xFB, 0x65, 0x18)`** — hardcoded orange ≠ brand gold |
| [`clash_of_gpts_view.cc`](../packages/browseros/chromium_patches/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_view.cc) | Side panel backgrounds, labels | Uses Chromium `ui::kColorDialogBackground`, `ui::kColorLabelForegroundSecondary` |
| [`third_party_llm_panel_coordinator.cc`](../packages/browseros/chromium_patches/chrome/browser/ui/views/side_panel/third_party_llm/third_party_llm_panel_coordinator.cc) | LLM panel labels, icons | Uses Chromium `ui::kColorIcon`, `ui::kColorLabelForegroundSecondary` |
| [`chrome_content_browser_client.cc`](../packages/browseros/chromium_patches/chrome/browser/chrome_content_browser_client.cc) | Scrollbar theme color | Delegates to Chromium prefs |

### Layer 2: Chromium Resources (requires rebuild)

| File | What it controls |
|------|-----------------|
| [`BRANDING.release`](../packages/browseros/chromium_files/chrome/app/theme/chromium/BRANDING.release) | Product name: "BrowserOS" |
| [`BRANDING.debug`](../packages/browseros/chromium_files/chrome/app/theme/chromium/BRANDING.debug) | Dev product name: "BrowserOS Dev" |
| [`resources/icons/`](../packages/browseros/resources/icons/) | Product logos (16px–1024px), macOS `.icns`, Windows `.ico` |

### Layer 3: TRIOS Extension UI (hot reload via WXT)

| File | What it controls | Current color |
|------|-----------------|---------------|
| [`global.css`](../packages/browseros-agent/apps/agent/styles/global.css) | 159+ CSS custom properties | `--accent-orange: oklch(0.766 0.087 79.2)` = `#D1AD72` |
| [`theme-provider.tsx`](../packages/browseros-agent/apps/agent/components/theme-provider.tsx) | Dark/light theme switching | Dark mode forced |
| [`tailwind.config.ts`](../packages/browseros-agent/apps/agent/tailwind.config.ts) | Tailwind utility classes | Maps to CSS vars |

### Problem Map

```
                    ┌─────────────────────┐
                    │  NO SINGLE SOURCE    │
                    │  OF TRUTH FOR COLOR  │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐         ┌─────▼──────┐        ┌──────▼─────┐
   │  C++      │         │  Resources │        │  CSS/TS    │
   │  SkColor  │         │  PNG/ICNS  │        │  oklch()   │
   │           │         │            │        │            │
   │ 0xFB6518  │         │ logo.png   │        │ #D1AD72    │
   │ (orange)  │         │            │        │ (gold)     │
   └───────────┘         └────────────┘        └────────────┘
   Requires rebuild      Requires rebuild       Hot reload
```

**Key issues:**
1. Toolbar icon color `#FB6518` (orange) ≠ brand accent `#D1AD72` (gold)
2. No way to change Chromium frame colors without full rebuild
3. CSS variables and C++ colors are defined independently
4. No runtime theme sync between extension and Chromium frame

---

## Solution Architecture

### Phase 1: Single Source of Truth — `trios_theme.h`

Create a new C++ header that defines all TRIOS brand colors in one place:

**File:** `chromium_patches/chrome/browser/browseros/core/trios_theme.h`

```cpp
#ifndef CHROME_BROWSER_BROWSEROS_CORE_TRIOS_THEME_H_
#define CHROME_BROWSER_BROWSEROS_CORE_TRIOS_THEME_H_

#include "third_party/skia/include/core/SkColor.h"

namespace trios::theme {

// ╔══════════════════════════════════════════════════════════╗
// ║  TRIOS BRAND COLORS — SINGLE SOURCE OF TRUTH            ║
// ║  Change colors HERE and run `bun run theme:sync`         ║
// ╚══════════════════════════════════════════════════════════╝

// Primary brand accent — TRIOS Gold
inline constexpr SkColor kBrandAccent = SkColorSetRGB(0xD1, 0xAD, 0x72);  // #D1AD72

// Brand accent — bright variant (hover states)
inline constexpr SkColor kBrandAccentBright = SkColorSetRGB(0xDB, 0xBD, 0x8A);  // #DBBD8A

// Brand accent — muted variant (subtle highlights)
inline constexpr SkColor kBrandAccentMuted = SkColorSetRGB(0xA0, 0x85, 0x55);  // #A08555

// Background — Ultra Black
inline constexpr SkColor kBackgroundPrimary = SkColorSetRGB(0x00, 0x00, 0x00);   // #000000
inline constexpr SkColor kBackgroundSecondary = SkColorSetRGB(0x0A, 0x0A, 0x0A); // #0A0A0A
inline constexpr SkColor kBackgroundSurface = SkColorSetRGB(0x14, 0x14, 0x14);   // #141414

// Text — on dark backgrounds
inline constexpr SkColor kTextPrimary = SkColorSetRGB(0xFA, 0xFA, 0xFA);    // #FAFAFA
inline constexpr SkColor kTextSecondary = SkColorSetRGB(0xA1, 0xA1, 0xAA);  // #A1A1AA

// Semantic colors
inline constexpr SkColor kSuccess = SkColorSetRGB(0x22, 0xC5, 0x5E);  // #22C55E
inline constexpr SkColor kWarning = SkColorSetRGB(0xE8, 0xB3, 0x38);  // #E8B338
inline constexpr SkColor kError = SkColorSetRGB(0xEF, 0x44, 0x44);    // #EF4444

// Toolbar icon colors
inline constexpr SkColor kToolbarIconActive = kBrandAccent;
inline constexpr SkColor kToolbarIconDefault = kTextSecondary;

// Scrollbar
inline constexpr SkColor kScrollbarThumb = SkColorSetRGB(0x33, 0x33, 0x33);  // #333333

}  // namespace trios::theme

#endif  // CHROME_BROWSER_BROWSEROS_CORE_TRIOS_THEME_H_
```

**File:** `chromium_patches/chrome/browser/browseros/core/trios_theme.cc`

```cpp
#include "chrome/browser/browseros/core/trios_theme.h"

namespace trios::theme {

// CSS variable generation for runtime injection
std::string GenerateCSSVariables() {
  return base::StrCat({
    ":root {",
    "  --trios-accent: #", SkColorToHex(kBrandAccent), ";",
    "  --trios-accent-bright: #", SkColorToHex(kBrandAccentBright), ";",
    "  --trios-accent-muted: #", SkColorToHex(kBrandAccentMuted), ";",
    "  --trios-bg-primary: #", SkColorToHex(kBackgroundPrimary), ";",
    "  --trios-bg-secondary: #", SkColorToHex(kBackgroundSecondary), ";",
    "  --trios-bg-surface: #", SkColorToHex(kBackgroundSurface), ";",
    "  --trios-text-primary: #", SkColorToHex(kTextPrimary), ";",
    "  --trios-text-secondary: #", SkColorToHex(kTextSecondary), ";",
    "}"
  });
}

}  // namespace trios::theme
```

### Phase 2: Update All C++ Consumers

#### 2a. Fix toolbar icon color (`pinned_action_toolbar_button.cc`)

**Before:**
```cpp
const SkColor orange = SkColorSetRGB(0xFB, 0x65, 0x18);
```

**After:**
```cpp
#include "chrome/browser/browseros/core/trios_theme.h"
// ...
const SkColor accent = trios::theme::kToolbarIconActive;
UpdateIconsWithColors(icon, accent, accent, accent,
                      GetForegroundColor(ButtonState::STATE_DISABLED));
```

#### 2b. Update `browseros_prefs.cc` — SyncDefaultTheme

**Before:**
```cpp
void SyncDefaultTheme(PrefService* pref_service) {
  // Don't set custom color - let Chrome use default dark theme
  pref_service->SetString(::prefs::kCurrentThemeID, "user_color_theme_id");
  pref_service->SetInteger(::prefs::kBrowserColorVariant,
      static_cast<int>(ui::mojom::BrowserColorVariant::kNeutral));
}
```

**After:**
```cpp
void SyncDefaultTheme(PrefService* pref_service) {
  const PrefService::Preference* user_color_pref =
      pref_service->FindPreference(::prefs::kUserColor);
  if (user_color_pref && user_color_pref->IsDefaultValue()) {
    // Set TRIOS brand accent as the user color for tonal theming
    pref_service->SetInteger(::prefs::kUserColor,
                             static_cast<int>(trios::theme::kBrandAccent));
    pref_service->SetString(::prefs::kCurrentThemeID,
                            "user_color_theme_id");
    pref_service->SetInteger(::prefs::kBrowserColorVariant,
        static_cast<int>(ui::mojom::BrowserColorVariant::kTonalSpot));
  }
}
```

#### 2c. Update side panel views to use trios::theme

In `clash_of_gpts_view.cc` and `third_party_llm_panel_coordinator.cc`, replace hardcoded color references with `trios::theme::kBrandAccent` where brand accent is needed.

### Phase 3: CSS Variable Bridge

#### 3a. Generate CSS from `trios_theme.h`

Create a build script that reads `trios_theme.h` and generates CSS variables:

**File:** `scripts/theme/generate_css_from_header.py`

```python
#!/usr/bin/env python3
"""Generate CSS custom properties from trios_theme.h"""
import re
import sys

def parse_skcolor(line):
    """Extract SkColorSetRGB(R, G, B) values"""
    match = re.search(r'SkColorSetRGB\((0x[A-Fa-f0-9]+),\s*(0x[A-Fa-f0-9]+),\s*(0x[A-Fa-f0-9]+)\)', line)
    if match:
        r, g, b = int(match.group(1), 16), int(match.group(2), 16), int(match.group(3), 16)
        return f"#{r:02X}{g:02X}{b:02X}"
    return None

def generate_css(header_path):
    colors = {}
    with open(header_path) as f:
        for line in f:
            name_match = re.search(r'inline constexpr SkColor k(\w+)\s*=', line)
            if name_match:
                name = name_match.group(1)
                # Convert CamelCase to kebab-case
                css_name = re.sub(r'(?<=[a-z])(?=[A-Z])', '-', name).lower()
                hex_color = parse_skcolor(line)
                if hex_color:
                    # Skip colors that reference other constants
                    colors[css_name] = hex_color

    print(":root {")
    for name, color in colors.items():
        print(f"  --trios-{name}: {color};")
    print("}")

if __name__ == "__main__":
    generate_css(sys.argv[1])
```

#### 3b. Update `global.css` to reference TRIOS variables

In [`global.css`](../packages/browseros-agent/apps/agent/styles/global.css), map TRIOS brand variables to the existing design system:

```css
:root {
  /* TRIOS Brand System — auto-synced from trios_theme.h */
  --trios-accent: #D1AD72;
  --trios-accent-bright: #DBBD8A;
  --trios-accent-muted: #A08555;
  --trios-bg-primary: #000000;
  --trios-bg-secondary: #0A0A0A;
  --trios-bg-surface: #141414;

  /* Map TRIOS → shadcn/ui design tokens */
  --primary: oklch(0.766 0.087 79.2);          /* ← --trios-accent */
  --accent: oklch(0.766 0.087 79.2);            /* ← --trios-accent */
  --accent-orange: oklch(0.766 0.087 79.2);     /* ← --trios-accent */
  --accent-orange-bright: oklch(0.82 0.075 79.2); /* ← --trios-accent-bright */
  --ring: oklch(0.766 0.087 79.2);              /* ← --trios-accent */
  --sidebar-primary: oklch(0.766 0.087 79.2);   /* ← --trios-accent */
  --background: oklch(0 0 0);                    /* ← --trios-bg-primary */
  --card: oklch(0.12 0 0);                       /* ← --trios-bg-surface */
}
```

### Phase 4: Runtime Theme Script (no rebuild needed)

Create a script that writes colors directly to Chromium's Preferences file for instant effect:

**File:** `scripts/theme/apply_runtime.py`

```python
#!/usr/bin/env python3
"""Apply TRIOS theme colors to Chromium Preferences (no rebuild required).

Usage:
  bun run theme:apply          # Apply default TRIOS gold theme
  bun run theme:apply --blue   # Apply blue variant
  bun run theme:apply --custom #D1AD72  # Apply custom hex color
"""
import json
import sys
import os
import shutil
from pathlib import Path

# TRIOS Brand Colors
TRIOS_COLORS = {
    'gold': {
        'accent': 0xFF72ADD1,  # SkColor (ARGB) for #D1AD72
        'variant': 1,          # kTonalSpot
    },
    'blue': {
        'accent': 0xFF2563EB,
        'variant': 1,
    },
}

def find_preferences_path():
    """Find the Chromium Preferences file"""
    candidates = [
        Path.home() / "Library/Application Support/BrowserOS/Default/Preferences",
        Path.home() / ".config/browseros/Default/Preferences",
        Path.home() / "AppData/Local/BrowserOS/User Data/Default/Preferences",
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError("Could not find BrowserOS Preferences file")

def apply_theme(color_name='gold', custom_hex=None):
    prefs_path = find_preferences_path()

    # Backup
    backup_path = prefs_path.with_suffix('.Preferences.bak')
    shutil.copy2(prefs_path, backup_path)

    with open(prefs_path, 'r') as f:
        prefs = json.load(f)

    if custom_hex:
        hex_clean = custom_hex.lstrip('#')
        r, g, b = int(hex_clean[0:2], 16), int(hex_clean[2:4], 16), int(hex_clean[4:6], 16)
        accent_argb = (0xFF << 24) | (b << 16) | (g << 8) | r
        variant = 1  # kTonalSpot
    else:
        colors = TRIOS_COLORS.get(color_name, TRIOS_COLORS['gold'])
        accent_argb = colors['accent']
        variant = colors['variant']

    # Apply theme colors
    prefs['browser']['user_color'] = accent_argb
    prefs['browser']['color_scheme'] = 1  # kDark
    prefs['browser']['browser_color_variant'] = variant
    prefs['browser']['current_theme_id'] = 'user_color_theme_id'

    with open(prefs_path, 'w') as f:
        json.dump(prefs, f)

    print(f"✅ Applied {color_name} theme to {prefs_path}")
    print(f"   Accent: #{(accent_argb & 0xFFFFFF):06X}")
    print(f"   Variant: {'TonalSpot' if variant == 1 else 'Neutral'}")
    print(f"   Backup: {backup_path}")
    print(f"\n⚠️  Restart BrowserOS to see changes.")

if __name__ == "__main__":
    color = 'gold'
    custom = None
    if '--blue' in sys.argv:
        color = 'blue'
    elif '--custom' in sys.argv:
        idx = sys.argv.index('--custom')
        custom = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None
    apply_theme(color, custom)
```

### Phase 5: NPM Scripts Integration

Add to [`package.json`](../packages/browseros-agent/package.json):

```json
{
  "scripts": {
    "theme:apply": "python3 scripts/theme/apply_runtime.py",
    "theme:apply:blue": "python3 scripts/theme/apply_runtime.py --blue",
    "theme:apply:custom": "python3 scripts/theme/apply_runtime.py --custom",
    "theme:sync": "python3 scripts/theme/generate_css_from_header.py chromium_patches/chrome/browser/browseros/core/trios_theme.h > apps/agent/styles/trios-theme.css",
    "theme:validate": "python3 scripts/theme/validate_colors.py"
  }
}
```

---

## Implementation Order

| Step | Task | Effort | Impact |
|------|------|--------|--------|
| **1** | Create `trios_theme.h` with all brand colors | 30 min | Foundation |
| **2** | Fix toolbar icon color `#FB6518` → `#D1AD72` | 15 min | Visual consistency |
| **3** | Update `SyncDefaultTheme()` to use brand accent | 20 min | First-run brand experience |
| **4** | Create `apply_runtime.py` script | 45 min | No-rebuild color changes |
| **5** | Create `generate_css_from_header.py` | 30 min | C++→CSS sync |
| **6** | Add CSS `--trios-*` bridge variables to `global.css` | 15 min | Extension↔Chromium bridge |
| **7** | Update side panel views to use `trios::theme::` | 30 min | Consistent C++ colors |
| **8** | Add npm scripts (`theme:apply`, `theme:sync`) | 10 min | Developer UX |
| **9** | Test: rebuild Chromium with new colors | 60+ min | Verification |
| **10** | Test: runtime script on macOS | 15 min | Verification |

---

## File Map After Implementation

```
packages/browseros/
├── chromium_patches/chrome/browser/browseros/core/
│   ├── trios_theme.h              ← NEW: Single source of truth
│   ├── trios_theme.cc             ← NEW: CSS generation helper
│   ├── browseros_prefs.cc         ← UPDATED: Uses trios::theme::kBrandAccent
│   └── browseros_prefs.h          ← UNCHANGED
├── chromium_patches/chrome/browser/ui/views/toolbar/
│   └── pinned_action_toolbar_button.cc  ← UPDATED: Uses trios::theme::kToolbarIconActive
└── resources/
    └── icons/                      ← UNCHANGED (brand logos)

packages/browseros-agent/
├── apps/agent/styles/
│   ├── global.css                  ← UPDATED: --trios-* bridge variables
│   └── trios-theme.css             ← NEW: Auto-generated from trios_theme.h
├── scripts/theme/
│   ├── apply_runtime.py            ← NEW: Runtime color application
│   ├── generate_css_from_header.py ← NEW: C++→CSS sync
│   └── validate_colors.py          ← NEW: Consistency checker
└── package.json                    ← UPDATED: theme:* scripts
```

---

## Two Operating Modes

### Quick Mode (no rebuild)
```bash
bun run theme:apply              # Apply default TRIOS gold
bun run theme:apply --blue       # Apply blue variant
bun run theme:apply --custom #FF6B6B  # Custom color
```
- Changes Chromium's `Preferences` file directly
- Takes effect on next browser restart
- Does NOT change toolbar icon colors (those are compiled in)

### Full Mode (with rebuild)
1. Edit `trios_theme.h` 
2. Run `bun run theme:sync` → generates CSS
3. Build Chromium: `./build.sh`
4. Changes ALL colors including toolbar icons, frame, side panels

---

## Color Reference

| Token | Hex | oklch | Usage |
|-------|-----|-------|-------|
| `kBrandAccent` | `#D1AD72` | `oklch(0.766 0.087 79.2)` | Primary accent, buttons, links |
| `kBrandAccentBright` | `#DBBD8A` | `oklch(0.82 0.075 79.2)` | Hover states, active elements |
| `kBrandAccentMuted` | `#A08555` | `oklch(0.65 0.07 79.2)` | Subtle highlights, borders |
| `kBackgroundPrimary` | `#000000` | `oklch(0 0 0)` | Main background |
| `kBackgroundSecondary` | `#0A0A0A` | `oklch(0.12 0 0)` | Card backgrounds |
| `kBackgroundSurface` | `#141414` | `oklch(0.18 0 0)` | Elevated surfaces |
| `kTextPrimary` | `#FAFAFA` | `oklch(0.98 0 0)` | Primary text |
| `kTextSecondary` | `#A1A1AA` | `oklch(0.7 0.01 264)` | Secondary text |

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `trios_theme.h` drifts from CSS | `theme:validate` script checks consistency |
| Runtime script corrupts Preferences | Auto-backup before modification |
| Chromium tonal theming doesn't match exactly | Test with `kTonalSpot` variant + user color |
| Side panel views don't respect theme | Use Chromium's `ColorProvider` + `trios::theme::` fallbacks |
