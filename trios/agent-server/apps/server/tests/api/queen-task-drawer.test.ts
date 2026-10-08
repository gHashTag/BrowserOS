/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ONE TASK, OPENED (gHashTag/t27 specs/queen/dashboard.t27 section 2): the
 * card's functions as the wasm runs them, and the address the drawer reads.
 * The rows are asked of Postgres in tests/pglive/queen-task-drawer-live.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LS_EXPIRED,
  LS_LIVE,
  LS_NONE,
} from '../../src/api/services/queen-dashboard.gen'
import {
  leaseState,
  parseDrawerRef,
  timelineShows,
} from '../../src/api/services/queen-task-drawer'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored dashboard card is the one PIN names', () => {
  it('dashboard.t27 and dashboard.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(
      `queen/dashboard.t27 sha256 ${sha('queen/dashboard.t27')}`,
    )
    expect(pin).toContain(
      `queen/dashboard.wasm sha256 ${sha('queen/dashboard.wasm')}`,
    )
  })
})

describe('the card, as the wasm runs it', () => {
  // test a_timeline_holds_what_names_the_task
  it('keeps the events that name a task in its timeline', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(timelineShows)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })

  // test a_lease_is_none_live_or_expired
  it('reads a lease as none, live or expired', () => {
    expect(leaseState(false, 2000, 1000)).toBe(LS_NONE)
    expect(leaseState(true, 1001, 1000)).toBe(LS_LIVE)
    expect(leaseState(true, 1000, 1000)).toBe(LS_EXPIRED)
    // seconds since the epoch past 2^32 still compare as u64
    expect(leaseState(true, 2 ** 33 + 1, 2 ** 33)).toBe(LS_LIVE)
  })
})

describe('the drawer address', () => {
  it('names an issue or a job by a whole number, and nothing else', () => {
    expect(parseDrawerRef({ issue: '7804' })).toEqual({ issue: 7804 })
    expect(parseDrawerRef({ job: '12' })).toEqual({ job: 12 })
    expect(parseDrawerRef({ issue: '7804', job: '12' })).toEqual({
      issue: 7804,
    })
    expect(parseDrawerRef({ issue: '0' })).toBe(null)
    expect(parseDrawerRef({ issue: '-3' })).toBe(null)
    expect(parseDrawerRef({ issue: '12abc' })).toBe(null)
    expect(parseDrawerRef({ issue: "1' OR 1=1" })).toBe(null)
    expect(parseDrawerRef({})).toBe(null)
  })
})
