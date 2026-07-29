/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Main orchestrator for OpenClaw integration.
 * Container lifecycle via the VM runtime, agent CRUD via in-container CLI,
 * chat via HTTP /v1/chat/completions proxy.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OPENCLAW_CONTAINER_HOME,
  OPENCLAW_GATEWAY_CONTAINER_PORT,
  OPENCLAW_IMAGE,
} from '@browseros/shared/constants/openclaw'
import { DEFAULT_PORTS } from '@browseros/shared/constants/ports'
import type { AgentStreamEvent } from '../../../lib/agents/types'
import { getOpenClawDir } from '../../../lib/browseros-dir'
import { logger } from '../../../lib/logger'
import { withProcessLock } from '../../../lib/process-lock'
import {
  type AgentLiveStatus,
  type AgentSessionState,
  ClawSession,
} from './claw-session'
import type {
  ContainerRuntime,
  GatewayContainerSpec,
} from './container-runtime'
import { buildContainerRuntime } from './container-runtime-factory'
import {
  OpenClawAgentAlreadyExistsError,
  OpenClawAgentNotFoundError,
  OpenClawInvalidAgentNameError,
  OpenClawProtectedAgentError,
} from './errors'
import {
  type OpenClawAgentRecord,
  OpenClawCliClient,
  type OpenClawConfigBatchEntry,
  type OpenClawSessionEntry,
} from './openclaw-cli-client'
import {
  buildOpenClawCliProviderModelRef,
  getOpenClawCliProvider,
  OPENCLAW_CLI_PROVIDERS,
} from './openclaw-cli-providers/registry'
import type {
  OpenClawCliProvider,
  OpenClawCliProviderAuthStatus,
} from './openclaw-cli-providers/types'
import {
  getHostWorkspaceDir,
  getOpenClawStateConfigPath,
  getOpenClawStateDir,
  getOpenClawStateEnvPath,
  mergeEnvContent,
} from './openclaw-env'
import {
  OpenClawHttpClient,
  type OpenClawSessionHistory,
  type OpenClawSessionHistoryEvent,
  type OpenClawSessionHistoryMessage,
} from './openclaw-http-client'
import {
  type ResolvedOpenClawProviderConfig,
  resolveSupportedOpenClawProvider,
} from './openclaw-provider-map'
import { allocateGatewayPort, readPersistedGatewayPort } from './runtime-state'

const READY_TIMEOUT_MS = 30_000
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const OPENCLAW_BROWSEROS_USER_SESSION_PATTERN =
  /^agent:[^:]+:openai-user:browseros:[^:]+:(.+)$/

export type OpenClawControlPlaneStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  // Retained for extension compatibility while the UI still branches on it.
  | 'recovering'
  | 'failed'

export type OpenClawGatewayRecoveryReason =
  // Retained for extension compatibility while the UI still renders these reasons.
  | 'transient_disconnect'
  | 'signature_expired'
  | 'pairing_required'
  | 'token_mismatch'
  | 'container_not_ready'
  | 'unknown'

export type OpenClawStatus =
  | 'uninitialized'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error'

export interface OpenClawStatusResponse {
  status: OpenClawStatus
  podmanAvailable: boolean
  machineReady: boolean
  port: number | null
  agentCount: number
  error: string | null
  controlPlaneStatus: OpenClawControlPlaneStatus
  lastGatewayError: string | null
  lastRecoveryReason: OpenClawGatewayRecoveryReason | null
}

export type OpenClawAgentEntry = OpenClawAgentRecord

export interface SetupInput {
  providerType?: string
  providerName?: string
  baseUrl?: string
  apiKey?: string
  modelId?: string
  // The agent UI's "Supports Image" flag (LlmProviderConfig.supportsImages).
  // Pass-through to provider-map so custom OpenAI-compat providers can
  // advertise `input: ['text', 'image']` on their model entries when the
  // user asserted vision support.
  supportsImages?: boolean
}

export interface OpenClawProviderUpdateResult {
  restarted: boolean
  modelUpdated: boolean
}

export interface OpenClawServiceConfig {
  browserosServerPort?: number
  resourcesDir?: string
  browserosDir?: string
}

export type OpenClawSessionSource =
  | 'user-chat'
  | 'cron'
  | 'hook'
  | 'channel'
  | 'other'

export interface BrowserOSOpenClawSession {
  key: string
  updatedAt: number
  sessionId: string
  agentId: string
  kind: string
  source: OpenClawSessionSource
  status?: string
  totalTokens?: number
  model?: string
  modelProvider?: string
}

export interface BrowserOSOpenClawAgentSessionResponse {
  agentId: string
  exists: boolean
  sessionKey: string | null
  session: BrowserOSOpenClawSession | null
}

export interface BrowserOSChatHistoryToolCall {
  toolCallId?: string
  toolName: string
  label: string
  subject?: string
  status: 'completed' | 'failed'
  input?: Record<string, unknown>
  output?: string
  error?: string
  durationMs?: number
}

export interface BrowserOSChatHistoryReasoning {
  text: string
  durationMs?: number
}

export interface BrowserOSChatHistoryAttachment {
  kind: 'image' | 'file'
  mediaType: string
  // Images carry the full data: URL so the client can render directly.
  // Files (text / pdf / etc) currently round-trip via inline text in the
  // message body and don't reach this field — kept on the type for v2.
  dataUrl?: string
  name?: string
}

export interface BrowserOSChatHistoryItem {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp?: number
  messageSeq: number
  sessionKey: string
  source: OpenClawSessionSource
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  toolCalls?: BrowserOSChatHistoryToolCall[]
  reasoning?: BrowserOSChatHistoryReasoning
  attachments?: BrowserOSChatHistoryAttachment[]
}

export function normalizeBrowserOSChatSessionKey(
  agentId: string,
  sessionKey: string,
): string {
  const trimmed = sessionKey.trim()
  if (!trimmed) return trimmed

  let normalized = trimmed
  const agentSpecificPrefix = getOpenClawBrowserOSSessionPrefix(agentId)

  while (normalized.startsWith(agentSpecificPrefix)) {
    normalized = normalized.slice(agentSpecificPrefix.length)
  }

  while (true) {
    const match = normalized.match(OPENCLAW_BROWSEROS_USER_SESSION_PATTERN)
    if (!match?.[1]) break
    normalized = match[1]
  }

  return normalized.trim() || trimmed
}

function getOpenClawBrowserOSSessionPrefix(agentId: string): string {
  return `agent:${agentId}:openai-user:browseros:${agentId}:`
}

const MAIN_SESSION_KEY_PATTERN = /^agent:([^:]+):main$/

