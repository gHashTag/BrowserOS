import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { farmNodeModules } from '../../src/api/services/queen-dispatch'

/**
 * Every dispatch used to write about 2.5 GB of its own node_modules, and the
 * loop reclaimed it afterwards - which bounded the damage and never stopped it.
 *
 * Proven by intervention before this code existed, on a scratch worktree:
 *   bare checkout                              159 MB
 *   with the farm built, before any install    159 MB
 *   after `bun install --frozen-lockfile`      159 MB
 *     "Checked 2250 installs across 2424 packages (no changes)"
 */
describe('farmNodeModules', () => {
  it('does nothing when no store exists for this lockfile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'farm-'))
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'trios/agent-server'), { recursive: true })
    writeFileSync(join(wt, 'trios/agent-server/bun.lock'), 'lock-a')
    process.env.TRIOS_MODULE_STORE = join(root, 'store')

    const said = await farmNodeModules(wt, root)

    expect(said).toContain('installed its own modules')
    // A worktree whose dependencies differ must install normally rather than be
    // given the wrong packages.
    expect(existsSync(join(wt, 'trios/agent-server/node_modules'))).toBe(false)
  })

  it('links every node_modules in the store, dotfiles included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'farm-'))
    const wt = join(root, 'wt')
    mkdirSync(join(wt, 'trios/agent-server'), { recursive: true })
    writeFileSync(join(wt, 'trios/agent-server/bun.lock'), 'lock-b')

    // The store is keyed by the md5 of the lockfile, so build it the same way.
    const proc = Bun.spawnSync(['md5sum', join(wt, 'trios/agent-server/bun.lock')])
    const hash = new TextDecoder().decode(proc.stdout).slice(0, 12)
    const store = join(root, 'store')
    const nm = join(store, hash, 'trios/agent-server/node_modules')
    mkdirSync(join(nm, 'clsx'), { recursive: true })
    // `.bun` is bun's isolated store - 2242 entries and 2.37 GB in production.
    // A POSIX glob that misses it is what made a pre-built farm look impossible.
    mkdirSync(join(nm, '.bun'), { recursive: true })
    process.env.TRIOS_MODULE_STORE = store

    const said = await farmNodeModules(wt, root)

    expect(said).toContain('linked 1 node_modules')
    const linked = join(wt, 'trios/agent-server/node_modules')
    expect(readdirSync(linked).sort()).toEqual(['.bun', 'clsx'])
    expect(lstatSync(join(linked, '.bun')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(linked, 'clsx')).isSymbolicLink()).toBe(true)
  })
})
