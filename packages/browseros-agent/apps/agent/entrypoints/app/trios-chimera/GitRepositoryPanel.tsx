/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Repository Panel
 * Displays repository status and provides quick actions
 */

import {
  AlertCircle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  CheckCircle2,
  FileDiff,
  FileX,
  GitBranch,
} from 'lucide-react'
import type { FC } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { GitBranchSelector } from './GitBranchSelector'
import type { GitRepository } from './git-types'

interface GitRepositoryPanelProps {
  repository: GitRepository
  onBranchChange: (branch: string) => void
  onCommit: () => void
  onPull: () => void
  onPush: () => void
}

export const GitRepositoryPanel: FC<GitRepositoryPanelProps> = ({
  repository,
  onBranchChange,
  onCommit,
  onPull,
  onPush,
}) => {
  const status = repository.status

  const hasChanges =
    status &&
    (status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0)

  const hasConflicts = status && status.conflicted.length > 0
  const hasUnpushed = status && status.ahead > 0
  const hasUnpulled = status && status.behind > 0

  return (
    <div className="space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{repository.name}</span>
            <Badge variant={hasChanges ? 'secondary' : 'default'}>
              {hasChanges ? 'dirty' : 'clean'}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-2 flex items-center gap-2 font-medium text-sm">
              <GitBranch className="size-4" />
              Branch
            </div>
            <GitBranchSelector
              repositoryId={repository.id}
              currentBranch={repository.currentBranch}
              branches={[]}
              onSwitch={onBranchChange}
              onCreate={() => {}}
              onDelete={() => {}}
            />
          </div>

          {status && (status.ahead > 0 || status.behind > 0) && (
            <div className="flex items-center gap-4 text-sm">
              {status.ahead > 0 && (
                <div className="flex items-center gap-1 text-green-600">
                  <ArrowUp className="size-4" />
                  <span>{status.ahead} ahead</span>
                </div>
              )}
              {status.behind > 0 && (
                <div className="flex items-center gap-1 text-blue-600">
                  <ArrowDown className="size-4" />
                  <span>{status.behind} behind</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onPull}
              disabled={!hasUnpulled}
            >
              <ArrowDownToLine className="mr-1 size-4" />
              Pull
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onPush}
              disabled={!hasUnpushed}
            >
              <ArrowUpFromLine className="mr-1 size-4" />
              Push
            </Button>
            <Button size="sm" onClick={onCommit} disabled={!hasChanges}>
              <CheckCircle2 className="mr-1 size-4" />
              Commit
            </Button>
          </div>
        </CardContent>
      </Card>

      {hasConflicts && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-5" />
              Conflicts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {status?.conflicted.map((file) => (
                <li key={file} className="flex items-center gap-2">
                  <FileX className="size-4 text-destructive" />
                  <span>{file}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {status && status.staged.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-medium text-sm">
              <FileDiff className="size-4 text-green-600" />
              Staged ({status.staged.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {status.staged.map((file) => (
                <li key={file.path} className="flex items-center gap-2">
                  <Badge variant="outline">{file.status}</Badge>
                  <span className="truncate">{file.path}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {status && status.unstaged.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-medium text-sm">
              <FileDiff className="size-4 text-yellow-600" />
              Unstaged ({status.unstaged.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {status.unstaged.map((file) => (
                <li key={file.path} className="flex items-center gap-2">
                  <Badge variant="outline">{file.status}</Badge>
                  <span className="truncate">{file.path}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {status && status.untracked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="font-medium text-sm">
              Untracked ({status.untracked.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-muted-foreground text-sm">
              {status.untracked.map((file) => (
                <li key={file} className="truncate">
                  {file}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
