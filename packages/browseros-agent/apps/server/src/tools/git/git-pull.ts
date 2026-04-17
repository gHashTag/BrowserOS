/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Pull Tool
 */

import { z } from 'zod'
import { defineTool } from '../framework'

export const gitPull = defineTool({
  name: 'git_pull',
  description: 'Pull changes from remote repository',
  approvalCategory: 'filesystem',
  input: z.object({
    path: z.string().describe('Path to the git repository'),
    branch: z.string().optional().describe('Specific branch to pull'),
    remote: z
      .string()
      .default('origin')
      .describe('Remote name (default: origin)'),
  }),
  output: z.object({
    success: z.boolean(),
    error: z.string().optional(),
    conflicts: z.array(z.string()).optional(),
  }),
  handler: async (args, ctx, response) => {
    const { path, branch, remote } = args
    const { $ } = await import('bun')

    try {
      if (branch) {
        await $`git pull ${remote} ${branch}`.cwd(path).quiet()
      } else {
        await $`git pull`.cwd(path).quiet()
      }

      response.json({ success: true })
    } catch (error) {
      const errStr = String(error)
      const conflicts: string[] = []

      if (errStr.includes('conflict')) {
        const status = await $`git status --porcelain`.cwd(path).quiet()
        const lines = status.stdout.toString().split('\n')
        for (const line of lines) {
          if (
            line.startsWith('UU') ||
            line.startsWith('AA') ||
            line.startsWith('DD')
          ) {
            conflicts.push(line.slice(3))
          }
        }
      }

      response.json({
        success: false,
        error: errStr,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      })
    }
  },
})
