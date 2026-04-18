/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Status Panel
 * Displays repository status with file changes
 */

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FileDiff,
  FileX,
  GitBranch,
  Plus,
} from 'lucide-react'
import type { FC } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useGitBranches } from '../hooks/useGitOrchestrator'
import type { GitRepository } from '../types'

interface GitStatusPanelProps {
  repository: GitRepository
}

export const GitStatusPanel: FC<GitStatusPanelProps> = ({ repository }) => {
  const { data: branches } = useGitBranches(repository.id)
  const status = repository.status

  const hasChanges =
    status &&
    (status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0)

  const hasConflicts = status && status.conflicted.length > 0
  const hasUnpushed = status && status.ahead > 0
  const hasUnpulled = status && status.behind > 0

  const currentBranch = branches?.find((b) => b.isCurrent)

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <GitBranch className="size-4" />
                {repository.name}
              </span>
              <Badge variant={hasChanges ? 'secondary' : 'default'}>
                {hasChanges ? 'dirty' : 'clean'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Branch</span>
              <Badge variant="outline">{repository.currentBranch}</Badge>
            </div>

            {currentBranch &&
              (currentBranch.ahead > 0 || currentBranch.behind > 0) && (
                <div className="flex items-center gap-4 text-sm">
                  {currentBranch.ahead > 0 && (
                    <div className="flex items-center gap-1 text-green-600">
                      <ArrowUp className="size-4" />
                      <span>{currentBranch.ahead} ahead</span>
                    </div>
                  )}
                  {currentBranch.behind > 0 && (
                    <div className="flex items-center gap-1 text-blue-600">
                      <ArrowDown className="size-4" />
                      <span>{currentBranch.behind} behind</span>
                    </div>
                  )}
                </div>
              )}

            {status && (
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded border p-2">
                  <div className="font-medium">{status.staged.length}</div>
                  <div className="text-muted-foreground text-xs">Staged</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-medium">{status.unstaged.length}</div>
                  <div className="text-muted-foreground text-xs">Modified</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-medium">{status.untracked.length}</div>
                  <div className="text-muted-foreground text-xs">Untracked</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {hasConflicts && (
          <Card className="border-destructive">
            <CardHeader className="py-2">
              <CardTitle className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="size-4" />
                Conflicts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {status?.conflicted.map((file) => (
                  <li key={file} className="flex items-center gap-2">
                    <FileX className="size-4 text-destructive" />
                    <span className="truncate">{file}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {status && status.staged.length > 0 && (
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <FileDiff className="size-4 text-green-600" />
                Staged ({status.staged.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              <ul className="space-y-1 text-sm">
                {status.staged.map((file) => (
                  <li key={file.path} className="flex items-center gap-2 py-1">
                    <Checkbox checked disabled />
                    <Badge variant="outline" className="text-xs">
                      {file.status}
                    </Badge>
                    <span className="truncate">{file.path}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {status && status.unstaged.length > 0 && (
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <FileDiff className="size-4 text-yellow-600" />
                Unstaged ({status.unstaged.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              <ul className="space-y-1 text-sm">
                {status.unstaged.map((file) => (
                  <li key={file.path} className="flex items-center gap-2 py-1">
                    <Checkbox />
                    <Badge variant="outline" className="text-xs">
                      {file.status}
                    </Badge>
                    <span className="truncate">{file.path}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {status && status.untracked.length > 0 && (
          <Card>
            <CardHeader className="py-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Plus className="size-4 text-blue-600" />
                Untracked ({status.untracked.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              <ul className="space-y-1 text-sm text-muted-foreground">
                {status.untracked.map((file) => (
                  <li key={file} className="flex items-center gap-2 py-1">
                    <Checkbox />
                    <span className="truncate">{file}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  )
}
