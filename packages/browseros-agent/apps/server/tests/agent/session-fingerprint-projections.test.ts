import { describe, expect, it } from 'bun:test'
import { LLM_PROVIDERS } from '@browseros/shared/schemas/llm'
import type { AclRule } from '@browseros/shared/types/acl'
import type { AiSdkAgentConfig } from '../../src/agent/ai-sdk-agent'
import { deriveSessionExecutionFingerprint } from '../../src/agent/session-fingerprint'
import type { Browser } from '../../src/browser/browser'
import type { ToolRegistry } from '../../src/tools/tool-registry'

function hostileBrowser(label: string): Browser {
  const target = Object.create(null) as Record<PropertyKey, unknown>
  target.self = target
  return new Proxy(target, {
    get() {
      throw new Error(`fingerprint inspected Browser ${label}`)
    },
    getOwnPropertyDescriptor() {
      throw new Error(`fingerprint described Browser ${label}`)
    },
    ownKeys() {
      throw new Error(`fingerprint enumerated Browser ${label}`)
    },
  }) as Browser
}

function registryWithNames(names: readonly string[]): ToolRegistry {
  const target = {
    names() {
      return [...names]
    },
  }
  Object.defineProperty(target, 'cycle', { value: target })
  return target as ToolRegistry
}

function createConfig(): AiSdkAgentConfig {
  return {
    resolvedConfig: {
      conversationId: 'projection-conversation',
      provider: LLM_PROVIDERS.BROWSEROS,
      model: 'projection-model',
      apiKey: 'PROJECTION_API_SECRET',
      baseUrl: 'https://provider.example/v1',
      upstreamProvider: LLM_PROVIDERS.ANTHROPIC,
      resourceName: 'projection-resource',
      region: 'projection-region',
      accessKeyId: 'projection-access-id',
      secretAccessKey: 'PROJECTION_ACCESS_SECRET',
      sessionToken: 'PROJECTION_SESSION_SECRET',
      accountId: 'projection-account',
      reasoningEffort: 'medium',
      reasoningSummary: 'concise',
      contextWindowSize: 131_072,
      userSystemPrompt: 'Projection prompt',
      workingDir: '/projection/workspace',
      supportsImages: true,
      evalMode: false,
      chatMode: false,
      isScheduledTask: false,
      declinedApps: ['calendar', 'notion'],
      origin: 'sidepanel',
      browserosId: 'projection-browseros',
      toolApprovalConfig: {
        categories: {
          input: true,
          navigation: false,
          scripts: true,
        },
      },
    },
    browser: hostileBrowser('baseline'),
    registry: registryWithNames(['click', 'constructor', '__proto__']),
    browserContext: {
      windowId: 10,
      activeTab: {
        id: 7,
        pageId: 42,
        title: 'Ignored title',
        url: 'https://ignored.example',
      },
      enabledMcpServers: ['slack', 'gmail'],
      customMcpServers: [
        { name: 'first', url: 'https://first.example/mcp' },
        { name: 'second', url: 'https://second.example/mcp' },
      ],
    },
    klavisRef: {
      handle: {} as NonNullable<
        NonNullable<AiSdkAgentConfig['klavisRef']>['handle']
      >,
    },
    browserosId: 'unused-top-level-id',
    aiSdkDevtoolsEnabled: true,
    aclRules: [
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
    ],
  }
}

function fingerprint(config: AiSdkAgentConfig): string {
  return deriveSessionExecutionFingerprint(config)
}

function reverseRuleKeys(rule: AclRule): AclRule {
  return Object.fromEntries(
    Object.entries(rule).reverse(),
  ) as unknown as AclRule
}

type ProjectionMutation = {
  readonly label: string
  readonly mutate: (config: AiSdkAgentConfig) => void
}

const PROJECTION_MUTATIONS: readonly ProjectionMutation[] = [
  {
    label: 'declined app',
    mutate: (config) => config.resolvedConfig.declinedApps?.push('slack'),
  },
  {
    label: 'registry tool name',
    mutate: (config) => {
      config.registry = registryWithNames([
        'click',
        'constructor',
        '__proto__',
        'new-tool',
      ])
    },
  },
  {
    label: 'managed MCP server',
    mutate: (config) => config.browserContext?.enabledMcpServers?.push('drive'),
  },
  {
    label: 'custom MCP name',
    mutate: (config) => {
      const server = config.browserContext?.customMcpServers?.[0]
      if (server) server.name = 'renamed-first'
    },
  },
  {
    label: 'custom MCP URL',
    mutate: (config) => {
      const server = config.browserContext?.customMcpServers?.[0]
      if (server) server.url = 'https://changed.example/mcp'
    },
  },
  {
    label: 'active page ID',
    mutate: (config) => {
      const tab = config.browserContext?.activeTab
      if (tab) tab.pageId = 84
    },
  },
  {
    label: 'Klavis connection state',
    mutate: (config) => {
      config.klavisRef = { handle: null }
    },
  },
  {
    label: 'enabled approval category',
    mutate: (config) => {
      const categories = config.resolvedConfig.toolApprovalConfig?.categories
      if (categories) categories.navigation = true
    },
  },
  {
    label: 'ACL id',
    mutate: (config) => {
      if (config.aclRules?.[0]) config.aclRules[0].id = 'changed-id'
    },
  },
  {
    label: 'ACL site pattern',
    mutate: (config) => {
      if (config.aclRules?.[0]) {
        config.aclRules[0].sitePattern = 'changed.example'
      }
    },
  },
  {
    label: 'ACL selector',
    mutate: (config) => {
      if (config.aclRules?.[0]) config.aclRules[0].selector = '#changed'
    },
  },
  {
    label: 'ACL text match',
    mutate: (config) => {
      if (config.aclRules?.[0]) config.aclRules[0].textMatch = 'Changed'
    },
  },
  {
    label: 'ACL description',
    mutate: (config) => {
      if (config.aclRules?.[0]) {
        config.aclRules[0].description = 'Changed description'
      }
    },
  },
  {
    label: 'ACL enabled state',
    mutate: (config) => {
      if (config.aclRules?.[0]) config.aclRules[0].enabled = false
    },
  },
]

