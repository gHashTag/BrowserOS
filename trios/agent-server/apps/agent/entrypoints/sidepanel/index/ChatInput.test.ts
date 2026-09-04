/**
 * First contract suite for the sole runtime export of
 * apps/agent/entrypoints/sidepanel/index/ChatInput.tsx: the `ChatInput`
 * component. The suite renders the unmodified component through
 * react-dom/server and asserts on the markup a user would receive, so every
 * assertion pins observable behaviour. Nothing here needs a DOM, the network,
 * a database or a container, and the subject file is never changed.
 *
 * Export accounting: 1 runtime export (`ChatInput`), 1 exercised, 0 listed as
 * blocked. The type-only export `ChatInputHandle` has no runtime behaviour of
 * its own beyond the imperative handle below.
 *
 * Behaviours of `ChatInput` pinned here, all observed as rendered markup for
 * a given prop set:
 *  - the composer is a form whose textarea mirrors the controlled draft
 *  - placeholder selection per chat mode and per transcription state
 *  - the send control staying disabled until the draft has visible text,
 *    and while voice recording or transcription is active
 *  - busy statuses (streaming, submitted) swapping the send control for a
 *    stop control, while the error status counts as not busy
 *  - the voice control appearing only when a voice state is wired, and its
 *    enabled/disabled shape across voice and busy states
 *  - the live waveform replacing the textarea while recording, with bar
 *    heights clamped from the reported mic levels
 *  - the tab mention picker staying closed on first paint
 *
 * Behaviours of `ChatInput` that could NOT be pinned here, all blocked by the
 * same missing dependency: a live DOM test environment. Typing-driven mention
 * handling (opening on "@" at a word boundary, tracking filter text, closing
 * when the "@" is removed), the keys reserved while the picker is open
 * (arrows, Enter, Escape, Tab), Enter submitting the form only for a
 * non-blank draft and only when not busy, the stop control's click wiring to
 * onStop, the imperative handle methods openTabMention, closeTabMention,
 * toggleTabMention and focus, the onTabMentionOpenChange notification, and
 * click-outside dismissal are observable only through real DOM events on a
 * mounted component. react-dom/client cannot mount without a DOM; this
 * dependency tree contains no DOM implementation usable for tests (no
 * happy-dom, no jsdom, and bun ships none), and adding one is a package
 * change outside this suite's file boundary. Per the issue's FR-001 the
 * subject is left unmodified rather than refactored to make these reachable.
 */
import { describe, expect, it } from 'bun:test'
import type { ComponentProps } from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatInput } from './ChatInput'

type ChatInputProps = ComponentProps<typeof ChatInput>
type VoiceState = NonNullable<ChatInputProps['voice']>

const baseProps: ChatInputProps = {
  input: 'Summarize this page',
  status: 'ready',
  mode: 'chat',
  onInputChange: () => {},
  onSubmit: () => {},
  onStop: () => {},
  selectedTabs: [],
  onToggleTab: () => {},
}

const voiceState = (overrides: Partial<VoiceState>): VoiceState => ({
  isRecording: false,
  isTranscribing: false,
  audioLevels: [0],
  error: null,
  onStartRecording: () => {},
  onStopRecording: () => {},
  ...overrides,
})

const renderComposer = (overrides: Partial<ChatInputProps> = {}): string =>
  renderToStaticMarkup(createElement(ChatInput, { ...baseProps, ...overrides }))

describe('ChatInputTsxContract', () => {
  it('publishes ChatInput under its own name so devtools and error reports can identify the export', () => {
    expect(ChatInput.displayName).toBe('ChatInput')
  })

  it('renders a form whose textarea mirrors the controlled draft and an enabled send control when ready', () => {
    const markup = renderComposer()

    expect(markup).toContain('<form')
    expect(markup).toContain('placeholder="Ask about this page..."')
    expect(markup).toContain('>Summarize this page</textarea>')
    expect(markup).toContain('<span class="sr-only">Send</span>')
    expect(markup).not.toContain('<button type="submit" disabled=""')
  })

  it('asks the agent-mode question instead of the chat placeholder in agent mode', () => {
    const markup = renderComposer({ mode: 'agent' })

    expect(markup).toContain('placeholder="What should I do?"')
    expect(markup).not.toContain('Ask about this page')
  })

  it('keeps the send control disabled until the draft has non-whitespace text', () => {
    const blank = renderComposer({ input: '' })
    expect(blank).toContain('<button type="submit" disabled=""')

    const whitespace = renderComposer({ input: ' \t\n ' })
    expect(whitespace).toContain('<button type="submit" disabled=""')

    const visible = renderComposer({ input: ' hi ' })
    expect(visible).not.toContain('<button type="submit" disabled=""')
  })

  it('swaps the send control for a stop control while streaming or submitted', () => {
    for (const busyStatus of ['streaming', 'submitted'] as const) {
      const markup = renderComposer({ status: busyStatus })

      expect(markup).toContain('<button type="button"')
      expect(markup).toContain('<span class="sr-only">Stop</span>')
      expect(markup).not.toContain('<span class="sr-only">Send</span>')
      expect(markup).not.toContain('<button type="submit"')
    }
  })

  it('treats the error status as not busy and offers the send control again', () => {
    const markup = renderComposer({ status: 'error' })

    expect(markup).toContain('<span class="sr-only">Send</span>')
    expect(markup).not.toContain('<span class="sr-only">Stop</span>')
  })

  it('offers no voice control unless a voice state is wired', () => {
    const markup = renderComposer()

    expect(markup).not.toContain('Voice input')
  })

  it('enables the idle voice control when ready and disables the voice control while the agent is busy', () => {
    const ready = renderComposer({ voice: voiceState({}) })
    expect(ready).toContain('<span class="sr-only">Voice input</span>')
    expect(ready).not.toContain('<button type="button" disabled=""')

    const busy = renderComposer({
      status: 'streaming',
      voice: voiceState({}),
    })
    expect(busy).toContain('<button type="button" disabled=""')
  })

  it('locks the textarea and shows a disabled transcribing control while speech is being turned into text', () => {
    const markup = renderComposer({
      voice: voiceState({ isTranscribing: true }),
    })

    expect(markup).toContain('placeholder="Transcribing..."')
    expect(markup).toContain('<span class="sr-only">Transcribing</span>')
    expect(/<textarea[^>]* disabled=""/.test(markup)).toBe(true)
    expect(markup).toContain('<button type="button" disabled=""')
    expect(markup).toContain('<button type="submit" disabled=""')
  })

  it('replaces the textarea with a live waveform whose bar heights clamp the reported mic levels', () => {
    const markup = renderComposer({
      voice: voiceState({ isRecording: true, audioLevels: [0, 10, 50, 100] }),
    })

    expect(markup).not.toContain('<textarea')
    expect(markup).toContain('<span class="sr-only">Stop recording</span>')
    // 0 clamps up to the 4px floor, 10 maps to 6px, 50 and 100 clamp at the 20px ceiling
    expect(markup).toContain('style="height:4px"')
    expect(markup).toContain('style="height:6px"')
    expect(markup).toContain('style="height:20px"')
    expect(markup.match(/style="height:20px"/g)?.length).toBe(2)
    expect(markup.match(/style="height:\d+px"/g)?.length).toBe(4)
    expect(markup).toContain('<button type="submit" disabled=""')
  })

  it('keeps the tab mention picker closed on first paint', () => {
    const markup = renderComposer()

    expect(markup).not.toContain('Attach Tabs')
    expect(markup).not.toContain('Type to filter')
  })
})
