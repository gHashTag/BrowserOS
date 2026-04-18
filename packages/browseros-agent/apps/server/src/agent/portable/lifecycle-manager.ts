/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Browser } from '../../browser/browser'
import { logger } from '../../lib/logger'
import type { ToolRegistry } from '../../tools/tool-registry'
import { ConfigLoader } from './config-loader'
import type { AgentStatus, AgentStatusResponse } from './config-schema'
import { ErrorCode, PortableAgentError } from './errors'
import { PortableAgent, type PortableAgentDeps } from './portable-agent'

export interface StartAgentOptions {
  force?: boolean
}

export class LifecycleManager {
  private agents = new Map<string, PortableAgent>()

  constructor(
    private readonly browser: Browser,
    private readonly registry: ToolRegistry,
    private readonly deps: PortableAgentDeps,
  ) {}

  async startAgent(
    agentName: string,
    options: StartAgentOptions = {},
  ): Promise<PortableAgent> {
    const existing = this.agents.get(agentName)

    if (existing && !options.force) {
      throw new PortableAgentError(
        `Agent '${agentName}' is already running`,
        ErrorCode.AGENT_ALREADY_RUNNING,
        agentName,
      )
    }

    if (existing && options.force) {
      logger.info(`Force restarting agent '${agentName}'`)
      await this.stopAgent(agentName)
    }

    try {
      const config = ConfigLoader.loadAgentConfig(agentName)

      const agent = new PortableAgent(
        config,
        this.browser,
        this.registry,
        this.deps,
      )

      await agent.start()
      this.agents.set(agentName, agent)

      logger.info(`Agent '${agentName}' started and registered`, {
        totalAgents: this.agents.size,
      })

      return agent
    } catch (error) {
      if (error instanceof PortableAgentError) throw error

      throw new PortableAgentError(
        `Failed to start agent '${agentName}': ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.AGENT_START_FAILED,
        agentName,
      )
    }
  }

  async stopAgent(agentName: string, graceful = true): Promise<void> {
    const agent = this.agents.get(agentName)

    if (!agent) {
      throw new PortableAgentError(
        `Agent '${agentName}' not found`,
        ErrorCode.AGENT_NOT_FOUND,
        agentName,
      )
    }

    try {
      if (graceful) {
        logger.info(`Gracefully stopping agent '${agentName}'`)
        await agent.stop()
      } else {
        logger.info(`Force stopping agent '${agentName}'`)
        await agent.dispose()
      }

      this.agents.delete(agentName)
      logger.info(`Agent '${agentName}' removed from lifecycle`, {
        totalAgents: this.agents.size,
      })
    } catch (error) {
      throw new PortableAgentError(
        `Failed to stop agent '${agentName}': ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.AGENT_STOP_FAILED,
        agentName,
      )
    }
  }

  async restartAgent(agentName: string): Promise<PortableAgent> {
    logger.info(`Restarting agent '${agentName}'`)
    ConfigLoader.clearCache()

    const existing = this.agents.get(agentName)
    if (existing) {
      await this.stopAgent(agentName, true)
    }

    return this.startAgent(agentName, { force: true })
  }

  getAgent(agentName: string): PortableAgent | undefined {
    return this.agents.get(agentName)
  }

  getAgentStatus(agentName: string): AgentStatusResponse | null {
    const agent = this.agents.get(agentName)
    if (!agent) return null

    return agent.getStatus()
  }

  getAllAgentsStatus(): Map<string, AgentStatusResponse> {
    const statuses = new Map<string, AgentStatusResponse>()

    for (const [name, agent] of this.agents) {
      statuses.set(name, agent.getStatus())
    }

    return statuses
  }

  async stopAllAgents(graceful = true): Promise<void> {
    logger.info(`Stopping all ${this.agents.size} agents`)

    const stopPromises = Array.from(this.agents.entries()).map(
      async ([name]) => {
        try {
          await this.stopAgent(name, graceful)
        } catch (error) {
          logger.error(`Failed to stop agent '${name}'`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )

    await Promise.all(stopPromises)
    this.agents.clear()

    logger.info('All agents stopped')
  }

  size(): number {
    return this.agents.size
  }

  async reloadAgent(agentName: string): Promise<void> {
    logger.info(`Reloading agent '${agentName}' configuration`)
    ConfigLoader.clearCache()

    const existing = this.agents.get(agentName)
    if (existing) {
      await this.restartAgent(agentName)
    } else {
      throw new PortableAgentError(
        `Agent '${agentName}' is not running, cannot reload`,
        ErrorCode.AGENT_NOT_FOUND,
        agentName,
      )
    }
  }

  getAgentNames(): string[] {
    return Array.from(this.agents.keys())
  }
}
