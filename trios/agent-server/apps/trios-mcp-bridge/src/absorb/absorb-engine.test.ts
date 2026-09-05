/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Contract suite for src/absorb/absorb-engine.ts — Issue #1642.
 *
 * The engine takes its GitButler client through the `deps` parameter, so the
 * whole module runs in-process: the stand-in below answers the four requests
 * the engine's contract rests on (workspace status, branch list, branch
 * creation, staging) from plain fixtures. The suite needs no network, no
 * database and no container, and it never spawns the `but` CLI.
 *
 * Every assertion reads a value a caller of the engine can observe — the
 * returned AbsorbPlan or AbsorbResult — so the suite pins the contract
 * rather than the wiring.
 *
 * Export coverage of src/absorb/absorb-engine.ts:
 *  - planAbsorb    — exercised below.
 *  - executeAbsorb — exercised below.
 *  - absorbSmart   — exercised below.
 *  - AbsorbEngineDeps is a type-only export with no runtime behaviour of its
 *    own; here it is only the shape of the deps stand-in.
 *
 * No export is left unexercised because of a live dependency.
 */

import { describe, expect, it } from 'bun:test'
import type { GitButlerMcpClient } from '../clients/gitbutler-client.js'
import type { BranchInfo, GitButlerStatus } from '../types.js'
import {
  type AbsorbEngineDeps,
  absorbSmart,
  executeAbsorb,
  planAbsorb,
} from './absorb-engine.js'
import type { AbsorbPlan } from './types.js'

// --- Fixtures ---

/** Workspace status fixture; every field the engine reads is overridable. */
function status(over: Partial<GitButlerStatus> = {}): GitButlerStatus {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...over,
  }
}

function branch(name: string): BranchInfo {
  return { name, isCurrent: false, isRemote: false, ahead: 0, behind: 0 }
}

/**
 * In-process stand-in for GitButlerMcpClient. The real client is a class with
 * private state, so the stand-in is cast — the same approach the suite for
 * src/bridge-server.ts takes for its deps stand-ins.
 */
function makeDeps(
  opts: {
    status?: GitButlerStatus
    branches?: BranchInfo[]
    createBranch?: (name: string) => string
  } = {},
): AbsorbEngineDeps {
  const standIn = {
    getStatus: async () => opts.status ?? status(),
    getBranches: async () => opts.branches ?? [],
    createBranch: async (name: string) =>
      opts.createBranch ? opts.createBranch(name) : `Branch '${name}' created`,
    stage: async (files: string[]) => `staged ${files.length} file(s)`,
  }
  return { gitbutler: standIn as unknown as GitButlerMcpClient }
}

/** A hand-written plan the execute path can act on: two branches, three files. */
const TWO_BRANCH_PLAN: AbsorbPlan = {
  strategy: 'by-directory',
  branches: [
    {
      branchName: 'feat/src',
      files: [
        { path: 'src/a.ts', status: 'modified', reason: 'in src/ directory' },
        { path: 'src/b.ts', status: 'added', reason: 'in src/ directory' },
      ],
      confidence: 1,
    },
    {
      branchName: 'feat/docs',
      files: [
        {
          path: 'docs/guide.md',
          status: 'modified',
          reason: 'in docs/ directory',
        },
      ],
      confidence: 1,
    },
  ],
  unassigned: [],
  summary: 'Strategy: by-directory\n3 file(s) → 2 branch(es)',
}

// --- Contract ---

