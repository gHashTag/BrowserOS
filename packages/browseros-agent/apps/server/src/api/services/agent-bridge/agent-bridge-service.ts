/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ConfigLoader } from '../../../agent/portable/config-loader'
import type {
  AgentLogEntry,
  AgentStatusResponse,
  AgentTask,
} from '../../../agent/portable/config-schema'
import { ErrorCode, PortableAgentError } from '../../../agent/portable/errors'
import {
  LifecycleManager,
  type StartAgentOptions,
} from '../../../agent/portable/lifecycle-manager'
import type { Browser } from '../../../browser/browser'
import { logger } from '../../../lib/logger'
import type { ToolRegistry } from '../../../tools/tool-registry'

export interface AgentBridgeServiceConfig {
  browser: Browser
  registry: ToolRegistry
  triosId: string
  browserContext?: Record<string, unknown>
}

export class AgentBridgeService {
  private lifecycleManager: LifecycleManager

  constructor(config: AgentBridgeServiceConfig) {
    this.lifecycleManager = new LifecycleManager(
      config.browser,
      config.registry,
      {
        triosId: config.triosId,
        browserContext: config.browserContext,
      },
    )
  }

  async startAgent(
    name: string,
    options: StartAgentOptions = {},
  ): Promise<AgentStatusResponse> {
    logger.info(`Starting agent via bridge: ${name}`)
    const agent = await this.lifecycleManager.startAgent(name, options)
    return agent.getStatus()
  }

  async stopAgent(name: string, graceful = true): Promise<void> {
    logger.info(`Stopping agent via bridge: ${name}`)
    await this.lifecycleManager.stopAgent(name, graceful)
  }

  async restartAgent(name: string): Promise<AgentStatusResponse> {
    logger.info(`Restarting agent via bridge: ${name}`)
    const agent = await this.lifecycleManager.restartAgent(name)
    return agent.getStatus()
  }

  getAgentStatus(name: string): AgentStatusResponse | null {
    return this.lifecycleManager.getAgentStatus(name)
  }

  getAllAgentsStatus(): Map<string, AgentStatusResponse> {
    return this.lifecycleManager.getAllAgentsStatus()
  }

  async sendTask(
    name: string,
    task: AgentTask,
  ): Promise<ReadableStream<unknown>> {
    const agent = this.lifecycleManager.getAgent(name)

    if (!agent) {
      throw new PortableAgentError(
        `Agent '${name}' is not running`,
        ErrorCode.AGENT_NOT_FOUND,
        name,
      )
    }

    return agent.sendTask(task)
  }

  getAgentLogs(
    name: string,
    options: { tail?: number; since?: string } = {},
  ): AgentLogEntry[] {
    const agent = this.lifecycleManager.getAgent(name)

    if (!agent) {
      throw new PortableAgentError(
        `Agent '${name}' is not running`,
        ErrorCode.AGENT_NOT_FOUND,
        name,
      )
    }

    return agent.getLogs()
  }

  getAgentLogsStream(name: string): ReadableStream<AgentLogEntry> | null {
    const agent = this.lifecycleManager.getAgent(name)

    if (!agent) {
      throw new PortableAgentError(
        `Agent '${name}' is not running`,
        ErrorCode.AGENT_NOT_FOUND,
        name,
      )
    }

    return agent.getLogsStream()
  }

  async reloadAgent(name: string): Promise<void> {
    logger.info(`Reloading agent via bridge: ${name}`)
    await this.lifecycleManager.reloadAgent(name)
  }

  listConfigs(): Map<string, unknown> {
    const configs = ConfigLoader.loadAllConfigs()

    const result = new Map<string, unknown>()
    for (const [name, config] of configs) {
      result.set(name, {
        metadata: config.metadata,
        spec: {
          llm: {
            provider: config.spec.llm.provider,
            model: config.spec.llm.model,
          },
          tools: config.spec.tools,
          workspace: config.spec.workspace,
          limits: config.spec.limits,
        },
      })
    }

    return result
  }

  getConfig(name: string): unknown | null {
    try {
      const config = ConfigLoader.loadAgentConfig(name)
      return {
        metadata: config.metadata,
        spec: {
          llm: {
            provider: config.spec.llm.provider,
            model: config.spec.llm.model,
          },
          tools: config.spec.tools,
          workspace: config.spec.workspace,
          limits: config.spec.limits,
        },
      }
    } catch (error) {
      if (
        error instanceof PortableAgentError &&
        error.code === ErrorCode.CONFIG_NOT_FOUND
      ) {
        return null
      }
      throw error
    }
  }

  async saveConfig(
    name: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const { mkdirSync, writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const {
      AGENTS_DIR,
      AGENT_CONFIG_FILE,
    } = require('@trios/shared/constants/portable-agent')

    const agentDir = join(AGENTS_DIR, name)
    mkdirSync(agentDir, { recursive: true })

    const configPath = join(agentDir, AGENT_CONFIG_FILE)
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o644 })

    ConfigLoader.clearCache()
    logger.info(`Saved agent config for '${name}'`)
  }

  async deleteConfig(name: string): Promise<void> {
    const { rmSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    const { AGENTS_DIR } = require('@trios/shared/constants/portable-agent')

    const configPath = join(AGENTS_DIR, name)
    if (!existsSync(configPath)) {
      throw new PortableAgentError(
        `Agent config '${name}' not found`,
        ErrorCode.CONFIG_NOT_FOUND,
        name,
      )
    }

    rmSync(configPath, { recursive: true, force: true })
    ConfigLoader.clearCache()

    await this.lifecycleManager.stopAgent(name, false)

    logger.info(`Deleted agent config for '${name}'`)
  }

  async stopAllAgents(): Promise<void> {
    await this.lifecycleManager.stopAllAgents()
  }

  getActiveAgentCount(): number {
    return this.lifecycleManager.size()
  }

  getActiveAgentNames(): string[] {
    return this.lifecycleManager.getAgentNames()
  }
}
