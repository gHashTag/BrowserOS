#!/usr/bin/env python3
"""
Generate CSS variables from trios_theme.h
Run: python tools/theme/generate_css_vars.py
"""

import re
from pathlib import Path

# Paths
CHROMIUM_PATCHES = Path(__file__).parent.parent.parent
THEME_H = CHROMIUM_PATCHES / "chrome" / "browser" / "browseros" / "theme" / "trios_theme.h"


def parse_sk_color(hex_str):
    """Parse 0xAARRGGBB to CSS RGB() format"""
    if not hex_str.startswith("0x"):
        return hex_str
    
    rgba = int(hex_str, 16)
    r = (rgba >> 16) & 0xFF
    g = (rgba >> 8) & 0xFF
    b = rgba & 0xFF
    
    return f"rgb({r} {g} {b})"


def parse_oklch_from_comment(line):
    """Extract OKLCH color from comment like // #D1AD72 - oklch(0.766 0.087 79.2)"""
    match = re.search(r'oklch\(([^)]+)\)', line)
    if match:
        return f"oklch({match.group(1)})"
    return None


def extract_all_colors(content):
    """Extract all color definitions, resolve references"""
    # First pass: get all direct hex values
    hex_colors = {}
    pattern = r'constexpr SkColor\s+(\w+)\s+=\s+(0x[0-9A-Fa-f]+);'
    
    for match in re.finditer(pattern, content):
        name = match.group(1)
        hex_value = match.group(2)
        
        # Try to find OKLCH in comment before this line
        line_start = content[:match.start()].rfind('\n', 0, match.start())
        comment_section = content[line_start:match.start()]
        oklch = parse_oklch_from_comment(comment_section)
        
        if oklch:
            hex_colors[name] = oklch
        else:
            hex_colors[name] = parse_sk_color(hex_value)
    
    # Second pass: resolve references (e.g., kDark_Background = kNeutral0)
    all_colors = {}
    ref_pattern = r'constexpr SkColor\s+(\w+)\s+=\s+(k\w+);'
    
    for match in re.finditer(ref_pattern, content):
        name = match.group(1)
        ref_name = match.group(2)
        
        if ref_name in hex_colors:
            all_colors[name] = hex_colors[ref_name]
    
    # Merge both
    all_colors.update(hex_colors)
    return all_colors


