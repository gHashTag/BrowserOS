/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * GitButler File Watcher Fallback
 * File watching when both CLI and API are unavailable
 */

import { existsSync } from 'node:fs'
import { $ } from 'bun'
import type { BranchInfo, CommitInfo, GitStatus } from '../git-repository'
import { parseGitPorcelain } from '../git-repository'

export class GitButlerFileWatcher {
  private repoPath: string

  constructor(repoPath: string) {
    this.repoPath = repoPath
  }

  isAvailable(): boolean {
    return existsSync(`${this.repoPath}/.git`)
  }

  async getStatus(): Promise<GitStatus> {
    const result = await $`git status --porcelain`.cwd(this.repoPath).quiet()
    const status = parseGitPorcelain(result.stdout.toString())

    const branch = await this.getCurrentBranch()
    status.branch = branch

    const { ahead, behind } = await this.getAheadBehind()
    status.ahead = ahead
    status.behind = behind

    return status
  }

  async getBranches(): Promise<BranchInfo[]> {
    const result = await $`git branch -vv`.cwd(this.repoPath).quiet()
    const lines = result.stdout.toString().split('\n')

    return lines
      .map((line) => {
        const isCurrent = line.startsWith('*')
        const match = line.match(/^\*?\s+(\S+)\s+(.+)/)
        if (!match) return null

        const name = match[1]
        const ref = match[2]
        const aheadMatch = ref.match(/ahead (\d+)/)
        const behindMatch = ref.match(/behind (\d+)/)

        return {
          name,
          isCurrent,
          isRemote: name.startsWith('remotes/'),
          ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
          behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
        }
      })
      .filter((b): b is BranchInfo => b !== null)
  }

  async switchBranch(branch: string): Promise<void> {
    await $`git checkout ${branch}`.cwd(this.repoPath).quiet()
  }

  async commit(message: string): Promise<CommitInfo> {
    await $`git commit -m "${message}"`.cwd(this.repoPath).quiet()
    return this.getLastCommit()
  }

  async stage(files: string[]): Promise<void> {
    for (const file of files) {
      await $`git add ${file}`.cwd(this.repoPath).quiet()
    }
  }

  async unstage(files: string[]): Promise<void> {
    for (const file of files) {
      await $`git restore --staged ${file}`.cwd(this.repoPath).quiet()
    }
  }

  async pull(): Promise<void> {
    await $`git pull`.cwd(this.repoPath).quiet()
  }

  async push(): Promise<void> {
    await $`git push`.cwd(this.repoPath).quiet()
  }

  async getFiles(): Promise<string[]> {
    const result = await $`git ls-files`.cwd(this.repoPath).quiet()
    return result.stdout.toString().split('\n').filter(Boolean)
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const result = await $`git rev-parse --abbrev-ref HEAD`
        .cwd(this.repoPath)
        .quiet()
      return result.stdout.toString().trim()
    } catch {
      return ''
    }
  }

  private async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
    try {
      const result = await $`git rev-list --left-right --count HEAD...@{u}`
        .cwd(this.repoPath)
        .quiet()
      const [ahead, behind] = result.stdout
        .toString()
        .trim()
        .split('\t')
        .map(Number)
      return { ahead, behind }
    } catch {
      return { ahead: 0, behind: 0 }
    }
  }

  private async getLastCommit(): Promise<CommitInfo> {
    const result = await $`git log -1 --format="%H|%s|%an|%ct"`
      .cwd(this.repoPath)
      .quiet()
    const [hash, message, author, timestamp] = result.stdout
      .toString()
      .split('|')
    return {
      hash,
      message,
      author,
      timestamp: Number.parseInt(timestamp, 10),
    }
  }
}
