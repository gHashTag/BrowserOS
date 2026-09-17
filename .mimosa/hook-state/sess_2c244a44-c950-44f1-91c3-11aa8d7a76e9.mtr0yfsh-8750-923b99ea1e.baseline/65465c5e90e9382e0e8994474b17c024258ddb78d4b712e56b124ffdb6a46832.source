/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'

import { createHealthRoute } from '../../../src/api/routes/health'

describe('createHealthRoute', () => {
  it('returns status ok', async () => {
    const route = createHealthRoute()
    const response = await route.request('/')

    assert.strictEqual(response.status, 200)
    const body = await response.json()
    // pid has been in this response since 66a2b0420, where it was added so a
    // supervisor could attribute an answer to a specific process. This
    // assertion was never updated and has been failing ever since.
    assert.deepStrictEqual(body, { status: 'ok', pid: process.pid })
  })
})
