/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Orchestrator Hooks
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BranchInfo, FileChange, GitRepository, GitStatus } from '../types'

const API_BASE = '/api/git'

export function useGitRepositories() {
  return useQuery({
    queryKey: ['git', 'repositories'],
    queryFn: async (): Promise<GitRepository[]> => {
      const res = await fetch(`${API_BASE}/repositories`)
      if (!res.ok) throw new Error('Failed to fetch repositories')
      const data = await res.json()
      return data.repositories
    },
  })
}

export function useGitStatus(repoId: string, enabled = true) {
  return useQuery({
    queryKey: ['git', 'status', repoId],
    queryFn: async (): Promise<GitStatus> => {
      const res = await fetch(`${API_BASE}/status/${repoId}`)
      if (!res.ok) throw new Error('Failed to fetch status')
      return res.json()
    },
    enabled: enabled && !!repoId,
    refetchInterval: 5000,
  })
}

export function useGitBranches(repoId: string, enabled = true) {
  return useQuery({
    queryKey: ['git', 'branches', repoId],
    queryFn: async (): Promise<BranchInfo[]> => {
      const res = await fetch(`${API_BASE}/branches/${repoId}`)
      if (!res.ok) throw new Error('Failed to fetch branches')
      const data = await res.json()
      return data.branches
    },
    enabled: enabled && !!repoId,
  })
}

export function useGitFiles(repoId: string, path?: string, enabled = true) {
  return useQuery({
    queryKey: ['git', 'files', repoId, path],
    queryFn: async (): Promise<string[]> => {
      const url = path
        ? `${API_BASE}/files/${repoId}?path=${encodeURIComponent(path)}`
        : `${API_BASE}/files/${repoId}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to fetch files')
      const data = await res.json()
      return data.files
    },
    enabled: enabled && !!repoId,
  })
}

export function useGitSwitchBranch() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      repoId,
      branch,
    }: {
      repoId: string
      branch: string
    }) => {
      const res = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, branch }),
      })
      if (!res.ok) throw new Error('Failed to switch branch')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['git', 'status', variables.repoId],
      })
      queryClient.invalidateQueries({
        queryKey: ['git', 'branches', variables.repoId],
      })
    },
  })
}

export function useGitCommit() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      repoId,
      message,
      files,
    }: {
      repoId: string
      message: string
      files?: string[]
    }) => {
      const res = await fetch(`${API_BASE}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, message, files }),
      })
      if (!res.ok) throw new Error('Failed to commit')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['git', 'status', variables.repoId],
      })
      queryClient.invalidateQueries({ queryKey: ['git', 'repositories'] })
    },
  })
}

export function useGitPull() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ repoId }: { repoId: string }) => {
      const res = await fetch(`${API_BASE}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId }),
      })
      if (!res.ok) throw new Error('Failed to pull')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['git', 'status', variables.repoId],
      })
      queryClient.invalidateQueries({
        queryKey: ['git', 'branches', variables.repoId],
      })
    },
  })
}

export function useGitPush() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      repoId,
      branch,
    }: {
      repoId: string
      branch?: string
    }) => {
      const res = await fetch(`${API_BASE}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, branch }),
      })
      if (!res.ok) throw new Error('Failed to push')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['git', 'status', variables.repoId],
      })
      queryClient.invalidateQueries({
        queryKey: ['git', 'branches', variables.repoId],
      })
    },
  })
}

export function useGitCreateBranch() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      repoId,
      name,
      baseBranch,
    }: {
      repoId: string
      name: string
      baseBranch?: string
    }) => {
      const res = await fetch(`${API_BASE}/branch/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, name, baseBranch }),
      })
      if (!res.ok) throw new Error('Failed to create branch')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['git', 'branches', variables.repoId],
      })
      queryClient.invalidateQueries({
        queryKey: ['git', 'status', variables.repoId],
      })
    },
  })
}

export function useGitDeleteBranch() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      repoId,
      branch,
    }: {
      repoId: string
      branch: string
    }) => {
      const res = await fetch(`${API_BASE}/branch/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, branch }),
      })
      if (!res.ok) throw new Error('Failed to delete branch')
      return res.json()
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['git', 'branches', variables.repoId],
      })
    },
  })
}
