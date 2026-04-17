/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Status Tool
 */

import { defineTool } from '../framework'
import { z } from 'zod'

export const gitStatus = defineTool({
  name: 'git_status',
  description: 'Get the current git status of a repository including branch, staged/unstaged changes, and untracked files',
  approvalCategory: 'filesystem',
  input: z.object({
    path: z.string().describe('Path to the git repository'),
  }),
  output: z.object({
    branch: z.string(),
    ahead: z.number(),
    behind: z.number(),
    staged: z.array(z.object({
      path: z.string(),
      status: z.enum(['added', 'modified', 'deleted', 'renamed']),
      oldPath: z.string().optional(),
    })),
    unstaged: z.array(z.object({
      path: z.string(),
      status: z.enum(['added', 'modified', 'deleted', 'renamed']),
      oldPath: z.string().optional(),
    })),
    untracked: z.array(z.string()),
    conflicted: z.array(z.string()),
  }),
  handler: async (args, ctx, response) => {
    const { path } = args
    const { $ } = await import('bun')

    try {
      const porcelain = await $`git status --porcelain`.cwd(path).quiet()
      const branch = await $`git rev-parse --abbrev-ref HEAD`.cwd(path).quiet()

      const staged: any[] = []
      const unstaged: any[] = []
      const untracked: string[] = []
      const conflicted: string[] = []

      const lines = porcelain.stdout.toString().split('\n')
      for (const line of lines) {
        if (!line) continue
        const xy = line.slice(0, 2)
        const filePath = line.slice(3)

        if (xy === '??') {
          untracked.push(filePath)
        } else if (xy === 'UU' || xy === 'AA' || xy === 'DD') {
          conflicted.push(filePath)
        } else {
          let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified'
          if (xy[0] === 'A') status = 'added'
          else if (xy[0] === 'D') status = 'deleted'
          else if (xy[0] === 'R') status = 'renamed'

          const change = { path: filePath, status }

          if (xy[0] !== ' ' && xy[0] !== '?') staged.push(change)
          if (xy[1] !== ' ' && xy[1] !== '?') unstaged.push(change)
        }
      }

      response.json({
        branch: branch.stdout.toString().trim(),
        ahead: 0,
        behind: 0,
        staged,
        unstaged,
        untracked,
        conflicted,
      })
    } catch (error) {
      response.error(String(error))
    }
  },
})
