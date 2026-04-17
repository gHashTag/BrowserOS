/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Branch Selector
 * Branch selection UI with create/switch functionality
 */

import { Cloud, GitBranch, Plus, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BranchInfo } from './git-types'

interface GitBranchSelectorProps {
  repositoryId: string
  currentBranch: string
  branches: BranchInfo[]
  onSwitch: (branch: string) => void
  onCreate: (name: string, baseBranch?: string) => void
  onDelete: (branch: string) => void
}

export const GitBranchSelector: FC<GitBranchSelectorProps> = ({
  repositoryId,
  currentBranch,
  branches,
  onSwitch,
  onCreate,
  onDelete,
}) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState(currentBranch)

  const filteredBranches = branches.filter((b) =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const handleCreate = () => {
    if (newBranchName.trim()) {
      onCreate(newBranchName.trim(), baseBranch)
      setNewBranchName('')
      setShowCreateDialog(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={currentBranch} onValueChange={onSwitch}>
        <SelectTrigger className="flex-1">
          <SelectValue placeholder="Select branch" />
        </SelectTrigger>
        <SelectContent>
          <div className="p-2">
            <Input
              placeholder="Search branches..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="mb-2"
            />
          </div>
          {filteredBranches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name}>
              <div className="flex items-center justify-between w-full gap-4">
                <div className="flex items-center gap-2">
                  {branch.isRemote ? (
                    <Cloud className="size-3 text-muted-foreground" />
                  ) : (
                    <GitBranch className="size-3 text-muted-foreground" />
                  )}
                  <span className="truncate">{branch.name}</span>
                  {branch.isCurrent && (
                    <Badge variant="secondary" className="text-xs">
                      current
                    </Badge>
                  )}
                </div>
                {(branch.ahead > 0 || branch.behind > 0) && (
                  <div className="text-xs text-muted-foreground">
                    {branch.ahead > 0 && `↑${branch.ahead}`}
                    {branch.behind > 0 && `↓${branch.behind}`}
                  </div>
                )}
              </div>
            </SelectItem>
          ))}
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <div
                className="px-2 py-1.5 text-sm hover:bg-muted cursor-pointer flex items-center gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <Plus className="size-3" />
                <span>Create new branch</span>
              </div>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Branch</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="branch-name">Branch name</Label>
                  <Input
                    id="branch-name"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder="feature/my-feature"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="base-branch">Base branch</Label>
                  <Select value={baseBranch} onValueChange={setBaseBranch}>
                    <SelectTrigger id="base-branch">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={handleCreate}
                  className="w-full"
                  disabled={!newBranchName.trim()}
                >
                  Create Branch
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </SelectContent>
      </Select>
    </div>
  )
}
