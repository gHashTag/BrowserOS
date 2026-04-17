/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git History Panel
 * Displays commit history
 */

import { GitCommit, Loader2 } from 'lucide-react'
import type { FC } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useQuery } from '@tanstack/react-query'

interface GitHistoryPanelProps {
  repositoryId: string
}

interface CommitHistoryItem {
  hash: string
  message: string
  author: string
  timestamp: number
  branch?: string
}

export const GitHistoryPanel: FC<GitHistoryPanelProps> = ({ repositoryId }) => {
  const { data: commits, isLoading, error } = useQuery({
    queryKey: ['git', 'history', repositoryId],
    queryFn: async (): Promise<CommitHistoryItem[]> => {
      const res = await fetch(`/api/git/history/${repositoryId}`)
      if (!res.ok) throw new Error('Failed to fetch history')
      return res.json()
    },
  })

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCommit className="size-4" />
          Commit History
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[calc(100vh-200px)]">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive">
              Failed to load history: {String(error)}
            </div>
          )}

          {commits && commits.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              No commits found in this repository
            </div>
          )}

          {commits && commits.length > 0 && (
            <div className="space-y-3">
              {commits.map((commit) => (
                <div
                  key={commit.hash}
                  className="flex gap-3 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex flex-col items-center gap-1 pt-1">
                    <div className="size-3 rounded-full bg-blue-500" />
                    <div className="w-0.5 flex-1 bg-muted" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs text-muted-foreground">
                        {commit.hash.slice(0, 7)}
                      </span>
                      <span className="text-sm font-medium truncate">
                        {commit.message}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{commit.author}</span>
                      <span>•</span>
                      <span>{formatDate(commit.timestamp)}</span>
                      {commit.branch && (
                        <Badge variant="outline" className="text-xs">
                          {commit.branch}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      title="View diff"
                    >
                      <GitCommit className="size-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
