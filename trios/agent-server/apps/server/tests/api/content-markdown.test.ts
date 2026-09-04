import { describe, expect, it } from 'bun:test'
import { buildContentMarkdownExpression } from '../../src/browser/content-markdown'

/**
 * content-markdown.ts builds a script that Runtime.evaluate runs inside a page
 * to turn that page's DOM into markdown. Until this file existed, no export of
 * that module appeared anywhere in the test corpus. This suite pins the
 * behaviour that already exists so the next change to the walker has something
 * to fail against. The subject was not modified to make any of this pass.
 *
 * Exports: buildContentMarkdownExpression - the only runtime symbol, exercised
 * below by evaluating the expression it returns against a stub DOM and
 * asserting on the markdown that comes back. Nothing was left uncovered, so
 * there is no list of exports that a live dependency blocked.
 *
 * Why a single scenario block: one exported symbol, covered; zero blocked.
 * The suite keeps that arithmetic exact on purpose, so a count of this file
 * stays honest about what is and is not exercised.
 */

/**
 * The walker reads a fixed handful of properties off every node it touches:
 * tagName, childNodes, children, textContent, hidden, getAttribute,
 * getBoundingClientRect, querySelector, and the anchor/image/code specifics.
 * Plain objects with those members are enough to run the real script - a
 * browser is not needed to pin what the script does.
 */
type TextNode = { nodeType: 3; textContent: string }

class FakeEl {
  readonly nodeType = 1
  readonly tagName: string
  readonly childNodes: Array<FakeEl | TextNode>
  readonly attrs: Record<string, string>
  display = 'block'
  visibility = 'visible'
  rect = { top: 10, bottom: 40, left: 10, right: 200 }
  contentDocument = null

  constructor(
    tagName: string,
    childNodes: Array<FakeEl | TextNode> = [],
    attrs: Record<string, string> = {},
    overrides: Partial<Pick<FakeEl, 'display' | 'rect'>> = {},
  ) {
    this.tagName = tagName.toUpperCase()
    this.childNodes = childNodes
    this.attrs = attrs
    Object.assign(this, overrides)
  }

  get children(): Array<FakeEl> {
    return this.childNodes.filter((n): n is FakeEl => n.nodeType === 1)
  }

  get hidden(): boolean {
    return 'hidden' in this.attrs
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null
  }

  getBoundingClientRect() {
    return this.rect
  }

  get className(): string {
    return this.attrs.class ?? ''
  }

  get href(): string {
    return this.attrs.href ?? ''
  }

  get src(): string {
    return this.attrs.src ?? ''
  }

  get alt(): string {
    return this.attrs.alt ?? ''
  }

  get textContent(): string {
    let out = ''
    for (const child of this.childNodes) out += child.textContent
    return out
  }

  // Only tag selectors are needed: the walker looks for 'img' inside an
  // anchor and 'code' inside a pre, nothing more elaborate.
  querySelector(selector: string): FakeEl | null {
    const wanted = selector.toUpperCase()
    for (const child of this.children) {
      if (child.tagName === wanted) return child
      const found = child.querySelector(selector)
      if (found) return found
    }
    return null
  }
}

function txt(content: string): TextNode {
  return { nodeType: 3, textContent: content }
}

type Globals = Record<string, unknown>

/**
 * Runs the expression the export builds, in global scope, against a stub DOM.
 * The script needs three globals - document (body, querySelector), window
 * (innerHeight, innerWidth) and getComputedStyle - and restores whatever was
 * there before, so the stub never leaks past the call.
 */
function runExpression(
  expression: string,
  root: FakeEl,
  resolveSelector: (selector: string) => FakeEl | null = () => root,
): string {
  const scope = globalThis as unknown as Globals
  const names = ['document', 'window', 'getComputedStyle'] as const
  const saved = names.map((name) => scope[name])
  scope.document = { body: root, querySelector: resolveSelector }
  scope.window = { innerHeight: 800, innerWidth: 600 }
  scope.getComputedStyle = (el: FakeEl) => ({
    display: el.display,
    visibility: el.visibility,
  })
  try {
    // biome-ignore lint/suspicious/noEval: the export's whole job is to emit a script that Runtime.evaluate executes; indirect eval in global scope against a stub DOM runs that exact contract without a browser.
    return (0, eval)(expression) as string
  } finally {
    names.forEach((name, index) => {
      const value = saved[index]
      if (value === undefined) delete scope[name]
      else scope[name] = value
    })
  }
}

