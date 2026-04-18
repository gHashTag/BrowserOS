/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git File Tree
 * File tree browser with Git status indicators
 */

import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  File,
  Folder,
  FolderOpen,
} from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { FileNode, FileStatus } from './git-types'
import { useGitFiles } from './useGit'

interface GitFileTreeProps {
  repositoryId: string
  rootPath: string
  onFileSelect: (path: string) => void
  onStageToggle: (path: string) => void
}

const STATUS_COLORS: Record<FileStatus, string> = {
  added: 'text-green-600',
  modified: 'text-yellow-600',
  deleted: 'text-red-600',
  renamed: 'text-blue-600',
}

export const GitFileTree: FC<GitFileTreeProps> = ({
  repositoryId,
  rootPath,
  onFileSelect,
  onStageToggle,
}) => {
  const { data: files = [], isLoading } = useGitFiles(repositoryId)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [stagedPaths, setStagedPaths] = useState<Set<string>>(new Set())

  const fileTree = buildFileTree(files, rootPath)

  const toggleExpand = (path: string) => {
    const newExpanded = new Set(expandedPaths)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    setExpandedPaths(newExpanded)
  }

  const toggleStage = (path: string) => {
    const newStaged = new Set(stagedPaths)
    if (newStaged.has(path)) {
      newStaged.delete(path)
    } else {
      newStaged.add(path)
    }
    setStagedPaths(newStaged)
    onStageToggle(path)
  }

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">Loading files...</div>
  }

  if (files.length === 0) {
    return <div className="text-muted-foreground text-sm">No files</div>
  }

  return (
    <ScrollArea className="h-96">
      <div className="space-y-1">
        {fileTree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            expandedPaths={expandedPaths}
            stagedPaths={stagedPaths}
            onToggleExpand={toggleExpand}
            onToggleStage={toggleStage}
            onSelect={onFileSelect}
            level={0}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

interface FileTreeNodeProps {
  node: FileNode
  expandedPaths: Set<string>
  stagedPaths: Set<string>
  onToggleExpand: (path: string) => void
  onToggleStage: (path: string) => void
  onSelect: (path: string) => void
  level: number
}

const FileTreeNode: FC<FileTreeNodeProps> = ({
  node,
  expandedPaths,
  stagedPaths,
  onToggleExpand,
  onToggleStage,
  onSelect,
  level,
}) => {
  const isExpanded = expandedPaths.has(node.path)
  const isStaged = stagedPaths.has(node.path)
  const isDirectory = node.type === 'directory'

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 hover:bg-muted/50 rounded px-2 cursor-pointer"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onSelect(node.path)}
      >
        {isDirectory ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(node.path)
            }}
            className="p-0 hover:bg-muted rounded"
          >
            {isExpanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        ) : (
          <div className="w-4" />
        )}

        {isDirectory ? (
          isExpanded ? (
            <FolderOpen className="size-4 text-blue-500" />
          ) : (
            <Folder className="size-4 text-blue-500" />
          )
        ) : (
          <File className="size-4 text-muted-foreground" />
        )}

        <span className="flex-1 text-sm truncate">{node.name}</span>

        {node.status && (
          <span className={`text-xs ${STATUS_COLORS[node.status]}`}>
            {node.status}
          </span>
        )}

        <Checkbox
          checked={isStaged}
          onCheckedChange={(checked) => {
            onToggleStage(node.path)
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              expandedPaths={expandedPaths}
              stagedPaths={stagedPaths}
              onToggleExpand={onToggleExpand}
              onToggleStage={onToggleStage}
              onSelect={onSelect}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function buildFileTree(paths: string[], rootPath: string): FileNode[] {
  const tree: Map<string, FileNode> = new Map()

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let currentPath = ''

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part

      const node: FileNode = {
        path: currentPath,
        name: part,
        type: isLast ? 'file' : 'directory',
        children: isLast ? undefined : [],
      }

      if (tree.has(currentPath)) {
        continue
      }

      tree.set(currentPath, node)

      if (i > 0) {
        const parentPath = parts.slice(0, i).join('/')
        const parent = tree.get(parentPath)
        if (parent && parent.children) {
          parent.children.push(node)
        }
      }
    }
  }

  return Array.from(tree.values()).filter((n) => n.path.split('/').length === 1)
}
