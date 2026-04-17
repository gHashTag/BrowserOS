/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Orchestrator
 * Core orchestrator with Git operations and transaction safety
 */

import type {
  GitRepository,
  GitStatus,
  CommitInfo,
  BranchInfo,
  RepositoryId,
} from './git-repository'
import { withTransaction, GitOperation } from './git-transaction'
import { detectGitButlerMode, createGitButlerClient, type GitButlerMode } from './gitbutler'
import { GIT_CONSTANTS } from '@browseros/shared/constants/git'
import { $ } from 'bun'
import { existsSync } from 'node:fs'

export interface GitOrchestratorConfig {
  workingDir: string
  gitButlerMode?: GitButlerMode
  transactionTimeout?: number
}

export interface TransactionResult<T> {
  success: boolean
  rollbackPerformed: boolean
  operations: string[]
  result?: T
  error?: string
}

export class GitOrchestrator {
  private gitButlerMode: GitButlerMode
  private client: any
  private repositories: Map<RepositoryId, GitRepository> = new Map()

  constructor(private config: GitOrchestratorConfig) {
    this.gitButlerMode = config.gitButlerMode || 'filewatch'
    this.client = createGitButlerClient(this.gitButlerMode)
  }

  static async create(config: GitOrchestratorConfig): Promise<GitOrchestrator> {
    const detected = await detectGitButlerMode()
    return new GitOrchestrator({
      ...config,
      gitButlerMode: detected.mode,
    })
  }

  async listRepositories(): Promise<GitRepository[]> {
    const repos: GitRepository[] = []
    const dirs = await this.findGitRepositories()

    for (const dir of dirs) {
      const repo = await this.initializeRepository(dir)
      if (repo) {
        repos.push(repo)
      }
    }

    return repos
  }

  async getRepositoryStatus(repoId: RepositoryId): Promise<GitStatus> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    const status = await this.client.getStatus(repo.path)
    repo.status = status
    repo.isDirty = this.isDirty(status)

    return status
  }

  async switchBranch(repoId: RepositoryId, branch: string): Promise<void> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    const op: GitOperation = {
      type: 'checkout',
      description: `Switch to branch ${branch}`,
      execute: async () => {
        await this.client.switchBranch(repo.path, branch)
      },
      rollback: async () => {
        await this.client.switchBranch(repo.path, repo.currentBranch)
      },
    }

    await withTransaction(repo.path, [op], async () => {
      repo.currentBranch = branch
      await this.getRepositoryStatus(repoId)
    })
  }

  async createCommit(
    repoId: RepositoryId,
    message: string,
    files: string[]
  ): Promise<CommitInfo> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    if (message.length > GIT_CONSTANTS.MAX_COMMIT_MESSAGE_LENGTH) {
      throw new Error('Commit message exceeds maximum length')
    }

    const op: GitOperation = {
      type: 'commit',
      description: `Commit: ${message.substring(0, 50)}...`,
      execute: async () => {
        if (files.length > 0) {
          await this.client.stage(repo.path, files)
        }
        return await this.client.commit(repo.path, message, files)
      },
      rollback: async () => {
        await this.client.unstage(repo.path, files)
      },
    }

    const result = await withTransaction(repo.path, [op], async () => {
      return await this.client.commit(repo.path, message, files)
    })

    if (!result.success) {
      throw new Error(result.error || 'Commit failed')
    }

    await this.getRepositoryStatus(repoId)
    return result.result as CommitInfo
  }

  async pull(repoId: RepositoryId): Promise<void> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    const status = await this.getRepositoryStatus(repoId)

    const op: GitOperation = {
      type: 'pull',
      description: `Pull changes for ${repo.name}`,
      execute: async () => {
        await this.client.pull(repo.path)
      },
      rollback: async () => {
        await this.client.reset(repo.path, 'HEAD@{1}')
      },
    }

    await withTransaction(repo.path, [op], async () => {
      await this.client.pull(repo.path)
    })

    await this.getRepositoryStatus(repoId)
  }

  async push(repoId: RepositoryId, branch?: string): Promise<void> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    const targetBranch = branch || repo.currentBranch

    const op: GitOperation = {
      type: 'push',
      description: `Push ${targetBranch} to remote`,
      execute: async () => {
        await this.client.push(repo.path, targetBranch)
      },
      rollback: async () => {
      },
    }

    await withTransaction(repo.path, [op], async () => {
      await this.client.push(repo.path, targetBranch)
    })
  }

  async listBranches(repoId: RepositoryId): Promise<BranchInfo[]> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    return await this.client.getBranches(repo.path)
  }

  async createBranch(
    repoId: RepositoryId,
    name: string,
    baseBranch?: string
  ): Promise<void> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    if ('createBranch' in this.client) {
      await this.client.createBranch(repo.path, name, baseBranch)
    } else {
      await $`git checkout -b ${name} ${baseBranch || ''}`.cwd(repo.path).quiet()
    }
  }

  async deleteBranch(repoId: RepositoryId, branch: string): Promise<void> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    if (branch === repo.currentBranch) {
      throw new Error('Cannot delete current branch')
    }

    await $`git branch -D ${branch}`.cwd(repo.path).quiet()
  }

  async getFiles(repoId: RepositoryId, path?: string): Promise<string[]> {
    const repo = this.repositories.get(repoId)
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`)
    }

    const allFiles = await this.client.getFiles(repo.path)
    if (path) {
      return allFiles.filter((f) => f.startsWith(path))
    }
    return allFiles
  }

  private async findGitRepositories(): Promise<string[]> {
    const repos: string[] = []

    async function searchDir(dir: string, depth = 0): Promise<void> {
      if (depth > 3) return

      const entries = await $`ls -la ${dir}`.quiet()
      const lines = entries.stdout.toString().split('\n')

      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 4) continue

        const name = parts[parts.length - 1]
        if (name === '.' || name === '..') continue

        const fullPath = `${dir}/${name}`

        if (existsSync(fullPath)) {
          if (existsSync(`${fullPath}/.git`)) {
            repos.push(fullPath)
          } else {
            await searchDir(fullPath, depth + 1)
          }
        }
      }
    }

    await searchDir(this.config.workingDir)
    return repos
  }

  private async initializeRepository(path: string): Promise<GitRepository | null> {
    try {
      const name = path.split('/').pop() || path
      const status = await this.client.getStatus(path)
      const lastCommit = await this.getLastCommit(path)

      const repo: GitRepository = {
        id: this.generateRepoId(path),
        path,
        name,
        currentBranch: status.branch,
        status,
        lastCommit,
        isDirty: this.isDirty(status),
      }

      this.repositories.set(repo.id, repo)
      return repo
    } catch (error) {
      console.error(`Failed to initialize repository at ${path}:`, error)
      return null
    }
  }

  private async getLastCommit(path: string): Promise<CommitInfo | null> {
    try {
      const result = await $`git log -1 --format="%H|%s|%an|%ct"`.cwd(path).quiet()
      const [hash, message, author, timestamp] = result.stdout.toString().split('|')
      return {
        hash,
        message,
        author,
        timestamp: Number.parseInt(timestamp, 10),
      }
    } catch {
      return null
    }
  }

  private generateRepoId(path: string): RepositoryId {
    return Buffer.from(path).toString('base64').slice(0, 16)
  }

  private isDirty(status: GitStatus): boolean {
    return (
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0 ||
      status.conflicted.length > 0
    )
  }
}
