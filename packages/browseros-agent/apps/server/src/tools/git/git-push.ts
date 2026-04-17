/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Push Tool
 */

import { defineTool } from '../framework'
import { z } from 'zod'

export const gitPush = defineTool({
  name: 'git_push',
  description: 'Push changes to remote repository',
  approvalCategory: 'filesystem',
  input: z.object({
    path: z.string().describe('Path to the git repository'),
    branch: z.string().optional().describe('Specific branch to push'),
    remote: z.string().default('origin').describe('Remote name (default: origin)'),
    force: z.boolean().default(false).describe('Force push (use with caution)'),
  }),
  output: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const { path, branch, remote, force } = args
    const { $ } = await import('bun')

    try {
      const forceFlag = force ? '--force' : ''

      if (branch) {
        await $`git push ${forceFlag} ${remote} ${branch}`.cwd(path).quiet()
      } else {
        await $`git push ${forceFlag} ${remote}`.cwd(path).quiet()
      }

      response.json({ success: true })
    } catch (error) {
      response.json({ success: false, error: String(error) })
    }
  },
})
