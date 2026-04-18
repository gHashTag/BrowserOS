#!/usr/bin/env node
/**
 * Launch TRIOS.app with TOTAL BLACK theme
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const DESKTOP_TRIOS = path.join(process.env.HOME || '', 'Desktop', 'TRIOS.app')
const BINARY_PATH = '/Applications/TRIOS.app'

async function main() {
  console.log('🚀 Launching TRIOS with TOTAL BLACK theme...')

  let appPath = BINARY_PATH
  if (fs.existsSync(DESKTOP_TRIOS)) {
    console.log(`  ✓ Using Desktop TRIOS: ${DESKTOP_TRIOS}`)
    appPath = DESKTOP_TRIOS
  } else if (fs.existsSync(BINARY_PATH)) {
    console.log(`  ✓ Using Applications TRIOS: ${BINARY_PATH}`)
  } else {
    console.error('❌ TRIOS.app not found!')
    console.error('   Looked for:')
    console.error(`     1. ${DESKTOP_TRIOS}`)
    console.error(`     2. ${BINARY_PATH}`)
    process.exit(1)
  }

  // Use spawnSync with array of arguments
  const result = spawnSync('open', ['-a', appPath], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    console.error('❌ Failed to launch TRIOS')
    process.exit(result.status || 1)
  }

  console.log('✅ TRIOS launched!')
  console.log('🎯 Expected: Frame color = rgb(0, 0, 0) = #000000')
}

main().catch((err) => {
  console.error('❌ Error launching TRIOS:', err)
  process.exit(1)
})
