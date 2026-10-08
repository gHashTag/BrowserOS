/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHEN FINISHED WORK LETS GO OF ITS FILES (gHashTag/t27 specs/queen/holds.t27):
 * the card as the wasm runs it, the stage of a dispatch row, and the paths a
 * row still holds against other bees.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  heldPaths,
  holdStage,
  holdsFiles,
} from '../../src/api/services/queen-holds'
import {
  AWAITING_HOLD_MINUTES,
  HS_AWAITING,
  HS_DONE,
  HS_ESCALATED,
  HS_SEND_BACK,
  HS_WORKING,
  SEND_BACK_HOLD_MINUTES,
} from '../../src/api/services/queen-holds.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored holds card is the one PIN names', () => {
  it('holds.t27 and holds.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(`queen/holds.t27 sha256 ${sha('queen/holds.t27')}`)
    expect(pin).toContain(`queen/holds.wasm sha256 ${sha('queen/holds.wasm')}`)
  })
})

describe('the card, as the wasm runs it', () => {
  it('a bee at work holds; finished work lets go; a person and a verdict hold nothing', () => {
    expect(holdsFiles(HS_WORKING, 1e9)).toBe(true)
    expect(holdsFiles(HS_AWAITING, AWAITING_HOLD_MINUTES - 1)).toBe(true)
    expect(holdsFiles(HS_AWAITING, AWAITING_HOLD_MINUTES)).toBe(false)
    expect(holdsFiles(HS_SEND_BACK, SEND_BACK_HOLD_MINUTES - 1)).toBe(true)
    expect(holdsFiles(HS_SEND_BACK, SEND_BACK_HOLD_MINUTES)).toBe(false)
    expect(holdsFiles(HS_ESCALATED, 0)).toBe(false)
    expect(holdsFiles(HS_DONE, 0)).toBe(false)
  })
})

describe('a dispatch row, for its files', () => {
  it('reads its stage from whether it finished and its verdict', () => {
    expect(holdStage(false, null)).toBe(HS_WORKING)
    expect(holdStage(false, 'sendBack')).toBe(HS_WORKING)
    expect(holdStage(true, 'sendBack')).toBe(HS_SEND_BACK)
    expect(holdStage(true, 'escalate')).toBe(HS_ESCALATED)
    expect(holdStage(true, 'wait')).toBe(HS_AWAITING)
    expect(holdStage(true, null)).toBe(HS_AWAITING)
    for (const done of [
      'accept',
      'failed',
      'cancelled',
      'obsolete',
      'stale-contract',
    ])
      expect(holdStage(true, done)).toBe(HS_DONE)
  })

  const now = Date.parse('2026-10-08T16:00:00Z')
  const owned = [
    'bootstrap/src/compiler.rs',
    'specs/tri/t27b/bit_cast_plan.t27',
  ]
  it('holds every path while a bee may be writing', () => {
    expect(
      heldPaths(
        { finished_at: null, review_state: null, owned_paths: owned },
        now,
      ),
    ).toEqual(owned)
  })
  it('lets go of finished work after AWAITING_HOLD_MINUTES, by when the bee finished', () => {
    const at = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString()
    expect(
      heldPaths(
        { finished_at: at(29), review_state: 'wait', owned_paths: owned },
        now,
      ),
    ).toEqual(owned)
    expect(
      heldPaths(
        { finished_at: at(31), review_state: 'wait', owned_paths: owned },
        now,
      ),
    ).toEqual([])
    // measured: #7772 finished 13:31 and still held compiler.rs at 15:24
    expect(
      heldPaths(
        {
          finished_at: '2026-10-08T13:31:00Z',
          review_state: 'wait',
          owned_paths: owned,
        },
        Date.parse('2026-10-08T15:24:00Z'),
      ),
    ).toEqual([])
  })
  it('an escalation holds nothing, at once', () => {
    expect(
      heldPaths(
        {
          finished_at: new Date(now).toISOString(),
          review_state: 'escalate',
          owned_paths: owned,
        },
        now,
      ),
    ).toEqual([])
  })
  it('a send-back holds for SEND_BACK_HOLD_MINUTES', () => {
    const at = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString()
    expect(
      heldPaths(
        { finished_at: at(90), review_state: 'sendBack', owned_paths: owned },
        now,
      ),
    ).toEqual(owned)
    expect(
      heldPaths(
        { finished_at: at(121), review_state: 'sendBack', owned_paths: owned },
        now,
      ),
    ).toEqual([])
  })
  it('a row with no paths holds none, whatever it is', () => {
    expect(
      heldPaths(
        { finished_at: null, review_state: null, owned_paths: null },
        now,
      ),
    ).toEqual([])
  })
})
