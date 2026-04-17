import type { RelayObserverConfig } from '../../agent/portable/config-schema'
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Task Router
 * Routes portable agent tasks to appropriate handlers
 */

import { logger } from '../../lib/logger'
import type { Env, HttpServerConfig } from './types'
import { createPortableAgent } from '../../agent/portable/portable-agent'
import { PortableAgentConfig } from '../../agent/portable/config-schema'
import { RelayObserverConfig } from '../../agent/portable/config-schema'

export function createTaskRouter(deps: {
  port: number,
  browserosId: string,
}) {
  return {
    /**
     * Handle relay observer task creation
     */
    async createRelayObserver(
      conversationId: string,
      config: RelayObserverConfig,
    ): Promise<{ success: boolean; message: string }> {
      const agentConfig: PortableAgentConfig<Env> = {
        spec: {
          llm: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            apiKey: process.env.ANTHROPIC_API_KEY || '',
          },
          metadata: {
            displayName: 'A2A Relay Observer',
            description: 'Relays A2A WebSocket messages to BrowserOS chat',
          },
          browserContext: config.browserContext,
          origin: 'sidepanel',
          workingDir: config.workingDir,
          isScheduledTask: false,
          chatMode: false,
        },
      }

      const agent = await createPortableAgent({
        resolvedConfig: agentConfig,
        browser: deps.browser,
        registry: deps.registry,
        browserContext: deps.browserContext,
        browserosId: deps.browserosId,
        klavisClient: undefined,
      })

      await agent.start()

      return {
        success: true,
        message: 'A2A Relay Observer agent started',
      }
    },

    /**
     * Handle all portable agent task requests
     */
    async handlePortableTask(
      taskType: string,
      conversationId: string,
      config: any,
    ): Promise<{ success: boolean; message: string }> {
      const agentConfig: PortableAgentConfig<Env> = {
        spec: {
          llm: {
            provider: config.provider || 'anthropic',
            model: config.model || 'claude-sonnet-4-20250514',
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || '',
            baseUrl: config.baseUrl || 'https://api.anthropic.com',
          },
          metadata: {
            displayName: taskType,
            description: `Portable agent task: ${taskType}`,
          },
          browserContext: config.browserContext,
          origin: 'sidepanel',
          workingDir: config.workingDir,
          isScheduledTask: false,
          chatMode: false,
        },
      }

      const agent = await createPortableAgent({
        resolvedConfig: agentConfig,
        browser: deps.browser,
        registry: deps.registry,
        browserContext: deps.browserContext,
        browserosId: deps.browserosId,
        klavisClient: undefined,
      })

      await agent.start()

      return {
        success: true,
        message: `${taskType} agent started`,
      }
    },
  }
}
