#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const BINARY_DIR = path.join(__dirname, '..', '.binary')
const EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_PATH = path.join(BINARY_DIR, `trios-cli${EXT}`)

if (!fs.existsSync(BIN_PATH)) {
  console.error('trios-cli: binary not found, downloading...')
  try {
    execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'postinstall.js')],
      { stdio: 'inherit', env: { ...process.env, BROWSEROS_NPM_FORCE: '1' } },
    )
  } catch {
    console.error(
      'trios-cli: failed to download binary. Try reinstalling:\n  npm install -g trios-cli',
    )
    process.exit(1)
  }
}

const result = spawnSync(BIN_PATH, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, BROWSEROS_INSTALL_METHOD: 'npm' },
})

process.exit(result.status ?? 1)
