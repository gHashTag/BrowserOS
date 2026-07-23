import { describe, expect, it } from 'bun:test'
import { AGENT_LIMITS } from '@browseros/shared/constants/limits'
import type { BrowserContext } from '@browseros/shared/schemas/browser-context'
import { LLM_PROVIDERS } from '@browseros/shared/schemas/llm'
import type { AclRule } from '@browseros/shared/types/acl'
import type { AiSdkAgentConfig } from '../../src/agent/ai-sdk-agent'
import * as sessionFingerprint from '../../src/agent/session-fingerprint'
import type { Browser } from '../../src/browser/browser'
import type { ToolRegistry } from '../../src/tools/tool-registry'

const { deriveSessionExecutionFingerprint } = sessionFingerprint

function opaqueBrowser(): Browser {
  return new Proxy(Object.create(null), {
    get() {
      throw new Error('fingerprinting must not inspect Browser')
    },
  }) as Browser
}

function registryWithNames(names: readonly string[]): ToolRegistry {
  return {
    names: () => [...names],
  } as ToolRegistry
}

function createConfig(): AiSdkAgentConfig {
  const browserContext: BrowserContext = {
    activeTab: {
      id: 7,
      pageId: 42,
    },
    enabledMcpServers: ['slack', 'gmail'],
    customMcpServers: [
      { name: 'first', url: 'https://first.example/mcp' },
      { name: 'second', url: 'https://second.example/mcp' },
    ],
  }
  const aclRules: AclRule[] = [
    {
      id: 'rule-a',
      sitePattern: '*.example',
      selector: '#confirm',
      description: 'Protect confirmation',
      enabled: true,
    },
    {
      id: 'rule-b',
      sitePattern: 'private.example',
      textMatch: 'Delete',
      enabled: true,
    },
  ]

  return {
    resolvedConfig: {
      conversationId: 'conversation-is-not-execution-config',
      provider: LLM_PROVIDERS.BROWSEROS,
      model: 'model-a',
      apiKey: 'API_KEY_SENTINEL',
      baseUrl: 'https://provider.example/v1',
      upstreamProvider: LLM_PROVIDERS.ANTHROPIC,
      resourceName: 'resource-a',
      region: 'region-a',
      accessKeyId: 'access-key-a',
      secretAccessKey: 'SECRET_ACCESS_KEY_SENTINEL',
      sessionToken: 'SESSION_TOKEN_SENTINEL',
      accountId: 'account-a',
      reasoningEffort: 'medium',
      reasoningSummary: 'concise',
      contextWindowSize: 131_072,
      userSystemPrompt: 'Use the verified workflow.',
      workingDir: '/workspace/a',
      supportsImages: true,
      evalMode: true,
      chatMode: false,
      isScheduledTask: false,
      declinedApps: ['calendar', 'notion'],
      origin: 'sidepanel',
      browserosId: 'resolved-browseros-a',
      toolApprovalConfig: {
        categories: {
          input: true,
          navigation: false,
          scripts: true,
        },
      },
    },
    browser: opaqueBrowser(),
    registry: registryWithNames(['click', 'constructor', '__proto__']),
    browserContext,
    klavisRef: {
      handle: {} as NonNullable<
        NonNullable<AiSdkAgentConfig['klavisRef']>['handle']
      >,
    },
    browserosId: 'agent-browseros-a',
    aiSdkDevtoolsEnabled: true,
    aclRules,
  }
}

function reverseObjectKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T
}

type ConfigMutation = {
  readonly label: string
  readonly mutate: (config: AiSdkAgentConfig) => void
}

