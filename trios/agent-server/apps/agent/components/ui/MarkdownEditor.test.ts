import { describe, expect, it } from 'bun:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MarkdownEditor } from './MarkdownEditor'

/**
 * Contract suite for the single export of MarkdownEditor.tsx.
 *
 * The component is mounted through its real dependency graph: the bundled
 * @mdxeditor/editor (Lexical based) renders on the server without a DOM, so the
 * whole component is rendered with react-dom/server and every assertion reads
 * the markup that is actually produced. Nothing is mocked, no network, no
 * database and no container are involved.
 *
 * The one exported symbol (the MarkdownEditor component itself) is exercised by
 * the assertions below; no export is fully blocked by a live dependency.
 *
 * Aspects of the component that could not be pinned here, and why:
 * - Typing and paste interactions (markdown paste interception, onChange
 *   wiring, keydown forwarding, autoFocus) and the copy-to-clipboard click
 *   (navigator.clipboard) all need a live browser DOM with real event dispatch
 *   and Clipboard support. No DOM environment (happy-dom/jsdom) is available
 *   to bun test in this repository, and installing one is outside this
 *   suite's remit.
 * - The markdown value is mounted inside the Lexical editor, which only
 *   hydrates its content in a browser: the server render serialises an empty
 *   editable area, so value seeding and the external value re-sync effect are
 *   likewise invisible to a server render.
 * The rendered contract pinned below - outer shell, toolbar wiring, editable
 * region, copy affordance and placeholder surfacing - is observable without
 * any of that.
 */
describe('MarkdownEditorTsxContract', () => {
  it('MarkdownEditor renders its current contract: shell, toolbar wiring, editable region, copy affordance and placeholder surfacing', () => {
    const onChange = () => {}

    // Editable mode with every presentational prop supplied.
    const editableHtml = renderToStaticMarkup(
      h(MarkdownEditor, {
        value: '# Team notes',
        onChange,
        placeholder: 'Write markdown here',
        className: 'w-full p-4',
        id: 'editor-shell',
      }),
    )

    // The outer shell carries the caller-supplied id and the merged classes.
    expect(editableHtml.startsWith('<div id="editor-shell"')).toBe(true)
    expect(editableHtml).toContain('class="mdx-editor-outer w-full p-4"')
    expect(editableHtml).toContain('<div class="mdx-editor-themed">')

    // Editable mode wires the formatting toolbar into the markup.
    expect(editableHtml).toContain('mdxeditor-toolbar')
    expect(editableHtml).toContain('aria-label="Undo Ctrl+Z"')
    expect(editableHtml).toContain('aria-label="Bold"')
    expect(editableHtml).toContain('aria-label="Bulleted list"')
    expect(editableHtml).toContain('aria-label="Create link"')

    // The editing surface is a live textbox with the component's content classes.
    expect(editableHtml).toContain('aria-label="editable markdown"')
    expect(editableHtml).toContain('role="textbox"')
    expect(editableHtml).toContain('contentEditable="true"')
    expect(editableHtml).toContain(
      'mdx-content-editable prose prose-sm max-w-none dark:prose-invert',
    )

    // The raw-markdown copy affordance is present with its tooltip and label.
    expect(editableHtml).toContain('<div class="mdx-copy-bar">')
    expect(editableHtml).toContain('class="mdx-copy-button"')
    expect(editableHtml).toContain('title="Copy raw markdown"')
    expect(editableHtml).toContain('<span>Copy markdown</span>')

    // The caller-supplied placeholder text surfaces in the placeholder layer.
    expect(editableHtml).toContain('<p>Write markdown here</p>')

    // Without a placeholder the layer stays empty of caller text, and the
    // shell renders bare when no className or id is supplied.
    const bareHtml = renderToStaticMarkup(
      h(MarkdownEditor, { value: 'x', onChange }),
    )
    expect(bareHtml).toContain('<div class="mdx-editor-outer">')
    expect(bareHtml).not.toContain('Write markdown here')

    // Read-only mode drops the toolbar and locks the editing surface while
    // keeping the shell and the copy affordance in place.
    const readOnlyHtml = renderToStaticMarkup(
      h(MarkdownEditor, {
        value: '# Team notes',
        onChange,
        readOnly: true,
        placeholder: 'Write markdown here',
      }),
    )
    expect(readOnlyHtml).toContain('<div class="mdx-editor-outer">')
    expect(readOnlyHtml).not.toContain('mdxeditor-toolbar')
    expect(readOnlyHtml).not.toContain('aria-label="Bold"')
    expect(readOnlyHtml).toContain('contentEditable="false"')
    expect(readOnlyHtml).toContain('aria-readonly="true"')
    expect(readOnlyHtml).toContain('title="Copy raw markdown"')
  })
})
