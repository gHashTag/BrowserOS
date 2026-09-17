#!/usr/bin/env bun

import { runCli } from './cli'

try {
  await runCli(Bun.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
