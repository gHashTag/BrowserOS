/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Actions Panel
 * Quick actions for Git operations
 */

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleCheck,
  GitBranch,
  Package,
  RefreshCw,
} from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  useGitBranches,
  useGitCommit,
  useGitCreateBranch,
  useGitDeleteBranch,
  useGitPull,
  useGitPush,
  useGitSwitchBranch,
} from '../hooks/useGitOrchestrator'
import type { GitRepository } from '../types'

interface GitActionsPanelProps {
  repository: GitRepository
}

export const GitActionsPanel: FC<GitActionsPanelProps> = ({ repository }) => {
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [showBranchDialog, setShowBranchDialog] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranchName, setNewBranchName] = useState('')

  const { data: branches } = useGitBranches(repository.id)
  const commit = useGitCommit()
  const pull = useGitPull()
  const push = useGitPush()
  const createBranch = useGitCreateBranch()
  const _deleteBranch = useGitDeleteBranch()
  const switchBranch = useGitSwitchBranch()

  const status = repository.status
  const hasChanges =
    status &&
    (status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0)

  const _hasConflicts = status && status.conflicted.length > 0
  const hasUnpushed = status && status.ahead > 0
  const hasUnpulled = status && status.behind > 0

  const handleCommit = async () => {
    if (!commitMessage.trim()) return

    const allFiles = [
      ...(status?.staged.map((f) => f.path) || []),
      ...(status?.unstaged.map((f) => f.path) || []),
    ]

    await commit.mutateAsync({
      repoId: repository.id,
      message: commitMessage,
      files: allFiles,
    })

    setCommitMessage('')
    setShowCommitDialog(false)
  }

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return

    await createBranch.mutateAsync({
      repoId: repository.id,
      name: newBranchName,
      baseBranch: repository.currentBranch,
    })

    setNewBranchName('')
    setShowBranchDialog(false)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => pull.mutate({ repoId: repository.id })}
              disabled={!hasUnpulled || pull.isPending}
            >
              <ArrowDownToLine className="mr-1 size-4" />
              Pull
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => push.mutate({ repoId: repository.id })}
              disabled={!hasUnpushed || push.isPending}
            >
              <ArrowUpFromLine className="mr-1 size-4" />
              Push
            </Button>
          </div>

          <Button
            size="sm"
            className="w-full"
            onClick={() => setShowCommitDialog(true)}
            disabled={!hasChanges || commit.isPending}
          >
            <CircleCheck className="mr-1 size-4" />
            Commit
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setShowBranchDialog(true)}
            disabled={createBranch.isPending}
          >
            <GitBranch className="mr-1 size-4" />
            New Branch
          </Button>

          <Button variant="outline" size="sm" className="w-full" disabled>
            <Package className="mr-1 size-4" />
            Stash
          </Button>
        </CardContent>
      </Card>

      {branches && branches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Branches</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {branches.map((branch) => (
              <div
                key={branch.name}
                className="flex items-center justify-between rounded border p-2"
              >
                <div className="flex items-center gap-2">
                  {branch.isCurrent && (
                    <RefreshCw className="size-3 text-green-600" />
                  )}
                  <span
                    className={
                      branch.isCurrent ? 'font-medium text-green-600' : ''
                    }
                  >
                    {branch.name}
                  </span>
                  {branch.ahead > 0 && (
                    <Badge variant="outline" className="text-xs">
                      ↑{branch.ahead}
                    </Badge>
                  )}
                  {branch.behind > 0 && (
                    <Badge variant="outline" className="text-xs">
                      ↓{branch.behind}
                    </Badge>
                  )}
                </div>
                {!branch.isCurrent && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() =>
                      switchBranch.mutate({
                        repoId: repository.id,
                        branch: branch.name,
                      })
                    }
                    disabled={switchBranch.isPending}
                  >
                    <ArrowDownToLine className="size-3" />
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={showCommitDialog} onOpenChange={setShowCommitDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Commit</DialogTitle>
            <DialogDescription>
              Create a new commit for {repository.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="message">Commit message</Label>
              <Textarea
                id="message"
                placeholder="feat: add new feature"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                rows={4}
              />
            </div>
            {hasChanges && (
              <div className="text-muted-foreground text-sm">
                Will commit {status?.staged.length || 0} staged,{' '}
                {status?.unstaged.length || 0} unstaged, and{' '}
                {status?.untracked.length || 0} untracked files.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCommitDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCommit}
              disabled={!commitMessage.trim() || commit.isPending}
            >
              {commit.isPending ? 'Committing...' : 'Commit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showBranchDialog} onOpenChange={setShowBranchDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Branch</DialogTitle>
            <DialogDescription>
              Create a new branch from {repository.currentBranch}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="branch-name">Branch name</Label>
              <Input
                id="branch-name"
                placeholder="feature/new-feature"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowBranchDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateBranch}
              disabled={!newBranchName.trim() || createBranch.isPending}
            >
              {createBranch.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
