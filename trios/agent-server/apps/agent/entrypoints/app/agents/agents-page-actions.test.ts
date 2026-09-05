/**
 * Contract suite for agents-page-actions.ts.
 *
 * The module has exactly one runtime export, `createAgentPageActions`, and it
 * is exercised below through the page-collaborator surface it is handed
 * (creators, deleters, state setters, navigation and the metrics adapter).
 *
 * Exports that could not be tested without a live dependency: none. The
 * module's only runtime export needs no network, database or container; every
 * collaborator is injected through its input, so the suite supplies local
 * stand-ins. (`AgentPageActionInput` is a type-only export and is erased at
 * runtime, so it has no behaviour to pin.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { NavigateFunction } from 'react-router'
import {
  AGENT_CREATED_EVENT,
  AGENT_DELETED_EVENT,
} from '@/lib/constants/analyticsEvents'
import type { HarnessAgent } from './agent-harness-types'
import { createAgentPageActions } from './agents-page-actions'
import type {
  AgentListItem,
  CreateAgentRuntime,
  ProviderOption,
} from './agents-page-types'
import type {
  AgentEntry,
  OpenClawAgentMutationInput,
  OpenClawSetupInput,
} from './useOpenClaw'

/**
 * The subject emits analytics through the platform metrics adapter, which
 * reads the extension `chrome` APIs. A minimal in-memory stand-in keeps the
 * suite free of any browser, and records what the subject emitted.
 */
type LogMetricCall = {
  eventName: string
  properties: Record<string, unknown>
}

const logMetricCalls: LogMetricCall[] = []
const chromeStub = {
  runtime: {
    getManifest: () => ({ version: 'contract-suite' }),
  },
  browserOS: {
    logMetric: (
      eventName: string,
      properties: Record<string, unknown>,
      callback: () => void,
    ) => {
      logMetricCalls.push({ eventName, properties })
      callback()
    },
  },
}

const globalWithChrome = globalThis as typeof globalThis & {
  chrome?: typeof chromeStub
}

beforeAll(() => {
  globalWithChrome.chrome = chromeStub
})

afterAll(() => {
  delete globalWithChrome.chrome
})

beforeEach(() => {
  logMetricCalls.length = 0
})

function makeOpenClawProvider(
  overrides: Partial<ProviderOption> = {},
): ProviderOption {
  return {
    id: 'openai/main',
    type: 'openai',
    name: 'OpenAI',
    modelId: 'gpt-5-main',
    ...overrides,
  }
}

function makeHermesProvider(
  overrides: Partial<ProviderOption> = {},
): ProviderOption {
  return {
    id: 'hermes/work-llm',
    type: 'custom-llm',
    name: 'Work LLM',
    modelId: 'qwen3-max',
    baseUrl: 'https://llm.internal',
    apiKey: 'sk-hermes',
    ...overrides,
  }
}

function makeAgentListItem(
  overrides: Partial<AgentListItem> = {},
): AgentListItem {
  return {
    key: 'openclaw:claw-9',
    agentId: 'claw-9',
    name: 'Claw Nine',
    source: 'openclaw',
    runtimeLabel: 'OpenClaw',
    modelLabel: 'gpt-5-main',
    detail: '',
    canChat: true,
    canDelete: true,
    ...overrides,
  }
}

