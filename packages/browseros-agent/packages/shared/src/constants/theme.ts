/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Theme constants
 */

/**
 * Theme mode values
 */
export const THEME_MODE = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
} as const

/**
 * Theme values for selection UI
 */
export const THEME_VALUES = [
  { value: THEME_MODE.SYSTEM, label: 'System' },
  { value: THEME_MODE.LIGHT, label: 'Light' },
  { value: THEME_MODE.DARK, label: 'Dark' },
] as const

export type ThemeMode = (typeof THEME_VALUES)[number]['value']
