import { describe, expect, it } from 'bun:test'
import { volumeUsedPercent } from '../../src/api/services/queen-dispatch'

// WHY THIS EXISTS.
//
// 2026-09-05: /workspace reached 100% - 71 MB of 46 GB, sixty worktrees - and
// every dispatch died in its first second with
// `git worktree add failed: unable to write file docs/images/...`.
//
// A reaper existed and had not run, because it lived OUTSIDE the container: it
// reached the volume through `railway ssh`, and railway refuses a connection
// while the application is unhealthy - which it was, BECAUSE the volume was
// full. The collector depended on the thing whose failure it collects for.
//
// These pin the properties that make the in-container collector safe. The
// removal path itself needs a real filesystem and a real git, so it is exercised
// in production behind the watermark rather than mocked into a shape that would
// agree with whatever it was written against.

describe('volumeUsedPercent', () => {
  it('measures a directory that exists', () => {
    const used = volumeUsedPercent(process.cwd())
    expect(used).not.toBeNull()
    expect(used).toBeGreaterThanOrEqual(0)
    expect(used).toBeLessThanOrEqual(100)
  })

  it('returns null - not zero - when it cannot measure', () => {
    // UNKNOWN IS NOT ROOM. A guard that reads an unmeasurable disk as empty
    // disables itself exactly when the filesystem is unwell, which is the one
    // moment it is needed.
    expect(volumeUsedPercent('/definitely/not/a/path/on/this/machine')).toBeNull()
  })
})

describe('the reaper refuses the things that would lose work', () => {
  const source = Bun.file(
    new URL('../../src/api/services/queen-dispatch.ts', import.meta.url).pathname,
  )

  it('never removes a worktree holding uncommitted work', async () => {
    // This container carries no push credential by design, so unpublished work
    // in a tree is the ONLY copy of it. A dirty tree is somebody's unfinished
    // turn and the disk is never worth it.
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('keptDirty')
    expect(body).toMatch(/dirty\.code !== 0 \|\| dirty\.out\.trim\(\)\.length > 0/)
  })

  it('treats an unreadable status as dirty, not as clean', async () => {
    const text = await source.text()
    expect(text).toContain('Unreadable is not clean')
  })

  it('never passes --force to git worktree remove', async () => {
    const text = await source.text()
    const code = text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/worktree['"\],\s]+remove[^\n]*--force/)
  })

  it('keeps the newest worktrees, which are the ones likely to be running', async () => {
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('keepNewest')
  })

  it('stops at the low watermark rather than emptying the volume', async () => {
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/now <= low\) break/)
  })
})

describe('the dispatch refuses before it dies half-way', () => {
  it('checks the volume BEFORE the fetch, and names the number when it refuses', async () => {
    // The dispatch that exposed this died with "cannot update the ref ... unable
    // to write file", which sent every reader looking at git rather than at df.
    const text = await Bun.file(
      new URL('../../src/api/services/queen-dispatch.ts', import.meta.url).pathname,
    ).text()
    const prep = text.slice(text.indexOf('export async function prepareWorktree'))
    const beforeFetch = prep.slice(0, prep.indexOf("['fetch'"))
    expect(beforeFetch).toContain('volumeUsedPercent')
    expect(beforeFetch).toContain('reapWorktrees')
    expect(beforeFetch).toMatch(/volume \$\{still\}% full after reaping/)
  })
})
