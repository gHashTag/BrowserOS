import { describe, expect, it } from 'bun:test'
import {
  a2aIsAlive,
  a2aLivenessThreshold,
} from '../../src/api/services/a2a/a2a-liveness'

/**
 * The liveness boundary, gHashTag/trios#1388.
 *
 * RING-01 (trios/rings/T27-01/a2a.t27) derives the offline threshold once
 * (30 s x 3 beats) and states is_alive with an inclusive comparison plus a
 * spelled-out negative-age case. These tests pin both of those properties
 * on the server's shared derivation.
 *
 * This file imports only the import-free a2a-liveness module - importing
 * the registry service would pull in pg and pino, and a fresh worktree has
 * no node_modules.
 */
describe('a2a liveness threshold', () => {
  it('counts an agent silent for exactly the threshold as alive (inclusive, a2a.t27:182)', () => {
    expect(a2aIsAlive(a2aLivenessThreshold('milliseconds'))).toBe(true)
  })

  it('counts one millisecond more than the threshold as not alive', () => {
    expect(a2aIsAlive(a2aLivenessThreshold('milliseconds') + 1)).toBe(false)
  })

  it('counts a negative age (clock skew, beat in the future) as alive (a2a.t27:179)', () => {
    expect(a2aIsAlive(-1)).toBe(true)
  })

  it('derives both units from the one spec product', () => {
    expect(a2aLivenessThreshold('milliseconds')).toBe(
      a2aLivenessThreshold('seconds') * 1000,
    )
  })
})
