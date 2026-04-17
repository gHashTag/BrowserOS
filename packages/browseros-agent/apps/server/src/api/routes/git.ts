/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git REST API Routes
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { GitOrchestrator } from '../../services/git/git-orchestrator'

interface GitRouteDeps {
  orchestrator: GitOrchestrator
}

const RepositoryIdSchema = z.object({
  repoId: z.string(),
})

const SwitchBranchSchema = z.object({
  repoId: z.string(),
  branch: z.string(),
})

const CommitSchema = z.object({
  repoId: z.string(),
  message: z.string().min(1).max(2048),
  files: z.array(z.string()).optional(),
})

const PullPushSchema = z.object({
  repoId: z.string(),
  branch: z.string().optional(),
})

const CreateBranchSchema = z.object({
  repoId: z.string(),
  name: z.string().min(1),
  baseBranch: z.string().optional(),
})

const DeleteBranchSchema = z.object({
  repoId: z.string(),
  branch: z.string(),
})

export function createGitRoutes(deps: GitRouteDeps) {
  const app = new Hono()
  const { orchestrator } = deps

  app.get('/repositories', async (c) => {
    try {
      const repos = await orchestrator.listRepositories()
      return c.json({ repositories: repos })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.get('/status/:repoId', zValidator('param', RepositoryIdSchema), async (c) => {
    const { repoId } = c.req.valid('param')
    try {
      const status = await orchestrator.getRepositoryStatus(repoId)
      return c.json(status)
    } catch (error) {
      return c.json({ error: String(error) }, 404)
    }
  })

  app.get('/branches/:repoId', zValidator('param', RepositoryIdSchema), async (c) => {
    const { repoId } = c.req.valid('param')
    try {
      const branches = await orchestrator.listBranches(repoId)
      return c.json({ branches })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.get('/files/:repoId', zValidator('param', RepositoryIdSchema), async (c) => {
    const { repoId } = c.req.valid('param')
    const path = c.req.query('path')
    try {
      const files = await orchestrator.getFiles(repoId, path)
      return c.json({ files })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.post('/checkout', zValidator('json', SwitchBranchSchema), async (c) => {
    const { repoId, branch } = c.req.valid('json')
    try {
      await orchestrator.switchBranch(repoId, branch)
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.post('/commit', zValidator('json', CommitSchema), async (c) => {
    const { repoId, message, files } = c.req.valid('json')
    try {
      const commit = await orchestrator.createCommit(repoId, message, files || [])
      return c.json(commit)
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.post('/pull', zValidator('json', PullPushSchema), async (c) => {
    const { repoId } = c.req.valid('json')
    try {
      await orchestrator.pull(repoId)
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.post('/push', zValidator('json', PullPushSchema), async (c) => {
    const { repoId, branch } = c.req.valid('json')
    try {
      await orchestrator.push(repoId, branch)
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.post('/branch/create', zValidator('json', CreateBranchSchema), async (c) => {
    const { repoId, name, baseBranch } = c.req.valid('json')
    try {
      await orchestrator.createBranch(repoId, name, baseBranch)
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  app.post('/branch/delete', zValidator('json', DeleteBranchSchema), async (c) => {
    const { repoId, branch } = c.req.valid('json')
    try {
      await orchestrator.deleteBranch(repoId, branch)
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: String(error) }, 500)
    }
  })

  return app
}
