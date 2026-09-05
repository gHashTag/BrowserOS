/**
 * Contract suite for the exports of ChatFooter.tsx.
 *
 * The module exports exactly one symbol: `ChatFooter`. Every assertion
 * below mounts that export on a minimal DOM shim and drives it the way
 * the sidepanel does - rendering it with controlled props, clicking the
 * controls it draws, firing the browser events it listens for - so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ChatFooter`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * No export is blocked by a live dependency. The collaborators that
 * touch the outside world (the tab-mention input, the app and workspace
 * pickers, the server-backed integrations hook, the wxt storage items,
 * the capability gate and the lucide icons) are swapped for in-memory
 * stand-ins through `mock.module`, while the attached-tabs strip, the
 * mode toggle and the selected-text card run as the real source, so the
 * footer's own wiring is what gets pinned. The suite therefore needs no
 * network, no database and no container - plain `bun test`.
 *
 * Not pinned, and why: the internals of the collaborators named above
 * (what the real ChatInput renders, how the pickers position their
 * popovers) belong to those modules' own suites, not to this one; the
 * footer's contract with them is pinned here through the props it hands
 * over and the DOM it emits around them.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'

/* ------------------------------------------------------------------ *
 * A DOM shim just complete enough for react-dom/client to mount,
 * update and dispatch bubbled click events on plain elements, and for
 * the footer's focus and tab-tracking effects to observe a document.
 * ------------------------------------------------------------------ */

class FakeEventTarget {
  parentNode: FakeNode | null = null
  listeners: Record<string, Array<(event: unknown) => void>> = {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
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
    return this.childNodes
      .map((child) => child.textContent)
      .join('')
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
    this.data = text
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
    return this.attributes['class'] ?? ''
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

  /** Focusing an element makes it the document's active element. */
  focus(): void {
    this.ownerDocument.activeElement = this
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null
    }
  }

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
  hasFocusFlag = true

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

  hasFocus(): boolean {
    return this.hasFocusFlag
  }
}

/** The interactive element classes the footer's focus guard checks. */
class FakeInputElement extends FakeElement {}
class FakeTextAreaElement extends FakeElement {}
class FakeSelectElement extends FakeElement {}
class FakeButtonElement extends FakeElement {}

class FakeWindow extends FakeEventTarget {
  navigator = { userAgent: 'bun-test-chat-footer' }
  document: FakeDocument
  HTMLIFrameElement = class HTMLIFrameElement {}

  constructor(document: FakeDocument) {
    super()
    this.document = document
  }

