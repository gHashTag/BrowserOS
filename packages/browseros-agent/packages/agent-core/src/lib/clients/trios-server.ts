/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Thin typed client for the Rust `trios-server` agent surface
 * (`POST /agent/run`, `GET /agent/tools`).
 *
 * The TS tool-loop runtime is retired: the agent loop, tools registry and
 * browser transport now live in the Rust monorepo (gHashTag/trios,
 * `crates/trios-server` + `crates/trios-host-cdp`). What remains on the TS
 * side is evaluation — this client is the only bridge the eval harness
 * needs to run prompts through the production Rust agent.
 */

export interface TriosProviderConfig {
  base_url: string
  api_key: string
  model: string
}

export interface TriosAgentRunRequest {
  prompt: string
  system?: string
  max_steps?: number
  provider?: TriosProviderConfig
  browser_agent_id?: string
  include_transcript?: boolean
}

export interface TriosAgentUsage {
  input_tokens?: number
  output_tokens?: number
  [key: string]: unknown
}

export interface TriosTranscriptEntry {
  role?: string
  type?: string
  tool?: string
  [key: string]: unknown
}

export interface TriosAgentRunResponse {
  finalText: string
  steps: number
  stopReason: string
  model: string
  usage?: TriosAgentUsage
  transcript?: TriosTranscriptEntry[]
}

export interface TriosToolDefinition {
  name: string
  description?: string
  [key: string]: unknown
}

export class TriosServerError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`trios-server responded ${status}: ${body.slice(0, 300)}`)
    this.name = 'TriosServerError'
  }
}

export interface TriosServerClientOptions {
  /** Base URL of the Rust server, e.g. `http://127.0.0.1:9105`. */
  serverUrl: string
  /** Per-request timeout in milliseconds (default 300 000). */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class TriosServerClient {
  private readonly serverUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: TriosServerClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Run one agent task through the Rust tool-loop (`POST /agent/run`). */
  async runAgent(
    request: TriosAgentRunRequest,
    signal?: AbortSignal,
  ): Promise<TriosAgentRunResponse> {
    const body = await this.request('POST', '/agent/run', request, signal)
    return body as TriosAgentRunResponse
  }

  /** List the tools the Rust agent exposes (`GET /agent/tools`). */
  async listTools(signal?: AbortSignal): Promise<TriosToolDefinition[]> {
    const body = (await this.request(
      'GET',
      '/agent/tools',
      undefined,
      signal,
    )) as {
      tools?: TriosToolDefinition[]
    }
    return body.tools ?? []
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: combined,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new TriosServerError(response.status, text)
    }
    return text.length > 0 ? JSON.parse(text) : {}
  }
}
