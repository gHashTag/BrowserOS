/**
 * Contract suite for the exports of NewTabChat.tsx.
 *
 * The module exports exactly one symbol: `NewTabChat`. The single test
 * below renders that export under a series of chat-session states and
 * asserts on the markup it emits, so the suite pins observable
 * behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`NewTabChat`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The chat state comes from `@/lib/chat-actions/useChatActions`, whose
 * real implementation drives a live chat session (agent server, chat
 * transport, extension storage, voice capture). The hook is swapped
 * for an in-memory stub via `mock.module`, so this suite needs no
 * network, no database and no container. The header, transcript and
 * footer widgets are stubbed the same way; every stub renders the props
 * it received as JSON text inside a named tag, so the markup itself
 * records what the subject passed down. The empty state and the error
 * cards are rendered for real, as is the router that backs
 * `useSearchParams`.
 *
 * Not pinned, and why: the mount effect that reads the `q`, `mode`,
 * `actionType`, `tabName`, `tabDescription` and `tabs` query parameters
 * and dispatches the first message through `chrome.tabs.query`. Effects
 * never run under `renderToString`, no DOM environment is available to
 * `bun test` in this project (`@testing-library`, `happy-dom` and
 * `jsdom` are all absent from the lockfile), and the effect needs the
 * `chrome.tabs` extension API. The same gap hides every user
 * interaction (sending a message, switching mode, liking a reply,
 * typing in the footer). Those are gaps in behaviour coverage, not an
 * export left unexercised: the export itself is rendered and asserted
 * on, so no export belongs in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { UIMessage } from 'ai'
import { createElement, type FC } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { Provider } from '@/components/chat/chatComponentTypes'

type Props = Record<string, unknown>

// Renders every prop the stub received as JSON text inside a named
// tag, so the markup itself records what the subject passed down.
// Functions are dropped by JSON serialisation, which is fine: this
// suite never asserts on callbacks, only on rendered output.
const stubFor = (tag: string): FC<Props> => {
  const Stub: FC<Props> = (props) =>
    createElement(tag, null, JSON.stringify(props))
  return Stub
}

type ChatMode = 'chat' | 'agent'

type ChatState = {
  mode: ChatMode
  setMode: (mode: ChatMode) => void
  messages: UIMessage[]
  sendMessage: (message: { text: string }) => void
  status: 'ready' | 'submitted' | 'streaming' | 'error'
  agentUrlError: Error | null
  chatError: Error | null
  getActionForMessage: (message: UIMessage) => unknown
  liked: Record<string, boolean>
  onClickLike: (messageId: string) => void
  disliked: Record<string, boolean>
  onClickDislike: (messageId: string) => void
  isRestoringConversation: boolean
  providers: Provider[]
  selectedProvider: Provider | undefined
  handleSelectProvider: (provider: Provider) => void
  resetConversation: () => void
  input: string
  setInput: (value: string) => void
  attachedTabs: Array<{ id?: number; title?: string }>
  mounted: boolean
  voiceState: {
    isRecording: boolean
    isTranscribing: boolean
    audioLevels: number[]
    error: string | null
    onStartRecording: () => void
    onStopRecording: () => void
  }
  handleModeChange: (mode: ChatMode) => void
  handleStop: () => void
  toggleTabSelection: (tab: { id?: number }) => void
  removeTab: (tabId?: number) => void
  handleSubmit: (event: { preventDefault: () => void }) => void
  handleSuggestionClick: (suggestion: string) => void
}

let chatState: ChatState

mock.module('@/lib/chat-actions/useChatActions', () => ({
  useChatActions: () => chatState,
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => undefined,
}))

mock.module('@/entrypoints/sidepanel/index/ChatHeader', () => ({
  ChatHeader: stubFor('chat-header-stub'),
}))

mock.module('@/entrypoints/sidepanel/index/ChatMessages', () => ({
  ChatMessages: stubFor('chat-messages-stub'),
}))

mock.module('@/entrypoints/sidepanel/index/ChatFooter', () => ({
  ChatFooter: stubFor('chat-footer-stub'),
}))

const { NewTabChat } = await import('./NewTabChat')

const provider: Provider = {
  kind: 'llm',
  id: 'browseros',
  name: 'BrowserOS',
  type: 'browseros',
}

const transcript: UIMessage = {
  id: 'm-1',
  parts: [{ type: 'text', text: 'first reply' }],
}

const noop = (): undefined => undefined

const settledState = (): ChatState => ({
  mode: 'agent',
  setMode: noop,
  messages: [],
  sendMessage: noop,
  status: 'ready',
  agentUrlError: null,
  chatError: null,
  getActionForMessage: () => null,
  liked: {},
  onClickLike: noop,
  disliked: {},
  onClickDislike: noop,
  isRestoringConversation: false,
  providers: [provider],
  selectedProvider: provider,
  handleSelectProvider: noop,
  resetConversation: noop,
  input: '',
  setInput: noop,
  attachedTabs: [],
  mounted: true,
  voiceState: {
    isRecording: false,
    isTranscribing: false,
    audioLevels: [],
    error: null,
    onStartRecording: noop,
    onStopRecording: noop,
  },
  handleModeChange: noop,
  handleStop: noop,
  toggleTabSelection: noop,
  removeTab: noop,
  handleSubmit: noop,
  handleSuggestionClick: noop,
})

const renderNewTabChat = (state: Partial<ChatState>): string => {
  chatState = { ...settledState(), ...state }
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: ['/newtab.html'] },
      createElement(NewTabChat),
    ),
  )
}

describe('NewTabChatTsxContract', () => {
  it('NewTabChat maps the chat session onto the new tab chat surface', () => {
    // Without a selected provider the chat surface is not rendered at all.
    const bare = renderNewTabChat({ selectedProvider: undefined })
    expect(bare).toBe('')

    // Agent mode with no messages shows the real agent empty state: the
    // agent copy and suggestion chips are present, the chat copy is not,
    // and no transcript area is mounted.
    const emptyAgent = renderNewTabChat({})
    expect(emptyAgent).toContain('Agent at your service')
    expect(emptyAgent).toContain('Let AI automate tasks and browse for you')
    expect(emptyAgent).toContain('Support BrowserOS on Github')
    expect(emptyAgent).not.toContain('Chat with this page')
    // The fade-in has settled, because the session reports mounted.
    expect(emptyAgent).toContain('translate-y-0 opacity-100')
    // The new tab header hides history and starts without messages.
    expect(emptyAgent).toContain('&quot;hasMessages&quot;:false')
    expect(emptyAgent).toContain('&quot;hideHistory&quot;:true')
    // The footer stub receives the agent mode.
    expect(emptyAgent).toContain('&quot;mode&quot;:&quot;agent&quot;')
    expect(emptyAgent).not.toContain('<chat-messages-stub>')
    expect(emptyAgent).not.toContain('Connection failed')
    expect(emptyAgent).not.toContain('Something went wrong')

    // Chat mode swaps the empty state for the chat copy and reaches the
    // footer as well.
    const emptyChat = renderNewTabChat({ mode: 'chat' })
    expect(emptyChat).toContain('Chat with this page')
    expect(emptyChat).toContain(
      'Ask questions about the current page or any topic',
    )
    expect(emptyChat).not.toContain('Agent at your service')
    expect(emptyChat).toContain('&quot;mode&quot;:&quot;chat&quot;')

    // Before the fade-in settles the empty state stays shifted down and
    // fully transparent.
    const notYetMounted = renderNewTabChat({ mounted: false })
    expect(notYetMounted).toContain('translate-y-4 opacity-0')

    // While a conversation restore is in flight the transcript area is
    // replaced by the spinner, whatever the message count.
    const restoring = renderNewTabChat({
      isRestoringConversation: true,
      messages: [transcript],
    })
    expect(restoring).toContain('animate-spin')
    expect(restoring).not.toContain('Agent at your service')
    expect(restoring).not.toContain('<chat-messages-stub>')

    // With messages on record the transcript area mounts and receives
    // the messages, their status, the like markers and the new tab
    // survey popups turned off; the empty state is gone.
    const withTranscript = renderNewTabChat({
      messages: [transcript],
      status: 'streaming',
      input: 'draft while streaming',
      attachedTabs: [
        { id: 7, title: 'Docs' },
        { id: 8, title: 'Notes' },
      ],
      liked: { 'm-1': true },
    })
    expect(withTranscript).toContain('<chat-messages-stub>')
    expect(withTranscript).toContain('&quot;id&quot;:&quot;m-1&quot;')
    expect(withTranscript).toContain('&quot;status&quot;:&quot;streaming&quot;')
    expect(withTranscript).toContain('&quot;showJtbdPopup&quot;:false')
    expect(withTranscript).toContain('&quot;showDontShowAgain&quot;:false')
    expect(withTranscript).toContain('&quot;liked&quot;:{&quot;m-1&quot;:true}')
    expect(withTranscript).toContain('&quot;hasMessages&quot;:true')
    expect(withTranscript).not.toContain('Agent at your service')
    // The footer stub receives the draft input, the attached tabs and
    // the idle voice state.
    expect(withTranscript).toContain(
      '&quot;input&quot;:&quot;draft while streaming&quot;',
    )
    expect(withTranscript).toContain('&quot;title&quot;:&quot;Docs&quot;')
    expect(withTranscript).toContain('&quot;title&quot;:&quot;Notes&quot;')
    expect(withTranscript).toContain('&quot;isRecording&quot;:false')

    // An unreachable agent server and a failed turn each mount their own
    // real error card.
    const withErrors = renderNewTabChat({
      agentUrlError: new Error('fetch failed'),
      chatError: new Error('boom went the model'),
    })
    expect(withErrors).toContain('Connection failed')
    expect(withErrors).toContain('Unable to connect to BrowserOS agent')
    expect(withErrors).toContain('View troubleshooting guide')
    expect(withErrors).toContain('Something went wrong')
    expect(withErrors).toContain('boom went the model')
  })
})
