/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * AGENT T Page
 * Git orchestration terminal page with GitButler integration
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
import { useGitRepositories } from './hooks/useGitOrchestrator'
import { AgentTLayout } from './layout/AgentTLayout'
import { TerminalPane } from './layout/TerminalPane'
import { GitActionsPanel } from './panels/GitActionsPanel'
import { GitButlerEmbed } from './panels/GitButlerEmbed'
import { GitHistoryPanel } from './panels/GitHistoryPanel'
import { GitStatusPanel } from './panels/GitStatusPanel'

type ActivePanel = 'status' | 'history' | 'terminal' | 'gitbutler'

export const AgentTPage: FC = () => {
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<ActivePanel>('status')
  const [_showGitButler, setShowGitButler] = useState(false)

  const { data: repositories, isLoading, error, refetch } = useGitRepositories()

  const selectedRepo =
    repositories?.find((r) => r.id === selectedRepoId) || null

  useEffect(() => {
    if (repositories && repositories.length > 0 && !selectedRepoId) {
      setSelectedRepoId(repositories[0].id)
    }
  }, [repositories, selectedRepoId])

  const handlePanelChange = (panel: ActivePanel) => {
    setActivePanel(panel)
    if (panel === 'gitbutler') {
      setShowGitButler(true)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
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
      <Card className="m-8">
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <FolderGit className="size-12 text-muted-foreground" />
          <div className="text-center">
            <h3 className="font-semibold text-lg">No Git repositories found</h3>
            <p className="text-muted-foreground text-sm">
              Navigate to a Git repository or use the terminal to initialize one
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <AgentTLayout
      header={
        <div className="flex items-center gap-4">
          <h1 className="flex items-center gap-2 font-bold text-lg">
            <TerminalSquare className="size-5" />
            AGENT T
          </h1>
          <Select
            value={selectedRepoId || ''}
            onValueChange={setSelectedRepoId}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select repository" />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  <div className="flex items-center gap-2">
                    <FolderGit className="size-4" />
                    <span className="truncate">{repo.name}</span>
                    {repo.isDirty && (
                      <Badge variant="secondary" className="text-xs">
                        dirty
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      }
      sidebar={
        <>
          <Button
            variant={activePanel === 'status' ? 'default' : 'ghost'}
            size="sm"
            className="w-full justify-start"
            onClick={() => handlePanelChange('status')}
          >
            Status
          </Button>
          <Button
            variant={activePanel === 'history' ? 'default' : 'ghost'}
            size="sm"
            className="w-full justify-start"
            onClick={() => handlePanelChange('history')}
          >
            History
          </Button>
          <Button
            variant={activePanel === 'terminal' ? 'default' : 'ghost'}
            size="sm"
            className="w-full justify-start"
            onClick={() => handlePanelChange('terminal')}
          >
            Terminal
          </Button>
          <Button
            variant={activePanel === 'gitbutler' ? 'default' : 'ghost'}
            size="sm"
            className="w-full justify-start"
            onClick={() => handlePanelChange('gitbutler')}
          >
            GitButler
          </Button>
        </>
      }
      main={
        selectedRepo && (
          <>
            {activePanel === 'status' && (
              <GitStatusPanel repository={selectedRepo} />
            )}
            {activePanel === 'history' && (
              <GitHistoryPanel repositoryId={selectedRepo.id} />
            )}
            {activePanel === 'terminal' && (
              <TerminalPane repositoryPath={selectedRepo.path} />
            )}
            {activePanel === 'gitbutler' && (
              <GitButlerEmbed
                repositoryPath={selectedRepo.path}
                onClose={() => handlePanelChange('status')}
              />
            )}
          </>
        )
      }
      actions={selectedRepo && <GitActionsPanel repository={selectedRepo} />}
    />
  )
}
