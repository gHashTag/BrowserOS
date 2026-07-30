/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import assert from 'node:assert'
import { logger } from '../logger'
import { runPgMigrations } from './pg-migrate'

describe('runPgMigrations', () => {
  let originalDatabaseUrl: string | undefined
  let originalRailwayUrl: string | undefined

  beforeEach(() => {
    originalDatabaseUrl = process.env.DATABASE_URL
    originalRailwayUrl = process.env.RAILWAY_SSOT_URL
    delete process.env.DATABASE_URL
    delete process.env.RAILWAY_SSOT_URL
  })

  afterEach(() => {
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
    if (originalRailwayUrl !== undefined) {
      process.env.RAILWAY_SSOT_URL = originalRailwayUrl
    } else {
      delete process.env.RAILWAY_SSOT_URL
    }
  })

  it('succeeds and logs warning when no DATABASE_URL', async () => {
    const warnings: unknown[] = []
    const originalWarn = logger.warn.bind(logger)
    logger.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      await runPgMigrations()
    } finally {
      logger.warn = originalWarn
    }

    assert.ok(
      warnings.some((args) => {
        const message = (args as unknown[])[0]
        return typeof message === 'string' && message.includes('DATABASE_URL')
      }),
      'expected a warning about missing DATABASE_URL',
    )
  })
})