function makeHarnessAgent(overrides: Partial<HarnessAgent> = {}): HarnessAgent {
  return {
    id: 'harness-created',
    name: 'Harness Agent',
    adapter: 'codex',
    permissionMode: 'approve-all',
    sessionKey: 'session',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

interface RecordedInput {
  input: Parameters<typeof createAgentPageActions>[0]
  navigateCalls: string[]
  createOpenClawAgentCalls: OpenClawAgentMutationInput[][]
  createHarnessAgentCalls: Parameters<
    Parameters<typeof createAgentPageActions>[0]['createHarnessAgent']
  >[][]
  deleteOpenClawAgentCalls: string[][]
  deleteHarnessAgentCalls: string[][]
  setupOpenClawCalls: OpenClawSetupInput[][]
  setCliAuthModalOpenCalls: boolean[]
  setCreateErrorCalls: (string | null)[]
  setCreateOpenCalls: boolean[]
  setDeletingAgentKeyCalls: (string | null)[]
  setNewNameCalls: string[]
  setPageErrorCalls: (string | null)[]
  setSetupOpenCalls: boolean[]
  /** The busy marker observed by the deleter while its request was in flight. */
  deletingKeyAtDeleteStart: (string | null)[]
}

function makeRecordedInput(
  overrides: {
    createProviderId?: string
    createRuntime?: CreateAgentRuntime
    createHermesProviderId?: string
    harnessModelId?: string
    harnessReasoningEffort?: string
    newName?: string
    selectableOpenClawProviders?: ProviderOption[]
    selectableHermesProviders?: ProviderOption[]
    setupProviderId?: string
    createHarnessAgent?: (
      input: Parameters<RecordedInput['input']['createHarnessAgent']>[0],
    ) => Promise<HarnessAgent>
    createOpenClawAgent?: (
      input: OpenClawAgentMutationInput,
    ) => Promise<{ agent: AgentEntry }>
    deleteHarnessAgent?: (agentId: string) => Promise<unknown>
    deleteOpenClawAgent?: (agentId: string) => Promise<unknown>
    setupOpenClaw?: (input: OpenClawSetupInput) => Promise<unknown>
  } = {},
): RecordedInput {
  const navigateCalls: string[] = []
  const createOpenClawAgentCalls: OpenClawAgentMutationInput[][] = []
  const createHarnessAgentCalls: RecordedInput['createHarnessAgentCalls'] = []
  const deleteOpenClawAgentCalls: string[][] = []
  const deleteHarnessAgentCalls: string[][] = []
  const setupOpenClawCalls: OpenClawSetupInput[][] = []
  const setCliAuthModalOpenCalls: boolean[] = []
  const setCreateErrorCalls: (string | null)[] = []
  const setCreateOpenCalls: boolean[] = []
  const setDeletingAgentKeyCalls: (string | null)[] = []
  const setNewNameCalls: string[] = []
  const setPageErrorCalls: (string | null)[] = []
  const setSetupOpenCalls: boolean[] = []
  const {
    createHarnessAgent: createHarnessAgentImpl,
    createOpenClawAgent: createOpenClawAgentImpl,
    deleteHarnessAgent: deleteHarnessAgentImpl,
    deleteOpenClawAgent: deleteOpenClawAgentImpl,
    setupOpenClaw: setupOpenClawImpl,
    ...restOverrides
  } = overrides
  const deletingKeyAtDeleteStart: (string | null)[] = []

  const input: RecordedInput['input'] = {
    createProviderId: 'openai/main',
    createRuntime: 'openclaw',
    createHermesProviderId: 'hermes/work-llm',
    harnessModelId: '',
    harnessReasoningEffort: '',
    navigate: ((to: string) => {
      navigateCalls.push(to)
    }) as unknown as NavigateFunction,
    newName: 'My Review Bot',
    selectableOpenClawProviders: [makeOpenClawProvider()],
    selectableHermesProviders: [makeHermesProvider()],
    setupProviderId: 'openai/main',
    createHarnessAgent: (request) => {
      createHarnessAgentCalls.push([request])
      return createHarnessAgentImpl
        ? createHarnessAgentImpl(request)
        : Promise.resolve(makeHarnessAgent())
    },
    createOpenClawAgent: (request) => {
      createOpenClawAgentCalls.push([request])
      return createOpenClawAgentImpl
        ? createOpenClawAgentImpl(request)
        : Promise.resolve({
            agent: {
              agentId: 'claw-created',
              name: 'my-review-bot',
              workspace: 'claw',
            },
          })
    },
    deleteHarnessAgent: (agentId) => {
      deleteHarnessAgentCalls.push([agentId])
      return deleteHarnessAgentImpl
        ? deleteHarnessAgentImpl(agentId)
        : Promise.resolve(undefined)
    },
    deleteOpenClawAgent: (agentId) => {
      deleteOpenClawAgentCalls.push([agentId])
      if (deleteOpenClawAgentImpl) {
        return deleteOpenClawAgentImpl(agentId)
      }
      deletingKeyAtDeleteStart.push(setDeletingAgentKeyCalls.at(-1) ?? null)
      return Promise.resolve(undefined)
    },
    setCliAuthModalOpen: (open) => {
      setCliAuthModalOpenCalls.push(open)
    },
    setCreateError: (error) => {
      setCreateErrorCalls.push(error)
    },
    setCreateOpen: (open) => {
      setCreateOpenCalls.push(open)
    },
    setDeletingAgentKey: (key) => {
      setDeletingAgentKeyCalls.push(key)
    },
    setNewName: (name) => {
      setNewNameCalls.push(name)
    },
    setPageError: (error) => {
      setPageErrorCalls.push(error)
    },
    setSetupOpen: (open) => {
      setSetupOpenCalls.push(open)
    },
    setupOpenClaw: (request) => {
      setupOpenClawCalls.push([request])
      return setupOpenClawImpl
        ? setupOpenClawImpl(request)
        : Promise.resolve(undefined)
    },
    ...restOverrides,
  }

  return {
    input,
    navigateCalls,
    createOpenClawAgentCalls,
    createHarnessAgentCalls,
    deleteOpenClawAgentCalls,
    deleteHarnessAgentCalls,
    setupOpenClawCalls,
    setCliAuthModalOpenCalls,
    setCreateErrorCalls,
    setCreateOpenCalls,
    setDeletingAgentKeyCalls,
    setNewNameCalls,
    setPageErrorCalls,
    setSetupOpenCalls,
    deletingKeyAtDeleteStart,
  }
}

/** Lets the fire-and-forget create handlers settle before asserting. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('agentsPageActionsContract', () => {
  describe('createAgentPageActions', () => {
    describe('runWithPageErrorHandling', () => {
      it('clears a stale page error before the wrapped work runs', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        const pageErrorCallsAtWorkStart: (string | null)[][] = []
        await actions.runWithPageErrorHandling(async () => {
          pageErrorCallsAtWorkStart.push([...recorded.setPageErrorCalls])
        })

        expect(pageErrorCallsAtWorkStart).toEqual([[null]])
      })

      it('leaves the page error cleared when the work succeeds', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        await actions.runWithPageErrorHandling(async () => {})

        expect(recorded.setPageErrorCalls).toEqual([null])
      })

      it('records an Error message as the page error instead of rethrowing', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        await actions.runWithPageErrorHandling(async () => {
          throw new Error('gateway offline')
        })

        expect(recorded.setPageErrorCalls.at(-1)).toBe('gateway offline')
      })

      it('stringifies a non-Error rejection as the page error', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        await actions.runWithPageErrorHandling(async () => {
          throw 'plain string failure'
        })

        expect(recorded.setPageErrorCalls.at(-1)).toBe('plain string failure')
      })
    })

    describe('handleSetup', () => {
      it('sets up the selected LLM provider and closes the setup dialog', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        await actions.handleSetup()

        expect(recorded.setupOpenClawCalls).toEqual([
          [
            {
              providerType: 'openai',
              providerName: 'OpenAI',
              modelId: 'gpt-5-main',
            },
          ],
        ])
        expect(recorded.setSetupOpenCalls).toEqual([false])
        expect(recorded.setCliAuthModalOpenCalls).toEqual([])
      })

      it('passes the selected provider credentials through on setup', async () => {
        const recorded = makeRecordedInput({
          selectableOpenClawProviders: [
            makeOpenClawProvider({
              baseUrl: 'https://api.example.com',
              apiKey: 'sk-setup',
            }),
          ],
        })
        const actions = createAgentPageActions(recorded.input)

        await actions.handleSetup()

        expect(recorded.setupOpenClawCalls).toEqual([
          [
            {
              providerType: 'openai',
              providerName: 'OpenAI',
              baseUrl: 'https://api.example.com',
              apiKey: 'sk-setup',
              modelId: 'gpt-5-main',
            },
          ],
        ])
      })

      it('routes CLI providers to the CLI auth modal without provider credentials', async () => {
        const recorded = makeRecordedInput({
          setupProviderId: 'claude-cli/claude-sonnet-4-6',
          selectableOpenClawProviders: [
            makeOpenClawProvider({
              id: 'claude-cli/claude-sonnet-4-6',
              type: 'claude-cli',
              name: 'Anthropic Claude CLI',
              modelId: 'claude-sonnet-4-6',
              baseUrl: 'https://must-not-pass.example.com',
              apiKey: 'sk-must-not-pass',
            }),
          ],
        })
        const actions = createAgentPageActions(recorded.input)

        await actions.handleSetup()

        const request = recorded.setupOpenClawCalls[0]?.[0]
        expect(request?.providerType).toBe('claude-cli')
        expect(request?.providerName).toBeUndefined()
        expect(request?.baseUrl).toBeUndefined()
        expect(request?.apiKey).toBeUndefined()
        expect(request?.modelId).toBe('claude-sonnet-4-6')
        expect(recorded.setSetupOpenCalls).toEqual([false])
        expect(recorded.setCliAuthModalOpenCalls).toEqual([true])
      })

      it('surfaces a setup failure as the page error and keeps the dialog open', async () => {
        const recorded = makeRecordedInput({
          setupOpenClaw: async () => {
            throw new Error('setup channel unavailable')
          },
        })
        const actions = createAgentPageActions(recorded.input)

        await actions.handleSetup()

        expect(recorded.setPageErrorCalls.at(-1)).toBe(
          'setup channel unavailable',
        )
        expect(recorded.setSetupOpenCalls).toEqual([])
      })
    })

    describe('handleCreate', () => {
      it('does nothing when the name is blank', async () => {
        const recorded = makeRecordedInput({ newName: '   ' })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        expect(recorded.createOpenClawAgentCalls).toEqual([])
        expect(recorded.setCreateOpenCalls).toEqual([])
        expect(recorded.navigateCalls).toEqual([])
      })

      it('creates a slug-normalized OpenClaw agent and navigates to it', async () => {
        const recorded = makeRecordedInput({
          newName: '  My Review Bot ',
          createOpenClawAgent: async () => ({
            agent: {
              agentId: 'claw-42',
              name: 'my-review-bot',
              workspace: 'claw',
            },
          }),
        })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        expect(recorded.createOpenClawAgentCalls).toEqual([
          [
            {
              name: 'my-review-bot',
              providerType: 'openai',
              providerName: 'OpenAI',
              modelId: 'gpt-5-main',
            },
          ],
        ])
        expect(recorded.setCreateOpenCalls).toEqual([false])
        expect(recorded.setNewNameCalls).toEqual([''])
        expect(recorded.navigateCalls).toEqual(['/agents/claw-42'])
      })

      it('reports the agent-created analytics event for the openclaw runtime', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        const created = logMetricCalls.find(
          (call) => call.eventName === AGENT_CREATED_EVENT,
        )
        expect(created?.properties.runtime).toBe('openclaw')
        expect(created?.properties.provider_type).toBe('openai')
      })

      it('creates a CLI-backed OpenClaw agent without provider credentials', async () => {
        const recorded = makeRecordedInput({
          createProviderId: 'claude-cli/claude-opus-4-6',
          selectableOpenClawProviders: [
            makeOpenClawProvider({
              id: 'claude-cli/claude-opus-4-6',
              type: 'claude-cli',
              name: 'Anthropic Claude CLI',
              modelId: 'claude-opus-4-6',
            }),
          ],
        })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        const request = recorded.createOpenClawAgentCalls[0]?.[0]
        expect(request?.name).toBe('my-review-bot')
        expect(request?.providerType).toBe('claude-cli')
        expect(request?.providerName).toBeUndefined()
        expect(request?.baseUrl).toBeUndefined()
        expect(request?.apiKey).toBeUndefined()
        expect(request?.modelId).toBe('claude-opus-4-6')
      })

      it('keeps the dialog open with a create error when OpenClaw creation fails', async () => {
        const recorded = makeRecordedInput({
          createOpenClawAgent: async () => {
            throw new Error('name already taken')
          },
        })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        expect(recorded.setCreateErrorCalls.at(-1)).toBe('name already taken')
        expect(recorded.setCreateOpenCalls).toEqual([])
        expect(recorded.setNewNameCalls).toEqual([])
        expect(recorded.navigateCalls).toEqual([])
      })

      it('routes claude and codex runtimes to the harness creator with a trimmed name', async () => {
        for (const runtime of ['claude', 'codex'] as const) {
          const recorded = makeRecordedInput({
            createRuntime: runtime,
            newName: '  Harness Bot ',
            createHarnessAgent: async () =>
              makeHarnessAgent({ id: `created-${runtime}` }),
          })
          const actions = createAgentPageActions(recorded.input)

          actions.handleCreate()
          await flushAsync()

          expect(recorded.createHarnessAgentCalls).toEqual([
            [{ name: 'Harness Bot', adapter: runtime }],
          ])
          expect(recorded.createOpenClawAgentCalls).toEqual([])
        }
      })

      it('creates harness agents from the chosen model and reasoning effort', async () => {
        const configured = makeRecordedInput({
          createRuntime: 'codex',
          harnessModelId: 'gpt-5.3',
          harnessReasoningEffort: 'low',
        })
        await createAgentPageActions(configured.input).handleCreate()
        await flushAsync()
        expect(configured.createHarnessAgentCalls).toEqual([
          [
            {
              name: 'My Review Bot',
              adapter: 'codex',
              modelId: 'gpt-5.3',
              reasoningEffort: 'low',
            },
          ],
        ])

        const blankFields = makeRecordedInput({ createRuntime: 'claude' })
        createAgentPageActions(blankFields.input).handleCreate()
        await flushAsync()
        expect(blankFields.createHarnessAgentCalls).toEqual([
          [{ name: 'My Review Bot', adapter: 'claude' }],
        ])
      })

      it('closes the dialog, clears the name, navigates and reports the runtime for harness creates', async () => {
        const recorded = makeRecordedInput({
          createRuntime: 'codex',
          harnessModelId: 'gpt-5.3',
          createHarnessAgent: async () =>
            makeHarnessAgent({ id: 'harness-created' }),
        })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        expect(recorded.setCreateOpenCalls).toEqual([false])
        expect(recorded.setNewNameCalls).toEqual([''])
        expect(recorded.navigateCalls).toEqual(['/agents/harness-created'])
        const created = logMetricCalls.find(
          (call) => call.eventName === AGENT_CREATED_EVENT,
        )
        expect(created?.properties.runtime).toBe('codex')
        expect(created?.properties.model_id).toBe('gpt-5.3')
      })

      it('builds hermes agents from the selected hermes provider, ignoring the harness model field', async () => {
        const recorded = makeRecordedInput({
          createRuntime: 'hermes',
          harnessModelId: 'ignored-model',
          harnessReasoningEffort: 'high',
        })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        expect(recorded.createHarnessAgentCalls).toEqual([
          [
            {
              name: 'My Review Bot',
              adapter: 'hermes',
              modelId: 'qwen3-max',
              reasoningEffort: 'high',
              providerType: 'custom-llm',
              apiKey: 'sk-hermes',
              baseUrl: 'https://llm.internal',
            },
          ],
        ])
        const created = logMetricCalls.find(
          (call) => call.eventName === AGENT_CREATED_EVENT,
        )
        expect(created?.properties.model_id).toBe('qwen3-max')
        expect(created?.properties.provider_type).toBe('custom-llm')
      })

      it('keeps the dialog open with a create error when harness creation fails', async () => {
        const recorded = makeRecordedInput({
          createRuntime: 'claude',
          createHarnessAgent: async () => {
            throw new Error('harness spawn failed')
          },
        })
        const actions = createAgentPageActions(recorded.input)

        actions.handleCreate()
        await flushAsync()

        expect(recorded.setCreateErrorCalls.at(-1)).toBe('harness spawn failed')
        expect(recorded.setCreateOpenCalls).toEqual([])
        expect(recorded.navigateCalls).toEqual([])
      })
    })

    describe('handleDelete', () => {
      it('deletes OpenClaw agents through the OpenClaw deleter and clears the busy marker', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        await actions.handleDelete(
          makeAgentListItem({
            key: 'openclaw:claw-9',
            agentId: 'claw-9',
            source: 'openclaw',
          }),
        )

        expect(recorded.deleteOpenClawAgentCalls).toEqual([['claw-9']])
        expect(recorded.deleteHarnessAgentCalls).toEqual([])
        expect(recorded.deletingKeyAtDeleteStart).toEqual(['openclaw:claw-9'])
        expect(recorded.setDeletingAgentKeyCalls.at(-1)).toBe(null)
        const deleted = logMetricCalls.find(
          (call) => call.eventName === AGENT_DELETED_EVENT,
        )
        expect(deleted?.properties.runtime).toBe('openclaw')
        expect(deleted?.properties.agent_id).toBe('claw-9')
      })

      it('deletes harness agents through the harness deleter', async () => {
        const recorded = makeRecordedInput()
        const actions = createAgentPageActions(recorded.input)

        await actions.handleDelete(
          makeAgentListItem({
            key: 'agent-harness:h-3',
            agentId: 'h-3',
            source: 'agent-harness',
          }),
        )

        expect(recorded.deleteHarnessAgentCalls).toEqual([['h-3']])
        expect(recorded.deleteOpenClawAgentCalls).toEqual([])
        const deleted = logMetricCalls.find(
          (call) => call.eventName === AGENT_DELETED_EVENT,
        )
        expect(deleted?.properties.runtime).toBe('agent-harness')
        expect(deleted?.properties.agent_id).toBe('h-3')
      })

      it('surfaces a delete failure as the page error and still clears the busy marker', async () => {
        const recorded = makeRecordedInput({
          deleteOpenClawAgent: async () => {
            throw new Error('podman is down')
          },
        })
        const actions = createAgentPageActions(recorded.input)

        await actions.handleDelete(
          makeAgentListItem({
            key: 'openclaw:claw-9',
            agentId: 'claw-9',
            source: 'openclaw',
          }),
        )

        expect(recorded.setPageErrorCalls.at(-1)).toBe('podman is down')
        expect(recorded.setDeletingAgentKeyCalls).toEqual([
          'openclaw:claw-9',
          null,
        ])
      })
    })
  })
})