/** A document with one of everything the walker has an opinion about. */
function releaseNotesBody(): FakeEl {
  return new FakeEl('body', [
    new FakeEl('h1', [txt('Release notes')]),
    new FakeEl('p', [
      txt('Shipping '),
      new FakeEl('strong', [txt('faster')]),
      txt(', and '),
      new FakeEl('em', [txt('safer')]),
      txt(' defaults.'),
    ]),
    new FakeEl('p', [
      txt('See '),
      new FakeEl('a', [txt('the docs')], { href: '/docs' }),
      txt(' or '),
      new FakeEl('code', [txt('bun test')]),
      txt('.'),
    ]),
    new FakeEl('p', [txt('unseen prose')], {}, { display: 'none' }),
    new FakeEl('div', [new FakeEl('p', [txt('skipped too')])], {
      'aria-hidden': 'true',
    }),
    new FakeEl('script', [txt('var leak = 1')]),
    new FakeEl('img', [], { src: 'badge.png', alt: 'badge' }),
    new FakeEl('ul', [
      new FakeEl('li', [txt('one')]),
      new FakeEl('li', [txt('two')]),
    ]),
    new FakeEl('blockquote', [txt('quoted line')]),
    new FakeEl('pre', [
      new FakeEl('code', [txt('const x = 1\n')], { class: 'language-ts' }),
    ]),
    new FakeEl('table', [
      new FakeEl('thead', [
        new FakeEl('tr', [
          new FakeEl('th', [txt('Name')]),
          new FakeEl('th', [txt('Value')]),
        ]),
      ]),
      new FakeEl('tbody', [
        new FakeEl('tr', [
          new FakeEl('td', [txt('a|b')]),
          new FakeEl('td', [txt('2')]),
        ]),
      ]),
    ]),
    new FakeEl('hr'),
    // Below the fold: rect.top past window.innerHeight (800) in the stub.
    new FakeEl(
      'h2',
      [txt('Appendix: migration notes')],
      {},
      { rect: { top: 900, bottom: 950, left: 10, right: 300 } },
    ),
    new FakeEl(
      'p',
      [txt('Older releases live here.')],
      {},
      { rect: { top: 960, bottom: 990, left: 10, right: 300 } },
    ),
  ])
}

describe('contentMarkdownContract', () => {
  it('buildContentMarkdownExpression renders the document it is evaluated against, honouring selector, viewport, links and images', () => {
    const markdown = runExpression(
      buildContentMarkdownExpression({}),
      releaseNotesBody(),
    )

    // Block-level shape: heading first, paragraphs trimmed, inline emphasis,
    // markdown links, inline code, lists, quotes, fenced code with the
    // language tag, a table with a separator row and escaped pipes, a rule.
    expect(typeof markdown).toBe('string')
    expect(markdown.startsWith('# Release notes')).toBe(true)
    expect(markdown).toBe(markdown.trim())
    expect(markdown).toContain('Shipping **faster**, and *safer* defaults.')
    expect(markdown).toContain('See [the docs](/docs) or `bun test`.')
    expect(markdown).toContain('- one\n- two')
    expect(markdown).toContain('> quoted line')
    expect(markdown).toContain('```ts\nconst x = 1\n```')
    expect(markdown).toContain('| Name | Value |\n| --- | --- |\n| a\\|b | 2 |')
    expect(markdown).toContain('\n---\n')

    // Elements the walker is contracted to drop: script bodies, hidden
    // elements, aria-hidden subtrees.
    expect(markdown).not.toContain('unseen')
    expect(markdown).not.toContain('skipped too')
    expect(markdown).not.toContain('leak')

    // Default options, observed through behaviour rather than the serialized
    // JSON: links render as markdown, images are omitted, and content below
    // the fold is kept because the viewport filter is off.
    expect(markdown).not.toContain('badge.png')
    expect(markdown).toContain('Appendix: migration notes')
    expect(markdown).toContain('Older releases live here.')

    // viewportOnly: true drops what sits below window.innerHeight.
    const viewportMarkdown = runExpression(
      buildContentMarkdownExpression({ viewportOnly: true }),
      releaseNotesBody(),
    )
    expect(viewportMarkdown).toContain('# Release notes')
    expect(viewportMarkdown).not.toContain('Appendix: migration notes')
    expect(viewportMarkdown).not.toContain('Older releases live here.')

    // includeLinks: false keeps the anchor text, drops the markdown link.
    const plainLinks = runExpression(
      buildContentMarkdownExpression({ includeLinks: false }),
      releaseNotesBody(),
    )
    expect(plainLinks).toContain('the docs')
    expect(plainLinks).not.toContain('[the docs]')

    // includeImages: true renders images, alt text included.
    const withImages = runExpression(
      buildContentMarkdownExpression({ includeImages: true }),
      releaseNotesBody(),
    )
    expect(withImages).toContain('![badge](badge.png)')

    // selector: the walk starts at querySelector's answer, and an empty
    // answer yields an empty document rather than a fall back to body.
    const scoped = new FakeEl('div', [new FakeEl('p', [txt('Scoped paragraph')])])
    const scopedMarkdown = runExpression(
      buildContentMarkdownExpression({ selector: '#main' }),
      scoped,
      (selector) => (selector === '#main' ? scoped : null),
    )
    expect(scopedMarkdown).toContain('Scoped paragraph')
    expect(scopedMarkdown).not.toContain('Release notes')

    const noMatch = runExpression(
      buildContentMarkdownExpression({ selector: '.nope' }),
      releaseNotesBody(),
      () => null,
    )
    expect(noMatch).toBe('')
  })
})
