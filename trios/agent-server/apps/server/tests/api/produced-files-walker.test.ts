/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { walkWorkspace } from '../../src/api/services/openclaw/produced-files-walker'

/*
 * Export accounting for this module.
 *
 *   walkWorkspace  exercised below, against real temporary directories:
 *                  every regular file is reported once, recursively, under
 *                  workspace-relative POSIX paths, with the file's own
 *                  size and mtime; directories themselves are never
 *                  reported; symlinks are neither followed nor recorded;
 *                  node_modules, .git and .cache are never entered, at
 *                  any depth; recursion stops past depth 16; the walk is
 *                  capped at 50,000 reported files; a missing workspace
 *                  directory resolves silently and reports nothing.
 *
 * No export is dependency-blocked. The module has one runtime export and
 * its only dependency is the local filesystem, which a temporary
 * directory supplies in full - no network, no database, no container.
 * Exercised (1) + blocked (0) equals the 1 export this module ships.
 * The type-only exports (WorkspaceFileMetadata, WorkspaceFileVisitor)
 * carry no runtime behaviour of their own; the visitor signature is what
 * the recording callbacks below implement.
 *
 * Two branches of the subject are named here rather than pinned, because
 * neither can be observed deterministically from outside: the
 * skip-silently path for a file deleted between readdir and stat (it
 * needs a race inside one walk), and the skip for non-regular,
 * non-directory entries such as FIFOs (creating one needs mkfifo, a
 * platform tool this suite declines to shell out to). Neither is an
 * export; both are interior to walkWorkspace, which is exercised.
 */

