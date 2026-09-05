/**
 * Contract suite for the exports of ApiKeyDialog.tsx.
 *
 * The module exports exactly one symbol: `ApiKeyDialog`. Every assertion
 * below renders that export through react-dom/server and asserts on the
 * markup it emits, so the suite pins observable behaviour rather than the
 * shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`ApiKeyDialog`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component renders through Radix dialog primitives that mount their
 * content in a portal, and react-dom/server does not render portals, so
 * the `@/components/ui/dialog` shell is swapped via `mock.module` for
 * thin stand-ins that render the same children inline - keeping the real
 * contract that a closed dialog shows nothing. Every other module the
 * component uses (the react-hook-form form widgets, the buttons, the
 * input, the server icon) is the real one. The suite needs no network,
 * no database and no container.
 *
 * Not pinned, and why: the interactive half of the contract - pressing
 * Cancel, submitting the form, the `API key is required` validation
 * message, the reset that fires when the dialog closes, and the moment
 * the submit callback fires with the typed key - dispatches DOM events
 * that need a browser DOM. There is no DOM environment available to
 * `bun test` in this project: `@testing-library`, `happy-dom` and
 * `jsdom` are all absent from the lockfile, so only the rendered
 * output, the open gate and the disabled/label states are pinned. That
 * is a gap in interaction coverage, not an export left unexercised:
 * the export itself is rendered and asserted on, so no export belongs
 * in the blocked list above.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

type ShellProps = { children?: ReactNode; open?: boolean }

// Radix portals are invisible to react-dom/server, so these stand-ins
// render the same children inline; a closed dialog still renders nothing.
mock.module('@/components/ui/dialog', () => {
  const Dialog = ({ open, children }: ShellProps) =>
    open ? createElement('div', { 'data-slot': 'dialog' }, children) : null
  const DialogContent = ({ children }: ShellProps) =>
    createElement('div', { 'data-slot': 'dialog-content' }, children)
  const DialogHeader = ({ children }: ShellProps) =>
    createElement('div', { 'data-slot': 'dialog-header' }, children)
  const DialogFooter = ({ children }: ShellProps) =>
    createElement('div', { 'data-slot': 'dialog-footer' }, children)
  const DialogTitle = ({ children }: ShellProps) =>
    createElement('h2', { 'data-slot': 'dialog-title' }, children)
  const DialogDescription = ({ children }: ShellProps) =>
    createElement('p', { 'data-slot': 'dialog-description' }, children)
  return {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  }
})

const { ApiKeyDialog } = await import('./ApiKeyDialog')

type ApiKeyDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName: string
  onSubmit: (apiKey: string) => void
  isSubmitting?: boolean
}

const noop = () => {}

const renderDialog = (overrides: Partial<ApiKeyDialogProps>): string =>
  renderToString(
    createElement(ApiKeyDialog, {
      open: true,
      onOpenChange: noop,
      serverName: 'Notion',
      onSubmit: noop,
      ...overrides,
    } as ApiKeyDialogProps),
  )

// react-dom/server separates static text from interpolated expressions
// with <!-- --> comment markers; stripping them leaves the text a user
// actually reads.
const visibleText = (html: string): string => html.replaceAll('<!-- -->', '')

describe('ApiKeyDialogTsxContract', () => {
  it('ApiKeyDialog renders the connect dialog for the named server, gates it on open, and reflects the submitting state', () => {
    // Open and idle: the title and description interpolate the server
    // name, and a known server gets its logo image at the icon size.
    const idle = visibleText(renderDialog({}))
    expect(idle).toContain('Connect Notion')
    expect(idle).toContain('Enter your Notion API key to connect')
    expect(idle).toContain('alt="Notion"')
    expect(idle).toContain('width="20"')
    expect(idle).toContain('>API Key</label>')
    expect(idle).toContain('type="password"')
    expect(idle).toContain('placeholder="Paste your API key here"')
    expect(idle).toContain('autoComplete="off"')
    expect(idle).toContain('name="apiKey"')
    expect(idle).toContain('value=""')
    // Cancel is a plain button; only the primary button submits the form.
    expect(idle).toContain('type="button"')
    expect(idle).toContain('type="submit"')
    expect(idle).toContain('>Cancel<')
    expect(idle).toContain('>Connect<')
    expect(idle).not.toContain('Connecting')
    // Idle: neither footer button is disabled.
    expect(idle).not.toContain('disabled=""')

    // Submitting: both footer buttons are disabled and the primary label
    // switches to a connecting indicator.
    const busy = visibleText(renderDialog({ isSubmitting: true }))
    expect(busy).toContain('Connecting...')
    expect(busy).not.toContain('>Connect<')
    expect((busy.match(/disabled=""/g) ?? []).length).toBe(2)

    // Closed: the dialog renders nothing at all.
    const closed = visibleText(renderDialog({ open: false }))
    expect(closed).not.toContain('Connect Notion')
    expect(closed).not.toContain('API Key')

    // An unknown server still gets its name in the copy but no logo image.
    const unknown = visibleText(renderDialog({ serverName: 'Zed Private MCP' }))
    expect(unknown).toContain('Connect Zed Private MCP')
    expect(unknown).toContain('Enter your Zed Private MCP API key to connect')
    expect(unknown).not.toContain('alt="Zed Private MCP"')
  })
})