describe('session fingerprint process projections', () => {
  it('never inspects Browser identity, getters, or cycles', () => {
    const first = createConfig()
    const second = createConfig()
    second.browser = hostileBrowser('replacement')

    expect(fingerprint(second)).toBe(fingerprint(first))
  })

  it('canonicalizes set-like registry, MCP, approval, and declined-app inputs', () => {
    const baseline = createConfig()
    const reordered = createConfig()
    reordered.resolvedConfig.declinedApps = ['notion', 'calendar', 'calendar']
    reordered.registry = registryWithNames([
      'constructor',
      'click',
      '__proto__',
      'click',
    ])
    if (reordered.browserContext) {
      reordered.browserContext.enabledMcpServers = ['gmail', 'slack', 'gmail']
    }
    reordered.resolvedConfig.toolApprovalConfig = {
      categories: {
        scripts: true,
        navigation: false,
        input: true,
      },
    }

    expect(fingerprint(reordered)).toBe(fingerprint(baseline))
  })

  it('normalizes absent and empty projected collections', () => {
    const omitted = createConfig()
    omitted.resolvedConfig.declinedApps = undefined
    omitted.resolvedConfig.toolApprovalConfig = undefined
    omitted.aclRules = undefined
    omitted.browserContext = { activeTab: { id: 7, pageId: 42 } }
    omitted.klavisRef = undefined

    const empty = createConfig()
    empty.resolvedConfig.declinedApps = []
    empty.resolvedConfig.toolApprovalConfig = {
      categories: { input: false },
    }
    empty.aclRules = []
    empty.browserContext = {
      activeTab: { id: 7, pageId: 42 },
      enabledMcpServers: [],
      customMcpServers: [],
    }
    empty.klavisRef = { handle: null }

    expect(fingerprint(empty)).toBe(fingerprint(omitted))
  })

  it('ignores active-tab id, title, url, and unrelated browser context', () => {
    const baseline = createConfig()
    const changed = createConfig()
    const tab = changed.browserContext?.activeTab
    if (tab) {
      tab.id = 999
      tab.title = 'Changed title'
      tab.url = 'https://changed.example'
    }
    if (changed.browserContext) {
      changed.browserContext.windowId = 999
      changed.browserContext.tabs = [{ id: 123, pageId: 321 }]
      changed.browserContext.selectedTabs = [{ id: 456, pageId: 654 }]
    }

    expect(fingerprint(changed)).toBe(fingerprint(baseline))
  })

  it('preserves custom MCP collision order and ACL rule order', () => {
    const customReordered = createConfig()
    customReordered.browserContext?.customMcpServers?.reverse()
    const aclReordered = createConfig()
    aclReordered.aclRules?.reverse()
    const baseline = fingerprint(createConfig())

    expect(fingerprint(customReordered)).not.toBe(baseline)
    expect(fingerprint(aclReordered)).not.toBe(baseline)
  })

  it('canonicalizes ACL object keys without sorting the rule array', () => {
    const reordered = createConfig()
    reordered.aclRules = reordered.aclRules?.map(reverseRuleKeys)

    expect(fingerprint(reordered)).toBe(fingerprint(createConfig()))
  })

  it('treats Klavis as disabled when no managed server is enabled', () => {
    const connectedHandle = createConfig()
    const nullHandle = createConfig()
    if (connectedHandle.browserContext) {
      connectedHandle.browserContext.enabledMcpServers = []
    }
    if (nullHandle.browserContext) {
      nullHandle.browserContext.enabledMcpServers = []
    }
    nullHandle.klavisRef = { handle: null }

    expect(fingerprint(connectedHandle)).toBe(fingerprint(nullHandle))
  })

  it('treats absent and null Klavis handles as pending with managed servers', () => {
    const absent = createConfig()
    absent.klavisRef = undefined
    const nullHandle = createConfig()
    nullHandle.klavisRef = { handle: null }

    expect(fingerprint(absent)).toBe(fingerprint(nullHandle))
  })

  it.each(PROJECTION_MUTATIONS)('changes when the $label projection changes', ({
    mutate,
  }) => {
    const changed = createConfig()
    mutate(changed)

    expect(fingerprint(changed)).not.toBe(fingerprint(createConfig()))
  })
})
