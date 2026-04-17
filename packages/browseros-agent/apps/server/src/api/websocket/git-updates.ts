/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 BrowserOS
 *
 * Git Updates WebSocket
 * Real-time Git status updates
 */

import type { GitOrchestrator } from '../../services/git/git-orchestrator'

interface GitUpdateClient {
  id: string
  repoIds: string[]
  send: (data: unknown) => void
}

export class GitUpdatesWebSocket {
  private clients: Map<string, GitUpdateClient> = new Map()
  private orchestrator: GitOrchestrator
  private interval: NodeJS.Timeout | null = null
  private clientIdCounter = 0

  constructor(orchestrator: GitOrchestrator) {
    this.orchestrator = orchestrator
  }

  start() {
    if (this.interval) return

    this.interval = setInterval(async () => {
      await this.broadcastUpdates()
    }, 5000)
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  addClient(repoIds: string[], send: (data: unknown) => void): string {
    const clientId = `client-${this.clientIdCounter++}`
    this.clients.set(clientId, { id: clientId, repoIds, send })
    return clientId
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId)
  }

  async broadcastUpdates() {
    const activeRepoIds = new Set<string>()
    this.clients.forEach((client) => {
      client.repoIds.forEach((id) => activeRepoIds.add(id))
    })

    if (activeRepoIds.size === 0) return

    const repos = await this.orchestrator.listRepositories()
    const repoMap = new Map(repos.map((r) => [r.id, r]))

    this.clients.forEach((client) => {
      const updates = client.repoIds
        .map((repoId) => repoMap.get(repoId))
        .filter(Boolean)

      if (updates.length > 0) {
        client.send({
          type: 'git-update',
          timestamp: Date.now(),
          repositories: updates,
        })
      }
    })
  }
}
