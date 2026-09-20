/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import {
  MEASUREMENT_SWEEP_MS,
  SWEEP_FLOOR_MS,
  sweepDeadlineMs,
} from '../../src/api/services/queen-tick'

describe('the sweep is bounded by a share of the tick, not by an absolute four minutes', () => {
  it('gives a sixty-second tick forty-five seconds', () => {
    // The round awaits the sweep before it dispatches, so this is how long the
    // swarm is willing to hand out no work at all.
    assert.strictEqual(sweepDeadlineMs(60), 45_000)
  })

  it('never exceeds the old ceiling, however long the tick', () => {
    assert.strictEqual(sweepDeadlineMs(3600), MEASUREMENT_SWEEP_MS)
    assert.ok(sweepDeadlineMs(600) <= MEASUREMENT_SWEEP_MS)
  })

  it('never falls below the floor, however short the tick', () => {
    // A five-second tick must not make review impossible.
    assert.strictEqual(sweepDeadlineMs(5), SWEEP_FLOOR_MS)
    assert.strictEqual(sweepDeadlineMs(0), SWEEP_FLOOR_MS)
  })

  it('grows with the tick between the floor and the ceiling', () => {
    assert.ok(sweepDeadlineMs(120) > sweepDeadlineMs(60))
  })
})
