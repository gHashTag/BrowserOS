/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * GitButler CLI Integration
 * CLI-first approach for GitButler
 */

import type { GitStatus, CommitInfo, BranchInfo } from '../git-repository'
import { GIT_CONSTANTS } from '@browseros/shared/constants/git'
import { $ } from 'bun'

export class GitButlerCLI {
  private cliPath: string
  private available: boolean | null = null

  constructor(cliPath = GIT_CONSTANTS.GITBUTLER_CLI_PATH) {
    this.cliPath = cliPath
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available
    }

    try {
      await $`${this.cliPath} --version`.quiet()
      this.available = true
      return true
    } catch {
      this.available = false
      return false
    }
  }

  async getStatus(path: string): Promise<GitStatus> {
    const result = await $`${this.cliPath} status --json ${path}`.quiet()
    const data = JSON.parse(result.stdout.toString())
    return this.parseStatus(data)
  }

  async getBranches(path: string): Promise<BranchInfo[]> {
    const result = await $`${this.cliPath} branch list --json ${path}`.quiet()
    const data = JSON.parse(result.stdout.toString())
    return data.map((b: any) => ({
      name: b.name,
      isCurrent: b.current,
      isRemote: b.remote,
      ahead: b.ahead || 0,
      behind: b.behind || 0,
    }))
  }

  async createBranch(
    path: string,
    name: string,
    baseBranch?: string
  ): Promise<void> {
    const cmd = baseBranch
      ? `${this.cliPath} branch create ${name} --base ${baseBranch} ${path}`
      : `${this.cliPath} branch create ${name} ${path}`
    await $`${cmd}`.quiet()
  }

  async switchBranch(path: string, branch: string): Promise<void> {
    await $`${this.cliPath} switch ${branch} ${path}`.quiet()
  }

  async commit(
    path: string,
    message: string,
    files?: string[]
  ): Promise<CommitInfo> {
    const result = await $`${this.cliPath} commit --message "${message}" ${path}`.quiet()
    const data = JSON.parse(result.stdout.toString())
    return {
      hash: data.hash,
      message: data.message,
      author: data.author,
      timestamp: data.timestamp,
    }
  }

  async stage(path: string, files: string[]): Promise<void> {
    for (const file of files) {
      await $`${this.cliPath} stage ${file} ${path}`.quiet()
    }
  }

  async unstage(path: string, files: string[]): Promise<void> {
    for (const file of files) {
      await $`${this.cliPath} unstage ${file} ${path}`.quiet()
    }
  }

  async pull(path: string, branch?: string): Promise<void> {
    const cmd = branch
      ? `${this.cliPath} pull --branch ${branch} ${path}`
      : `${this.cliPath} pull ${path}`
    await $`${cmd}`.quiet()
  }

  async push(path: string, branch?: string): Promise<void> {
    const cmd = branch
      ? `${this.cliPath} push --branch ${branch} ${path}`
      : `${this.cliPath} push ${path}`
    await $`${cmd}`.quiet()
  }

  async getFiles(path: string): Promise<string[]> {
    const result = await $`${this.cliPath} file list --json ${path}`.quiet()
    const data = JSON.parse(result.stdout.toString())
    return data.files || []
  }

  private parseStatus(data: any): GitStatus {
    return {
      branch: data.branch || '',
      ahead: data.ahead || 0,
      behind: data.behind || 0,
      staged: data.staged?.map((f: any) => ({
        path: f.path,
        status: f.status,
        oldPath: f.oldPath,
      })) || [],
      unstaged: data.unstaged?.map((f: any) => ({
        path: f.path,
        status: f.status,
        oldPath: f.oldPath,
      })) || [],
      untracked: data.untracked || [],
      conflicted: data.conflicted || [],
    }
  }
}