  open(url: string, target?: string) {
    return { url, target, focus: () => {} }
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

const fakeDocument = new FakeDocument({})
const fakeWindow = new FakeWindow(fakeDocument)
fakeDocument.defaultView = fakeWindow

defineGlobal('document', fakeDocument)
defineGlobal('window', fakeWindow)
defineGlobal('navigator', fakeWindow.navigator)
defineGlobal('IS_REACT_ACT_ENVIRONMENT', true)
defineGlobal('HTMLInputElement', FakeInputElement)
defineGlobal('HTMLTextAreaElement', FakeTextAreaElement)
defineGlobal('HTMLSelectElement', FakeSelectElement)
defineGlobal('HTMLButtonElement', FakeButtonElement)

/* ------------------------------------------------------------------ *
 * In-memory stand-ins for the browser and storage dependencies.
 * ------------------------------------------------------------------ */

interface SelectedTextEntry {
  text: string
  pageUrl: string
  pageTitle: string
  tabId: number
  timestamp: number
}

interface ManagedServerEntry {
  id: string
  displayName: string
  type: 'managed' | 'custom'
  managedServerName?: string
}

const env = {
  /** Result of chrome.tabs.query({ active: true, currentWindow: true }). */
  activeTabs: [] as { id: number }[],
  /** Listeners currently registered on chrome.tabs.onActivated. */
  tabActivatedListeners: [] as ((activeInfo: { tabId: number }) => void)[],
  /** Listeners removed from chrome.tabs.onActivated on cleanup. */
  tabActivatedRemoved: [] as ((activeInfo: { tabId: number }) => void)[],
  /** The map behind selectedTextStorage and its live watchers. */
  selectionMap: {} as Record<string, SelectedTextEntry>,
  selectionWatchers: new Set<(value: Record<string, SelectedTextEntry>) => void>(),
  /** What useWorkspace reports as the selected folder. */
  selectedFolder: null as { name: string; path: string } | null,
  /** What useMcpServers reports as the persisted servers. */
  mcpServers: [] as ManagedServerEntry[],
  /** What useGetUserMCPIntegrations reports from the agent server. */
  integrations: {
    integrations: [] as { name: string; is_authenticated: boolean }[]
  },
  /** Features useCapabilities reports as supported. */
  enabledFeatures: new Set<string>(),
}

const recorded = {
  modeChanges: [] as string[],
  removeTabCalls: [] as (number | undefined)[],
  toggleTabCalls: [] as { id: number; title: string }[],
}

function resetFixtures(): void {
  env.activeTabs = [{ id: 7 }]
  env.tabActivatedListeners = []
  env.tabActivatedRemoved = []
  env.selectionMap = {}
  env.selectionWatchers = new Set()
  env.selectedFolder = null
  env.mcpServers = []
  env.integrations = { integrations: [] }
  env.enabledFeatures = new Set()
  recorded.modeChanges = []
  recorded.removeTabCalls = []
  recorded.toggleTabCalls = []
  fakeDocument.activeElement = null
  fakeDocument.hasFocusFlag = true
}

defineGlobal('chrome', {
  tabs: {
    query: async () => env.activeTabs,
    onActivated: {
      addListener: (listener: (activeInfo: { tabId: number }) => void) => {
        env.tabActivatedListeners.push(listener)
      },
      removeListener: (listener: (activeInfo: { tabId: number }) => void) => {
        env.tabActivatedRemoved.push(listener)
        env.tabActivatedListeners = env.tabActivatedListeners.filter(
          (existing) => existing !== listener,
        )
      },
    },
  },
})

/* ------------------------------------------------------------------ *
 * Stand-in components for the collaborators, reduced to plain
 * elements that surface the props the footer hands over.
 * ------------------------------------------------------------------ */

const h = React.createElement

/**
 * Stand-in for the tab-mention input. It mirrors the real ChatInput's
 * outward contract: a forwarded handle with the mention and focus
 * commands, a report of mention visibility through
 * onTabMentionOpenChange, and a focusable host element.
 */
const MockChatInput = React.forwardRef<
  {
    openTabMention: () => void
    closeTabMention: () => void
    toggleTabMention: () => void
    focus: () => void
  },
  Record<string, unknown>
>(function MockChatInput(props, ref) {
  const [mentionOpen, setMentionOpen] = React.useState(false)
  const hostRef = React.useRef<FakeElement | null>(null)

  React.useImperativeHandle(
    ref,
    () => ({
      openTabMention: () => setMentionOpen(true),
      closeTabMention: () => setMentionOpen(false),
      toggleTabMention: () => setMentionOpen((open) => !open),
      focus: () => hostRef.current?.focus(),
    }),
    [],
  )

  React.useEffect(() => {
    const report = props.onTabMentionOpenChange as
      | ((isOpen: boolean) => void)
      | undefined
    report?.(mentionOpen)
  }, [mentionOpen, props.onTabMentionOpenChange])

  return h(
    'div',
    {
      'data-slot': 'chat-input-host',
      'data-status': (props.status as string) ?? '',
      'data-mode': (props.mode as string) ?? '',
      ref: hostRef,
    },
    (props.input as string) ?? '',
  )
})

/** Radix tooltip reduced to plain elements, for the real ChatModeToggle. */
function MockTooltipProvider(props: Record<string, unknown>) {
  return h(React.Fragment, null, props.children)
}

function MockTooltip(props: Record<string, unknown>) {
  return h(React.Fragment, null, props.children)
}

function MockTooltipTrigger(props: Record<string, unknown>) {
  const child = props.children as React.ReactElement | undefined
  if (props.asChild && React.isValidElement(child)) {
    return child
  }
  return h('button', { type: 'button', 'data-slot': 'tooltip-trigger' }, child)
}

function MockTooltipContent(props: Record<string, unknown>) {
  return h(
    'div',
    { 'data-slot': 'tooltip-content', 'data-side': (props.side as string) ?? '' },
    props.children,
  )
}

function MockAppSelector(props: Record<string, unknown>) {
  return h(
    'div',
    { 'data-slot': 'app-selector', 'data-side': (props.side as string) ?? '' },
    props.children,
  )
}

function MockWorkspaceSelector(props: Record<string, unknown>) {
  return h(
    'div',
    {
      'data-slot': 'workspace-selector',
      'data-side': (props.side as string) ?? '',
    },
    props.children,
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

/* ------------------------------------------------------------------ *
 * mock.module registrations. The subject is imported only after every
 * mock below is registered.
 * ------------------------------------------------------------------ */

mock.module('lucide-react', () => ({
  ChevronDown: makeIconStub('chevron-down'),
  Folder: makeIconStub('folder'),
  Layers: makeIconStub('layers'),
  PlugZap: makeIconStub('plug-zap'),
  Globe: makeIconStub('globe'),
  X: makeIconStub('x'),
  FileText: makeIconStub('file-text'),
  MessageSquare: makeIconStub('message-square'),
  MousePointer2: makeIconStub('mouse-pointer-2'),
}))

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: MockTooltip,
  TooltipContent: MockTooltipContent,
  TooltipProvider: MockTooltipProvider,
  TooltipTrigger: MockTooltipTrigger,
}))

mock.module('@/components/elements/AppSelector', () => ({
  AppSelector: MockAppSelector,
}))

mock.module('@/components/elements/workspace-selector', () => ({
  WorkspaceSelector: MockWorkspaceSelector,
}))

mock.module('@/entrypoints/app/connect-mcp/McpServerIcon', () => ({
  McpServerIcon: MockMcpServerIcon,
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  useGetUserMCPIntegrations: () => ({ data: env.integrations }),
}))

mock.module('@/lib/browseros/capabilities', () => ({
  Feature: {
    WORKSPACE_FOLDER_SUPPORT: 'WORKSPACE_FOLDER_SUPPORT',
    MANAGED_MCP_SUPPORT: 'MANAGED_MCP_SUPPORT',
  },
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({
    supports: (feature: string) => env.enabledFeatures.has(feature),
    isLoading: false,
  }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  useMcpServers: () => ({ servers: env.mcpServers }),
}))

const selectedTextStorageStandIn = {
  getValue: async () => env.selectionMap,
  setValue: async (value: Record<string, SelectedTextEntry>) => {
    env.selectionMap = value
    for (const watcher of env.selectionWatchers) watcher(value)
  },
  watch: (
    watcher: (value: Record<string, SelectedTextEntry>) => void,
  ) => {
    env.selectionWatchers.add(watcher)
    return () => env.selectionWatchers.delete(watcher)
  },
}

mock.module('@/lib/selected-text/selectedTextStorage', () => ({
  selectedTextStorage: selectedTextStorageStandIn,
}))

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({ selectedFolder: env.selectedFolder }),
}))

