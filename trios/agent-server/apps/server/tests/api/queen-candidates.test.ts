import { describe, expect, it } from 'bun:test'
import {
  deriveCandidates,
  FILE_LENGTH_THRESHOLD,
} from '../../src/api/services/queen-tick'

/**
 * The Queen has never written one of her own tasks.
 *
 * Every issue a bee has worked in this repository came from a person or from
 * an agent outside the loop, so each time the backlog is fed she drains it
 * within the hour and returns to `nothing to choose`. Measured 2026-09-03:
 * 41 done, 17 in backlog, 0 she may start. That is not a defect in the
 * scheduler; it is the absence of a supply.
 *
 * This is the first supply, and it is deliberately the least imaginative one
 * available: the file-length threshold the pre-commit gate already warns about
 * on every commit. Each entry is a count anyone can reproduce with `wc -l`, and
 * it carries the one thing a candidate needs to be delegatable - a boundary,
 * which is the file itself.
 */
describe('deriving work the repository already measured', () => {
  const fake = (sizes: Record<string, number>) => async (path: string) => {
    const key = Object.keys(sizes).find((k) => path.endsWith(k))
    if (!key) throw new Error('not found')
    return 'x\n'.repeat(sizes[key] - 1)
  }

  it('proposes nothing when every owned file is under the threshold', async () => {
    const out = await deriveCandidates('/nowhere', fake({}))
    expect(out).toEqual([])
  })

  it('uses the same threshold the pre-commit gate warns on', () => {
    expect(FILE_LENGTH_THRESHOLD).toBe(400)
  })

  // Evidence, not opinion: the candidate must carry the command that produced
  // it, or a reader cannot tell a measurement from a preference.
  it('carries the command that produced it', async () => {
    const out = await deriveCandidates('/Users/playra/BrowserOS')
    // Not vacuous. A `for` over an empty list passes and proves nothing, which
    // is the exact shape of test this session has caught three times.
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) {
      expect(c.source).toContain('wc -l')
      expect(c.source).toContain(String(c.lines))
      expect(c.lines).toBeGreaterThan(FILE_LENGTH_THRESHOLD)
    }
  })

  // The boundary is the file. A candidate with no path is not delegatable and
  // must never be produced.
  it('gives every candidate a path that can be a boundary', async () => {
    const out = await deriveCandidates('/Users/playra/BrowserOS')
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) {
      expect(c.path.startsWith('agent-server/')).toBe(true)
      expect(c.path.endsWith('.ts')).toBe(true)
    }
  })

  // Upstream files are over the threshold too - openclaw, the container
  // runtime, klavis - and splitting them would create merge pain in code this
  // project does not own for a gate it did not write.
  it('proposes nothing from code this project does not own', async () => {
    const out = await deriveCandidates('/Users/playra/BrowserOS')
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) {
      expect(c.path).not.toContain('openclaw')
      expect(c.path).not.toContain('klavis')
      expect(c.path).not.toContain('lib/container')
    }
  })

  it('puts the longest first, which is the one the gate complains about most', async () => {
    const out = await deriveCandidates('/Users/playra/BrowserOS')
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].lines).toBeGreaterThanOrEqual(out[i].lines)
    }
  })
})
