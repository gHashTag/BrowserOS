/**
 * Development configuration utilities
 * Reads ports from config.dev.json to stay in sync with TRIOS
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MONOREPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)

interface DevConfig {
  ports: {
    cdp: number
    http_mcp: number
    agent: number
    extension: number
  }
}

export interface EvalPorts {
  cdp: number
  server: number
  extension: number
}

export function getEvalPorts(): EvalPorts {
  const configPath = join(MONOREPO_ROOT, 'config.dev.json')
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as DevConfig

  return {
    cdp: config.ports.cdp,
    server: config.ports.http_mcp,
    extension: config.ports.extension,
  }
}
