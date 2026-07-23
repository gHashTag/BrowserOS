import { devToolsMiddleware } from '@ai-sdk/devtools'
import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
} from '@ai-sdk/provider'
import { AGENT_LIMITS } from '@browseros/shared/constants/limits'
import type { BrowserContext } from '@browseros/shared/schemas/browser-context'
import { LLM_PROVIDERS } from '@browseros/shared/schemas/llm'
import type { AclRule } from '@browseros/shared/types/acl'
import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
  type UIMessage,
  wrapLanguageModel,
} from 'ai'
import {
  buildKlavisToolSet,
  type KlavisProxyRef,
} from '../api/services/klavis/strata-proxy'
import type { Browser } from '../browser/browser'
import { logger } from '../lib/logger'
import { metrics } from '../lib/metrics'
import { isSoulBootstrap, readSoul } from '../lib/soul'
import { buildSkillsCatalog } from '../skills/catalog'
import { loadSkills } from '../skills/loader'
import { buildFilesystemToolSet } from '../tools/filesystem/build-toolset'
import type { ToolContext } from '../tools/framework'
import { buildMemoryToolSet } from '../tools/memory/build-toolset'
import type { ToolRegistry } from '../tools/tool-registry'
import { CHAT_MODE_ALLOWED_TOOLS } from './chat-mode'
import { createCompactionPrepareStep, type StepWithUsage } from './compaction'
import {
  createMergedToolDescriptorResolver,
  MutableToolEvidenceSinkRelay,
  resolveToolReliabilityDescriptor,
  type ToolEvidenceSink,
  wrapToolSetWithEvidence,
} from './execution-evidence'
import { buildMcpServerSpecs, createMcpClients } from './mcp-builder'
import {
  getMessageNormalizationOptions,
  normalizeMessagesForModel,
} from './message-normalization'
import { buildSystemPrompt } from './prompt'
import { createLanguageModel } from './provider-factory'
import { buildBrowserToolSet } from './tool-adapter'
import type { ResolvedAgentConfig } from './types'

type RuntimeToolExecute = (...args: unknown[]) => unknown

function dataMethod(
  value: unknown,
  property: PropertyKey,
): RuntimeToolExecute | undefined {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return undefined
  }

  let current: object | null = value as object
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, property)
    } catch {
      return undefined
    }
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function'
        ? descriptor.value
        : undefined
    }
    try {
      current = Object.getPrototypeOf(current)
    } catch {
      return undefined
    }
  }
  return undefined
}

function safeErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'Unknown tool execution error'
  }
}

function instrumentExternalMcpTool(
  name: string,
  sourceTool: ToolSet[string],
): ToolSet[string] {
  const executeDescriptor = Object.getOwnPropertyDescriptor(
    sourceTool,
    'execute',
  )
  if (
    executeDescriptor === undefined ||
    !Object.hasOwn(executeDescriptor, 'value') ||
    typeof executeDescriptor.value !== 'function'
  ) {
    return sourceTool
  }
  const sourceExecute = executeDescriptor.value as RuntimeToolExecute

  const execute = function (this: unknown, ...args: unknown[]): unknown {
    const startTime = performance.now()
    let settled = false
    const settle = (success: boolean, error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      try {
        metrics.log('tool_executed', {
          tool_name: name,
          duration_ms: Math.round(performance.now() - startTime),
          success,
          ...(success ? {} : { error_message: safeErrorMessage(error) }),
          source: 'chat',
        })
      } catch {
        // Metrics are observe-only and must never affect the external tool.
      }
    }

    let output: unknown
    try {
      output = sourceExecute.call(this, ...args)
    } catch (error) {
      settle(false, error)
      throw error
    }

    const asyncIteratorMethod = dataMethod(output, Symbol.asyncIterator)
    if (asyncIteratorMethod !== undefined) {
      return (async function* () {
        let completed = false
        try {
          for await (const chunk of output as AsyncIterable<unknown>) {
            yield chunk
          }
          completed = true
          settle(true)
        } catch (error) {
          settle(false, error)
          throw error
        } finally {
          if (!completed) {
            settle(false, new Error('Tool output iteration was cancelled'))
          }
        }
      })()
    }

    const thenMethod = dataMethod(output, 'then')
    if (
      thenMethod !== undefined &&
      (typeof output === 'object' || typeof output === 'function') &&
      output !== null
    ) {
      return new Promise<unknown>((resolve, reject) => {
        try {
          thenMethod.call(output, resolve, reject)
        } catch (error) {
          reject(error)
        }
      }).then(
        (resolved) => {
          settle(true)
          return resolved
        },
        (error) => {
          settle(false, error)
          throw error
        },
      )
    }

    settle(true)
    return output
  }

  const descriptors = Object.getOwnPropertyDescriptors(
    sourceTool,
  ) as PropertyDescriptorMap
  descriptors.execute = {
    ...executeDescriptor,
    value: execute,
  }
  return Object.create(
    Object.getPrototypeOf(sourceTool),
    descriptors,
  ) as ToolSet[string]
}

