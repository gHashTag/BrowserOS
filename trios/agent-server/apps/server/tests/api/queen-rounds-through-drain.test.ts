/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A deploy must neither stop the swarm nor break a bee (owner, 2026-10-08).
 * The Queen's container is also a runner and drains its bees for up to
 * TRIOS_BEE_RUNNER_DRAIN_SECONDS. The next container cannot start until this
 * one ends (one instance, one volume). So when bees run elsewhere, the rounds
 * go on through the drain, and the hive is handed back only just before exit.
 */

import { describe, expect, it } from 'bun:test'
import {
  roundsThroughDrain,
  stopQueenTickNow,
} from '../../src/api/services/queen-tick'

describe('rounds through the drain', () => {
  it('go on when bees run elsewhere and the container drains', () => {
    expect(
      roundsThroughDrain({
        TRIOS_QUEEN_BEES_RUN_ELSEWHERE: 'on',
        TRIOS_BEE_RUNNER_DRAIN_SECONDS: '1800',
      }),
    ).toBe(true)
  })
  it('stop at SIGTERM when a round would start a bee in this container', () => {
    expect(roundsThroughDrain({ TRIOS_BEE_RUNNER_DRAIN_SECONDS: '1800' })).toBe(
      false,
    )
    expect(
      roundsThroughDrain({
        TRIOS_QUEEN_BEES_RUN_ELSEWHERE: 'off',
        TRIOS_BEE_RUNNER_DRAIN_SECONDS: '1800',
      }),
    ).toBe(false)
  })
  it('stop at SIGTERM when there is no drain to wait through', () => {
    for (const drain of [undefined, '', '0', 'soon'])
      expect(
        roundsThroughDrain({
          TRIOS_QUEEN_BEES_RUN_ELSEWHERE: 'on',
          TRIOS_BEE_RUNNER_DRAIN_SECONDS: drain,
        }),
      ).toBe(false)
  })
  it('hands nothing back when the tick never started', async () => {
    await stopQueenTickNow()
    await stopQueenTickNow()
  })
})