def generate_css():
    """Generate CSS variables from trios_theme.h"""
    if not THEME_H.exists():
        return f"/* Error: {THEME_H} not found */\n"
    
    content = THEME_H.read_text()
    
    # Extract all colors, resolving references
    colors = extract_all_colors(content)
    
    # Generate CSS with OKLCH where available, otherwise RGB
    output = """@import "tailwindcss";
@import "tw-animate-css";
@import "tailwind-scrollbar-hide/v4";
@plugin "@tailwindcss/typography";

@custom-variant dark (&:is(.dark *));

/* Geist Sans Variable Font */
@font-face {
  font-family: "Geist";
  src: url("../geist/Geist[wght].woff2") format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Geist";
  src: url("../geist/Geist-Italic[wght].woff2") format("woff2-variations");
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
}

/* Geist Mono Variable Font */
@font-face {
  font-family: "Geist Mono";
  src: url("../geist-mono/GeistMono[wght].woff2") format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Geist Mono";
  src: url("../geist-mono/GeistMono-Italic[wght].woff2") format("woff2-variations");
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
}

:root {{
  --radius: 0.65rem;

  /* Brand Colors */
  --primary: {kPrimaryBase};
  --primary-foreground: {kDark_PrimaryForeground};
  --accent: {kPrimaryBase};
  --accent-foreground: {kDark_PrimaryForeground};
  --accent-orange: {kPrimaryBase};
  --accent-orange-bright: {kPrimaryBright};

  /* Semantic Colors (Dark) */
  --background: {kDark_Background};
  --foreground: {kDark_Foreground};
  --card: {kDark_Card};
  --card-foreground: {kDark_CardForeground};
  --popover: {kDark_Popover};
  --popover-foreground: {kDark_PopoverForeground};
  --secondary: {kDark_Secondary};
  --secondary-foreground: {kDark_SecondaryForeground};
  --muted: {kDark_Muted};
  --muted-foreground: {kDark_MutedForeground};
  --accent: {kDark_Accent};
  --accent-foreground: {kDark_AccentForeground};
  --destructive: {kDark_Destructive};
  --destructive-foreground: {kDark_DestructiveForeground};
  --border: {kDark_Border};
  --input: {kDark_Input};
  --ring: {kDark_Ring};

  /* Sidebar */
  --sidebar: {kDark_Sidebar};
  --sidebar-foreground: {kDark_SidebarForeground};
  --sidebar-primary: {kDark_SidebarPrimary};
  --sidebar-primary-foreground: {kDark_SidebarPrimaryForeground};
  --sidebar-accent: {kDark_SidebarAccent};
  --sidebar-accent-foreground: {kDark_SidebarAccentForeground};
  --sidebar-border: {kDark_SidebarBorder};
  --sidebar-ring: {kDark_SidebarRing};

  /* Charts */
  --chart-1: {kChart1};
  --chart-2: {kChart2};
  --chart-3: {kChart3};
  --chart-4: {kChart4};
  --chart-5: {kChart5};
}}

.dark {{
  /* Semantic Colors (Dark) */
  --background: {kDark_Background};
  --foreground: {kDark_Foreground};
  --card: {kDark_Card};
  --card-foreground: {kDark_CardForeground};
  --popover: {kDark_Popover};
  --popover-foreground: {kDark_PopoverForeground};
  --primary: {kLight_Primary};
  --primary-foreground: {kLight_PrimaryForeground};
  --secondary: {kLight_Secondary};
  --secondary-foreground: {kLight_SecondaryForeground};
  --muted: {kLight_Muted};
  --muted-foreground: {kLight_MutedForeground};
  --accent: {kLight_Accent};
  --accent-foreground: {kLight_AccentForeground};
  --destructive: {kLight_Destructive};
  --destructive-foreground: {kLight_DestructiveForeground};
  --border: {kLight_Border};
  --input: {kLight_Input};
  --ring: {kLight_Ring};

  --sidebar: {kDark_Sidebar};
  --sidebar-foreground: {kDark_SidebarForeground};
  --sidebar-primary: {kDark_SidebarPrimary};
  --sidebar-primary-foreground: {kDark_SidebarPrimaryForeground};
  --sidebar-accent: {kDark_SidebarAccent};
  --sidebar-accent-foreground: {kDark_SidebarAccentForeground};
  --sidebar-border: {kDark_SidebarBorder};
  --sidebar-ring: {kDark_SidebarRing};
}}

.light {{
  /* Semantic Colors (Light) */
  --background: {kLight_Background};
  --foreground: {kLight_Foreground};
  --card: {kLight_Card};
  --card-foreground: {kLight_CardForeground};
  --popover: {kLight_Popover};
  --popover-foreground: {kLight_PopoverForeground};
  --primary: {kLight_Primary};
  --primary-foreground: {kLight_PrimaryForeground};
  --secondary: {kLight_Secondary};
  --secondary-foreground: {kLight_SecondaryForeground};
  --muted: {kLight_Muted};
  --muted-foreground: {kLight_MutedForeground};
  --accent: {kLight_Accent};
  --accent-foreground: {kLight_AccentForeground};
  --destructive: {kLight_Destructive};
  --destructive-foreground: {kLight_DestructiveForeground};
  --border: {kLight_Border};
  --input: {kLight_Input};
  --ring: {kLight_Ring};

  --sidebar: {kLight_Sidebar};
  --sidebar-foreground: {kLight_SidebarForeground};
  --sidebar-primary: {kLight_SidebarPrimary};
  --sidebar-primary-foreground: {kLight_SidebarPrimaryForeground};
  --sidebar-accent: {kLight_SidebarAccent};
  --sidebar-accent-foreground: {kLight_SidebarAccentForeground};
  --sidebar-border: {kLight_SidebarBorder};
  --sidebar-ring: {kLight_SidebarRing};
}}

@theme inline {{
  --font-sans: "Geist", "Geist Fallback";
  --font-mono: "Geist Mono", "Geist Mono Fallback";
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}}

@layer base {{
  * {{
    @apply border-border outline-ring/50;
  }}
  body {{
    @apply bg-background text-foreground font-sans! antialiased;
  }}
}}
"""
    
    # Replace color placeholders
    for name, value in colors.items():
        output = output.replace(f"{{{name}}}", value)
    
    return output


if __name__ == "__main__":
    print(generate_css())
