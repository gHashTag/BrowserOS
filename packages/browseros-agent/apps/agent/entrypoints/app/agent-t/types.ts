/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * AGENT T Types
 */

export type RepositoryId = string
export type BranchName = string
export type CommitHash = string
export type FilePath = string

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface FileChange {
  path: FilePath
  status: FileStatus
  oldPath?: FilePath
}

export interface CommitInfo {
  hash: CommitHash
  message: string
  author: string
  timestamp: number
}

export interface GitStatus {
  branch: BranchName
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: string[]
  conflicted: string[]
}

export interface GitRepository {
  id: RepositoryId
  path: string
  name: string
  currentBranch: BranchName
  status: GitStatus | null
  lastCommit: CommitInfo | null
  isDirty: boolean
}

export interface BranchInfo {
  name: string
  isCurrent: boolean
  isRemote: boolean
  ahead: number
  behind: number
}

export interface FileNode {
  path: string
  name: string
  type: 'file' | 'directory'
  status?: FileStatus
  children?: FileNode[]
  expanded?: boolean
}