const CORE_SCALAR_MUTATIONS: readonly ConfigMutation[] = [
  {
    label: 'provider',
    mutate: (config) => {
      config.resolvedConfig.provider = LLM_PROVIDERS.OPENAI
    },
  },
  {
    label: 'model',
    mutate: (config) => {
      config.resolvedConfig.model = 'model-b'
    },
  },
  {
    label: 'base URL',
    mutate: (config) => {
      config.resolvedConfig.baseUrl = 'https://other-provider.example/v1'
    },
  },
  {
    label: 'upstream provider',
    mutate: (config) => {
      config.resolvedConfig.upstreamProvider = LLM_PROVIDERS.AZURE
    },
  },
  {
    label: 'resource name',
    mutate: (config) => {
      config.resolvedConfig.resourceName = 'resource-b'
    },
  },
  {
    label: 'region',
    mutate: (config) => {
      config.resolvedConfig.region = 'region-b'
    },
  },
  {
    label: 'access-key identity',
    mutate: (config) => {
      config.resolvedConfig.accessKeyId = 'access-key-b'
    },
  },
  {
    label: 'account identity',
    mutate: (config) => {
      config.resolvedConfig.accountId = 'account-b'
    },
  },
  {
    label: 'reasoning effort',
    mutate: (config) => {
      config.resolvedConfig.reasoningEffort = 'high'
    },
  },
  {
    label: 'reasoning summary',
    mutate: (config) => {
      config.resolvedConfig.reasoningSummary = 'detailed'
    },
  },
  {
    label: 'context window',
    mutate: (config) => {
      config.resolvedConfig.contextWindowSize = 200_000
    },
  },
  {
    label: 'system prompt',
    mutate: (config) => {
      config.resolvedConfig.userSystemPrompt = 'Use a different workflow.'
    },
  },
  {
    label: 'working directory',
    mutate: (config) => {
      config.resolvedConfig.workingDir = '/workspace/b'
    },
  },
  {
    label: 'image support',
    mutate: (config) => {
      config.resolvedConfig.supportsImages = false
    },
  },
  {
    label: 'eval mode',
    mutate: (config) => {
      config.resolvedConfig.evalMode = false
    },
  },
  {
    label: 'chat mode',
    mutate: (config) => {
      config.resolvedConfig.chatMode = true
    },
  },
  {
    label: 'scheduled mode',
    mutate: (config) => {
      config.resolvedConfig.isScheduledTask = true
    },
  },
  {
    label: 'origin',
    mutate: (config) => {
      config.resolvedConfig.origin = 'newtab'
    },
  },
  {
    label: 'resolved BrowserOS ID',
    mutate: (config) => {
      config.resolvedConfig.browserosId = 'resolved-browseros-b'
    },
  },
  {
    label: 'AI SDK devtools',
    mutate: (config) => {
      config.aiSdkDevtoolsEnabled = false
    },
  },
]