describe('producedFilesWalkerContract', () => {
  /** Every scratch directory this suite creates; removed once, at the end. */
  const scratch: string[] = []
  afterAll(async () => {
    await Promise.all(
      scratch.map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  /** A fresh empty workspace under the OS temp dir, reclaimed afterAll. */
  async function freshWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'produced-files-walker-'))
    scratch.push(dir)
    return dir
  }

  /** Records everything the walker reports for `dir`, keyed by path. */
  async function collect(
    dir: string,
  ): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const recorded = new Map<string, { size: number; mtimeMs: number }>()
    await walkWorkspace(dir, (relativePath, metadata) => {
      recorded.set(relativePath, metadata)
    })
    return recorded
  }

  it('walkWorkspace - the observable contract, held against the module as it stands', async () => {
    // ------------------------------------------------------------------
    // Every regular file is reported, recursively, under POSIX-style
    // workspace-relative paths, with the file's own size and mtime.
    // Directories themselves are never reported; an empty directory
    // contributes nothing.
    {
      const ws = await freshWorkspace()
      await mkdir(join(ws, 'notes', 'deep', 'a', 'b'), { recursive: true })
      await mkdir(join(ws, 'empty'))
      await writeFile(join(ws, 'top.txt'), 'hello')
      await writeFile(join(ws, 'notes', 'todo.md'), 'todo!')
      await writeFile(
        join(ws, 'notes', 'deep', 'a', 'b', 'leaf.json'),
        '{"a":1}',
      )

      const recorded = await collect(ws)
      expect([...recorded.keys()].sort()).toEqual([
        'notes/deep/a/b/leaf.json',
        'notes/todo.md',
        'top.txt',
      ])
      // The metadata is the file's own stat, exactly - size, mtime, and
      // nothing else rides along.
      const topStats = await stat(join(ws, 'top.txt'))
      expect(recorded.get('top.txt')).toEqual({
        size: 5,
        mtimeMs: topStats.mtimeMs,
      })
      expect(recorded.get('notes/todo.md')?.size).toBe(5)
      expect(recorded.get('notes/deep/a/b/leaf.json')?.size).toBe(7)
      // POSIX separators on every platform: no backslash ever appears.
      for (const path of recorded.keys()) {
        expect(path.includes('\\')).toBe(false)
      }
    }

    // ------------------------------------------------------------------
    // A workspace directory that does not exist resolves silently and
    // reports nothing - a fresh agent that has yet to write a file.
    {
      const ws = await freshWorkspace()
      const recorded = await collect(join(ws, 'never-created'))
      expect(recorded.size).toBe(0)
    }

    // ------------------------------------------------------------------
    // Symlinks are neither recorded nor followed: a link to a file
    // outside the workspace, a link to a whole outside directory, and a
    // dangling link all stay out of the report, while the real files
    // beside them still come through.
    {
      const parent = await mkdtemp(join(tmpdir(), 'produced-files-walker-'))
      scratch.push(parent)
      const ws = join(parent, 'ws')
      const outside = join(parent, 'outside')
      await mkdir(ws)
      await mkdir(join(outside, 'nested'), { recursive: true })
      await writeFile(join(outside, 'secret.txt'), 's')
      await writeFile(join(outside, 'nested', 'another.txt'), 'a')
      await writeFile(join(ws, 'real.txt'), 'r')
      await symlink(
        join('..', 'outside', 'secret.txt'),
        join(ws, 'link-to-file'),
      )
      await symlink(join('..', 'outside'), join(ws, 'link-to-dir'))
      await symlink('dangling-target', join(ws, 'dangling'))

      const recorded = await collect(ws)
      expect([...recorded.keys()].sort()).toEqual(['real.txt'])
    }

    // ------------------------------------------------------------------
    // node_modules, .git and .cache are never entered, at any depth,
    // and nothing else is excluded: a dotfile and a nested package dir
    // both survive.
    {
      const ws = await freshWorkspace()
      await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
      await mkdir(join(ws, '.git', 'objects'), { recursive: true })
      await mkdir(join(ws, '.cache'), { recursive: true })
      await mkdir(join(ws, 'src', 'node_modules'), { recursive: true })
      await writeFile(join(ws, 'node_modules', 'pkg', 'index.js'), 'x')
      await writeFile(join(ws, '.git', 'config'), 'x')
      await writeFile(join(ws, '.cache', 'blob'), 'x')
      await writeFile(join(ws, 'src', 'node_modules', 'x.js'), 'x')
      await writeFile(join(ws, 'src', 'kept.js'), 'x')
      await writeFile(join(ws, 'keep.txt'), 'x')
      await writeFile(join(ws, '.dotfile-kept'), 'x')

      const recorded = await collect(ws)
      expect([...recorded.keys()].sort()).toEqual([
        '.dotfile-kept',
        'keep.txt',
        'src/kept.js',
      ])
    }

    // ------------------------------------------------------------------
    // Recursion is bounded: a file 16 directories deep is still
    // reported, a file 17 deep is not, and the walk above them is
    // untouched by the cut.
    {
      const ws = await freshWorkspace()
      await writeFile(join(ws, 'root.txt'), 'x')
      const chain: string[] = []
      let current = ws
      for (let level = 1; level <= 17; level++) {
        current = join(current, `d${level}`)
        chain.push(current)
        await mkdir(current)
        await writeFile(join(current, 'f.txt'), 'x')
      }

      const recorded = await collect(ws)
      expect(recorded.size).toBe(17)
      expect(recorded.has('root.txt')).toBe(true)
      for (let level = 1; level <= 17; level++) {
        const fileInside = `${relative(ws, chain[level - 1])}/f.txt`
        expect(recorded.has(fileInside)).toBe(level <= 16)
      }
    }

    // ------------------------------------------------------------------
    // The walk is capped: with 50,001 files in one directory, exactly
    // 50,000 are reported and the walk then stops early rather than
    // reporting every file. The one held back is not knowable in
    // advance - readdir order is the platform's - but the count is not.
    {
      const ws = await freshWorkspace()
      const flat = join(ws, 'flat')
      await mkdir(flat)
      const names = Array.from({ length: 50_001 }, (_, index) => `f-${index}`)
      for (let start = 0; start < names.length; start += 500) {
        await Promise.all(
          names.slice(start, start + 500).map((name) =>
            writeFile(join(flat, name), 'x'),
          ),
        )
      }

      const recorded = await collect(ws)
      expect(recorded.size).toBe(50_000)
      const created = new Set(names.map((name) => `flat/${name}`))
      const alienPaths = [...recorded.keys()].filter(
        (path) => !created.has(path),
      )
      expect(alienPaths).toEqual([])
      const unreported = names.filter((name) => !recorded.has(`flat/${name}`))
      expect(unreported.length).toBe(1)
    }
  }, 120_000)
})
