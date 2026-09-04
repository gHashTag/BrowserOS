/**
 * Contract suite for trios/agent-server/apps/agent/components/elements/AppSelector.tsx.
 *
 * The module exports one symbol, the AppSelector component. This suite pins
 * that component's behaviour as it stands today, without modifying it: the
 * picker starts closed and renders its children as the trigger, opens on
 * trigger activation, partitions managed servers into Connected /
 * Needs authentication / Available groups, excludes already-created servers
 * from the catalog, filters every group through the search field, shows the
 * empty state when nothing matches, adds servers on selection (opening the
 * OAuth window or the API-key dialog), reports failures through toasts and
 * Sentry, closes the API-key dialog on success, and closes itself when the
 * manage-apps button is used. The `side` prop is passed through to the
 * popover content, defaulting to "bottom".
 *
 * Exports and how each is covered:
 *   - AppSelector: exercised end-to-end by the assertions below.
 *
 * No export is blocked by a live dependency, so the list of untestable
 * exports required by the issue is empty.
 *
 * The suite runs under `bun test` with no network, no database and no
 * container: the agent-server HTTP hooks, browser storage, metrics, Sentry
 * and the cmdk/Radix view primitives are replaced through mock.module with
 * minimal in-memory stand-ins, and a tiny DOM shim is installed so the real
 * react-dom/client renderer can mount the unmodified component.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

/* ------------------------------------------------------------------ *
 * A DOM shim just complete enough for react-dom/client to mount,
 * update and dispatch click events on plain elements.
 * ------------------------------------------------------------------ */

class FakeEventTarget {
  parentNode: FakeNode | null = null
  listeners: Record<string, Array<(event: unknown) => void>> = {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners[type]
    if (existing) existing.push(listener)
    else this.listeners[type] = [listener]
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter(
      (existing) => existing !== listener,
    )
  }

  dispatchEvent(event: Record<string, unknown>): boolean {
    const type = event.type as string
    event.target ??= this
    event.timeStamp ??= Date.now()
    let node: FakeNode | null = this as unknown as FakeNode
    while (node) {
      event.currentTarget = node
      for (const listener of [...(node.listeners[type] ?? [])]) {
        listener(event)
        if (event.__stopped) break
      }
      if (event.__stopped || event.bubbles === false) break
      node = node.parentNode
    }
    return true
  }
}

class FakeNode extends FakeEventTarget {
  nodeType: number
  nodeName: string
  tagName: string
  ownerDocument: FakeDocument
  childNodes: FakeNode[] = []
  namespaceURI: string | null = null
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  value = ''

  constructor(nodeType: number, name: string, ownerDocument: FakeDocument) {
    super()
    this.nodeType = nodeType
    this.nodeName = name
    this.tagName = name
    this.ownerDocument = ownerDocument
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null)
  }

  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = reference
      ? this.childNodes.indexOf(reference)
      : this.childNodes.length
    this.childNodes.splice(
      index === -1 ? this.childNodes.length : index,
      0,
      child,
    )
    child.parentNode = this
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child)
    if (index !== -1) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(text: string) {
    this.childNodes.forEach((child) => {
      child.parentNode = null
    })
    this.childNodes = []
    if (text) this.appendChild(this.ownerDocument.createTextNode(text))
  }
}

class FakeText extends FakeNode {
  private data: string

  constructor(text: string, ownerDocument: FakeDocument) {
    super(3, '#text', ownerDocument)
    this.data = text
  }

  get nodeValue(): string | null {
    return this.data
  }

  set nodeValue(text: string | null) {
    this.data = text ?? ''
  }

  override get textContent(): string {
    return this.data
  }

  override set textContent(text: string) {
    this.data = text ?? ''
  }
}

class FakeElement extends FakeNode {
  attributes: Record<string, string> = {}

