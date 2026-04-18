import { storage } from '@wxt-dev/storage'
import type { Theme } from '@/shared/constants/theme'

/**
 * @public
 */
export type ThemeStorage = Theme

/**
 * @public
 */
export type { Theme }

/**
 * @public
 */
export const themeStorage = storage.defineItem<Theme>('local:theme', {
  fallback: 'dark' as Theme,
})
