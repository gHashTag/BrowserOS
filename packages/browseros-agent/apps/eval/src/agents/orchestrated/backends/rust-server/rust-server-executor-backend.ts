/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Executor backend that delegates to the Rust `trios-server` agent loop
 * (`POST /agent/run`). This is the thin-eval-harness endgame of the TS
 * retirement: no TS tool loop, no TS browser runtime — the eval harness
 * sends the instruction to the production Rust agent and maps the reply
 * back onto the eval `ExecutorResult` contract.
 */

import type { ResolvedAgentConfig } from '@browseros/agent-core/agent/types'
import {
  type TriosAgentRunResponse,
  TriosServerClient,
} from '@browseros/agent-core/lib/clients/trios-server'
import type {
  DelegationResult,
  ExecutorBackend,
  ExecutorCallbacks,
} from '../../executor-backend'

export interface RustServerExecutorBackendOptions {
  configTemplate: ResolvedAgentConfig
  /** Base URL of the Rust trios-server, e.g. `http://127.0.0.1:9105`. */
  serverUrl: string
  /** Browser agent id registered on the Rust side (host-cdp), if any. */
  browserAgentId?: string
  maxSteps?: number
  callbacks?: ExecutorCallbacks
  client?: TriosServerClient
}

/** Executes delegated goals through the Rust trios-server `/agent/run`. */
export class RustServerExecutorBackend implements ExecutorBackend {
  readonly kind = 'rust-server'
  private stepsUsed = 0
  private readonly client: TriosServerClient

  constructor(private readonly options: RustServerExecutorBackendOptions) {
    this.client =
      options.client ?? new TriosServerClient({ serverUrl: options.serverUrl })
  }

  async execute(
    instruction: string,
    signal?: AbortSignal,
  ): Promise<DelegationResult> {
    const cfg = this.options.configTemplate
    let response: TriosAgentRunResponse
    try {
      response = await this.client.runAgent(
        {
          prompt: instruction,
          system: cfg.userSystemPrompt,
          max_steps: this.options.maxSteps,
          provider:
            cfg.baseUrl && cfg.apiKey && cfg.model
              ? {
                  base_url: cfg.baseUrl,
                  api_key: cfg.apiKey,
                  model: cfg.model,
                }
              : undefined,
          browser_agent_id: this.options.browserAgentId,
          include_transcript: true,
        },
        signal,
      )
    } catch (error) {
      return {
        observation: `rust-server /agent/run failed: ${String(error)}`,
        status: 'blocked',
        url: '',
        actionsPerformed: 0,
        toolsUsed: [],
      }
    }

    this.stepsUsed += response.steps
    const toolsUsed = [
      ...new Set(
        (response.transcript ?? [])
          .map((entry) => entry.tool)
          .filter((tool): tool is string => typeof tool === 'string'),
      ),
    ]

    return {
      observation: response.finalText,
      status: response.stopReason === 'max_steps' ? 'timeout' : 'done',
      url: '',
      actionsPerformed: response.steps,
      toolsUsed,
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }

  getTotalSteps(): number {
    return this.stepsUsed
  }
}
