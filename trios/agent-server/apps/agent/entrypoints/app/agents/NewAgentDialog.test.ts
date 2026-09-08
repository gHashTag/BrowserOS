/**
 * First contract suite for NewAgentDialog.tsx.
 *
 * The module exports exactly one symbol, NewAgentDialog, and this file pins
 * the behaviour that already exists rather than redesigning anything: the
 * sections rendered for each runtime, the create-error surface, the gating of
 * the Create button, and the wiring from user actions to the callbacks the
 * parent supplies.
 *
 * Rendering seam: the dialog shell from '@/components/ui/dialog' is Radix
 * based and mounts its content through a DOM portal, which no server renderer
 * supports and no DOM is available here. The suite stubs only that shell (its
 * children render inline while the dialog is open), so everything the subject
 * itself renders stays the real component tree. Assertions reference only
 * text, ids and attributes the subject controls, never the stub's own tags.
 *
 * User actions (typing, the Enter key, Cancel, choosing an adapter) are driven
 * through the handlers the subject attaches to those fields, since static
 * markup cannot dispatch DOM events.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import {
  type ComponentProps,
  createElement,
  type FC,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  HarnessAdapterDescriptor,
  HarnessAgentAdapter,
} from './agent-harness-types'
import type { CreateAgentRuntime, ProviderOption } from './agents-page-types'
import type { OpenClawCliProvider } from './openclaw-cli-providers'

mock.module('@/components/ui/dialog', () => {
  const passthrough: FC<{ children?: ReactNode }> = ({ children }) =>
    children ?? null
  const openGate: FC<{ open?: boolean; children?: ReactNode }> = ({
    open,
    children,
  }) => (open ? (children ?? null) : null)
  const titleShell: FC<{ children?: ReactNode }> = ({ children }) =>
    createElement('h2', { 'data-dialog-title': '' }, children)
  return {
    Dialog: openGate,
    DialogContent: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: titleShell,
    DialogTrigger: passthrough,
    DialogClose: passthrough,
  }
})

import { NewAgentDialog } from './NewAgentDialog'

type DialogProps = ComponentProps<typeof NewAgentDialog>

const ADAPTERS: HarnessAdapterDescriptor[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    defaultModelId: 'sonnet',
    defaultReasoningEffort: 'medium',
    modelControl: 'runtime-supported',
    models: [
      { id: 'sonnet', label: 'Sonnet', recommended: true },
      { id: 'opus', label: 'Opus' },
    ],
    reasoningEfforts: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High', recommended: true },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    defaultModelId: 'gpt-5',
    defaultReasoningEffort: 'medium',
    modelControl: 'best-effort',
    models: [{ id: 'gpt-5', label: 'GPT-5' }],
    reasoningEfforts: [{ id: 'medium', label: 'Medium' }],
  },
]

const PROVIDERS: ProviderOption[] = [
  {
    id: 'prov-anthropic',
    type: 'anthropic',
    name: 'Anthropic',
    modelId: 'claude-x',
  },
  { id: 'prov-openai', type: 'openai', name: 'OpenAI', modelId: 'gpt-x' },
]

const CLI_PROVIDER: OpenClawCliProvider = {
  id: 'claude-cli',
  displayName: 'Anthropic Claude CLI',
  description: 'Uses your Claude.ai subscription via the Claude Code CLI',
  models: ['claude-sonnet'],
  authLoginCommand: 'claude /login',
}

const noop = () => {}

const baseProps = (overrides: Partial<DialogProps> = {}): DialogProps => ({
  adapters: ADAPTERS,
  canManageOpenClaw: true,
  createError: null,
  createRuntime: 'openclaw',
  creating: false,
  defaultProviderId: 'prov-anthropic',
  harnessAdapterId: 'claude',
  harnessModelId: 'sonnet',
  harnessReasoningEffort: 'medium',
  hermesProviders: PROVIDERS,
  hermesSelectedProviderId: 'prov-anthropic',
  name: 'research-bot',
  open: true,
  providers: PROVIDERS,
  selectedCliProvider: undefined,
  selectedProviderId: 'prov-anthropic',
  cliAuthError: null,
  cliAuthLoading: false,
  cliAuthStatus: undefined,
  onConnectCliProvider: noop,
  onCreate: noop,
  onOpenChange: noop,
  onRuntimeChange: noop,
  onHarnessAdapterChange: noop,
  onHarnessModelChange: noop,
  onHarnessReasoningChange: noop,
  onHermesProviderChange: noop,
  onNameChange: noop,
  onProviderChange: noop,
  ...overrides,
})

const renderDialog = (overrides: Partial<DialogProps> = {}): string =>
  renderToStaticMarkup(createElement(NewAgentDialog, baseProps(overrides)))

const elementsOf = (
  node: ReactNode,
  found: ReactElement[] = [],
): ReactElement[] => {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, found)
    return found
  }
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const el = node as ReactElement
    found.push(el)
    elementsOf((el.props as { children?: ReactNode }).children, found)
  }
  return found
}

const propsOf = (el: ReactElement | undefined): Record<string, any> =>
  (el?.props ?? {}) as Record<string, any>

const treeFor = (overrides: Partial<DialogProps> = {}): ReactElement => {
  const root = NewAgentDialog(baseProps(overrides))
  if (typeof root !== 'object' || root === null || !('props' in root)) {
    throw new Error('NewAgentDialog returned no root element')
  }
  return root
}

const buttonTagBefore = (html: string, text: string): string => {
  const end = html.indexOf(`>${text}</button>`)
  expect(end).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf('<button', end), end)
}

const createDisabled = (html: string): boolean =>
  buttonTagBefore(html, 'Create').includes('disabled=""')

const cancelDisabled = (html: string): boolean =>
  buttonTagBefore(html, 'Cancel').includes('disabled=""')

const wiredProps = (): Partial<DialogProps> => ({
  onNameChange: mock((_value: string) => {}),
  onCreate: mock(() => {}),
  onOpenChange: mock((_nextOpen: boolean) => {}),
  onRuntimeChange: mock((_runtime: CreateAgentRuntime) => {}),
  onHarnessAdapterChange: mock((_adapter: HarnessAgentAdapter) => {}),
})

describe('NewAgentDialogTsxContract', () => {
  it('NewAgentDialog renders the create-agent surface per runtime, gates the Create button, and forwards user actions', () => {
    // --- dialog frame and base fields ---
    const base = renderDialog()
    expect(base).toContain('New Agent')
    expect(base).toContain('for="agent-name"')
    expect(base).toContain('Name</label>')
    expect(base).toContain('for="agent-runtime"')
    expect(base).toContain('Adapter</label>')
    expect(base).toContain('id="agent-runtime"')

    // --- create-error feedback appears only when creation failed ---
    expect(base).not.toContain('Create failed')
    const errored = renderDialog({ createError: 'Gateway exploded' })
    expect(errored).toContain('Create failed')
    expect(errored).toContain('Gateway exploded')

    // --- name field mirrors state and switches copy per runtime ---
    expect(base).toContain('value="research-bot"')
    expect(base).toContain('placeholder="research-agent"')
    expect(renderDialog({ createRuntime: 'claude' })).toContain(
      'placeholder="Review bot"',
    )

    // --- openclaw runtime: llm provider section, gateway guard ---
    expect(base).toContain('id="provider-select"')
    expect(base).not.toContain('No compatible LLM providers configured')
    expect(renderDialog({ providers: [] })).toContain(
      'No compatible LLM providers configured',
    )
    expect(base).not.toContain('OpenClaw is not ready')
    expect(renderDialog({ canManageOpenClaw: false })).toContain(
      'OpenClaw is not ready',
    )

    // --- cli provider status panel only while a cli provider is chosen ---
    expect(base).not.toContain('Anthropic Claude CLI')
    expect(
      renderDialog({
        selectedCliProvider: CLI_PROVIDER,
        cliAuthLoading: true,
      }),
    ).toContain('Checking Anthropic Claude CLI status')
    expect(
      renderDialog({
        selectedCliProvider: CLI_PROVIDER,
        cliAuthStatus: { installed: true, loggedIn: false },
      }),
    ).toContain('Anthropic Claude CLI not set up')
    const cliConnected = renderDialog({
      selectedCliProvider: CLI_PROVIDER,
      cliAuthStatus: {
        installed: true,
        loggedIn: true,
        accountLabel: 'team@example.com',
      },
    })
    expect(cliConnected).toContain('Connected to Anthropic Claude CLI')
    expect(cliConnected).toContain('team@example.com')

    // --- classic harness runtime: model and reasoning, no llm section ---
    const classic = renderDialog({ createRuntime: 'claude' })
    expect(classic).toContain('Model</label>')
    expect(classic).toContain('id="harness-model"')
    expect(classic).toContain('Reasoning</label>')
    expect(classic).toContain('id="harness-effort"')
    expect(classic).not.toContain('id="provider-select"')

    // --- hermes runtime: llm section, no model controls ---
    const hermes = renderDialog({ createRuntime: 'hermes' })
    expect(hermes).toContain('id="provider-select"')
    expect(hermes).not.toContain('id="harness-model"')
    expect(hermes).not.toContain('id="harness-effort"')
    expect(base).not.toContain('id="harness-model"')

    // --- footer buttons and creation gating ---
    expect(createDisabled(base)).toBe(false)
    expect(cancelDisabled(base)).toBe(false)
    expect(base).not.toContain('animate-spin')
    expect(createDisabled(renderDialog({ name: '' }))).toBe(true)
    expect(createDisabled(renderDialog({ name: '   ' }))).toBe(true)
    expect(createDisabled(renderDialog({ creating: true }))).toBe(true)
    expect(cancelDisabled(renderDialog({ creating: true }))).toBe(true)
    expect(renderDialog({ creating: true })).toContain('animate-spin')
    expect(createDisabled(renderDialog({ canManageOpenClaw: false }))).toBe(
      true,
    )
    expect(
      createDisabled(
        renderDialog({
          selectedCliProvider: CLI_PROVIDER,
          cliAuthStatus: { installed: true, loggedIn: false },
        }),
      ),
    ).toBe(true)
    expect(
      createDisabled(
        renderDialog({
          selectedCliProvider: CLI_PROVIDER,
          cliAuthStatus: { installed: true, loggedIn: true },
        }),
      ),
    ).toBe(false)
    expect(
      createDisabled(
        renderDialog({ createRuntime: 'hermes', hermesProviders: [] }),
      ),
    ).toBe(true)
    expect(
      createDisabled(
        renderDialog({ createRuntime: 'hermes', hermesSelectedProviderId: '' }),
      ),
    ).toBe(true)
    expect(createDisabled(renderDialog({ providers: [] }))).toBe(true)
    expect(createDisabled(renderDialog({ createRuntime: 'claude' }))).toBe(
      false,
    )
    expect(
      createDisabled(renderDialog({ createRuntime: 'claude', adapters: [] })),
    ).toBe(true)

    // --- typing in the name field reaches onNameChange ---
    const wired = wiredProps()
    const root = treeFor(wired)
    const nameField = elementsOf(root).find(
      (el) => propsOf(el).id === 'agent-name',
    )
    expect(nameField).toBeDefined()
    propsOf(nameField).onChange({ target: { value: 'renamed-bot' } })
    expect(wired.onNameChange).toHaveBeenCalledWith('renamed-bot')

    // --- Enter submits only while creation is allowed ---
    propsOf(nameField).onKeyDown({ key: 'Enter' })
    expect(wired.onCreate).toHaveBeenCalledTimes(1)
    propsOf(nameField).onKeyDown({ key: 'Escape' })
    expect(wired.onCreate).toHaveBeenCalledTimes(1)

    const blank = wiredProps()
    const blankField = elementsOf(treeFor({ ...blank, name: '' })).find(
      (el) => propsOf(el).id === 'agent-name',
    )
    propsOf(blankField).onKeyDown({ key: 'Enter' })
    expect(blank.onCreate).toHaveBeenCalledTimes(0)

    // --- Cancel closes the dialog ---
    const closing = wiredProps()
    const cancelButton = elementsOf(treeFor(closing)).find(
      (el) =>
        propsOf(el).children === 'Cancel' &&
        typeof propsOf(el).onClick === 'function',
    )
    expect(cancelButton).toBeDefined()
    propsOf(cancelButton).onClick()
    expect(closing.onOpenChange).toHaveBeenCalledWith(false)

    // --- choosing an adapter routes the runtime change ---
    const routing = wiredProps()
    const runtimePicker = elementsOf(treeFor(routing)).find(
      (el) =>
        propsOf(el).value === 'openclaw' &&
        typeof propsOf(el).onValueChange === 'function',
    )
    expect(runtimePicker).toBeDefined()
    propsOf(runtimePicker).onValueChange('hermes')
    propsOf(runtimePicker).onValueChange('openclaw')
    propsOf(runtimePicker).onValueChange('bogus')
    expect(routing.onRuntimeChange).toHaveBeenCalledTimes(2)
    expect(routing.onRuntimeChange).toHaveBeenNthCalledWith(1, 'hermes')
    expect(routing.onRuntimeChange).toHaveBeenNthCalledWith(2, 'openclaw')
    expect(routing.onHarnessAdapterChange).toHaveBeenCalledTimes(1)
    expect(routing.onHarnessAdapterChange).toHaveBeenCalledWith('hermes')
  })

  afterAll(() => {
    mock.restore()
  })
})