/**
 * Extract the agent id from a main-session key (e.g. `agent:research:main`
 * → `research`). Returns null when the key isn't a top-level main session,
 * which signals the caller to use the per-session fetch path.
 */
function extractAgentIdFromMainSessionKey(sessionKey: string): string | null {
  const match = MAIN_SESSION_KEY_PATTERN.exec(sessionKey)
  return match?.[1] ?? null
}

/**
 * Classify a session key by its source. The pattern is `agent:<id>:<kind>:...`;
 * the third segment identifies how the session was started.
 */
function parseSessionSource(
  sessionKey: string,
): NonNullable<OpenClawSessionHistoryMessage['source']> {
  const parts = sessionKey.split(':')
  if (parts[0] !== 'agent' || parts.length < 3) return 'other'
  switch (parts[2]) {
    case 'main':
      return 'main'
    case 'cron':
      return 'cron'
    case 'hook':
      return 'hook'
    case 'channel':
      return 'channel'
    default:
      return 'other'
  }
}

/**
 * Per-session monotonic sequence. Gateway encodes it inside the
 * `__openclaw` extension envelope; the legacy top-level `messageSeq`
 * field exists in the type but is rarely populated.
 */
function resolveMessageSeq(msg: OpenClawSessionHistoryMessage): number | null {
  const fromEnvelope = msg.__openclaw?.seq
  if (typeof fromEnvelope === 'number' && Number.isFinite(fromEnvelope)) {
    return fromEnvelope
  }
  if (typeof msg.messageSeq === 'number' && Number.isFinite(msg.messageSeq)) {
    return msg.messageSeq
  }
  return null
}

/**
 * Stable chronological order across sessions. Falls back to seq
 * when timestamps tie or are missing, preserving intra-session order.
 */
function compareMessageOrder(
  a: OpenClawSessionHistoryMessage,
  b: OpenClawSessionHistoryMessage,
): number {
  const aTs = a.timestamp ?? 0
  const bTs = b.timestamp ?? 0
  if (aTs !== bTs) return aTs - bTs
  return (resolveMessageSeq(a) ?? 0) - (resolveMessageSeq(b) ?? 0)
}

/**
 * Compound cursor for the aggregated history endpoint. Maps each
 * session key to either:
 *   - a `messageSeq` to fetch BEFORE on the next page (more historical),
 *   - or `null` meaning the session is exhausted and should be skipped.
 *
 * Encoded as base64url JSON for URL-safe transport in `?cursor=`.
 */
type CompoundCursor = Record<string, number | null>

function decodeCompoundCursor(encoded: string | undefined): CompoundCursor {
  if (!encoded) return {}
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: CompoundCursor = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' || v === null) out[k] = v
      }
      return out
    }
  } catch {
    // Malformed cursors are treated as "first page" — preferable to
    // erroring out the entire history fetch on a bad client cursor.
  }
  return {}
}