describe('deriveSessionExecutionFingerprint', () => {
  it('returns a stable lowercase SHA-256 fingerprint', () => {
    const first = deriveSessionExecutionFingerprint(createConfig())
    const second = deriveSessionExecutionFingerprint(createConfig())

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
  })

  it('canonicalizes object keys recursively', () => {
    const baseline = createConfig()
    const reordered = createConfig()
    reordered.resolvedConfig = reverseObjectKeys(reordered.resolvedConfig)
    const recursivelyReordered = reverseObjectKeys(reordered)

    expect(deriveSessionExecutionFingerprint(recursivelyReordered)).toBe(
      deriveSessionExecutionFingerprint(baseline),
    )
  })

  it('normalizes effective constructor defaults', () => {
    const omitted = createConfig()
    omitted.resolvedConfig.contextWindowSize = undefined
    omitted.resolvedConfig.supportsImages = undefined
    omitted.resolvedConfig.evalMode = undefined
    omitted.resolvedConfig.chatMode = undefined
    omitted.resolvedConfig.isScheduledTask = undefined
    omitted.resolvedConfig.origin = undefined
    omitted.aiSdkDevtoolsEnabled = undefined

    const explicit = createConfig()
    explicit.resolvedConfig.contextWindowSize =
      AGENT_LIMITS.DEFAULT_CONTEXT_WINDOW
    explicit.resolvedConfig.supportsImages = true
    explicit.resolvedConfig.evalMode = false
    explicit.resolvedConfig.chatMode = false
    explicit.resolvedConfig.isScheduledTask = false
    explicit.resolvedConfig.origin = 'sidepanel'
    explicit.aiSdkDevtoolsEnabled = false

    expect(deriveSessionExecutionFingerprint(omitted)).toBe(
      deriveSessionExecutionFingerprint(explicit),
    )
  })

  it('normalizes ChatGPT Pro empty reasoning settings to high and auto', () => {
    const omitted = createConfig()
    omitted.resolvedConfig.provider = LLM_PROVIDERS.CHATGPT_PRO
    omitted.resolvedConfig.reasoningEffort = undefined
    omitted.resolvedConfig.reasoningSummary = undefined

    const empty = createConfig()
    empty.resolvedConfig.provider = LLM_PROVIDERS.CHATGPT_PRO
    empty.resolvedConfig.reasoningEffort = ''
    empty.resolvedConfig.reasoningSummary = ''

    const explicit = createConfig()
    explicit.resolvedConfig.provider = LLM_PROVIDERS.CHATGPT_PRO
    explicit.resolvedConfig.reasoningEffort = 'high'
    explicit.resolvedConfig.reasoningSummary = 'auto'

    const expected = deriveSessionExecutionFingerprint(explicit)
    expect(deriveSessionExecutionFingerprint(omitted)).toBe(expected)
    expect(deriveSessionExecutionFingerprint(empty)).toBe(expected)
  })

  it.each(CORE_SCALAR_MUTATIONS)('changes when the $label changes', ({
    mutate,
  }) => {
    const baseline = createConfig()
    const changed = createConfig()
    mutate(changed)

    expect(deriveSessionExecutionFingerprint(changed)).not.toBe(
      deriveSessionExecutionFingerprint(baseline),
    )
  })

  it('does not include conversation or unused object identity fields', () => {
    const baseline = createConfig()
    const changed = createConfig()
    changed.resolvedConfig.conversationId = 'another-conversation'
    changed.browserosId = 'unused-agent-browseros-b'

    expect(deriveSessionExecutionFingerprint(changed)).toBe(
      deriveSessionExecutionFingerprint(baseline),
    )
  })

  it.each([
    'apiKey',
    'secretAccessKey',
    'sessionToken',
  ] as const)('changes when %s rotates', (credential) => {
    const baseline = createConfig()
    const changed = createConfig()
    changed.resolvedConfig[credential] = `rotated-${credential}`

    expect(deriveSessionExecutionFingerprint(changed)).not.toBe(
      deriveSessionExecutionFingerprint(baseline),
    )
  })

  it('normalizes undefined and empty credential tuple members', () => {
    const omitted = createConfig()
    omitted.resolvedConfig.apiKey = undefined
    omitted.resolvedConfig.secretAccessKey = undefined
    omitted.resolvedConfig.sessionToken = undefined

    const empty = createConfig()
    empty.resolvedConfig.apiKey = ''
    empty.resolvedConfig.secretAccessKey = ''
    empty.resolvedConfig.sessionToken = ''

    expect(deriveSessionExecutionFingerprint(omitted)).toBe(
      deriveSessionExecutionFingerprint(empty),
    )
  })

  it('length-prefixes credential tuple members without delimiter collisions', () => {
    const left = createConfig()
    left.resolvedConfig.apiKey = 'alpha'
    left.resolvedConfig.secretAccessKey = 'beta:gamma'
    left.resolvedConfig.sessionToken = ''

    const right = createConfig()
    right.resolvedConfig.apiKey = 'alpha:beta'
    right.resolvedConfig.secretAccessKey = 'gamma'
    right.resolvedConfig.sessionToken = ''

    expect(deriveSessionExecutionFingerprint(left)).not.toBe(
      deriveSessionExecutionFingerprint(right),
    )
  })

  it('uses UTF-8 byte lengths for Unicode credential framing', () => {
    const config = createConfig()
    config.resolvedConfig.apiKey = 'clé-🔐'
    config.resolvedConfig.secretAccessKey = '秘密'
    config.resolvedConfig.sessionToken = 'токен'

    expect(deriveSessionExecutionFingerprint(config)).toBe(
      '540c2a09b37ea379b604eab888c79b3e0ec2fcdfb30a18db1004471f85f65d7d',
    )
  })

  it('exposes no secret-bearing material', () => {
    const config = createConfig()
    const sentinels = [
      config.resolvedConfig.apiKey,
      config.resolvedConfig.secretAccessKey,
      config.resolvedConfig.sessionToken,
    ].filter((value): value is string => value !== undefined)
    const fingerprint = deriveSessionExecutionFingerprint(config)
    const exportedMaterial = JSON.stringify(sessionFingerprint)

    expect(Object.keys(sessionFingerprint)).toEqual([
      'deriveSessionExecutionFingerprint',
    ])
    for (const sentinel of sentinels) {
      expect(fingerprint).not.toContain(sentinel)
      expect(exportedMaterial).not.toContain(sentinel)
    }
  })
})
