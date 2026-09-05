/**
 * Contract suite for the exports of ConnectAppCard.tsx.
 *
 * The module exports exactly one symbol: `ConnectAppCard`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ConnectAppCard`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's live dependencies - the agent server behind
 * `useAddManagedServer` and `useSubmitApiKey`, the chat session context,
 * MCP-server storage, declined-app storage, metrics, Sentry and toast
 * notifications - are swapped for in-memory stubs via `mock.module`, so
 * this suite needs no network, no database and no container. React,
 * React DOM, the lucide icons and the shared Button component stay real,
 * so the pinned markup is the markup the app ships.
 *
 * Not pinned, and why: the click handlers (connect, hand over an API key,
 * finish OAuth, do it manually) dispatch DOM events, and the
 * `oauth-pending` phase is reachable only through them. There is no DOM
 * environment available to `bun test` in this project -
 * `@testing-library`, `happy-dom` and `jsdom` are all absent from the
 * lockfile - so only the component's rendered output is pinned. That is
 * a gap in interaction coverage, not an export left unexercised: the
 * export itself is rendered and asserted on, so no export belongs in the
 * blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { type FC, createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { NudgeData } from './getMessageSegments'

const sendMessage = mock(() => {})
const addServer = mock(async () => {})
const addManagedServer = mock(async () => ({
  success: true,
  serverName: '',
  strataId: '',
  addedServers: [] as string[],
}))
const submitApiKey = mock(async () => ({ success: true, serverName: '' }))
const track = mock(() => {})
const captureException = mock(() => {})
const toastError = mock(() => {})
const toastSuccess = mock(() => {})

const ApiKeyDialogStub: FC<{
  open: boolean
  serverName: string
  isSubmitting?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (apiKey: string) => void
}> = (props) =>
  createElement('aside', {
    'data-stub': 'apikey-dialog',
    'data-open': String(props.open),
    'data-server': props.serverName,
    'data-submitting': String(props.isSubmitting ?? false),
  })

mock.module('../layout/ChatSessionContext', () => ({
  useChatSessionContext: () => ({ sendMessage }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  useMcpServers: () => ({
    servers: [],
    addServer,
    removeServer: async () => {},
  }),
}))

mock.module('../../app/connect-mcp/useAddManagedServer', () => ({
  useAddManagedServer: () => ({ trigger: addManagedServer }),
}))

mock.module('../../app/connect-mcp/useSubmitApiKey', () => ({
  useSubmitApiKey: () => ({ trigger: submitApiKey, isMutating: false }),
}))

mock.module('../../app/connect-mcp/ApiKeyDialog', () => ({
  ApiKeyDialog: ApiKeyDialogStub,
}))

mock.module('@/lib/declined-apps/storage', () => ({
  declinedAppsStorage: {
    getValue: async () => [] as string[],
    setValue: async (_value: string[]) => {},
  },
}))

mock.module('@/lib/metrics/track', () => ({ track }))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: { captureException },
}))

mock.module('sonner', () => ({
  toast: { error: toastError, success: toastSuccess },
}))

const { ConnectAppCard } = await import('./ConnectAppCard')

describe('ConnectAppCardTsxContract', () => {
  it('renders ConnectAppCard in every phase reachable without a DOM', () => {
    // React's server renderer inserts `<!-- -->` markers between adjacent
    // text nodes; they are transport plumbing, not content, so drop them
    // before asserting on the emitted markup.
    const renderCard = (data: NudgeData, isLastMessage: boolean) =>
      renderToString(
        createElement(ConnectAppCard, { data, isLastMessage }),
      ).replaceAll('<!-- -->', '')

    // The newest message shows the choosing card: headline, reason, both
    // actions and the plug icon.
    const choosing = renderCard(
      {
        type: 'app_connection',
        appName: 'Slack',
        reason: 'Send messages without leaving the chat',
      },
      true,
    )
    expect(choosing).toContain('Connect Slack for better results')
    expect(choosing).toContain('Send messages without leaving the chat')
    expect(choosing).toContain('>Connect Slack<')
    expect(choosing).toContain('>Do it manually<')
    expect(choosing).toContain('<svg')

    // The API-key dialog rides along with the choosing card, mounted but
    // closed, nameless and idle.
    expect(choosing).toContain('data-stub="apikey-dialog"')
    expect(choosing).toContain('data-open="false"')
    expect(choosing).toContain('data-server=""')
    expect(choosing).toContain('data-submitting="false"')

    // A nudge without a reason keeps the headline but drops the reason.
    const bare = renderCard({ type: 'app_connection', appName: 'Slack' }, true)
    expect(bare).toContain('Connect Slack for better results')
    expect(bare).not.toContain('Send messages without leaving the chat')

    // Any older message is past choosing: it renders the settled summary
    // with its check icon, and neither the prompt nor the dialog.
    const resolved = renderCard(
      {
        type: 'app_connection',
        appName: 'Slack',
        reason: 'Send messages without leaving the chat',
      },
      false,
    )
    expect(resolved).toContain('Slack suggested')
    expect(resolved).toContain('<svg')
    expect(resolved).not.toContain('Connect Slack for better results')
    expect(resolved).not.toContain('data-stub="apikey-dialog"')

    // A nudge with no app name falls back to a generic label.
    const unnamed = renderCard({ type: 'app_connection' }, false)
    expect(unnamed).toContain('App suggested')
  })
})
