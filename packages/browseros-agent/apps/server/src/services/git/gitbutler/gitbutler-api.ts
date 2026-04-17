/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * GitButler API Integration
 * API fallback when CLI is unavailable
 */

import { GIT_CONSTANTS } from '@browseros/shared/constants/git'
import type { BranchInfo, CommitInfo, GitStatus } from '../git-repository'

export class GitButlerAPI {
  private baseUrl: string
  private available: boolean | null = null

  constructor(private port: number = GIT_CONSTANTS.GITBUTLER_API_PORT) {
    this.baseUrl = `http://localhost:${this.port}`
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      })
      this.available = res.ok
      return this.available
    } catch {
      this.available = false
      return false
    }
  }

  async getStatus(path: string): Promise<GitStatus> {
    const res = await fetch(`${this.baseUrl}/api/v1/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  }

  async getBranches(path: string): Promise<BranchInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    const data = await res.json()
    return data.branches || []
  }

  async switchBranch(path: string, branch: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, branch }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
  }

  async commit(path: string, message: string): Promise<CommitInfo> {
    const res = await fetch(`${this.baseUrl}/api/v1/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, message }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  }

  async pull(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
  }

  async push(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
  }

  async stage(path: string, files: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, files }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
  }

  async unstage(path: string, files: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/unstage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, files }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
  }

  async getFiles(path: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    const data = await res.json()
    return data.files || []
  }
}
