/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Agent Terminal Page
 * Main page for AGENT T tab with Git integration
 */

import {
  AlertCircle,
  FolderGit,
  Loader2,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { GitCommitDialog } from './GitCommitDialog'
import { GitFileTree } from './GitFileTree'
import { GitRepositoryPanel } from './GitRepositoryPanel'
import { useGitRepositories } from './useGit'

export const AgentTerminalPage: FC = () => {
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<
    'status' | 'files' | 'history'
  >('status')
  const [showCommitDialog, setShowCommitDialog] = useState(false)

  const { data: repositories, isLoading, error, refetch } = useGitRepositories()

  const selectedRepo =
    repositories?.find((r) => r.id === selectedRepoId) || null

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
          <FolderGit className="size-12 text-muted-foreground" />
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
      <div className="flex w-80 flex-col border-r bg-muted/10">
        <div className="space-y-4 border-b p-4">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-2 font-bold text-lg">
              <TerminalSquare className="size-5" />
              AGENT T
            </h1>
            <Button variant="ghost" size="icon" onClick={() => refetch()}>
              <RefreshCw className="size-4" />
            </Button>
          </div>

          <Select
            value={selectedRepoId || ''}
            onValueChange={setSelectedRepoId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select repository" />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  <div className="flex items-center gap-2">
                    <FolderGit className="size-4" />
                    <span className="truncate">{repo.name}</span>
                    {repo.isDirty && <Badge variant="secondary">dirty</Badge>}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedRepo && (
          <div className="space-y-2 p-4">
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

      <div className="flex flex-1 overflow-hidden">
        {selectedRepo && (
          <div className="flex-1 overflow-auto">
            {activePanel === 'status' ? (
              <GitRepositoryPanel
                repository={selectedRepo}
                onBranchChange={(_branch) => {}}
                onCommit={() => setShowCommitDialog(true)}
                onPull={() => {}}
                onPush={() => {}}
              />
            ) : (
              <div className="p-6">
                <h2 className="mb-4 font-semibold text-lg">Files</h2>
                <GitFileTree
                  repositoryId={selectedRepo.id}
                  rootPath={selectedRepo.path}
                  onFileSelect={(_path) => {}}
                  onStageToggle={(_path) => {}}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {selectedRepo && (
        <GitCommitDialog
          open={showCommitDialog}
          onOpenChange={setShowCommitDialog}
          repositoryId={selectedRepo.id}
          stagedFiles={selectedRepo.status?.staged.map((f) => f.path) || []}
          unstagedFiles={selectedRepo.status?.unstaged.map((f) => f.path) || []}
          onCommit={async (_message, _files) => {
            setShowCommitDialog(false)
          }}
        />
      )}
    </div>
  )
}