  constructor(tag: string, ownerDocument: FakeDocument) {
    super(1, tag.toUpperCase(), ownerDocument)
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value)
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null
  }

  removeAttribute(name: string): void {
    delete this.attributes[name]
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes
  }

  get className(): string {
    return this.getAttribute('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', value)
  }

  getBoundingClientRect(): {
    top: number
    left: number
    bottom: number
    right: number
    width: number
    height: number
  } {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }
  }

  focus(): void {}

  blur(): void {}

  click(): void {
    this.dispatchEvent({
      type: 'click',
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      detail: 1,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.__stopped = true
      },
      stopImmediatePropagation() {
        this.__stopped = true
      },
    })
  }

  contains(node: FakeNode | null): boolean {
    let current: FakeNode | null = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }
}

class FakeDocumentFragment extends FakeNode {
  constructor(ownerDocument: FakeDocument) {
    super(11, '#document-fragment', ownerDocument)
  }
}

class FakeDocument extends FakeEventTarget {
  override nodeType = 9
  override nodeName = '#document'
  body: FakeElement
  documentElement: FakeElement
  activeElement: FakeElement | null = null
  defaultView: Record<string, unknown>

  constructor(defaultView: Record<string, unknown>) {
    super()
    this.defaultView = defaultView
    this.documentElement = new FakeElement('html', this)
    this.body = new FakeElement('body', this)
    this.documentElement.appendChild(this.body)
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }

  createElementNS(namespace: string, tag: string): FakeElement {
    const element = new FakeElement(tag, this)
    element.namespaceURI = namespace
    return element
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text, this)
  }

  createDocumentFragment(): FakeDocumentFragment {
    return new FakeDocumentFragment(this)
  }

  getElementById(): FakeElement | null {
    return null
  }
}

/**
 * Everything the suite installs on globalThis, so afterAll can put the
 * process back the way a sibling test file expects to find it.
 */
const installedGlobals: Array<[string, unknown]> = []

function defineGlobal(name: string, value: unknown): void {
  installedGlobals.push([name, (globalThis as Record<string, unknown>)[name]])
  ;(globalThis as Record<string, unknown>)[name] = value
}

const fakeWindow: Record<string, unknown> = {
  navigator: { userAgent: 'bun-test-app-selector' },
  HTMLIFrameElement: class HTMLIFrameElement {},
  open: (url: string, target?: string) => {
    recorded.windowOpen.push({ url, target })
    return { focus: () => {} }
  },
}

const fakeDocument = new FakeDocument(fakeWindow)
fakeWindow.document = fakeDocument

defineGlobal('document', fakeDocument)
defineGlobal('window', fakeWindow)
defineGlobal('navigator', fakeWindow.navigator)
defineGlobal('IS_REACT_ACT_ENVIRONMENT', true)
defineGlobal('chrome', {
  runtime: {
    getURL: (path: string) => `chrome-extension://test-extension-id${path}`,
    getManifest: () => ({ version: '0.0.0-test' }),
  },
})

/* ------------------------------------------------------------------ *
 * In-memory stand-ins for the agent-server and browser dependencies.
 * ------------------------------------------------------------------ */

interface CatalogServer {
  name: string
  description: string
}

interface CreatedServer {
  id: string
  displayName: string
  type: 'managed' | 'custom'
  managedServerName?: string
  managedServerDescription?: string
  config?: { url?: string; description?: string }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error }

interface AddServerResponse {
  success: boolean
  serverName: string
  strataId: string
  addedServers: string[]
  oauthUrl?: string
  apiKeyUrl?: string
}

const env = {
  created: [] as CreatedServer[],
  catalog: { servers: [] as CatalogServer[] },
  integrations: {
    integrations: [] as { name: string; is_authenticated: boolean }[],
  },
  integrationsLoading: false,
  addOutcome: { ok: true, value: {} } as Outcome<AddServerResponse>,
  submitOutcome: { ok: true, value: {} } as Outcome<{
    success: boolean
    serverName: string
  }>,
}

