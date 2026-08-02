/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PATHS } from '@browseros/shared/constants/paths'
import {
  getBrowserosDir,
  getCacheDir,
  getDbPath,
  getVmCacheDir,
  logDevelopmentBrowserosDir,
} from '../src/lib/browseros-dir'
import { logger } from '../src/lib/logger'

describe('getBrowserosDir', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalBrowserosDir = process.env.BROWSEROS_DIR

  beforeEach(() => {
    delete process.env.NODE_ENV
    delete process.env.BROWSEROS_DIR
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
      return
    }

    process.env.NODE_ENV = originalNodeEnv

    if (originalBrowserosDir === undefined) {
      delete process.env.BROWSEROS_DIR
      return
    }

    process.env.BROWSEROS_DIR = originalBrowserosDir
  })

  it('uses a separate home directory in development', () => {
    process.env.NODE_ENV = 'development'

    expect(getBrowserosDir()).toBe(join(homedir(), '.browseros-dev'))
  })

  it('uses the standard home directory outside development', () => {
    process.env.NODE_ENV = 'test'

    expect(getBrowserosDir()).toBe(join(homedir(), PATHS.BROWSEROS_DIR_NAME))
  })

  it('logs the resolved development directory path', () => {
    process.env.NODE_ENV = 'development'
    const originalInfo = logger.info
    const info = mock(() => {})
    logger.info = info

    try {
      logDevelopmentBrowserosDir()

      expect(info).toHaveBeenCalledWith(
        `Using development BrowserOS directory: ${join(homedir(), '.browseros-dev')}`,
      )
    } finally {
      logger.info = originalInfo
    }
  })

  it('does not log a development directory outside development', () => {
    process.env.NODE_ENV = 'test'
    const originalInfo = logger.info
    const info = mock(() => {})
    logger.info = info

    try {
      logDevelopmentBrowserosDir()

      expect(info).not.toHaveBeenCalled()
    } finally {
      logger.info = originalInfo
    }
  })

  it('uses the development cache directory in development', () => {
    process.env.NODE_ENV = 'development'

    expect(getCacheDir()).toBe(join(homedir(), '.browseros-dev', 'cache'))
  })

  it('uses the BrowserOS directory for the sqlite database', () => {
    process.env.NODE_ENV = 'development'

    expect(getDbPath()).toBe(
      join(
        homedir(),
        PATHS.DEV_BROWSEROS_DIR_NAME,
        PATHS.DB_DIR_NAME,
        PATHS.DB_FILE_NAME,
      ),
    )
  })

  it('uses the standard BrowserOS directory for the sqlite database outside development', () => {
    process.env.NODE_ENV = 'test'

    expect(getDbPath()).toBe(
      join(
        homedir(),
        PATHS.BROWSEROS_DIR_NAME,
        PATHS.DB_DIR_NAME,
        PATHS.DB_FILE_NAME,
      ),
    )
  })

  it('uses the standard cache directory outside development', () => {
    process.env.NODE_ENV = 'test'

    expect(getCacheDir()).toBe(
      join(homedir(), PATHS.BROWSEROS_DIR_NAME, 'cache'),
    )
  })

  it('uses a vm cache directory below cache', () => {
    process.env.NODE_ENV = 'development'

    expect(getVmCacheDir()).toBe(
      join(homedir(), '.browseros-dev', 'cache', 'vm'),
    )
  })
})
