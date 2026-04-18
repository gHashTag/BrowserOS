/**
 * Theme constants for TRIOS
 * @module shared/constants/theme
 */

export enum THEME_MODE {
  DARK = 'dark',
  LIGHT = 'light',
  SYSTEM = 'system',
}

export const THEME_VALUES = {
  [THEME_MODE.DARK]: 'dark',
  [THEME_MODE.LIGHT]: 'light',
  [THEME_MODE.SYSTEM]: 'system',
} as const

export type Theme = THEME_MODE