mock.module('./ChatInput', () => ({ ChatInput: MockChatInput }))

const { createRoot } = await import('react-dom/client')
const { ChatFooter } = await import('./ChatFooter')

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

function findByTitle(root: FakeNode, title: string): FakeElement | null {
  return (
    findAll(
      root,
      (element) => element.getAttribute('title') === title,
    )[0] ?? null
  )
}

function footerOf(root: FakeNode): FakeElement {
  const footer = findAll(root, (element) => element.tagName === 'FOOTER')[0]
  if (!footer) throw new Error('the footer element did not render')
  return footer
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const act = async (run: () => void | Promise<void>) => {
  await React.act(async () => {
    await run()
    await tick()
  })
}

/* ------------------------------------------------------------------ *
 * The contract itself. One exported symbol, one walkthrough.
 * ------------------------------------------------------------------ */

describe('ChatFooterTsxContract', () => {
  beforeEach(resetFixtures)

  afterAll(() => {
    for (const [name, previous] of installedGlobals.reverse()) {
      const globalScope = globalThis as Record<string, unknown>
      if (previous === undefined) delete globalScope[name]
      else globalScope[name] = previous
    }
  })

  it('ChatFooter renders the chat controls, gates them on capabilities, scopes selection to the active tab and manages focus', async () => {
    let container = fakeDocument.createElement('div')
    let root = createRoot(container)

    const baseProps = () => ({
      mode: 'chat' as const,
      onModeChange: (mode: string) => recorded.modeChanges.push(mode),
      input: 'hello draft',
      onInputChange: () => {},
      onSubmit: () => {},
      status: 'ready' as const,
      onStop: () => {},
      attachedTabs: [] as { id: number; title: string }[],
      onToggleTab: (tab: { id: number; title: string }) =>
        recorded.toggleTabCalls.push(tab),
      onRemoveTab: (tabId?: number) => recorded.removeTabCalls.push(tabId),
    })

    // --- bare mount: mode toggle, attach button, input, no extras -----
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    const footer = footerOf(container)

    // The mode toggle runs as the real source and reflects the mode.
    const modeButton = findAll(
      footer,
      (element) =>
        element.tagName === 'BUTTON' && textOf(element).includes('Mode ON'),
    )[0]
    expect(modeButton).toBeDefined()
    expect(textOf(modeButton)).toBe('Chat Mode ON')
    const tooltip = findAll(footer, bySlot('tooltip-content'))[0]
    expect(textOf(tooltip)).toBe('AI can only read, cannot click or navigate')

    // The attach button starts closed and shows no count with no tabs.
    const attachButton = findByTitle(footer, 'Attach tabs (@)')
    expect(attachButton).not.toBeNull()
    expect(attachButton?.getAttribute('aria-expanded')).toBe('false')
    expect(attachButton?.getAttribute('data-state')).toBe('closed')
    expect(attachButton?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(textOf(attachButton)).toBe('')

    // The input receives the draft, the status and the mode.
    const inputHost = findAll(footer, bySlot('chat-input-host'))[0]
    expect(textOf(inputHost)).toBe('hello draft')
    expect(inputHost.getAttribute('data-status')).toBe('ready')
    expect(inputHost.getAttribute('data-mode')).toBe('chat')

    // Without the capability flags neither picker button renders, and
    // with no selection and no voice state nothing else appears.
    expect(findByTitle(footer, 'Select workspace folder')).toBeNull()
    expect(findByTitle(footer, 'Connect apps')).toBeNull()
    expect(findAll(footer, bySlot('workspace-selector')).length).toBe(0)
    expect(findAll(footer, bySlot('app-selector')).length).toBe(0)

    // --- switching the mode through the real toggle -------------------
    await act(() => {
      modeButton.click()
    })
    expect(recorded.modeChanges).toEqual(['agent'])
    await act(() => {
      root.render(h(ChatFooter, { ...baseProps(), mode: 'agent' }))
    })
    const footerAgent = footerOf(container)
    const modeButtonAgent = findAll(
      footerAgent,
      (element) =>
        element.tagName === 'BUTTON' && textOf(element).includes('Mode ON'),
    )[0]
    expect(textOf(modeButtonAgent)).toBe('Agent Mode ON')
    const tooltipAgent = findAll(footerAgent, bySlot('tooltip-content'))[0]
    expect(textOf(tooltipAgent)).toBe('AI can browse, click, and navigate')

    // --- attached tabs reach the real strip with removal wired -------
    const tabs = [
      { id: 11, title: 'Docs — BrowserOS' },
      { id: 12, title: 'GitHub PR' },
    ]
    await act(() => {
      root.render(h(ChatFooter, { ...baseProps(), attachedTabs: tabs }))
    })
    const footerTabs = footerOf(container)
    expect(textOf(footerTabs)).toContain('Docs — BrowserOS')
    expect(textOf(footerTabs)).toContain('GitHub PR')
    const attachWithTabs = findByTitle(footerTabs, 'Attach tabs (@)')
    expect(textOf(attachWithTabs)).toBe('2')
    const removeDocs = findByTitle(footerTabs, 'Remove tab')
    await act(() => {
      removeDocs?.click()
    })
    expect(recorded.removeTabCalls).toEqual([11])

    // --- the attach button drives the input's mention picker ---------
    const attachAgain = findByTitle(footerOf(container), 'Attach tabs (@)')
    await act(() => {
      attachAgain?.click()
    })
    const attachOpen = findByTitle(footerOf(container), 'Attach tabs (@)')
    expect(attachOpen?.getAttribute('aria-expanded')).toBe('true')
    expect(attachOpen?.getAttribute('data-state')).toBe('open')
    await act(() => {
      attachOpen?.click()
    })
    const attachClosed = findByTitle(footerOf(container), 'Attach tabs (@)')
    expect(attachClosed?.getAttribute('aria-expanded')).toBe('false')
    expect(attachClosed?.getAttribute('data-state')).toBe('closed')

    // --- voice errors surface next to the controls --------------------
    await act(() => {
      root.render(
        h(ChatFooter, {
          ...baseProps(),
          voice: {
            isListening: false,
            isSupported: true,
            start: () => {},
            stop: () => {},
            error: 'Microphone permission denied',
          },
        }),
      )
    })
    expect(textOf(footerOf(container))).toContain('Microphone permission denied')
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    expect(textOf(footerOf(container))).not.toContain(
      'Microphone permission denied',
    )

    // --- selected text is scoped to the active tab --------------------
    // The map is read once on mount, so populate storage before a fresh
    // mount, exactly as a sidepanel opening onto a tab with a selection.
    await act(() => {
      root.unmount()
    })
    const longText = `${'selected words '.repeat(20)}tail of the selection`
    env.selectionMap = {
      '7': {
        text: 'tab seven selection',
        pageUrl: 'https://seven.example',
        pageTitle: 'Tab Seven',
        tabId: 7,
        timestamp: 1,
      },
      '9': {
        text: longText,
        pageUrl: 'https://nine.example',
        pageTitle: 'Tab Nine',
        tabId: 9,
        timestamp: 2,
      },
    }
    const selectionContainer = fakeDocument.createElement('div')
    container = selectionContainer
    root = createRoot(selectionContainer)
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    let footerSelection = footerOf(selectionContainer)
    expect(textOf(footerSelection)).toContain('Tab Seven')
    expect(textOf(footerSelection)).toContain('tab seven selection')
    expect(textOf(footerSelection)).not.toContain('Tab Nine')

    // Switching the active tab swaps the selection shown.
    await act(() => {
      env.tabActivatedListeners[0]?.({ tabId: 9 })
    })
    footerSelection = footerOf(container)
    expect(textOf(footerSelection)).toContain('Tab Nine')
    // Long selections are truncated by the real card, quotes included.
    expect(textOf(footerSelection)).toContain(
      `${longText.slice(0, 200)}...`,
    )
    expect(textOf(footerSelection)).not.toContain(longText)
    expect(textOf(footerSelection)).not.toContain('Tab Seven')

    // A tab without a selection shows no card.
    await act(() => {
      env.tabActivatedListeners[0]?.({ tabId: 42 })
    })
    expect(textOf(footerOf(container))).not.toContain('Tab Nine')

    // Storage updates stream in through the watch the footer keeps.
    await act(() => {
      env.tabActivatedListeners[0]?.({ tabId: 7 })
    })
    await act(async () => {
      await selectedTextStorageStandIn.setValue({
        ...env.selectionMap,
        '7': {
          text: 'replacement selection',
          pageUrl: 'https://seven.example',
          pageTitle: 'Tab Seven Updated',
          tabId: 7,
          timestamp: 3,
        },
      })
    })
    expect(textOf(footerOf(container))).toContain('Tab Seven Updated')
    expect(textOf(footerOf(container))).toContain('replacement selection')

    // Dismissing removes only the active tab's entry, in storage and
    // on screen.
    const dismiss = findByTitle(footerOf(container), 'Remove selected text')
    expect(dismiss).not.toBeNull()
    await act(() => {
      dismiss?.click()
    })
    expect(Object.keys(env.selectionMap)).toEqual(['9'])
    expect(textOf(footerOf(container))).not.toContain('Tab Seven Updated')
    expect(env.selectionMap['9']?.pageTitle).toBe('Tab Nine')

    // --- capability-gated pickers -------------------------------------
    env.enabledFeatures.add('WORKSPACE_FOLDER_SUPPORT')
    env.selectedFolder = { name: 'Projects', path: '/home/bee/Projects' }
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    let footerGated = footerOf(container)
    expect(findAll(footerGated, bySlot('workspace-selector')).length).toBe(1)
    expect(
      findAll(footerGated, bySlot('workspace-selector'))[0].getAttribute('data-side'),
    ).toBe('top')
    const folderButton = findByTitle(footerGated, 'Projects')
    expect(folderButton).not.toBeNull()
    // A selected folder is marked with the indicator dot.
    expect(
      findAll(
        footerGated,
        (element) =>
          element.tagName === 'DIV' &&
          element.className.includes('rounded-full'),
      ).length,
    ).toBeGreaterThan(0)

    // Without a selection the button invites choosing one and the dot
    // disappears.
    env.selectedFolder = null
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    footerGated = footerOf(container)
    expect(findByTitle(footerGated, 'Select workspace folder')).not.toBeNull()
    expect(findByTitle(footerGated, 'Projects')).toBeNull()
    expect(
      findAll(
        footerGated,
        (element) =>
          element.tagName === 'DIV' &&
          element.className.includes('rounded-full'),
      ).length,
    ).toBe(0)
    env.enabledFeatures.delete('WORKSPACE_FOLDER_SUPPORT')
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    expect(
      findAll(footerOf(container), bySlot('workspace-selector')).length,
    ).toBe(0)

    // The connect-apps button counts only managed servers whose
    // integration is authenticated.
    env.enabledFeatures.add('MANAGED_MCP_SUPPORT')
    env.integrations = {
      integrations: [
        { name: 'Notion', is_authenticated: true },
        { name: 'Figma', is_authenticated: false },
      ],
    }
    env.mcpServers = [
      { id: 'srv-notion', displayName: 'Notion', type: 'managed', managedServerName: 'Notion' },
      { id: 'srv-figma', displayName: 'Figma', type: 'managed', managedServerName: 'Figma' },
      { id: 'srv-custom', displayName: 'My local MCP', type: 'custom' },
      { id: 'srv-unnamed', displayName: 'Unnamed', type: 'managed' },
    ]
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    let footerApps = footerOf(container)
    const appSelector = findAll(footerApps, bySlot('app-selector'))[0]
    expect(appSelector.getAttribute('data-side')).toBe('top')
    const connectButton = findByTitle(footerApps, 'Connect apps')
    expect(connectButton).not.toBeNull()
    let icons = findAll(connectButton as FakeNode, bySlot('mcp-server-icon'))
    expect(icons.map((icon) => icon.getAttribute('data-server-name'))).toEqual([
      'Notion',
    ])
    expect(textOf(connectButton)).not.toContain('+')

    // Five connected servers render three icons and a "+2" overflow.
    env.mcpServers = [
      'Notion',
      'Linear',
      'Slack',
      'GitHub',
      'Stripe',
    ].map((name, index) => ({
      id: `srv-${index}`,
      displayName: name,
      type: 'managed' as const,
      managedServerName: name,
    }))
    env.integrations = {
      integrations: [
        'Notion',
        'Linear',
        'Slack',
        'GitHub',
        'Stripe',
      ].map((name) => ({ name, is_authenticated: true })),
    }
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    footerApps = footerOf(container)
    const connectOverflow = findByTitle(footerApps, 'Connect apps')
    icons = findAll(connectOverflow as FakeNode, bySlot('mcp-server-icon'))
    expect(icons.length).toBe(3)
    expect(textOf(connectOverflow)).toContain('+2')

    // With nothing connected the plug icon stands in.
    env.mcpServers = []
    env.integrations = { integrations: [] }
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    footerApps = footerOf(container)
    const connectEmpty = findByTitle(footerApps, 'Connect apps')
    expect(
      findAll(connectEmpty as FakeNode, (element) =>
        bySlot('lucide-icon')(element),
      )
        .map((icon) => icon.getAttribute('data-icon'))
        .includes('plug-zap'),
    ).toBe(true)
    expect(findAll(connectEmpty as FakeNode, bySlot('mcp-server-icon')).length).toBe(0)

    env.enabledFeatures.delete('MANAGED_MCP_SUPPORT')
    await act(() => {
      root.render(h(ChatFooter, baseProps()))
    })
    expect(findAll(footerOf(container), bySlot('app-selector')).length).toBe(0)

    // --- focus management ---------------------------------------------
    // A fresh mount with the window focused moves focus to the input.
    await act(() => {
      root.unmount()
    })
    fakeDocument.activeElement = null
    fakeDocument.hasFocusFlag = true
    const focusContainer = fakeDocument.createElement('div')
    const rootTwo = createRoot(focusContainer)
    await act(() => {
      rootTwo.render(h(ChatFooter, baseProps()))
    })
    expect(
      findAll(focusContainer, bySlot('chat-input-host')).length,
    ).toBeGreaterThan(0)
    expect(fakeDocument.activeElement?.getAttribute('data-slot')).toBe(
      'chat-input-host',
    )

    // An already-focused interactive control is left alone.
    await act(() => {
      rootTwo.unmount()
    })
    const heldButton = new FakeButtonElement('button', fakeDocument)
    fakeDocument.activeElement = heldButton
    const guardContainer = fakeDocument.createElement('div')
    const rootThree = createRoot(guardContainer)
    await act(() => {
      rootThree.render(h(ChatFooter, baseProps()))
    })
    expect(fakeDocument.activeElement).toBe(heldButton)

    // Regaining window focus moves focus to the input, unless an
    // interactive element holds it.
    fakeDocument.activeElement = null
    await act(() => {
      fakeWindow.dispatchEvent({ type: 'focus' })
    })
    expect(fakeDocument.activeElement?.getAttribute('data-slot')).toBe(
      'chat-input-host',
    )
    fakeDocument.activeElement = heldButton
    await act(() => {
      fakeWindow.dispatchEvent({ type: 'focus' })
    })
    expect(fakeDocument.activeElement).toBe(heldButton)

    // --- unmount cleans up every subscription -------------------------
    expect(env.tabActivatedListeners.length).toBe(1)
    const registeredListener = env.tabActivatedListeners[0]
    const removalsBeforeUnmount = env.tabActivatedRemoved.length
    expect(env.selectionWatchers.size).toBe(1)
    expect((fakeWindow.listeners.focus ?? []).length).toBe(1)
    await act(() => {
      rootThree.unmount()
    })
    expect(env.tabActivatedRemoved.length).toBe(removalsBeforeUnmount + 1)
    expect(env.tabActivatedRemoved[removalsBeforeUnmount]).toBe(
      registeredListener,
    )
    expect(env.tabActivatedListeners.length).toBe(0)
    expect(env.selectionWatchers.size).toBe(0)
    expect((fakeWindow.listeners.focus ?? []).length).toBe(0)
  }, 30000)
})
