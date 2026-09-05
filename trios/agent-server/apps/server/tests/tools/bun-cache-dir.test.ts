import { describe, expect, it } from 'bun:test'

import { bunCacheDir } from '../../src/tools/filesystem/bash'

/**
 * A hardlink cannot cross a filesystem boundary, and on the live container the
 * bee's bun cache and the worktrees are on different devices:
 *
 *   /home/bee/.bun   2493 MB   overlay
 *   /workspace       46 GB     /dev/zd29056
 *
 * So every `bun install` copies about 2.4 GB into each worktree instead of
 * linking it, which is what refilled a 46 GB volume at 39 points per hour while
 * three rounds of reaper work moved only the symptom.
 */
describe('bunCacheDir', () => {
  it('puts the cache on the volume when there is one', () => {
    expect(bunCacheDir((p) => p === '/workspace')).toBe('/workspace/.bun-cache')
  })

  it('leaves a machine with no /workspace exactly as it was', () => {
    // A laptop or a CI runner has no volume to share, and inventing a cache
    // directory there would move somebody's cache for no reason.
    expect(bunCacheDir(() => false)).toBeUndefined()
  })

  it('lets the deployment override it', () => {
    const before = process.env.TRIOS_BUN_CACHE_DIR
    process.env.TRIOS_BUN_CACHE_DIR = '/elsewhere/cache'
    try {
      expect(bunCacheDir(() => true)).toBe('/elsewhere/cache')
    } finally {
      if (before === undefined) delete process.env.TRIOS_BUN_CACHE_DIR
      else process.env.TRIOS_BUN_CACHE_DIR = before
    }
  })
})
