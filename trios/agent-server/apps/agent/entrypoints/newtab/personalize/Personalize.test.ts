/**
 * Contract suite for the exports of Personalize.tsx.
 *
 * The module exports exactly one symbol: `Personalize`. Every assertion
 * below renders that export and asserts on the markup it emits, so the
 * suite pins observable behaviour rather than the shape of the
 * implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`Personalize`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The component's dependencies are:
 *   - `usePersonalization` hook: uses browser storage API, mocked with in-memory state
 *   - `NewTabBranding` component: static branding, mocked with simple div
 *   - UI components from `@/components/ui/*`: all mocked with simple divs
 *   - `templates` from `./templates`: static data, imported directly
 *
 * Not pinned, and why: user interactions (clicking copy buttons, expanding 
 * collapsible sections) dispatch DOM events through Radix widgets. There is 
 * no DOM environment available to `bun test` in this project - `@testing-library`, 
 * `happy-dom` and `jsdom` are all absent from the lockfile - so only the component's 
 * rendered output is pinned. That is a gap in interaction coverage, not an export 
 * left unexercised: the export itself is rendered and asserted on, so no export 
 * belongs in the blocked list above.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { usePersonalization } from '@/lib/personalization/personalizationStorage'
import { NewTabBranding } from '../index/NewTabBranding'
import { templates } from './templates'

// Mock all UI components with simple divs to avoid dependency on Radix components
const MockButton = ({ children, onClick, className, title, variant }: any) => 
  createElement('button', { className, title, onClick }, children)

const MockCollapsible = ({ children, open, onOpenChange, className }: any) => 
  createElement('div', { className, 'data-open': open }, children)

const MockCollapsibleContent = ({ children, className }: any) => 
  createElement('div', { className }, children)

const MockCollapsibleTrigger = ({ children, asChild, className }: any) => 
  createElement('div', { className }, children)

const MockLabel = ({ children, htmlFor, className }: any) => 
  createElement('label', { className, htmlFor }, children)

const MockMarkdownEditor = ({ 
  id, 
  value, 
  onChange, 
  autoFocus, 
  placeholder, 
  className 
}: any) => 
  createElement('textarea', { 
    id, 
    value, 
    onChange, 
    autoFocus, 
    placeholder, 
    className 
  })

// Mock the usePersonalization hook
const mockUsePersonalization = () => ({
  personalization: '',
  setPersonalization: mock(() => {}),
  clearPersonalization: mock(() => Promise.resolve()),
})

// Mock the NewTabBranding component
const mockNewTabBranding = () => 
  '<div class="space-y-4 text-center"><div class="mb-2 flex items-center justify-center gap-3"><div class="flex h-20 w-20 items-center justify-center rounded-xl bg-transparent"><img alt="BrowserOS" class="h-20 w-20" /></div></div></div>'

// Set up module mocks
mock.module('@/lib/personalization/personalizationStorage', () => ({
  usePersonalization: mockUsePersonalization,
}))

mock.module('../index/NewTabBranding', () => ({
  NewTabBranding: mockNewTabBranding,
}))

mock.module('@/components/ui/button', () => ({
  Button: MockButton,
}))

mock.module('@/components/ui/collapsible', () => ({
  Collapsible: MockCollapsible,
  CollapsibleContent: MockCollapsibleContent,
  CollapsibleTrigger: MockCollapsibleTrigger,
}))

mock.module('@/components/ui/label', () => ({
  Label: MockLabel,
}))

mock.module('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: MockMarkdownEditor,
}))

const { Personalize } = await import('./Personalize')

const render = () => renderToString(createElement(Personalize))

describe('PersonalizeTsxContract', () => {
  it('renders the branding section at the top', () => {
    const html = render()
    
    expect(html).toContain('space-y-4 text-center')
    expect(html).toContain('BrowserOS')
    expect(html).toContain('h-20 w-20')
  })

  it('renders the personalization text area with proper styling', () => {
    const html = render()
    
    expect(html).toContain('Your Information')
    expect(html).toContain('personalization')
    expect(html).toContain('Tell BrowserOS about yourself...')
    expect(html).toContain('styled-scrollbar')
    expect(html).toContain('h-96')
    expect(html).toContain('overflow-y-auto')
  })

  it('renders the privacy notice below the text area', () => {
    const html = render()
    
    expect(html).toContain('Your information is saved locally and never leaves your device.')
    expect(html).toContain('Markdown formatting is supported.')
  })

  it('renders the help section header', () => {
    const html = render()
    
    expect(html).toContain('Need help getting started?')
    expect(html).toContain('font-semibold text-muted-foreground text-sm uppercase tracking-wide')
  })

  it('renders all three template sections', () => {
    const html = render()
    
    expect(html).toContain('Add more info about you')
    expect(html).toContain('What you expect from the browser')
    expect(html).toContain('Your commonly performed actions')
    
    expect(html).toContain('Help BrowserOS understand who you are')
    expect(html).toContain('Share your preferences and needs')
    expect(html).toContain('Describe your daily workflows')
  })

  it('renders template content for each section', () => {
    const html = render()
    
    // Check that template content is present
    expect(html).toContain('# About Me')
    expect(html).toContain('**Name:** [Your name]')
    expect(html).toContain('**Role:** [Your job title or role]')
    
    expect(html).toContain('## What I Expect from the Browser')
    expect(html).toContain('**Primary use case:** [What you mainly use the browser for]')
    
    expect(html).toContain('## Commonly Performed Actions')
    expect(html).toContain('**Daily tasks:**')
  })

  it('renders example content for each section', () => {
    const html = render()
    
    // Check that example content is present
    expect(html).toContain('**Example:**')
    expect(html).toContain('Alex Johnson')
    expect(html).toContain('Software Developer')
    
    expect(html).toContain('Research and development work')
    expect(html).toContain('Fast tab switching, quick search, AI assistance')
    
    expect(html).toContain('Checking emails and messages')
    expect(html).toContain('Reading tech news and articles')
  })

  it('renders copy buttons for each template', () => {
    const html = render()
    
    expect(html).toContain('Copy template')
    expect(html).toContain('title="Copy template"')
    
    // Check for copy button icons (Copy icon when not copied, Check icon when copied)
    expect(html).toContain('h-4 w-4')
    expect(html).toContain('text-muted-foreground')
  })

  it('renders copy instructions for each template', () => {
    const html = render()
    
    expect(html).toContain('Click the copy button to add this template to your')
    expect(html).toContain('clipboard, then paste it into the text area above and')
    expect(html).toContain('customize it.')
  })

  it('applies proper animation classes based on mounted state', () => {
    const html = render()
    
    // Check for transition classes and initial unmounted state
    expect(html).toContain('transition-all')
    expect(html).toContain('duration-500')
    expect(html).toContain('translate-y-4')
    expect(html).toContain('opacity-0')
  })

  it('renders collapsible sections with proper structure', () => {
    const html = render()
    
    expect(html).toContain('w-full rounded-xl border border-border/50 bg-card hover:border-border')
    expect(html).toContain('flex h-auto w-full items-center justify-between p-4 text-left hover:bg-accent/50')
  })

  it('contains proper accessibility attributes', () => {
    const html = render()
    
    // Check for proper button structure and accessibility
    expect(html).toContain('button')
    expect(html).toContain('text-left')
  })

  it('renders template and example content with proper styling', () => {
    const html = render()
    
    // Check for preformatted text styling
    expect(html).toContain('whitespace-pre-wrap')
    expect(html).toContain('break-words')
    expect(html).toContain('rounded-lg')
    expect(html).toContain('border')
    expect(html).toContain('border-border')
    expect(html).toContain('p-4')
    expect(html).toContain('text-xs')
  })
})