const recorded = {
  addServer: [] as CreatedServer[],
  addTriggerCalls: [] as { serverName: string }[],
  submitTriggerCalls: [] as {
    serverName: string
    apiKey: string
    apiKeyUrl: string
  }[],
  trackCalls: [] as { name: string; properties: Record<string, unknown> }[],
  capturedExceptions: [] as unknown[],
  toastErrors: [] as string[],
  toastSuccesses: [] as string[],
  windowOpen: [] as { url: string; target?: string }[],
  mutateIntegrationsCalls: 0,
}

/** Latest props the mocked controlled input received, for driving typing. */
const commandInputState: {
  value: string
  onValueChange: ((value: string) => void) | null
} = { value: '', onValueChange: null }

/** Latest props the mocked API-key dialog received, for driving submit/close. */
const apiKeyDialogState: {
  open: boolean
  serverName: string
  onSubmit: ((apiKey: string) => void) | null
  onOpenChange: ((open: boolean) => void) | null
} = { open: false, serverName: '', onSubmit: null, onOpenChange: null }

function resetFixtures(): void {
  env.created = [
    {
      id: 'srv-notion',
      displayName: 'Notion',
      type: 'managed',
      managedServerName: 'Notion',
      managedServerDescription: 'Notes and docs',
    },
    {
      id: 'srv-figma',
      displayName: 'Figma',
      type: 'managed',
      managedServerName: 'Figma',
      managedServerDescription: 'Design files',
    },
    {
      id: 'srv-custom',
      displayName: 'My local MCP',
      type: 'custom',
      config: { url: 'http://127.0.0.1:9999/sse' },
    },
  ]
  env.catalog = {
    servers: [
      { name: 'GitHub', description: 'Code hosting and pull requests' },
      { name: 'Slack', description: 'Team chat and notifications' },
      { name: 'Linear', description: 'Issue tracking' },
      // Already created above, so the catalog must not offer them again.
      { name: 'Notion', description: 'Notes and docs' },
      { name: 'Figma', description: 'Design files' },
    ],
  }
  env.integrations = {
    integrations: [
      { name: 'Notion', is_authenticated: true },
      { name: 'Figma', is_authenticated: false },
    ],
  }
  env.integrationsLoading = false
  env.addOutcome = {
    ok: true,
    value: {
      success: true,
      serverName: 'GitHub',
      strataId: 'strata-gh',
      addedServers: ['GitHub'],
      oauthUrl: 'https://oauth.example/github',
    },
  }
  env.submitOutcome = {
    ok: true,
    value: { success: true, serverName: 'Linear' },
  }
  recorded.addServer = []
  recorded.addTriggerCalls = []
  recorded.submitTriggerCalls = []
  recorded.trackCalls = []
  recorded.capturedExceptions = []
  recorded.toastErrors = []
  recorded.toastSuccesses = []
  recorded.windowOpen = []
  recorded.mutateIntegrationsCalls = 0
  commandInputState.value = ''
  commandInputState.onValueChange = null
  apiKeyDialogState.open = false
  apiKeyDialogState.serverName = ''
  apiKeyDialogState.onSubmit = null
  apiKeyDialogState.onOpenChange = null
}

const h = React.createElement

/* --- view-layer stand-ins (cmdk + Radix, reduced to plain elements) --- */

const CommandContext = React.createContext<{
  registerItem: () => () => void
  itemCount: number
}>({ registerItem: () => () => {}, itemCount: 0 })

const PopoverContext = React.createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
}>({ open: false, onOpenChange: () => {} })

function MockCommand(props: Record<string, unknown>) {
  const [itemCount, setItemCount] = React.useState(0)
  const registerItem = React.useCallback(() => {
    setItemCount((count) => count + 1)
    return () => setItemCount((count) => count - 1)
  }, [])
  const value = React.useMemo(
    () => ({ registerItem, itemCount }),
    [registerItem, itemCount],
  )
  return h(CommandContext.Provider, { value }, props.children)
}