function encodeCompoundCursor(cursor: CompoundCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export interface AgentOverview {
  agentId: string
  status: AgentLiveStatus
  latestMessage: string | null
  latestMessageAt: number | null
  activitySummary: string | null
  currentTool: string | null
  totalCostUsd: number
  sessionCount: number
}

export interface DashboardResponse {
  agents: AgentOverview[]
  summary: {
    totalAgents: number
    totalCostUsd: number
  }
}

export class OpenClawService {
  private runtime: ContainerRuntime
  private cliClient: OpenClawCliClient
  private bootstrapCliClient: OpenClawCliClient
  private httpClient: OpenClawHttpClient
  private openclawDir: string
  private hostPort = OPENCLAW_GATEWAY_CONTAINER_PORT
  private lastError: string | null = null
  private browserosServerPort: number
  private resourcesDir: string | null
  private browserosDir: string | undefined
  private controlPlaneStatus: OpenClawControlPlaneStatus = 'disconnected'
  private lastGatewayError: string | null = null
  private lastRecoveryReason: OpenClawGatewayRecoveryReason | null = null
  private stopLogTail: (() => void) | null = null
  private lifecycleLock: Promise<void> = Promise.resolve()
  private clawSession = new ClawSession()

  constructor(config: OpenClawServiceConfig = {}) {
    this.openclawDir = getOpenClawDir()
    this.runtime = buildContainerRuntime({
      resourcesDir: config.resourcesDir,
      projectDir: this.openclawDir,
      browserosRoot: config.browserosDir,
    })
    this.cliClient = new OpenClawCliClient(this.runtime)
    this.bootstrapCliClient = this.buildBootstrapCliClient()
    this.httpClient = new OpenClawHttpClient(this.hostPort)
    this.browserosServerPort =
      config.browserosServerPort ?? DEFAULT_PORTS.server
    this.resourcesDir = config.resourcesDir ?? null
    this.browserosDir = config.browserosDir
  }

  configure(config: OpenClawServiceConfig): void {
    if (config.browserosServerPort !== undefined) {
      this.browserosServerPort = config.browserosServerPort
    }

    let runtimeChanged = false
    if (
      config.resourcesDir !== undefined &&
      config.resourcesDir !== this.resourcesDir
    ) {
      this.resourcesDir = config.resourcesDir
      runtimeChanged = true
    }
    if (
      config.browserosDir !== undefined &&
      config.browserosDir !== this.browserosDir
    ) {
      this.browserosDir = config.browserosDir
      runtimeChanged = true
    }
    if (runtimeChanged) {
      this.rebuildRuntimeClients()
    }
  }

  getPort(): number {
    return this.hostPort
  }

  /** Subscribe to real-time agent status changes from the ClawSession state machine. */
  onAgentStatusChange(
    listener: (agentId: string, state: AgentSessionState) => void,
  ): () => void {
    return this.clawSession.onStateChange(listener)
  }

  /** Read the current ClawSession state for an agent (read-only snapshot). */
  getAgentState(agentId: string): AgentSessionState {
    return this.clawSession.getState(agentId)
  }

  /**
   * Drive the live-status state machine from a turn lifecycle event the
   * AgentHarnessService observed. Replaces the previous WS observer
   * pipeline that re-tapped the same gateway events; the harness already
   * sees them as ACP `session/update` notifications, so we forward those
   * here. Caller passes the stream events verbatim.
   *
   * `tool_call` and `tool_call_update` populate `currentTool` so the
   * dashboard SSE keeps its existing payload shape. `done` clears
   * working state to `idle`; `error` keeps a sticky error badge.
   */
  recordAgentTurnEvent(
    agentId: string,
    sessionKey: string,
    event:
      | { type: 'turn_started' }
      | { type: 'turn_event'; event: AgentStreamEvent }
      | { type: 'turn_ended'; error?: string },
  ): void {
    if (event.type === 'turn_started') {
      this.clawSession.transition(agentId, 'working', { sessionKey })
      return
    }
    if (event.type === 'turn_ended') {
      if (event.error !== undefined) {
        this.clawSession.transition(agentId, 'error', {
          sessionKey,
          error: event.error,
        })
      } else {
        this.clawSession.transition(agentId, 'idle', { sessionKey })
      }
      return
    }
    const inner = event.event
    if (inner.type === 'tool_call') {
      this.clawSession.transition(agentId, 'working', {
        sessionKey,
        currentTool: inner.title ?? null,
      })
      return
    }
    if (inner.type === 'error') {
      this.clawSession.transition(agentId, 'error', {
        sessionKey,
        error: inner.message,
      })
      return
    }
    if (inner.type === 'done') {
      this.clawSession.transition(agentId, 'idle', { sessionKey })
      return
    }
    if (inner.type === 'text_delta') {
      // Heartbeat — keep the existing `working` row fresh; preserve
      // the last-known currentTool by passing it through.
      const prev = this.clawSession.getState(agentId)
      this.clawSession.transition(agentId, 'working', {
        sessionKey,
        currentTool: prev.currentTool,
      })
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Warm the VM and gateway image so later setup/start avoids registry work. */
  async prewarm(onLog?: (msg: string) => void): Promise<void> {
    return this.withLifecycleLock('prewarm', async () => {
      const imageRef = process.env.OPENCLAW_IMAGE?.trim() || OPENCLAW_IMAGE
      const logProgress = (message: string) => {
        // Startup prewarm runs outside a user request, so keep phase logs visible without streaming command progress.
        logger.info(message)
        onLog?.(message)
      }
      logProgress('OpenClaw prewarm: ensuring BrowserOS VM is ready')
      await this.runtime.ensureReady()
      logProgress(`OpenClaw prewarm: ensuring image ${imageRef} is available`)
      await this.runtime.prewarmGatewayImage()
      logProgress('OpenClaw prewarm: ready')
    })
  }

  async setup(input: SetupInput, onLog?: (msg: string) => void): Promise<void> {
    return this.withLifecycleLock('setup', async () => {
      const logProgress = this.createProgressLogger(onLog)
      const provider = this.resolveProviderForAgent(input)
      logger.info('Starting OpenClaw setup', {
        hostPort: this.hostPort,
        browserosServerPort: this.browserosServerPort,
        providerType: input.providerType,
        providerName: input.providerName,
        hasBaseUrl: !!input.baseUrl,
        hasModel: !!input.modelId,
        hasApiKey: !!input.apiKey,
      })

      await this.runtime.ensureReady(logProgress)
      logProgress('Container runtime ready')

      await mkdir(this.openclawDir, { recursive: true })
      await mkdir(this.getStateDir(), { recursive: true })
      await mkdir(this.getHostWorkspaceDir('main'), { recursive: true })

      await this.ensureStateEnvFile()
      await this.writeStateEnv(provider.envValues)
      logger.info('Updated OpenClaw state env', {
        providerKeyCount: Object.keys(provider.envValues).length,
      })

      await this.ensureGatewayPortAllocated(logProgress)

      logProgress('Bootstrapping OpenClaw config...')
      await this.bootstrapCliClient.runOnboard({
        acceptRisk: true,
        authChoice: 'skip',
        gatewayAuth: 'none',
        gatewayBind: 'lan',
        gatewayPort: OPENCLAW_GATEWAY_CONTAINER_PORT,
        installDaemon: false,
        mode: 'local',
        nonInteractive: true,
        skipHealth: true,
      })
      await this.applyBrowserosConfig()
      await this.mergeProviderConfigIfChanged(provider)
      if (provider.model) {
        await this.bootstrapCliClient.setDefaultModel(provider.model)
      }

      logProgress('Validating OpenClaw config...')
      await this.assertConfigValid(this.bootstrapCliClient)

      logProgress('Starting OpenClaw gateway...')
      await this.runtime.startGateway(
        this.buildGatewayRuntimeSpec(),
        logProgress,
      )
      this.startGatewayLogTail()
      logProgress('Waiting for gateway readiness...')
      const ready = await this.runtime.waitForReady(
        this.hostPort,
        READY_TIMEOUT_MS,
      )
      if (!ready) {
        this.lastError = 'Gateway did not become ready within 30 seconds'
        const logs = await this.runtime.getGatewayLogs()
        logger.error('Gateway readiness check failed', { logs })
        throw new Error(this.lastError)
      }

      this.controlPlaneStatus = 'connecting'
      logProgress('Probing OpenClaw control plane...')
      await this.runControlPlaneCall(() => this.cliClient.probe())

      await this.ensureAllCliProvidersInstalled(logProgress)

      const existingAgents = await this.listAgents()
      logger.info('Fetched existing OpenClaw agents after setup', {
        count: existingAgents.length,
        names: existingAgents.map((agent) => agent.name),
      })
      if (existingAgents.some((agent) => agent.agentId === 'main')) {
        logProgress('Main agent detected')
      } else {
        logProgress('Creating main agent...')
        await this.runControlPlaneCall(() =>
          this.cliClient.createAgent({
            name: 'main',
            model: provider.model,
          }),
        )
      }

      this.lastError = null
      logProgress(
        `OpenClaw gateway running at http://127.0.0.1:${this.hostPort}`,
      )
      logger.info('OpenClaw setup complete', { hostPort: this.hostPort })
    })
  }

  async start(onLog?: (msg: string) => void): Promise<void> {
    return this.withLifecycleLock('start', async () => {
      const logProgress = this.createProgressLogger(onLog)
      logger.info('Starting OpenClaw service', {
        hostPort: this.hostPort,
      })

      await this.runtime.ensureReady(logProgress)

      await this.ensureStateEnvFile()

      await this.ensureGatewayPortAllocated(logProgress)

      if (await this.isCurrentGatewayAvailable(this.hostPort)) {
        this.startGatewayLogTail()
        this.controlPlaneStatus = 'connecting'
        logProgress('Probing OpenClaw control plane...')
        try {
          await this.runControlPlaneCall(() => this.cliClient.probe())
          this.lastError = null
          logger.info('OpenClaw gateway already running', {
            hostPort: this.hostPort,
          })
          return
        } catch (error) {
          logger.warn('OpenClaw control plane probe failed during start', {
            hostPort: this.hostPort,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      logProgress('Starting OpenClaw gateway...')
      await this.runtime.startGateway(
        this.buildGatewayRuntimeSpec(),
        logProgress,
      )
      this.startGatewayLogTail()

      logProgress('Waiting for gateway readiness...')
      const ready = await this.runtime.waitForReady(
        this.hostPort,
        READY_TIMEOUT_MS,
      )
      if (!ready) {
        this.lastError = 'Gateway did not become ready after start'
        throw new Error(this.lastError)
      }

      this.controlPlaneStatus = 'connecting'
      logProgress('Probing OpenClaw control plane...')
      await this.runControlPlaneCall(() => this.cliClient.probe())
      await this.ensureAllCliProvidersInstalled(logProgress)
      this.lastError = null
      logger.info('OpenClaw gateway started', { hostPort: this.hostPort })
    })
  }

  async stop(): Promise<void> {
    return this.withLifecycleLock('stop', async () => {
      logger.info('Stopping OpenClaw service', { hostPort: this.hostPort })
      this.controlPlaneStatus = 'disconnected'
      this.stopGatewayLogTail()
      await this.runtime.stopGateway()
      logger.info('OpenClaw container stopped')
    })
  }

  async restart(onLog?: (msg: string) => void): Promise<void> {
    return this.withLifecycleLock('restart', async () => {
      const logProgress = this.createProgressLogger(onLog)
      logger.info('Restarting OpenClaw service', {
        hostPort: this.hostPort,
      })

      this.controlPlaneStatus = 'reconnecting'
      await this.runtime.ensureReady(logProgress)
      this.stopGatewayLogTail()
      await this.ensureStateEnvFile()
      await this.ensureGatewayPortAllocated(logProgress)
      logProgress('Restarting OpenClaw gateway...')
      await this.runtime.restartGateway(
        this.buildGatewayRuntimeSpec(),
        logProgress,
      )
      this.startGatewayLogTail()

      logProgress('Waiting for gateway readiness...')
      const ready = await this.runtime.waitForReady(
        this.hostPort,
        READY_TIMEOUT_MS,
      )
      if (!ready) {
        this.lastError = 'Gateway did not become ready after restart'
        throw new Error(this.lastError)
      }

      logProgress('Probing OpenClaw control plane...')
      await this.runControlPlaneCall(() => this.cliClient.probe())
      await this.ensureAllCliProvidersInstalled(logProgress)
      this.lastError = null
      logProgress('Gateway restarted successfully')
      logger.info('OpenClaw gateway restarted', { hostPort: this.hostPort })
    })
  }

  async reconnectControlPlane(onLog?: (msg: string) => void): Promise<void> {
    return this.withLifecycleLock('reconnect', async () => {
      const logProgress = this.createProgressLogger(onLog)
      logger.info('Reconnecting OpenClaw control plane', {
        hostPort: this.hostPort,
      })

      logProgress('Checking gateway readiness...')
      const ready = await this.runtime.isReady(this.hostPort)
      if (!ready) {
        this.controlPlaneStatus = 'failed'
        this.lastGatewayError = 'OpenClaw gateway is not ready'
        this.lastRecoveryReason = 'container_not_ready'
        throw new Error('OpenClaw gateway is not ready')
      }

      this.controlPlaneStatus = 'reconnecting'
      logProgress('Reconnecting control plane...')
      await this.runControlPlaneCall(() => this.cliClient.probe())
      logProgress('Control plane connected')
    })
  }

  async shutdown(): Promise<void> {
    this.controlPlaneStatus = 'disconnected'
    this.stopGatewayLogTail()
    try {
      await this.runtime.stopGateway()
    } catch {
      // Best effort during shutdown
    }
    await this.runtime.stopVm()
    logger.info('OpenClaw shutdown complete')
  }

  // ── Status ───────────────────────────────────────────────────────────

  async getStatus(): Promise<OpenClawStatusResponse> {
    const isSetUp = existsSync(this.getStateConfigPath())
    if (!isSetUp) {
      const machineStatus = await this.runtime.getMachineStatus()
      return {
        status: 'uninitialized',
        podmanAvailable: true,
        machineReady: machineStatus.running,
        port: null,
        agentCount: 0,
        error: null,
        controlPlaneStatus: 'disconnected',
        lastGatewayError: this.lastGatewayError,
        lastRecoveryReason: this.lastRecoveryReason,
      }
    }

    const machineStatus = await this.runtime.getMachineStatus()
    const ready = machineStatus.running
      ? await this.runtime.isReady(this.hostPort)
      : false

    let agentCount = 0
    if (ready) {
      try {
        const agents = await this.runControlPlaneCall(() =>
          this.cliClient.listAgents(),
        )
        agentCount = agents.length
      } catch {
        // latest control plane error is captured by runControlPlaneCall
      }
    }

    return {
      status: ready ? 'running' : this.lastError ? 'error' : 'stopped',
      podmanAvailable: true,
      machineReady: machineStatus.running,
      port: this.hostPort,
      agentCount,
      error: this.lastError,
      controlPlaneStatus: ready ? this.controlPlaneStatus : 'disconnected',
      lastGatewayError: this.lastGatewayError,
      lastRecoveryReason: this.lastRecoveryReason,
    }
  }

  // ── Agent Management (via CLI) ──────────────────────────────────────

  async createAgent(input: {
    name: string
    providerType?: string
    providerName?: string
    baseUrl?: string
    apiKey?: string
    modelId?: string
    supportsImages?: boolean
  }): Promise<OpenClawAgentEntry> {
    const { name } = input
    if (!AGENT_NAME_PATTERN.test(name)) {
      throw new OpenClawInvalidAgentNameError()
    }

    logger.debug('Creating OpenClaw agent', {
      name,
      providerType: input.providerType,
      providerName: input.providerName,
      hasBaseUrl: !!input.baseUrl,
      hasModel: !!input.modelId,
      hasApiKey: !!input.apiKey,
      supportsImages: !!input.supportsImages,
    })
    await this.assertGatewayReady()

    const provider = this.resolveProviderForAgent(input)
    const configChanged = await this.mergeProviderConfigIfChanged(provider)
    const keysChanged = await this.writeStateEnv(provider.envValues)

    if (configChanged || keysChanged) {
      logger.info('OpenClaw provider config changed while creating agent', {
        name,
        configChanged,
        keysChanged,
      })
      await this.restart()
    }

    const model = provider.model
    let agent: OpenClawAgentRecord
    try {
      agent = await this.runControlPlaneCall(() =>
        this.cliClient.createAgent({
          name,
          model,
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('already exists')) {
        throw new OpenClawAgentAlreadyExistsError(name)
      }
      throw error
    }

    logger.info('Agent created via CLI', {
      agentId: agent.agentId,
      providerType: input.providerType,
    })
    return agent
  }

  async removeAgent(agentId: string): Promise<void> {
    logger.info('Removing OpenClaw agent', { agentId })
    if (agentId === 'main') {
      throw new OpenClawProtectedAgentError('Cannot delete the main agent')
    }

    await this.assertGatewayReady()
    try {
      await this.runControlPlaneCall(() => this.cliClient.deleteAgent(agentId))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('not found')) {
        throw new OpenClawAgentNotFoundError(agentId)
      }
      throw error
    }
    logger.info('Agent removed via CLI', { agentId })
  }

  async listAgents(): Promise<OpenClawAgentEntry[]> {
    await this.assertGatewayReady()
    logger.debug('Listing OpenClaw agents')
    return this.runControlPlaneCall(() => this.cliClient.listAgents())
  }

  // ── Dashboard ──────────────────────────────────────────────────────

  /**
   * Reports the live status of every agent the in-memory `ClawSession`
   * knows about. Pre-Step-11 the dashboard also surfaced JSONL-derived
   * stats (latest message, per-session cost, activity summary) that
   * went away with `OpenClawJsonlReader`. Those fields are filled with
   * null/0 placeholders until a harness-side equivalent ships;
   * `status`/`currentTool` still reflect real-time observer state.
   */
  getDashboard(): DashboardResponse {
    const states = this.clawSession.getAllStates()
    const agentOverviews: AgentOverview[] = []
    for (const [agentId, liveStatus] of states) {
      agentOverviews.push({
        agentId,
        status: liveStatus.status,
        latestMessage: null,
        latestMessageAt: liveStatus.lastEventAt || null,
        activitySummary: null,
        currentTool: liveStatus.currentTool,
        totalCostUsd: 0,
        sessionCount: 0,
      })
    }
    return {
      agents: agentOverviews,
      summary: { totalAgents: agentOverviews.length, totalCostUsd: 0 },
    }
  }

  // ── Session History (HTTP) ───────────────────────────────────────────

  async getSessionHistory(
    sessionKey: string,
    input: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<OpenClawSessionHistory> {
    await this.assertGatewayReady()
    return this.runControlPlaneCall(async () => {
      const agentId = extractAgentIdFromMainSessionKey(sessionKey)
      if (!agentId) {
        return this.httpClient.getSessionHistory(sessionKey, input)
      }
      return this.fetchAggregatedAgentHistory(sessionKey, agentId, input)
    })
  }

  /**
   * Aggregates the agent's main session and every sub-session (cron,
   * hook, channel) into a single chronological response. The main
   * session's own messages are included; each sub-session's messages
   * are tagged with `source` and `subSessionKey` so the UI can
   * distinguish autonomous turns from user-driven turns.
   *
   * Pagination uses a compound cursor that encodes a per-session seq
   * for each session in scope (`{<sessionKey>: seq | null}`). Each page
   * fetches each non-exhausted session with its own per-session cursor,
   * merges messages across sessions by timestamp, slices to `limit`,
   * and emits a fresh compound cursor reflecting where each session
   * should resume on the next page. A session with `null` in the
   * cursor is exhausted and skipped.
   *
   * Sub-session fetches that fail are logged and dropped — partial
   * timelines are preferable to a hard failure that hides the main
   * session.
   */
  private async fetchAggregatedAgentHistory(
    mainSessionKey: string,
    agentId: string,
    input: { limit?: number; cursor?: string; signal?: AbortSignal },
  ): Promise<OpenClawSessionHistory> {
    const compoundIn = decodeCompoundCursor(input.cursor)
    const sessions = await this.cliClient
      .listSessions(agentId)
      .catch((err): OpenClawSessionEntry[] => {
        logger.warn(
          'Failed to list OpenClaw sub-sessions; falling back to main only',
          { agentId, error: err instanceof Error ? err.message : String(err) },
        )
        return []
      })

    // Build the candidate set from the agent's session directory plus
    // the main key (which may not appear in `sessions.list` if the file
    // hasn't been written yet for a fresh agent).
    const targetKeys = new Set<string>([mainSessionKey])
    for (const entry of sessions) {
      if (entry.key?.startsWith(`agent:${agentId}:`)) {
        targetKeys.add(entry.key)
      }
    }

    // Only fetch sessions that aren't exhausted by the inbound cursor.
    // A session with `null` in the cursor is fully read; skip it on
    // subsequent pages.
    const activeKeys = Array.from(targetKeys).filter(
      (k) => compoundIn[k] !== null,
    )

    const fetchedHistories = await Promise.all(
      activeKeys.map(async (key) => {
        const sessionCursor = compoundIn[key]
        try {
          const history = await this.httpClient.getSessionHistory(key, {
            limit: input.limit,
            cursor:
              typeof sessionCursor === 'number'
                ? String(sessionCursor)
                : undefined,
            signal: input.signal,
          })
          return { key, history }
        } catch (err) {
          logger.warn('Failed to fetch OpenClaw sub-session history', {
            sessionKey: key,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      }),
    )

    type Annotated = OpenClawSessionHistoryMessage & { __sessionKey: string }
    const merged: Annotated[] = []
    let truncated = false
    for (const result of fetchedHistories) {
      if (!result) continue
      const source = parseSessionSource(result.key)
      const isMain = result.key === mainSessionKey
      for (const msg of result.history.messages) {
        merged.push({
          ...msg,
          source,
          ...(isMain ? {} : { subSessionKey: result.key }),
          __sessionKey: result.key,
        })
      }
      if (result.history.truncated) truncated = true
    }

    merged.sort(compareMessageOrder)

    // The merged window contains the latest portion fetched. We emit
    // up to `limit` messages from the END (newest), and compute the
    // resume position for each session as the seq of the EARLIEST
    // emitted message that came from that session.
    const limited =
      typeof input.limit === 'number' && input.limit > 0
        ? merged.slice(-input.limit)
        : merged

    const compoundOut: CompoundCursor = {}
    // Carry forward exhausted sessions so subsequent pages keep skipping them.
    for (const key of Array.from(targetKeys)) {
      if (compoundIn[key] === null) {
        compoundOut[key] = null
      }
    }
    for (const result of fetchedHistories) {
      if (!result) continue
      const key = result.key
      const earliestEmitted = limited.find((m) => m.__sessionKey === key)
      const sessionFetchHasMore = Boolean(result.history.hasMore)
      const droppedFromMerge =
        result.history.messages.length >
        limited.filter((m) => m.__sessionKey === key).length
      const sessionHasMore = sessionFetchHasMore || droppedFromMerge
      if (!sessionHasMore) {
        compoundOut[key] = null
        continue
      }
      const seq = earliestEmitted ? resolveMessageSeq(earliestEmitted) : null
      compoundOut[key] = seq
    }

    const hasMore = Object.values(compoundOut).some(
      (v) => typeof v === 'number',
    )
    const messages = limited.map(({ __sessionKey: _drop, ...rest }) => rest)

    return {
      sessionKey: mainSessionKey,
      messages,
      cursor: hasMore ? encodeCompoundCursor(compoundOut) : null,
      hasMore,
      truncated: truncated || limited.length < merged.length,
    }
  }

  async streamSessionHistory(
    sessionKey: string,
    input: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ReadableStream<OpenClawSessionHistoryEvent>> {
    await this.assertGatewayReady()
    return this.runControlPlaneCall(() =>
      this.httpClient.streamSessionHistory(sessionKey, input),
    )
  }

  // ── Provider Keys ────────────────────────────────────────────────────
  async updateProviderKeys(input: {
    providerType: string
    providerName?: string
    baseUrl?: string
    apiKey: string
    modelId?: string
  }): Promise<OpenClawProviderUpdateResult> {
    const provider = this.resolveProviderForAgent(input)
    const configChanged = await this.mergeProviderConfigIfChanged(provider)
    const envChanged = await this.writeStateEnv(provider.envValues)
    const restarted = configChanged || envChanged
    if (restarted) {
      await this.restart()
    }
    if (provider.model) {
      const model = provider.model
      await this.applyCliMutation(() => this.cliClient.setDefaultModel(model))
    }
    logger.info('Provider keys updated', {
      providerType: input.providerType,
      modelUpdated: !!provider.model,
      restarted,
    })
    return {
      restarted,
      modelUpdated: !!provider.model,
    }
  }

  // ── CLI-backed Providers ─────────────────────────────────────────────

  async getCliProviderAuthStatus(
    provider: OpenClawCliProvider,
  ): Promise<OpenClawCliProviderAuthStatus> {
    const { stdout, exitCode } = await this.runtime.runInContainer(
      provider.authStatusCommand,
    )
    return provider.parseAuthStatus(stdout, exitCode)
  }

  // ── Logs ─────────────────────────────────────────────────────────────

  async getLogs(tail = 100): Promise<string[]> {
    logger.debug('Fetching OpenClaw container logs', { tail })
    return this.runtime.getGatewayLogs(tail)
  }

  // ── Auto-start on BrowserOS boot ────────────────────────────────────

  async tryAutoStart(): Promise<void> {
    return this.withLifecycleLock('auto-start', async () => {
      const isSetUp = existsSync(this.getStateConfigPath())
      if (!isSetUp) return

      logger.info('Attempting OpenClaw auto-start', {
        hostPort: this.hostPort,
      })

      try {
        await this.runtime.ensureReady()

        await this.ensureStateEnvFile()

        const persistedPort = await readPersistedGatewayPort(this.openclawDir)
        if (persistedPort !== null) {
          this.setPort(persistedPort)
        }

        if (!(await this.isCurrentGatewayAvailable(this.hostPort))) {
          await this.ensureGatewayPortAllocated()
          await this.runtime.startGateway(this.buildGatewayRuntimeSpec())
          const ready = await this.runtime.waitForReady(
            this.hostPort,
            READY_TIMEOUT_MS,
          )
          if (!ready) {
            logger.warn('OpenClaw gateway failed to become ready on auto-start')
            return
          }
        }

        await this.runControlPlaneCall(() => this.cliClient.probe())
        await this.ensureAllCliProvidersInstalled()
        logger.info('OpenClaw gateway auto-started')
      } catch (err) {
        logger.warn('OpenClaw auto-start failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // ── Internal ─────────────────────────────────────────────────────────

  // CLI-provider short-circuit: skip env writes and custom-provider merges,
  // just build the `<id>/<model>` ref that OpenClaw's own plugin routes to.
  private resolveProviderForAgent(
    input: SetupInput,
  ): ResolvedOpenClawProviderConfig {
    const cliProvider = input.providerType
      ? getOpenClawCliProvider(input.providerType)
      : undefined
    if (cliProvider) {
      return {
        envValues: {},
        model: input.modelId
          ? buildOpenClawCliProviderModelRef(cliProvider.id, input.modelId)
          : undefined,
      }
    }
    return resolveSupportedOpenClawProvider(input)
  }

  private async ensureAllCliProvidersInstalled(
    onLog?: (msg: string) => void,
  ): Promise<void> {
    // Test mocks may swap `this.runtime` for a partial stub without
    // execInContainer. Skip silently — production ContainerRuntime always
    // provides it.
    if (typeof this.runtime.execInContainer !== 'function') return
    for (const provider of OPENCLAW_CLI_PROVIDERS) {
      await this.ensureCliProviderInstalled(provider, onLog)
    }
  }

  private async ensureCliProviderInstalled(
    provider: OpenClawCliProvider,
    onLog?: (msg: string) => void,
  ): Promise<void> {
    // argv probe — no shell, no interpolation: `which` returns 0 if the
    // binary is on PATH in the container, non-zero otherwise.
    const probe = await this.runtime.execInContainer(['which', provider.binary])
    if (probe === 0) {
      logger.info('CLI-backed provider already present', {
        providerId: provider.id,
      })
      return
    }

    // argv install — registry values flow straight through nerdctl exec,
    // never through a shell. Version is pinned in the provider registry.
    const lines: string[] = []
    const exitCode = await this.runtime.execInContainer(
      [
        'npm',
        'install',
        '-g',
        `${provider.npmPackage}@${provider.npmPackageVersion}`,
      ],
      (line) => {
        lines.push(line)
        onLog?.(line)
      },
    )
    if (exitCode !== 0) {
      logger.warn('CLI-backed provider install failed', {
        providerId: provider.id,
        exitCode,
        tail: lines.slice(-5),
      })
      return
    }
    logger.info('CLI-backed provider installed', { providerId: provider.id })
  }

  private buildBootstrapCliClient(): OpenClawCliClient {
    return new OpenClawCliClient({
      execInContainer: (command, onLog) =>
        this.runtime.runGatewaySetupCommand(
          command,
          this.buildGatewayRuntimeSpec(),
          onLog,
        ),
    })
  }

  private rebuildRuntimeClients(): void {
    this.stopGatewayLogTail()
    this.runtime = buildContainerRuntime({
      resourcesDir: this.resourcesDir ?? undefined,
      projectDir: this.openclawDir,
      browserosRoot: this.browserosDir,
    })
    this.cliClient = new OpenClawCliClient(this.runtime)
    this.bootstrapCliClient = this.buildBootstrapCliClient()
  }

  private setPort(hostPort: number): void {
    if (hostPort === this.hostPort) return
    this.hostPort = hostPort
    this.httpClient = new OpenClawHttpClient(this.hostPort)
  }

  private async ensureGatewayPortAllocated(
    logProgress?: (msg: string) => void,
  ): Promise<void> {
    const persistedPort = await readPersistedGatewayPort(this.openclawDir)
    if (persistedPort !== null) {
      this.setPort(persistedPort)
    }
    const currentPortReady = await this.isGatewayPortReady(this.hostPort)
    if (
      currentPortReady &&
      (await this.isGatewayAuthenticated(this.hostPort))
    ) {
      return
    }
    const hostPort = await allocateGatewayPort(this.openclawDir, {
      excludePort: currentPortReady ? this.hostPort : undefined,
    })
    if (hostPort !== this.hostPort) {
      logProgress?.(`Allocated OpenClaw gateway host port ${hostPort}`)
      logger.info('Allocated OpenClaw gateway host port', { hostPort })
      this.setPort(hostPort)
    }
  }

  private async isGatewayAvailable(hostPort: number): Promise<boolean> {
    if (!(await this.isGatewayPortReady(hostPort))) return false
    return this.isGatewayAuthenticated(hostPort)
  }

  private async isGatewayAuthenticated(hostPort: number): Promise<boolean> {
    const client =
      hostPort === this.hostPort
        ? this.httpClient
        : new OpenClawHttpClient(hostPort)
    const authenticated = await client.isAuthenticated()
    if (!authenticated) {
      logger.warn('OpenClaw gateway readiness probe failed', { hostPort })
    }
    return authenticated
  }

  private async isCurrentGatewayAvailable(hostPort: number): Promise<boolean> {
    if (!(await this.isGatewayAvailable(hostPort))) return false
    return this.runtime.isGatewayCurrent()
  }

  private async isGatewayPortReady(hostPort: number): Promise<boolean> {
    if (await this.runtime.isReady(hostPort)) return true

    const runtime = this.runtime as {
      isHealthy?: (port: number) => Promise<boolean>
    }
    if (runtime.isHealthy) {
      return runtime.isHealthy(hostPort)
    }
    return false
  }

  private async assertGatewayReady(): Promise<void> {
    const portReady = await this.runtime.isReady(this.hostPort)
    logger.debug('Checking OpenClaw gateway readiness before use', {
      hostPort: this.hostPort,
      portReady,
      controlPlaneStatus: this.controlPlaneStatus,
    })
    if (portReady) {
      return
    }

    this.controlPlaneStatus = 'failed'
    this.lastGatewayError = 'OpenClaw gateway is not ready'
    this.lastRecoveryReason = 'container_not_ready'
    throw new Error('OpenClaw gateway is not ready')
  }

  private async runControlPlaneCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn()
      this.controlPlaneStatus = 'connected'
      this.lastGatewayError = null
      this.lastRecoveryReason = null
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = this.classifyControlPlaneError(error)
      this.controlPlaneStatus = 'failed'
      this.lastGatewayError = message
      this.lastRecoveryReason = reason
      throw error
    }
  }

  private classifyControlPlaneError(
    error: unknown,
  ): OpenClawGatewayRecoveryReason {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('not ready')) return 'container_not_ready'
    return 'unknown'
  }

  private startGatewayLogTail(): void {
    if (process.env.NODE_ENV !== 'development') return
    if (this.stopLogTail) return
    try {
      this.stopLogTail = this.runtime.tailGatewayLogs((line) => {
        logger.debug(line)
      })
      logger.info('Streaming OpenClaw gateway logs into server log (dev mode)')
    } catch (err) {
      logger.warn('Failed to start OpenClaw gateway log tail', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private stopGatewayLogTail(): void {
    if (!this.stopLogTail) return
    try {
      this.stopLogTail()
    } catch {
      // best effort
    }
    this.stopLogTail = null
  }

  private getHostWorkspaceDir(agentName: string): string {
    return getHostWorkspaceDir(this.openclawDir, agentName)
  }

  private getStateConfigPath(): string {
    return getOpenClawStateConfigPath(this.openclawDir)
  }

  private getStateDir(): string {
    return getOpenClawStateDir(this.openclawDir)
  }

  private getStateEnvPath(): string {
    return getOpenClawStateEnvPath(this.openclawDir)
  }

  private async applyBrowserosConfig(): Promise<void> {
    await this.bootstrapCliClient.setConfigBatch(this.getBrowserosConfigBatch())
  }

  private getBrowserosConfigBatch(): OpenClawConfigBatchEntry[] {
    const entries: OpenClawConfigBatchEntry[] = [
      {
        path: 'agents.defaults.workspace',
        value: `${OPENCLAW_CONTAINER_HOME}/workspace`,
      },
      {
        path: 'agents.defaults.thinkingDefault',
        value: 'off',
      },
      {
        path: 'gateway.controlUi.allowInsecureAuth',
        value: true,
      },
      {
        path: 'gateway.controlUi.dangerouslyDisableDeviceAuth',
        value: true,
      },
      {
        path: 'gateway.controlUi.allowedOrigins',
        value: [
          `http://127.0.0.1:${this.hostPort}`,
          `http://localhost:${this.hostPort}`,
        ],
      },
      {
        path: 'gateway.http.endpoints.chatCompletions.enabled',
        value: true,
      },
      {
        path: 'tools.profile',
        value: 'full',
      },
      {
        path: 'tools.web.search.provider',
        value: 'duckduckgo',
      },
      {
        path: 'tools.web.search.enabled',
        value: true,
      },
      {
        path: 'tools.exec.host',
        value: 'gateway',
      },
      {
        path: 'tools.exec.security',
        value: 'full',
      },
      {
        path: 'tools.exec.ask',
        value: 'off',
      },
      {
        path: 'cron.enabled',
        value: true,
      },
      {
        path: 'hooks.internal.enabled',
        value: true,
      },
      {
        path: 'mcp.servers.browseros.url',
        value: `http://host.containers.internal:${this.browserosServerPort}/mcp`,
      },
      {
        path: 'mcp.servers.browseros.transport',
        value: 'streamable-http',
      },
      {
        path: 'approvals.exec.enabled',
        value: false,
      },
      {
        path: 'skills.install.nodeManager',
        value: 'npm',
      },
      {
        path: 'agents.defaults.memorySearch.enabled',
        value: false,
      },
      {
        // Enable OpenClaw's image-understanding pipeline so models that
        // declare `input: ['text', 'image']` actually receive image bytes
        // instead of having them stripped at the gateway. Without this,
        // image_url content parts are silently dropped even if the model
        // and provider both support vision. Per-model `input` still gates
        // which models see images — this just turns the global pipeline on.
        path: 'tools.media.image.enabled',
        value: true,
      },
    ]

    if (process.env.NODE_ENV === 'development') {
      entries.push(
        {
          path: 'logging.level',
          value: 'debug',
        },
        {
          path: 'logging.consoleLevel',
          value: 'debug',
        },
      )
    }

    return entries
  }

  private async applyCliMutation(action: () => Promise<void>): Promise<void> {
    let retried = false

    while (true) {
      try {
        await action()
        await this.waitForGatewayAfterCliMutation()
        return
      } catch (error) {
        if (!this.isRestartInterruptedCliMutation(error) || retried) {
          throw error
        }

        logger.info(
          'Retrying OpenClaw CLI mutation after gateway reload interrupted the command',
          {
            error: error instanceof Error ? error.message : String(error),
          },
        )
        await this.waitForGatewayAfterCliMutation()
        retried = true
      }
    }
  }

  private isRestartInterruptedCliMutation(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return (
      message.includes('Config overwrite:') && message.includes('openclaw.json')
    )
  }

  private async waitForGatewayAfterCliMutation(): Promise<void> {
    const ready = await this.runtime.waitForReady(
      this.hostPort,
      READY_TIMEOUT_MS,
    )
    if (!ready) {
      this.lastError = 'Gateway did not become ready after applying config'
      throw new Error(this.lastError)
    }
  }

  private async assertConfigValid(
    client: OpenClawCliClient = this.cliClient,
  ): Promise<void> {
    const validation = await client.validateConfig()
    if (
      validation &&
      typeof validation === 'object' &&
      'ok' in validation &&
      validation.ok === false
    ) {
      throw new Error('OpenClaw config validation failed')
    }
  }

  private async ensureStateEnvFile(): Promise<void> {
    const envPath = this.getStateEnvPath()
    if (existsSync(envPath)) return
    await mkdir(this.getStateDir(), { recursive: true })
    await writeFile(envPath, '', { mode: 0o600 })
  }

  private buildGatewayRuntimeSpec(): GatewayContainerSpec {
    return {
      hostPort: this.hostPort,
      hostHome: this.openclawDir,
      envFilePath: this.getStateEnvPath(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }

  private async writeStateEnv(
    values: Record<string, string>,
  ): Promise<boolean> {
    if (Object.keys(values).length === 0) return false

    const envPath = this.getStateEnvPath()
    let content = ''
    try {
      content = await readFile(envPath, 'utf-8')
    } catch {
      // state env may not exist yet
    }

    const next = mergeEnvContent(content, values)
    if (!next.changed) return false

    await mkdir(this.getStateDir(), { recursive: true })
    await writeFile(envPath, next.content, { mode: 0o600 })
    logger.debug('Updated OpenClaw provider credentials', {
      keys: Object.keys(values),
    })
    return true
  }

  private async mergeProviderConfigIfChanged(
    provider: ResolvedOpenClawProviderConfig,
  ): Promise<boolean> {
    if (!provider.customProvider) {
      return false
    }

    const configPath = this.getStateConfigPath()
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content) as Record<string, unknown>
    const models =
      config.models && typeof config.models === 'object'
        ? (config.models as Record<string, unknown>)
        : {}
    const providers =
      models.providers && typeof models.providers === 'object'
        ? (models.providers as Record<string, Record<string, unknown>>)
        : {}
    const existingProvider = providers[provider.customProvider.providerId] ?? {}
    const existingModels = Array.isArray(existingProvider.models)
      ? (existingProvider.models as Array<Record<string, unknown>>)
      : []
    const desiredModelEntry =
      Array.isArray(provider.customProvider.config.models) &&
      provider.customProvider.config.models.length > 0
        ? (provider.customProvider.config.models[0] as Record<string, unknown>)
        : null
    const hasDesiredModel = desiredModelEntry
      ? existingModels.some(
          (model) =>
            model.id === desiredModelEntry.id ||
            model.name === desiredModelEntry.name,
        )
      : true
    const mergedModels =
      desiredModelEntry && !hasDesiredModel
        ? [...existingModels, desiredModelEntry]
        : existingModels.length > 0
          ? existingModels
          : Array.isArray(provider.customProvider.config.models)
            ? provider.customProvider.config.models
            : undefined

    const nextProvider: Record<string, unknown> = {
      ...existingProvider,
      ...provider.customProvider.config,
      ...(mergedModels ? { models: mergedModels } : {}),
    }
    const nextModels: Record<string, unknown> = {
      ...models,
      mode: 'merge',
      providers: {
        ...providers,
        [provider.customProvider.providerId]: nextProvider,
      },
    }
    const nextConfig: Record<string, unknown> = {
      ...config,
      models: nextModels,
    }

    if (JSON.stringify(config) === JSON.stringify(nextConfig)) {
      return false
    }

    await writeFile(
      configPath,
      `${JSON.stringify(nextConfig, null, 2)}\n`,
      'utf-8',
    )
    logger.debug('Updated OpenClaw custom provider config', {
      providerId: provider.customProvider.providerId,
    })
    return true
  }

  private createProgressLogger(
    onLog?: (msg: string) => void,
  ): (msg: string) => void {
    return (msg) => {
      logger.debug(`OpenClaw: ${msg}`)
      onLog?.(msg)
    }
  }

  private async withLifecycleLock<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleLock
    let release!: () => void
    this.lifecycleLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      return await withProcessLock(
        'openclaw-lifecycle',
        { lockDir: join(this.openclawDir, '.locks') },
        async () => {
          logger.debug('OpenClaw lifecycle operation started', { operation })
          return await fn()
        },
      )
    } finally {
      release()
    }
  }
}

let service: OpenClawService | null = null

export function configureOpenClawService(
  config: OpenClawServiceConfig,
): OpenClawService {
  if (!service) {
    service = new OpenClawService(config)
    return service
  }

  service.configure(config)
  return service
}

export function configureVmRuntime(config: {
  resourcesDir?: string
  browserosDir?: string
}): OpenClawService {
  return configureOpenClawService(config)
}

export function getOpenClawService(): OpenClawService {
  if (!service) service = new OpenClawService()
  return service
}
