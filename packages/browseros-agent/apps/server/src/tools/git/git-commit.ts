/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Commit Tool
 */

import { z } from 'zod'
import { defineTool } from '../framework'

export const gitCommit = defineTool({
  name: 'git_commit',
  description: 'Create a git commit with staged changes',
  approvalCategory: 'data-modification',
  input: z.object({
    path: z.string().describe('Path to the git repository'),
    message: z.string().min(1).max(2048).describe('Commit message'),
    files: z
      .array(z.string())
      .optional()
      .describe('Files to stage before committing'),
  }),
  output: z.object({
    success: z.boolean(),
    hash: z.string().optional(),
    error: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const { path, message, files } = args
    const { $ } = await import('bun')

    try {
      if (files && files.length > 0) {
        for (const file of files) {
          await $`git add ${file}`.cwd(path).quiet()
        }
      }

      const result = await $`git commit -m "${message}"`.cwd(path).quiet()

      const hashResult = await $`git rev-parse HEAD`.cwd(path).quiet()

      response.text(
        JSON.stringify({
          success: true,
          hash: hashResult.stdout.toString().trim(),
        }),
      )
    } catch (error) {
      const errStr = String(error)
      if (errStr.includes('nothing to commit')) {
        response.text(
          JSON.stringify({ success: false, error: 'No changes to commit' }),
        )
      } else {
        response.text(JSON.stringify({ success: false, error: errStr }))
      }
    }
  },
})
