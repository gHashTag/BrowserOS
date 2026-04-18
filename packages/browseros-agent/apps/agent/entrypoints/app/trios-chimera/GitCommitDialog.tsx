/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Commit Dialog
 * Commit message dialog with file staging
 */

import { Check, FileText, GitCommit } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'

interface GitCommitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repositoryId: string
  stagedFiles: string[]
  unstagedFiles: string[]
  onCommit: (message: string, unstagedToStage: string[]) => void
}

const CONVENTIONAL_COMMITS = [
  { prefix: 'feat', description: 'New feature' },
  { prefix: 'fix', description: 'Bug fix' },
  { prefix: 'docs', description: 'Documentation' },
  { prefix: 'style', description: 'Code style' },
  { prefix: 'refactor', description: 'Refactoring' },
  { prefix: 'test', description: 'Tests' },
  { prefix: 'chore', description: 'Chores' },
]

export const GitCommitDialog: FC<GitCommitDialogProps> = ({
  open,
  onOpenChange,
  repositoryId,
  stagedFiles,
  unstagedFiles,
  onCommit,
}) => {
  const [message, setMessage] = useState('')
  const [selectedUnstaged, setSelectedUnstaged] = useState<Set<string>>(
    new Set(),
  )
  const [selectedPrefix, setSelectedPrefix] = useState<string | null>(null)

  const handleMessageChange = (value: string) => {
    setMessage(value)
    const match = value.match(/^(\w+):\s*/)
    if (match) {
      setSelectedPrefix(match[1])
    } else {
      setSelectedPrefix(null)
    }
  }

  const toggleUnstagedFile = (file: string) => {
    const newSelected = new Set(selectedUnstaged)
    if (newSelected.has(file)) {
      newSelected.delete(file)
    } else {
      newSelected.add(file)
    }
    setSelectedUnstaged(newSelected)
  }

  const handleCommit = () => {
    if (message.trim()) {
      const unstagedToStage = Array.from(selectedUnstaged)
      onCommit(message, unstagedToStage)
      setMessage('')
      setSelectedUnstaged(new Set())
      setSelectedPrefix(null)
    }
  }

  const applyConventionalCommit = (prefix: string) => {
    setMessage(`${prefix}: `)
  }

  const charCount = message.length
  const maxChars = 2048

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCommit className="size-5" />
            Commit Changes
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="commit-message">Commit message</Label>
            <Textarea
              id="commit-message"
              value={message}
              onChange={(e) => handleMessageChange(e.target.value)}
              placeholder="Describe your changes..."
              rows={4}
              className="resize-none"
            />
            <div className="flex justify-between items-center text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-2">
                {CONVENTIONAL_COMMITS.map(({ prefix, description }) => (
                  <Badge
                    key={prefix}
                    variant={selectedPrefix === prefix ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => applyConventionalCommit(prefix)}
                  >
                    {prefix}: {description}
                  </Badge>
                ))}
              </div>
              <span>
                {charCount}/{maxChars}
              </span>
            </div>
          </div>

          {unstagedFiles.length > 0 && (
            <div className="space-y-2">
              <Label>Unstaged files to include</Label>
              <ScrollArea className="h-32 border rounded-md p-2">
                <div className="space-y-1">
                  {unstagedFiles.map((file) => (
                    <label
                      key={file}
                      className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 p-1 rounded"
                    >
                      <Checkbox
                        checked={selectedUnstaged.has(file)}
                        onCheckedChange={() => toggleUnstagedFile(file)}
                      />
                      <FileText className="size-3 text-muted-foreground" />
                      <span className="truncate">{file}</span>
                    </label>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {stagedFiles.length > 0 && (
            <div className="space-y-2">
              <Label>Staged files ({stagedFiles.length})</Label>
              <ScrollArea className="h-24 border rounded-md p-2">
                <div className="space-y-1">
                  {stagedFiles.map((file) => (
                    <div
                      key={file}
                      className="flex items-center gap-2 text-sm text-muted-foreground p-1"
                    >
                      <Check className="size-3 text-green-600" />
                      <FileText className="size-3" />
                      <span className="truncate">{file}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleCommit} disabled={!message.trim()}>
              <Check className="mr-1 size-4" />
              Commit
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
