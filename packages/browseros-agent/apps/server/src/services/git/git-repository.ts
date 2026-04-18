/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Repository Model
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

export function parseGitPorcelain(output: string): GitStatus {
  const staged: FileChange[] = []
  const unstaged: FileChange[] = []
  const untracked: string[] = []
  const conflicted: string[] = []

  const lines = output.trim().split('\n')

  for (const line of lines) {
    if (!line) continue

    const xy = line[0]
    const sub = line[1]
    const path = line.slice(3)

    if (xy === '??') {
      untracked.push(path)
    } else if (xy === 'UU' || xy === 'AA' || xy === 'DD') {
      conflicted.push(path)
    } else {
      let status: FileStatus | null = null

      if (xy === 'M ' || xy === ' M') {
        status = 'modified'
      } else if (xy === 'A ') {
        status = 'added'
      } else if (xy === 'D ' || xy === ' D') {
        status = 'deleted'
      } else if (xy === 'R ') {
        status = 'renamed'
      }

      if (status) {
        const change: FileChange = { path, status }

        if (xy === 'R ') {
          const parts = path.split(' -> ')
          if (parts.length === 2) {
            change.oldPath = parts[0]
            change.path = parts[1]
          }
        }

        if (xy[0] !== ' ' && xy[0] !== '?') {
          staged.push(change)
        }
        if (xy[1] !== ' ' && xy[1] !== '?') {
          unstaged.push(change)
        }
      }
    }
  }

  return {
    branch: '',
    ahead: 0,
    behind: 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  }
}
