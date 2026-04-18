#!/usr/bin/env bun
/**
 * Apply TRIOS theme colors directly to TRIOS preferences
 * Без rebuild — быстрый способ тестирования цветов
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Цвета из trios_theme.h (будут автоматически синхронизированы)
const TRIOS_COLORS = {
  primary: '#D1AD72', // gold/orange
  primaryBright: '#E6C491',
  // Можно добавить больше цветов по необходимости
}

// Путь к файлу предпочтений TRIOS
const PREFS_PATH = join(
  process.env.HOME || '',
  'Library/Application Support/TRIOS/Default/Preferences',
)

function main() {
  console.log('🎨 Applying TRIOS theme...')

  if (!existsSync(PREFS_PATH)) {
    console.error('❌ TRIOS preferences file not found:')
    console.error(`   ${PREFS_PATH}`)
    console.error('\n💡 Make sure TRIOS has been launched at least once.')
    process.exit(1)
  }

  try {
    // Читаем текущие предпочтения
    const prefsContent = readFileSync(PREFS_PATH, 'utf-8')
    const prefs = JSON.parse(prefsContent)

    // Применяем цвета TRIOS
    if (!prefs.profile) {
      prefs.profile = {}
    }
    if (!prefs.profile.preferences) {
      prefs.profile.preferences = {}
    }

    // Применяем настройки темы
    Object.assign(prefs.profile.preferences, {
      'browser.color_scheme': 2, // 2 = dark
      'browser.color_variant': 3, // 3 = tonal spot
      'profile.theme_user_color': TRIOS_COLORS.primary,
      'profile.custom_theme': {
        frame_active_tab_background: TRIOS_COLORS.primary,
        frame_inactive_tab_background: TRIOS_COLORS.primaryBright,
        toolbar_text: '#FFFFFF',
      },
    })

    // Сохраняем
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2))

    console.log('✅ TRIOS theme applied successfully!')
    console.log('\n🔄 Restart TRIOS to see changes.')
  } catch (error) {
    console.error('❌ Failed to apply theme:', error)
    process.exit(1)
  }
}

main()