export interface AiSdkAgentConfig {
  resolvedConfig: ResolvedAgentConfig
  browser: Browser
  registry: ToolRegistry
  browserContext?: BrowserContext
  klavisRef?: KlavisProxyRef
  browserosId?: string
  aiSdkDevtoolsEnabled?: boolean
  aclRules?: AclRule[]
}

export class AiSdkAgent {
  private constructor(
    private _agent: ToolLoopAgent,
    private _messages: UIMessage[],
    private _mcpClients: Array<{ close(): Promise<void> }>,
    private conversationId: string,
    private _toolNames: Set<string>,
    private toolContext: ToolContext,
    private evidenceRelay: MutableToolEvidenceSinkRelay,
  ) {}

  /** Tool names registered on this agent — used to sanitize messages during session rebuilds. */
  get toolNames(): Set<string> {
    return this._toolNames
  }

  static async create(config: AiSdkAgentConfig): Promise<AiSdkAgent> {
    const contextWindow =
      config.resolvedConfig.contextWindowSize ??
      AGENT_LIMITS.DEFAULT_CONTEXT_WINDOW

    const rawModel = createLanguageModel(config.resolvedConfig)
    const isV3Model =
      typeof rawModel === 'object' &&
      rawModel !== null &&
      'specificationVersion' in rawModel &&
      rawModel.specificationVersion === 'v3'

    let model = rawModel
    if (isV3Model && config.aiSdkDevtoolsEnabled) {
      model = wrapLanguageModel({
        model: rawModel as LanguageModelV3,
        middleware: devToolsMiddleware() as LanguageModelV3Middleware,
      })
      logger.info('AI SDK DevTools middleware enabled', {
        conversationId: config.resolvedConfig.conversationId,
        provider: config.resolvedConfig.provider,
        model: config.resolvedConfig.model,
      })
    }

    // Build browser tools from the unified tool registry
    const originPageId = config.browserContext?.activeTab?.pageId
    const toolContext: ToolContext = {
      browser: config.browser,
      directories: { workingDir: config.resolvedConfig.workingDir },
      session: {
        origin: config.resolvedConfig.origin,
        originPageId,
      },
      aclRules: config.aclRules,
    }
    const allBrowserTools = buildBrowserToolSet(
      config.registry,
      toolContext,
      config.resolvedConfig.toolApprovalConfig,
    )
    const browserTools = config.resolvedConfig.chatMode
      ? Object.fromEntries(
          Object.entries(allBrowserTools).filter(([name]) =>
            CHAT_MODE_ALLOWED_TOOLS.has(name),
          ),
        )
      : allBrowserTools
    if (config.resolvedConfig.chatMode) {
      logger.info('Chat mode enabled, restricting to read-only browser tools', {
        allowedTools: Array.from(CHAT_MODE_ALLOWED_TOOLS),
      })
    }

    // Get Klavis tools from shared background handle (no per-session connection).
    // Only expose when user has enabled servers — matches old per-session gating.
    const klavisTools =
      config.klavisRef?.handle &&
      config.browserContext?.enabledMcpServers?.length
        ? buildKlavisToolSet(config.klavisRef.handle)
        : {}

    // Connect custom (non-Klavis) MCP servers per-session
    const specs = await buildMcpServerSpecs({
      browserContext: config.browserContext,
    })
    const { clients, tools: customMcpTools } = await createMcpClients(specs)
    const collidingToolNames = Object.keys(customMcpTools).filter(
      (name) => name in klavisTools,
    )
    if (collidingToolNames.length > 0) {
      logger.warn('Custom MCP tools override Klavis tools', {
        toolNames: collidingToolNames,
      })
    }
    const rawExternalMcpTools = { ...klavisTools, ...customMcpTools }

    // Wrap external MCP tools (Klavis, custom) with return-shape-preserving
    // metrics. In particular, AsyncIterable preliminary outputs must remain
    // AsyncIterable instead of becoming Promise<AsyncIterable>.
    const externalMcpTools: ToolSet = {}
    for (const [name, t] of Object.entries(rawExternalMcpTools)) {
      externalMcpTools[name] = instrumentExternalMcpTool(name, t)
    }

    // Add filesystem tools — skip in chat mode (read-only) and when no workspace is selected
    const filesystemTools =
      !config.resolvedConfig.chatMode && config.resolvedConfig.workingDir
        ? buildFilesystemToolSet(config.resolvedConfig.workingDir)
        : {}
    const memoryTools = config.resolvedConfig.chatMode
      ? {}
      : buildMemoryToolSet()
    const mergedTools: ToolSet = {
      ...browserTools,
      ...externalMcpTools,
      ...filesystemTools,
      ...memoryTools,
    }

    if (
      config.resolvedConfig.isScheduledTask ||
      config.resolvedConfig.chatMode
    ) {
      delete mergedTools.suggest_schedule
      delete mergedTools.suggest_app_connection
    }

    const finalToolNames = new Set(Object.keys(mergedTools))
    const finalNamesFrom = (source: ToolSet): string[] =>
      Object.keys(source).filter((name) => finalToolNames.has(name))
    const describeTool = createMergedToolDescriptorResolver([
      {
        toolNames: finalNamesFrom(browserTools),
        describeTool: (name) =>
          resolveToolReliabilityDescriptor(name, {
            kind: 'browser',
            approvalCategory: config.registry.get(name)?.approvalCategory,
          }),
      },
      {
        toolNames: finalNamesFrom(externalMcpTools),
        describeTool: (name) =>
          resolveToolReliabilityDescriptor(name, { kind: 'external' }),
      },
      {
        toolNames: finalNamesFrom(filesystemTools),
        describeTool: (name) =>
          resolveToolReliabilityDescriptor(name, { kind: 'filesystem' }),
      },
      {
        toolNames: finalNamesFrom(memoryTools),
        describeTool: (name) =>
          resolveToolReliabilityDescriptor(name, { kind: 'memory' }),
      },
    ])
    const evidenceRelay = new MutableToolEvidenceSinkRelay()
    const tools = wrapToolSetWithEvidence(mergedTools, {
      evidenceSink: evidenceRelay,
      describeTool,
    })

    // Build system prompt with optional section exclusions
    const excludeSections: string[] = []
    if (
      config.resolvedConfig.isScheduledTask ||
      config.resolvedConfig.chatMode
    ) {
      excludeSections.push('nudges')
    }
    const soulContent = await readSoul()
    const isBootstrap = await isSoulBootstrap()

    // Load skills catalog for prompt injection
    const skills = await loadSkills()
    const skillsCatalog =
      skills.length > 0 ? buildSkillsCatalog(skills) : undefined

    const instructions = buildSystemPrompt({
      userSystemPrompt: config.resolvedConfig.userSystemPrompt,
      exclude: excludeSections,
      isScheduledTask: config.resolvedConfig.isScheduledTask,
      scheduledTaskPageId: config.browserContext?.activeTab?.pageId,
      workspaceDir: config.resolvedConfig.workingDir,
      soulContent,
      isSoulBootstrap: isBootstrap,
      chatMode: config.resolvedConfig.chatMode,
      connectedApps: config.browserContext?.enabledMcpServers,
      declinedApps: config.resolvedConfig.declinedApps,
      skillsCatalog,
      origin: config.resolvedConfig.origin,
    })

    // Configure compaction for context window management
    const compactionPrepareStep = createCompactionPrepareStep({
      contextWindow,
    })
    const normalizationOptions = getMessageNormalizationOptions(
      config.resolvedConfig,
    )
    const prepareStep = async (options: {
      messages: ModelMessage[]
      steps: ReadonlyArray<StepWithUsage>
      model: LanguageModel
      experimental_context: unknown
    }) =>
      compactionPrepareStep({
        ...options,
        messages: normalizeMessagesForModel(
          options.messages,
          normalizationOptions,
        ),
      })

    // Codex requires store=false — tell the SDK to inline content
    // instead of using item_reference (which fails with store=false)
    const isChatGPTPro =
      config.resolvedConfig.provider === LLM_PROVIDERS.CHATGPT_PRO

    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      stopWhen: [stepCountIs(AGENT_LIMITS.MAX_TURNS)],
      prepareStep,
      ...(isChatGPTPro && {
        providerOptions: {
          openai: {
            store: false,
            reasoningEffort: config.resolvedConfig.reasoningEffort || 'high',
            reasoningSummary: config.resolvedConfig.reasoningSummary || 'auto',
            include: ['reasoning.encrypted_content'],
          },
        },
      }),
    })

    logger.info('Agent session created (v2)', {
      conversationId: config.resolvedConfig.conversationId,
      provider: config.resolvedConfig.provider,
      model: config.resolvedConfig.model,
      toolCount: Object.keys(tools).length,
    })

    return new AiSdkAgent(
      agent,
      [],
      clients,
      config.resolvedConfig.conversationId,
      new Set(Object.keys(tools)),
      toolContext,
      evidenceRelay,
    )
  }

  get toolLoopAgent(): ToolLoopAgent {
    return this._agent
  }

  get messages(): UIMessage[] {
    return this._messages
  }

  set messages(msgs: UIMessage[]) {
    this._messages = msgs
  }

  appendUserMessage(content: string): void {
    this._messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: content }],
    })
  }

  updateAclRules(rules?: AclRule[]): void {
    this.toolContext.aclRules = rules
  }

  setEvidenceSink(sink: ToolEvidenceSink | undefined): void {
    this.evidenceRelay.setTarget(sink)
  }

  async dispose(): Promise<void> {
    this.evidenceRelay.setTarget(undefined)
    for (const client of this._mcpClients) {
      await client.close().catch(() => {})
    }
    logger.info('Agent disposed', { conversationId: this.conversationId })
  }
}

export { formatUserMessage } from './format-message'
