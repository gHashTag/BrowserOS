/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Agent Terminal Page
 * Main page for AGENT T tab with Git integration
 */

import type { FC } from 'react'
import { useState, useEffect } from 'react'
import {
  GitRepo,
  RefreshCw,
  Loader2,
  TerminalSquare,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useGitRepositories } from './useGit'
import { type GitRepository } from './git-types'
import { GitRepositoryPanel } from './GitRepositoryPanel'
import { GitFileTree } from './GitFileTree'
import { GitBranchSelector } from './GitBranchSelector'
import { GitCommitDialog } from './GitCommitDialog'

export const AgentTerminalPage: FC = () => {
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<'status' | 'files' | 'history'>('status')
  const [showCommitDialog, setShowCommitDialog] = useState(false)

  const {
    data: repositories,
    isLoading,
    error,
    refetch,
  } = useGitRepositories()

  const selectedRepo = repositories?.find((r) => r.id === selectedRepoId) || null

  useEffect(() => {
    if (repositories && repositories.length > 0 && !selectedRepoId) {
      setSelectedRepoId(repositories[0].id)
    }
  }, [repositories, selectedRepoId])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>
          Failed to load Git repositories: {String(error)}
        </AlertDescription>
      </Alert>
    )
  }

  if (!repositories || repositories.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <GitRepo className="size-12 text-muted-foreground" />
          <div className="text-center">
            <h3 className="font-semibold text-lg">No Git repositories found</h3>
            <p className="text-muted-foreground text-sm">
              Navigate to a Git repository to get started
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex h-full">
      <div className="w-80 border-r bg-muted/10 flex flex-col">
        <div className="p-4 border-b space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="font-bold text-lg flex items-center gap-2">
              <TerminalSquare className="size-5" />
              AGENT T
            </h1>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => refetch()}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>

          <Select value={selectedRepoId || ''} onValueChange={setSelectedRepoId}>
            <SelectTrigger>
              <SelectValue placeholder="Select repository" />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  <div className="flex items-center gap-2">
                    <GitRepo className="size-4" />
                    <span className="truncate">{repo.name}</span>
                    {repo.isDirty && <Badge variant="secondary">dirty</Badge>}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedRepo && (
          <div className="p-4 space-y-2">
            <div className="flex gap-1">
              <Button
                variant={activePanel === 'status' ? 'default' : 'ghost'}
                size="sm"
                className="flex-1"
                onClick={() => setActivePanel('status')}
              >
                Status
              </Button>
              <Button
                variant={activePanel === 'files' ? 'default' : 'ghost'}
                size="sm"
                className="flex-1"
                onClick={() => setActivePanel('files')}
              >
                Files
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {selectedRepo && (
          <>
            <div className="flex-1 overflow-auto">
              {activePanel === 'status' ? (
                <GitRepositoryPanel
                  repository={selectedRepo}
                  onBranchChange={(branch) => {
                  }}
                  onCommit={() => setShowCommitDialog(true)}
                  onPull={() => {
                  }}
                  onPush={() => {
                  }}
                />
              ) : (
                <div className="p-6">
                  <h2 className="font-semibold text-lg mb-4">Files</h2>
                  <GitFileTree
                    repositoryId={selectedRepo.id}
                    rootPath={selectedRepo.path}
                    onFileSelect={(path) => console.log('Selected:', path)}
                    onStageToggle={(path) => console.log('Toggle stage:', path)}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {selectedRepo && (
        <GitCommitDialog
          open={showCommitDialog}
          onOpenChange={setShowCommitDialog}
          repositoryId={selectedRepo.id}
          stagedFiles={selectedRepo.status?.staged.map((f) => f.path) || []}
          unstagedFiles={selectedRepo.status?.unstaged.map((f) => f.path) || []}
          onCommit={async (message, files) => {
            console.log('Commit:', message, files)
            setShowCommitDialog(false)
          }}
        />
      )}
    </div>
  )
}
