/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * GitButler Integration Entry Point
 * Detects available mode and creates appropriate client
 */

import type { BranchInfo, CommitInfo, GitStatus } from '../git-repository'
import { GitButlerAPI } from './gitbutler-api'
import { GitButlerCLI } from './gitbutler-cli'
import { GitButlerFileWatcher } from './gitbutler-fs'

export type GitButlerMode = 'cli' | 'api' | 'filewatch'

export interface GitButlerConfig {
  cliPath?: string
  apiPort?: number
  repoPath?: string
}

export interface GitButlerClient {
  isAvailable(): boolean | Promise<boolean>
  getStatus(path: string): Promise<GitStatus>
  getBranches(path: string): Promise<BranchInfo[]>
  switchBranch(path: string, branch: string): Promise<void>
  commit(path: string, message: string, files?: string[]): Promise<CommitInfo>
  stage(path: string, files: string[]): Promise<void>
  unstage(path: string, files: string[]): Promise<void>
  pull(path: string, branch?: string): Promise<void>
  push(path: string, branch?: string): Promise<void>
  getFiles(path: string): Promise<string[]>
}

export async function detectGitButlerMode(
  config: GitButlerConfig = {},
): Promise<{ mode: GitButlerMode; available: boolean }> {
  const cli = new GitButlerCLI(config.cliPath)
  if (await cli.isAvailable()) {
    return { mode: 'cli', available: true }
  }

  const api = new GitButlerAPI(config.apiPort)
  if (await api.isAvailable()) {
    return { mode: 'api', available: true }
  }

  return { mode: 'filewatch', available: false }
}

export function createGitButlerClient(
  mode: GitButlerMode,
  config: GitButlerConfig = {},
): GitButlerClient {
  switch (mode) {
    case 'cli':
      return new GitButlerCLI(config.cliPath)
    case 'api':
      return new GitButlerAPI(config.apiPort)
    case 'filewatch':
      return new GitButlerFileWatcher(config.repoPath || '.') as GitButlerClient
  }
}
