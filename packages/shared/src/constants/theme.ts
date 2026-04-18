/**
 * Unified Theme Constants for TRIOS (TRIOS)
 * 
 * Single source of truth for all theme-related settings across:
 * - Chromium (C++ level)
 * - Extension (React/TypeScript level)
 * - CSS Variables
 */

export const THEME_MODE = {
  LIGHT: 'light' as const,
  DARK: 'dark' as const,
  SYSTEM: 'system' as const,
} as const;

export const THEME_VALUES = {
  LIGHT: {
    background: '#FFFFFF', // Pure white
    foreground: '#000000', // Pure black
    border: '#000000',
    accent: '#D1AD72', // Brand yellow/orange (#D1AD72)
    card: '#F3F4F6',
    muted: '#E5E7EB',
  } as const,
  DARK: {
    background: '#000000', // Pure black (ultra-dark)
    foreground: '#FFFFFF', // Pure white
    border: '#1F1F1F', // Dark gray border
    accent: '#D1AD72', // Brand yellow/orange
    card: '#0A0A0A', // Dark card
    muted: '#404040', // Dark muted
  } as const,
  SYSTEM: 'system', // Respects OS preference
} as const;

export const FONT_VALUES = {
  SANS_FAMILY: 'Geist' as const,
  MONO_FAMILY: 'Geist Mono' as const,
} as const;

export const ICON_SIZES = {
  SMALL: 16 as const,
  MEDIUM: 32 as const,
  LARGE: 48 as const,
  XL: 96 as const,
  XXL: 128 as const,
} as const;

/**
 * Default theme for TRIOS
 * Override all other systems to use this
 */
export const DEFAULT_THEME = THEME_MODE.DARK as const;