function MockCommandInput(props: Record<string, unknown>) {
  commandInputState.value = (props.value as string) ?? ''
  commandInputState.onValueChange =
    (props.onValueChange as (value: string) => void) ?? null
  return h('div', {
    'data-slot': 'command-input',
    'data-value': (props.value as string) ?? '',
  })
}

function MockCommandList(props: Record<string, unknown>) {
  return h('div', { 'data-slot': 'command-list' }, props.children)
}

function MockCommandGroup(props: Record<string, unknown>) {
  return h('div', { 'data-slot': 'command-group' }, props.children)
}

/** Like cmdk, the empty message only shows while zero items are rendered. */
function MockCommandEmpty(props: Record<string, unknown>) {
  const { itemCount } = React.useContext(CommandContext)
  if (itemCount > 0) return null
  return h('div', { 'data-slot': 'command-empty' }, props.children)
}

function MockCommandItem(props: Record<string, unknown>) {
  const { registerItem } = React.useContext(CommandContext)
  React.useEffect(registerItem, [registerItem])
  return h(
    'div',
    {
      'data-slot': 'command-item',
      'data-value': (props.value as string) ?? '',
      onClick: () => {
        const onSelect = props.onSelect as ((value: string) => void) | undefined
        onSelect?.((props.value as string) ?? '')
      },
    },
    props.children,
  )
}

function MockPopover(props: Record<string, unknown>) {
  const value = React.useMemo(
    () => ({
      open: (props.open as boolean) ?? false,
      onOpenChange:
        (props.onOpenChange as (open: boolean) => void) ?? (() => {}),
    }),
    [props.open, props.onOpenChange],
  )
  return h(PopoverContext.Provider, { value }, props.children)
}

function MockPopoverTrigger(props: Record<string, unknown>) {
  const context = React.useContext(PopoverContext)
  const child = props.children as React.ReactElement | undefined
  if (props.asChild && React.isValidElement(child)) {
    const ownOnClick = (child.props as Record<string, unknown>).onClick as
      | ((event: unknown) => void)
      | undefined
    return React.cloneElement(child, {
      onClick: (event: unknown) => {
        ownOnClick?.(event)
        context.onOpenChange(!context.open)
      },
    })
  }
  return h('button', { type: 'button', 'data-slot': 'popover-trigger' }, child)
}

function MockPopoverContent(props: Record<string, unknown>) {
  const context = React.useContext(PopoverContext)
  if (!context.open) return null
  const { side, ...rest } = props
  return h('div', {
    ...rest,
    'data-slot': 'popover-content',
    'data-side': (side as string) ?? '',
  })
}

function MockApiKeyDialog(props: Record<string, unknown>) {
  apiKeyDialogState.open = (props.open as boolean) ?? false
  apiKeyDialogState.serverName = (props.serverName as string) ?? ''
  apiKeyDialogState.onSubmit =
    (props.onSubmit as (apiKey: string) => void) ?? null
  apiKeyDialogState.onOpenChange =
    (props.onOpenChange as (open: boolean) => void) ?? null
  if (!props.open) return null
  return h(
    'div',
    {
      'data-slot': 'api-key-dialog',
      'data-open': 'true',
      'data-server-name': apiKeyDialogState.serverName,
    },
    `API key for ${apiKeyDialogState.serverName}`,
  )
}

function MockMcpServerIcon(props: Record<string, unknown>) {
  return h('span', {
    'data-slot': 'mcp-server-icon',
    'data-server-name': (props.serverName as string) ?? '',
  })
}

function makeIconStub(name: string) {
  return (props: Record<string, unknown>) =>
    h('span', {
      'data-slot': 'lucide-icon',
      'data-icon': name,
      'data-size': String(props?.size ?? ''),
    })
}

