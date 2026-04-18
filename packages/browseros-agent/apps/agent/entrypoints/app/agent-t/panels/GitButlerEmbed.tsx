/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * GitButler Embed
 * Embed GitButler application in an iframe or webview
 */

import { AlertCircle, ExternalLink, X } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

interface GitButlerEmbedProps {
  repositoryPath: string
  onClose: () => void
}

export const GitButlerEmbed: FC<GitButlerEmbedProps> = ({
  repositoryPath,
  onClose,
}) => {
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null)
  const [gitbutlerUrl, setGitbutlerUrl] = useState<string>('')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    checkGitButlerAvailability()
  }, [])

  const checkGitButlerAvailability = async () => {
    try {
      const response = await fetch('/api/git/gitbutler/status')
      const data = await response.json()

      if (data.available) {
        setIsAvailable(true)

        if (data.mode === 'api') {
          setGitbutlerUrl(`http://localhost:${data.port || 43216}`)
        } else if (data.mode === 'cli') {
          setGitbutlerUrl('about:blank')
        } else {
          setGitbutlerUrl('about:blank')
        }
      } else {
        setIsAvailable(false)
      }
    } catch {
      setIsAvailable(false)
    }
  }

  const openGitButlerApp = () => {
    window.open('gitbutler:', '_blank')
  }

  if (isAvailable === null) {
    return (
      <Card className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">
          Checking GitButler availability...
        </p>
      </Card>
    )
  }

  if (isAvailable === false) {
    return (
      <Card className="h-full p-6">
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <AlertCircle className="size-12 text-muted-foreground" />
          <div className="text-center">
            <h3 className="font-semibold text-lg mb-2">GitButler Not Found</h3>
            <p className="text-muted-foreground text-sm mb-4">
              GitButler is not available. Install it from{' '}
              <a
                href="https://gitbutler.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                gitbutler.com
              </a>
            </p>
            <Button onClick={checkGitButlerAvailability}>Retry</Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="h-full flex flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">GitButler</span>
          <span className="text-xs text-muted-foreground">
            {repositoryPath.split('/').pop()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={openGitButlerApp}
            className="gap-1"
          >
            <ExternalLink className="size-3" />
            Open App
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 p-4">
        <Alert>
          <AlertCircle />
          <AlertDescription>
            GitButler CLI is available. Use the Terminal pane to run GitButler
            commands, or click "Open App" to launch the native application.
          </AlertDescription>
        </Alert>

        <div className="mt-4 space-y-2">
          <h4 className="font-medium text-sm">Quick GitButler Commands:</h4>
          <code className="block rounded bg-muted p-2 text-xs">
            gitbutler open {repositoryPath}
          </code>
          <code className="block rounded bg-muted p-2 text-xs">
            gitbutler status
          </code>
          <code className="block rounded bg-muted p-2 text-xs">
            gitbutler commit --message "feat: add feature"
          </code>
        </div>
      </div>
    </Card>
  )
}