describe('absorbEngineContract', () => {
  it('planAbsorb — turns the whole workspace into a strategy plan', async () => {
    // Mixed workspace: staged, unstaged and untracked entries; one path
    // duplicated across staged and unstaged; one planned branch name already
    // taken.
    const deps = makeDeps({
      status: status({
        branch: 'feat',
        staged: [
          { path: 'src/a.ts', status: 'added' },
          { path: 'src/b.ts', status: 'modified' },
        ],
        unstaged: [
          { path: 'src/a.ts', status: 'modified' },
          { path: 'docs/guide.md', status: 'modified' },
        ],
        untracked: ['notes/scratch.txt'],
      }),
      branches: [branch('feat/src'), branch('main')],
    })

    const plan = await planAbsorb(deps, 'by-directory')

    // Every file from every section of the status reaches the plan...
    const assigned = plan.branches.flatMap((b) => b.files)
    expect(assigned.map((f) => f.path).sort()).toEqual([
      'docs/guide.md',
      'notes/scratch.txt',
      'src/a.ts',
      'src/b.ts',
    ])
    // ...exactly once per path, and the staged status wins the duplicate.
    expect(assigned.find((f) => f.path === 'src/a.ts')?.status).toBe('added')
    // Untracked paths enter the plan as untracked.
    expect(assigned.find((f) => f.path === 'notes/scratch.txt')?.status).toBe(
      'untracked',
    )
    // The chosen strategy is echoed and grouping is by top directory.
    expect(plan.strategy).toBe('by-directory')
    const names = plan.branches.map((b) => b.branchName)
    expect(names).toContain('feat/docs')
    expect(names).toContain('feat/notes')
    // 'feat/src' already exists, so the plan must name around it.
    expect(names).toContain('feat/src-2')
    expect(names).not.toContain('feat/src')

    // A clean workspace plans nothing and says so.
    const clean = await planAbsorb(makeDeps({ status: status() }), 'by-type')
    expect(clean.strategy).toBe('by-type')
    expect(clean.branches).toEqual([])
    expect(clean.unassigned).toEqual([])
    expect(clean.summary).toBe('No changed files to sort — workspace is clean.')
  })

  it('executeAbsorb — reports what was created and staged, and what failed', async () => {
    // A plan with no branches is refused outright.
    const refused = await executeAbsorb(makeDeps(), {
      strategy: 'by-directory',
      branches: [],
      unassigned: [],
      summary: '',
    })
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('No branches in plan — nothing to execute.')
    expect(refused.branchesCreated).toBeUndefined()

    // Happy path: two branches created, three files staged, plan carried back.
    const done = await executeAbsorb(makeDeps(), TWO_BRANCH_PLAN)
    expect(done.ok).toBe(true)
    expect(done.branchesCreated).toEqual(['feat/src', 'feat/docs'])
    expect(done.filesStaged).toBe(3)
    expect(done.reason).toBe('Sorted 3 file(s) into 2 branch(es).')
    expect(done.plan).toEqual(TWO_BRANCH_PLAN)

    // One branch failing is a warning, not a failure: the result reports only
    // what succeeded, and names the branch that failed and why.
    const partial = await executeAbsorb(
      makeDeps({
        createBranch: (name) => {
          if (name === 'feat/src') throw new Error('branch already exists')
          return 'created'
        },
      }),
      TWO_BRANCH_PLAN,
    )
    expect(partial.ok).toBe(true)
    expect(partial.branchesCreated).toEqual(['feat/docs'])
    expect(partial.filesStaged).toBe(1)
    expect(partial.reason).toContain('Sorted 1 file(s) into 1 branch(es).')
    expect(partial.reason).toContain('feat/src: branch already exists')

    // Every branch failing fails the whole call, naming each error.
    const broken = await executeAbsorb(
      makeDeps({
        createBranch: () => {
          throw new Error('gitbutler offline')
        },
      }),
      TWO_BRANCH_PLAN,
    )
    expect(broken.ok).toBe(false)
    expect(broken.branchesCreated).toBeUndefined()
    expect(broken.reason).toContain('All branches failed:')
    expect(broken.reason).toContain('feat/src: gitbutler offline')
    expect(broken.reason).toContain('feat/docs: gitbutler offline')
  })

  it('absorbSmart — a dry run hands back the plan, a real run executes it', async () => {
    const deps = makeDeps({
      status: status({
        branch: 'feat',
        staged: [
          { path: 'src/a.ts', status: 'modified' },
          { path: 'docs/guide.md', status: 'modified' },
        ],
      }),
    })

    // Dry run: a plan comes back, nothing is reported as created or staged.
    const preview = await absorbSmart(deps, 'by-directory', true)
    expect(preview.ok).toBe(true)
    expect(preview.reason).toContain('Dry run')
    expect(preview.plan?.strategy).toBe('by-directory')
    expect(preview.plan?.branches.map((b) => b.branchName)).toEqual([
      'feat/src',
      'feat/docs',
    ])
    expect(preview.branchesCreated).toBeUndefined()
    expect(preview.filesStaged).toBeUndefined()

    // The same request without dryRun executes the plan and reports counts.
    const applied = await absorbSmart(deps, 'by-directory', false)
    expect(applied.ok).toBe(true)
    expect(applied.branchesCreated).toEqual(['feat/src', 'feat/docs'])
    expect(applied.filesStaged).toBe(2)
    expect(applied.reason).toBe('Sorted 2 file(s) into 2 branch(es).')
  })
})