/* --- dependency stand-ins --- */

async function addManagedServerTrigger(arg: { serverName: string }) {
  recorded.addTriggerCalls.push({ serverName: arg.serverName })
  if (!env.addOutcome.ok) throw env.addOutcome.error
  return env.addOutcome.value
}

async function submitApiKeyTrigger(arg: {
  serverName: string
  apiKey: string
  apiKeyUrl: string
}) {
  recorded.submitTriggerCalls.push({ ...arg })
  if (!env.submitOutcome.ok) throw env.submitOutcome.error
  return env.submitOutcome.value
}

mock.module('lucide-react', () => ({
  KeyRound: makeIconStub('key-round'),
  Plus: makeIconStub('plus'),
  Settings: makeIconStub('settings'),
}))

mock.module('sonner', () => ({
  toast: {
    error: (message: string) => {
      recorded.toastErrors.push(message)
    },
    success: (message: string) => {
      recorded.toastSuccesses.push(message)
    },
  },
}))

mock.module('@/components/ui/command', () => ({
  Command: MockCommand,
  CommandEmpty: MockCommandEmpty,
  CommandGroup: MockCommandGroup,
  CommandInput: MockCommandInput,
  CommandItem: MockCommandItem,
  CommandList: MockCommandList,
}))

mock.module('@/components/ui/popover', () => ({
  Popover: MockPopover,
  PopoverContent: MockPopoverContent,
  PopoverTrigger: MockPopoverTrigger,
}))

mock.module('@/entrypoints/app/connect-mcp/ApiKeyDialog', () => ({
  ApiKeyDialog: MockApiKeyDialog,
}))

mock.module('@/entrypoints/app/connect-mcp/McpServerIcon', () => ({
  McpServerIcon: MockMcpServerIcon,
}))

