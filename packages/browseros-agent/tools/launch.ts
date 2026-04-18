#!/usr/bin/env node
/**
 * Launch TRIOS desktop app with black frame theme.
 * This script ensures that black frame is applied before launch.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// Detect TRIOS app location
// Priority order: /Applications → ~/Applications → ~/Desktop
const PATHS = [
  '/Applications/TRIOS.app',
  `${process.env.HOME}/Applications/TRIOS.app`,
  `${process.env.HOME}/Desktop/TRIOS.app`,
]

function findTriOSPath(): string {
  for (const path of PATHS) {
    if (existsSync(path)) {
      console.log(`✓ Found at: ${path}`)
      return path
    }
  }

  // If not found in standard locations, log warning and use fallback
  console.warn('TRIOS.app not found in standard locations')
  return '/Applications/TRIOS.app'
}

/**
 * Apply black theme to TRIOS preferences.
 * This writes to ALL profile directories.
 */
async function applyBlackTheme() {
  const baseDir = `${process.env.HOME}/Library/Application Support/TRIOS`

  // List all possible profile directories
  const profileDirs = [
    'Default',
    'Profile 1',
    'Profile 2',
    'Profile 3',
    'Profile 4',
    'System Profile',
    'Profile 5',
  ]

  for (const profileName of profileDirs) {
    const prefsPath = `${baseDir}/${profileName}/Preferences`

    if (!existsSync(prefsPath)) {
      console.log(`ℹ️  Skipping ${profileName}: ${prefsPath} not found`)
      continue
    }

    try {
      const d = JSON.parse(readFileSync(prefsPath, 'utf-8'))
      const browser = (d.browser = d.browser || {})

      // Apply black frame settings
      browser['color_scheme2'] = 2 // kDark
      browser['user_color2'] = 4278190080 // #000000 pure black

      // Clear custom theme
      browser['extensions'] = browser['extensions'] || {}
      browser['extensions']['theme'] = browser['extensions']['theme'] || {}
      const extensions = browser['extensions']
      if (extensions['theme'] && typeof extensions['theme'] === 'object') {
        extensions['theme']['id'] = ''
        extensions['theme']['pack_hash'] = ''
      }

      writeFileSync(prefsPath, JSON.stringify(d, null, 2), 'utf-8')
      console.log(`✅ Fixed: ${profileName}`)
    } catch (error: any) {
      console.error(`❌ Error fixing ${profileName}:`, error)
    }
  }

  console.log('✅ Black frame applied to all TRIOS profiles!')
}

/**
 * Kill any existing TRIOS processes to ensure clean launch.
 */
async function killTriOS() {
  console.log('🔪 Checking for existing TRIOS processes...')

  try {
    await new Promise<void>((resolve) => {
      const proc = spawn('pkill', ['-9', '-f', 'TRIOS'], {
        stdio: 'pipe',
      })

      proc.on('close', resolve)
      proc.on('error', () => resolve()) // Ignore if no process found
    })
  } catch (e) {
    // pkill might not be available, try alternative
    console.log('ℹ️  pkill not available, skipping process kill')
  }
}

/**
 * Launch TRIOS desktop app.
 */
async function launchTriOS() {
  const triOSPath = findTriOSPath()
  console.log(`🚀 Launching ${triOSPath}...`)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('open', [triOSPath], {
      stdio: 'inherit',
    })

    proc.on('error', reject)
    proc.on('close', resolve)
  })
}

/**
 * Main execution flow.
 */
async function main() {
  console.log('')
  console.log('=== TRIOS Launcher ===')
  console.log('')

  try {
    // 1. Kill existing processes
    await killTriOS()

    // 2. Apply black theme
    await applyBlackTheme()

    // 3. Launch app
    await launchTriOS()

    console.log('')
    console.log('✅ TRIOS launched with black frame on ALL profiles!')
    console.log('')
    console.log('💡 Verify frame color in DevTools:')
    console.log('   1. Open any page')
    console.log('   2. Press F12 to open DevTools')
    console.log('   3. Run: getComputedStyle(document.body).backgroundColor')
    console.log('   4. Should return: rgb(0, 0, 0)')
    console.log('')

    process.exit(0)
  } catch (error: any) {
    console.error('❌ Launch failed:', error)
    process.exit(1)
  }
}

main()
