import { describe, expect, it } from 'bun:test'

const linkedomUrl = 'file:///workspace/BrowserOS/.worktrees/queen-1503/trios/agent-server/node_modules/.bun/linkedom@0.18.12/node_modules/linkedom/esm/index.js'
const linkedom = (await import(linkedomUrl)) as any
const win: any = linkedom.parseHTML('<!doctype html><html><body></body></html>')
const g: any = globalThis
g.window = win; g.global = win; g.document = win.document
for (const k of ['Event','CustomEvent','InputEvent','KeyboardEvent','Node','NodeList','Element','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLButtonElement','HTMLFormElement','MutationObserver','DocumentFragment']) {
  const v = win[k]; if (v !== undefined) g[k] = v
}
const React = await import('react')
const { createRoot } = await import('react-dom/client')
g.IS_REACT_ACT_ENVIRONMENT = true

describe('probe2', () => {
  it('which react handlers fire', async () => {
    const container = win.document.createElement('div')
    win.document.body.appendChild(container)
    const root = createRoot(container)
    const fired: string[] = []
    const C = () => {
      return React.createElement('div', null,
        React.createElement('textarea', {
          'data-slot': 'ta',
          onClick: () => fired.push('onClick'),
          onInput: () => fired.push('onInput'),
          onChange: () => fired.push('onChange'),
        }),
      )
    }
    await React.act(async () => { root.render(React.createElement(C)) })
    const ta: any = container.querySelector('[data-slot=ta]')
    const nativeProto = Object.getPrototypeOf(ta)
    const d = Object.getOwnPropertyDescriptor(nativeProto, 'value')
    await React.act(async () => {
      d?.set?.call(ta, 'hello')
      ta.dispatchEvent(new win.Event('click', { bubbles: true }))
    })
    await React.act(async () => {
      d?.set?.call(ta, 'hello2')
      ta.dispatchEvent(new win.Event('input', { bubbles: true }))
    })
    await React.act(async () => {
      d?.set?.call(ta, 'hello3')
      ta.dispatchEvent(new win.Event('change', { bubbles: true }))
    })
    await React.act(async () => {
      ta.dispatchEvent(new win.Event('beforeinput', { bubbles: true, cancelable: true }))
    })
    console.log('fired:', JSON.stringify(fired), 'ta.value:', JSON.stringify(ta.value))
    expect(fired.length).toBeGreaterThan(0)
  })
})