mock.module('@/entrypoints/app/connect-mcp/useAddManagedServer', () => ({
  useAddManagedServer: () => ({
    trigger: addManagedServerTrigger,
    isMutating: false,
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetMCPServersList', () => ({
  useGetMCPServersList: () => ({ data: env.catalog }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  useGetUserMCPIntegrations: () => ({
    data: env.integrations,
    isLoading: env.integrationsLoading,
    isFetching: false,
    isSuccess: true,
    mutate: () => {
      recorded.mutateIntegrationsCalls += 1
    },
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useSubmitApiKey', () => ({
  useSubmitApiKey: () => ({
    trigger: submitApiKeyTrigger,
    isMutating: false,
  }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  useMcpServers: () => ({
    servers: env.created,
    addServer: async (server: CreatedServer) => {
      recorded.addServer.push(server)
      env.created = [...env.created, server]
    },
    removeServer: async () => {},
  }),
}))

mock.module('@/lib/mcp/useSyncRemoteIntegrations', () => ({
  useSyncRemoteIntegrations: () => ({ isSyncing: false, hasSynced: true }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: (name: string, properties?: Record<string, unknown>) => {
    recorded.trackCalls.push({ name, properties: properties ?? {} })
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (error: unknown) => {
      recorded.capturedExceptions.push(error)
    },
  },
}))

/* The subject is imported only after every mock above is registered. */
const { createRoot } = await import('react-dom/client')
const { AppSelector } = await import('./AppSelector')

/* ------------------------------------------------------------------ *
 * Query helpers over the shim DOM.
 * ------------------------------------------------------------------ */

function findAll(
  root: FakeNode,
  predicate: (element: FakeElement) => boolean,
): FakeElement[] {
  const found: FakeElement[] = []
  const walk = (node: FakeNode): void => {
    if (node.nodeType === 1 && predicate(node as FakeElement)) {
      found.push(node as FakeElement)
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return found
}

const textOf = (node: FakeNode): string => node.textContent ?? ''

const bySlot = (slot: string) => (element: FakeElement) =>
  element.getAttribute('data-slot') === slot

function dialogNode(root: FakeNode): FakeElement | null {
  return (
    findAll(root, (element) => element.getAttribute('role') === 'dialog')[0] ??
    null
  )
}

function clickCommandItem(root: FakeNode, name: string): void {
  const item = findAll(root, bySlot('command-item')).find((element) =>
    textOf(element).includes(name),
  )
  if (!item) {
    throw new Error(
      `no command item containing ${JSON.stringify(name)} rendered`,
    )
  }
  item.click()
}

/**
 * The picker renders one group per non-empty list, each group opening with
 * its heading ("Connected", "Needs authentication", "Available"). Group the
 * rendered server entries by that heading.
 */
function renderedSections(root: FakeNode): {
  heading: string
  connectedTitles: string[]
  itemTexts: string[]
}[] {
  return findAll(root, bySlot('command-group')).map((group) => {
    const heading = textOf(group.childNodes[0] ?? group).trim()
    const connectedTitles = findAll(
      group,
      (element) => element.tagName === 'DIV' && element.hasAttribute('title'),
    ).map((element) => element.getAttribute('title') ?? '')
    const itemTexts = findAll(group, bySlot('command-item')).map(textOf)
    return { heading, connectedTitles, itemTexts }
  })
}

const availableNames = (root: FakeNode): string[] =>
  renderedSections(root)
    .filter((section) => section.heading === 'Available')
    .flatMap((section) => section.itemTexts)

const needsAuthNames = (root: FakeNode): string[] =>
  renderedSections(root)
    .filter((section) => section.heading === 'Needs authentication')
    .flatMap((section) => section.itemTexts)

const connectedTitles = (root: FakeNode): string[] =>
  renderedSections(root)
    .filter((section) => section.heading === 'Connected')
    .flatMap((section) => section.connectedTitles)

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/* ------------------------------------------------------------------ *
 * The contract itself. One exported symbol, one walkthrough.
 * ------------------------------------------------------------------ */

describe('AppSelectorTsxContract', () => {
  beforeEach(resetFixtures)

  afterAll(() => {
    for (const [name, previous] of installedGlobals.reverse()) {
      const globalScope = globalThis as Record<string, unknown>
      if (previous === undefined) delete globalScope[name]
      else globalScope[name] = previous
    }
  })

  it('AppSelector renders the trigger, groups, filtering, adding, API-key and failure behaviour of the app picker', async () => {
    const container = fakeDocument.createElement('div')
    const root = createRoot(container)
    const trigger = h(
      'button',
      { type: 'button', 'data-testid': 'app-selector-trigger' },
      'Connect apps',
    )

    // The picker starts closed: children render as the trigger, no dialog.
    await React.act(async () => {
      root.render(h(AppSelector, { children: trigger }))
    })
    const triggerButton = findAll(
      container,
      (element) =>
        element.getAttribute('data-testid') === 'app-selector-trigger',
    )[0]
    expect(triggerButton).toBeDefined()
    expect(textOf(triggerButton)).toBe('Connect apps')
    expect(dialogNode(container)).toBeNull()

    // Activating the trigger opens the picker with the default side.
    await React.act(async () => {
      triggerButton.click()
    })
    const dialog = dialogNode(container)
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-label')).toBe('Connect apps')
    expect(dialog?.getAttribute('data-side')).toBe('bottom')

    // Partitioning: Notion is authenticated, Figma is not, the catalog
    // offers only servers that were not created yet, and the custom server
    // is nowhere in the picker.
    expect(connectedTitles(container)).toEqual(['Notion'])
    expect(needsAuthNames(container)).toEqual(['Figma'])
    expect(availableNames(container).length).toBe(3)
    expect(availableNames(container).join('|')).toContain('GitHub')
    expect(availableNames(container).join('|')).toContain('Slack')
    expect(availableNames(container).join('|')).toContain('Linear')
    expect(availableNames(container).join('|')).not.toContain('Notion')
    expect(availableNames(container).join('|')).not.toContain('Figma')
    expect(
      findAll(container, (element) => textOf(element).includes('My local MCP'))
        .length,
    ).toBe(0)
    expect(findAll(container, bySlot('command-empty')).length).toBe(0)

    // Searching is case-insensitive and matches names and descriptions.
    await React.act(async () => {
      commandInputState.onValueChange?.('GIT')
    })
    expect(availableNames(container).join('|')).toContain('GitHub')
    expect(availableNames(container).join('|')).not.toContain('Slack')
    expect(needsAuthNames(container).length).toBe(0)
    expect(connectedTitles(container).length).toBe(0)

    await React.act(async () => {
      commandInputState.onValueChange?.('notes')
    })
    expect(connectedTitles(container)).toEqual(['Notion'])
    expect(availableNames(container).length).toBe(0)

    // With no match at all, the empty state is shown.
    await React.act(async () => {
      commandInputState.onValueChange?.('zzz')
    })
    const emptyNode = findAll(container, bySlot('command-empty'))[0]
    expect(emptyNode).toBeDefined()
    expect(textOf(emptyNode)).toBe('No apps found')
    expect(
      findAll(container, bySlot('command-input'))[0].getAttribute('data-value'),
    ).toBe('zzz')

    await React.act(async () => {
      commandInputState.onValueChange?.('')
    })

    // While integrations load, unauthenticated servers stay hidden but
    // connected ones keep rendering.
    env.integrationsLoading = true
    await React.act(async () => {
      root.render(h(AppSelector, { children: trigger }))
    })
    expect(needsAuthNames(container).length).toBe(0)
    expect(connectedTitles(container)).toEqual(['Notion'])
    env.integrationsLoading = false
    await React.act(async () => {
      root.render(h(AppSelector, { children: trigger }))
    })
    expect(needsAuthNames(container)).toEqual(['Figma'])

    // Selecting an available server with an OAuth response: the browser
    // window opens on the OAuth URL, the server is persisted with its
    // catalog metadata, and the addition is tracked.
    await React.act(async () => {
      clickCommandItem(container, 'GitHub')
      await tick()
    })
    expect(recorded.windowOpen).toEqual([
      { url: 'https://oauth.example/github', target: '_blank' },
    ])
    expect(recorded.addServer.length).toBe(1)
    const added = recorded.addServer[0]
    expect(added.displayName).toBe('GitHub')
    expect(added.type).toBe('managed')
    expect(added.managedServerName).toBe('GitHub')
    expect(added.managedServerDescription).toBe(
      'Code hosting and pull requests',
    )
    expect(recorded.trackCalls).toEqual([
      {
        name: 'settings.managed_mcp.added',
        properties: { server_name: 'GitHub' },
      },
    ])
    expect(recorded.toastErrors.length).toBe(0)

    // The added server now shows as needing authentication and leaves the
    // available catalog.
    await React.act(async () => {
      root.render(h(AppSelector, { children: trigger }))
    })
    expect(needsAuthNames(container).join('|')).toContain('GitHub')
    expect(availableNames(container).join('|')).not.toContain('GitHub')

    // A failing add reports through a toast and Sentry and keeps the
    // server available.
    env.addOutcome = { ok: false, error: new Error('klavis exploded') }
    await React.act(async () => {
      clickCommandItem(container, 'Slack')
      await tick()
    })
    expect(recorded.toastErrors).toEqual(['Failed to add app: Slack'])
    expect(recorded.capturedExceptions.length).toBe(1)
    expect(recorded.addServer.length).toBe(1)
    expect(availableNames(container).join('|')).toContain('Slack')

    // A server answered with an API-key URL opens the dialog instead of a
    // browser window.
    env.addOutcome = {
      ok: true,
      value: {
        success: true,
        serverName: 'Linear',
        strataId: 'strata-linear',
        addedServers: ['Linear'],
        apiKeyUrl: 'https://klavis.example/linear-api-key',
      },
    }
    await React.act(async () => {
      clickCommandItem(container, 'Linear')
      await tick()
    })
    const linearDialog = findAll(container, bySlot('api-key-dialog'))[0]
    expect(linearDialog.getAttribute('data-server-name')).toBe('Linear')
    expect(recorded.windowOpen.length).toBe(1)

    // Submitting the key succeeds: toast, dialog closed, integrations
    // refetched.
    await React.act(async () => {
      apiKeyDialogState.onSubmit?.('sk-live-42')
      await tick()
    })
    expect(recorded.submitTriggerCalls).toEqual([
      {
        serverName: 'Linear',
        apiKey: 'sk-live-42',
        apiKeyUrl: 'https://klavis.example/linear-api-key',
      },
    ])
    expect(recorded.toastSuccesses).toEqual(['Linear connected successfully'])
    expect(findAll(container, bySlot('api-key-dialog')).length).toBe(0)
    expect(recorded.mutateIntegrationsCalls).toBe(1)

    // A needs-auth server with an API-key URL also opens the dialog; a
    // failed submission reports the server name and error message, reports
    // to Sentry, and keeps the dialog open until dismissed.
    env.addOutcome = {
      ok: true,
      value: {
        success: true,
        serverName: 'Figma',
        strataId: 'strata-figma',
        addedServers: ['Figma'],
        apiKeyUrl: 'https://klavis.example/figma-api-key',
      },
    }
    await React.act(async () => {
      clickCommandItem(container, 'Figma')
      await tick()
    })
    const figmaDialog = findAll(container, bySlot('api-key-dialog'))[0]
    expect(figmaDialog.getAttribute('data-server-name')).toBe('Figma')
    env.submitOutcome = { ok: false, error: new Error('Invalid API key') }
    await React.act(async () => {
      apiKeyDialogState.onSubmit?.('wrong-key')
      await tick()
    })
    expect(recorded.toastErrors).toEqual([
      'Failed to add app: Slack',
      'Failed to connect Figma: Invalid API key',
    ])
    expect(recorded.capturedExceptions.length).toBe(2)
    expect(findAll(container, bySlot('api-key-dialog')).length).toBe(1)
    await React.act(async () => {
      apiKeyDialogState.onOpenChange?.(false)
    })
    expect(findAll(container, bySlot('api-key-dialog')).length).toBe(0)

    // The manage-apps button in the connected row opens the extension
    // settings page and closes the picker.
    const manageButton = findAll(
      container,
      (element) =>
        element.tagName === 'BUTTON' &&
        element.getAttribute('title') === 'Manage apps',
    )[0]
    expect(manageButton).toBeDefined()
    await React.act(async () => {
      manageButton.click()
    })
    expect(recorded.windowOpen).toEqual([
      { url: 'https://oauth.example/github', target: '_blank' },
      {
        url: 'chrome-extension://test-extension-id/app.html#/connect-apps',
        target: '_blank',
      },
    ])
    expect(dialogNode(container)).toBeNull()
    expect(triggerButton).toBeDefined()

    // A remount honours the side prop.
    await React.act(async () => {
      root.unmount()
    })
    const secondContainer = fakeDocument.createElement('div')
    const secondRoot = createRoot(secondContainer)
    await React.act(async () => {
      secondRoot.render(h(AppSelector, { children: trigger, side: 'top' }))
    })
    const secondTrigger = findAll(
      secondContainer,
      (element) =>
        element.getAttribute('data-testid') === 'app-selector-trigger',
    )[0]
    await React.act(async () => {
      secondTrigger.click()
    })
    expect(dialogNode(secondContainer)?.getAttribute('data-side')).toBe('top')
    await React.act(async () => {
      secondRoot.unmount()
    })
  })
})
