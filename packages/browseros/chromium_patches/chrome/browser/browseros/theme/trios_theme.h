// Copyright 2025 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_BROWSEROS_THEME_TRIOS_THEME_H_
#define CHROME_BROWSER_BROWSEROS_THEME_TRIOS_THEME_H_

#include "third_party/skia/include/core/SkColor.h"

namespace browseros {
namespace trios {

/**
 * TRIOS Color System — Single Source of Truth
 *
 * Измените цвета здесь, затем запустите:
 * - Быстро: bun run theme:apply (без rebuild)
 * - Полностью: bun run theme:sync && ./build.sh
 */

// ============================================================================
// BRAND COLORS
// ============================================================================

// Primary accent (TRIOS gold/orange)
// Format: SkColor ARGB
constexpr SkColor kPrimaryBase =
    0xFFD1AD72;  // #D1AD72 - oklch(0.766 0.087 79.2)
constexpr SkColor kPrimaryBright =
    0xFFE6C491;  // #E6C491 - для анимаций
constexpr SkColor kPrimaryDim =
    0xFFB8955A;  // #B8955A - для hover

// ============================================================================
// NEUTRAL PALETTE (Grayscale)
// ============================================================================

constexpr SkColor kNeutral0 = 0xFF000000;   // #000000
constexpr SkColor kNeutral10 = 0xFF0A0A0A;  // #0A0A0A
constexpr SkColor kNeutral20 = 0xFF141414;  // #141414
constexpr SkColor kNeutral30 = 0xFF1F1F1F;  // #1F1F1F
constexpr SkColor kNeutral40 = 0xFF2A2A2A;  // #2A2A2A
constexpr SkColor kNeutral50 = 0xFF353535;  // #353535
constexpr SkColor kNeutral60 = 0xFF4A4A4A;  // #4A4A4A
constexpr SkColor kNeutral70 = 0xFF6A6A6A;  // #6A6A6A
constexpr SkColor kNeutral80 = 0xFF9A9A9A;  // #9A9A9A
constexpr SkColor kNeutral90 = 0xFFB3B3B3;  // #B3B3B3
constexpr SkColor kNeutral95 = 0xFFE5E5E5;  // #E5E5E5
constexpr SkColor kNeutral100 = 0xFFFFFFFF;  // #FFFFFF

// ============================================================================
// FUNCTIONAL COLORS
// ============================================================================

constexpr SkColor kDestructive = 0xFFE74C3C;  // #E74C3C - красный для ошибок
constexpr SkColor kSuccess = 0xFF27AE60;      // #27AE60 - зелёный для успеха
constexpr SkColor kWarning = 0xFFF39C12;      // #F39C12 - оранжевый для предупреждений

// ============================================================================
// SEMANTIC COLORS — DARK THEME
// ============================================================================

constexpr SkColor kDark_Background = kNeutral0;
constexpr SkColor kDark_Foreground = kNeutral95;
constexpr SkColor kDark_Card = kNeutral10;
constexpr SkColor kDark_CardForeground = kNeutral95;
constexpr SkColor kDark_Popover = kNeutral10;
constexpr SkColor kDark_PopoverForeground = kNeutral95;
constexpr SkColor kDark_Primary = kPrimaryBase;
constexpr SkColor kDark_PrimaryForeground = kNeutral20;
constexpr SkColor kDark_Secondary = kNeutral20;
constexpr SkColor kDark_SecondaryForeground = kNeutral95;
constexpr SkColor kDark_Muted = kNeutral20;
constexpr SkColor kDark_MutedForeground = kNeutral80;
constexpr SkColor kDark_Accent = kNeutral20;
constexpr SkColor kDark_AccentForeground = kNeutral95;
constexpr SkColor kDark_Border = kNeutral30;
constexpr SkColor kDark_Input = kNeutral30;
constexpr SkColor kDark_Ring = kPrimaryBase;
constexpr SkColor kDark_Sidebar = kNeutral0;
constexpr SkColor kDark_SidebarForeground = kNeutral95;
constexpr SkColor kDark_SidebarPrimary = kPrimaryBase;
constexpr SkColor kDark_SidebarPrimaryForeground = kNeutral20;
constexpr SkColor kDark_SidebarAccent = kNeutral20;
constexpr SkColor kDark_SidebarAccentForeground = kNeutral95;
constexpr SkColor kDark_SidebarBorder = kNeutral30;
constexpr SkColor kDark_SidebarRing = kPrimaryBase;
constexpr SkColor kDark_Destructive = kDestructive;
constexpr SkColor kDark_DestructiveForeground = kNeutral100;

// ============================================================================
// SEMANTIC COLORS — LIGHT THEME
// ============================================================================

constexpr SkColor kLight_Background = 0xFFFAFAFA;  // Почти белый
constexpr SkColor kLight_Foreground = kNeutral10;
constexpr SkColor kLight_Card = 0xFFF0F0F0;
constexpr SkColor kLight_CardForeground = kNeutral10;
constexpr SkColor kLight_Popover = kNeutral100;
constexpr SkColor kLight_PopoverForeground = kNeutral10;
constexpr SkColor kLight_Primary = kPrimaryBase;
constexpr SkColor kLight_PrimaryForeground = kNeutral100;
constexpr SkColor kLight_Secondary = 0xFFE5E5E5;
constexpr SkColor kLight_SecondaryForeground = kNeutral10;
constexpr SkColor kLight_Muted = 0xFFF5F5F5;
constexpr SkColor kLight_MutedForeground = kNeutral60;
constexpr SkColor kLight_Accent = kNeutral90;
constexpr SkColor kLight_AccentForeground = kNeutral10;
constexpr SkColor kLight_Border = 0xFFE0E0E0;
constexpr SkColor kLight_Input = 0xFFE0E0E0;
constexpr SkColor kLight_Ring = kPrimaryBase;
constexpr SkColor kLight_Sidebar = 0xFFFAFAFA;
constexpr SkColor kLight_SidebarForeground = kNeutral10;
constexpr SkColor kLight_SidebarPrimary = kPrimaryBase;
constexpr SkColor kLight_SidebarPrimaryForeground = kNeutral100;
constexpr SkColor kLight_SidebarAccent = 0xFFE5E5E5;
constexpr SkColor kLight_SidebarAccentForeground = kNeutral10;
constexpr SkColor kLight_SidebarBorder = 0xFFE0E0E0;
constexpr SkColor kLight_SidebarRing = kPrimaryBase;
constexpr SkColor kLight_Destructive =
    0xFFDC2626;  // Более тёмный красный для светлой темы
constexpr SkColor kLight_DestructiveForeground = kNeutral100;

// ============================================================================
// CHART COLORS
// ============================================================================

constexpr SkColor kChart1 = kPrimaryBase;
constexpr SkColor kChart2 = 0xFFC9A661;  // Вариация primary
constexpr SkColor kChart3 = 0xFFB68F50;  // Вариация primary
constexpr SkColor kChart4 = 0xFFA3783F;  // Вариация primary
constexpr SkColor kChart5 = 0xFF90612E;  // Вариация primary

// ============================================================================
// THEME DEFAULT
// ============================================================================

// Default theme for new installs
constexpr const char* kDefaultTheme = "dark";

}  // namespace trios
}  // namespace browseros

#endif  // CHROME_BROWSER_BROWSEROS_THEME_TRIOS_THEME_H_
