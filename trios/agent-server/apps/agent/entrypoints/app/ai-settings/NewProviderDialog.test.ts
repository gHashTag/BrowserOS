/* eslint-disable */
import { describe, expect, it, mock } from 'bun:test'

// ---- linkedom DOM ----
const { parseHTML } = await import(
  '../../../../../node_modules/.bun/linkedom@0.18.12/node_modules/linkedom'
)

const dom = parseHTML(
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
)
const g = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
const computedStyleStub = () => ({
  getPropertyValue: () => '',
  paddingRight: '',
  paddingLeft: '',
  marginRight: '',
  marginLeft: '',
  borderTopWidth: '',
  borderBottomWidth: '',
  overflow: '',
  overflowX: '',
  overflowY: '',
})
domWindow.getComputedStyle = computedStyleStub
g.window = dom.window
g.document = dom.document
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
g.ResizeObserver = g.ResizeObserver ?? ResizeObserverStub
class MutationObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
g.MutationObserver = g.MutationObserver ?? MutationObserverStub
for (const key of Object.keys(domWindow)) {
  if (g[key] === undefined) g[key] = domWindow[key]
}
class DocumentFragmentStub {
  constructor() {
    return dom.document.createDocumentFragment()
  }
}
g.DocumentFragment = DocumentFragmentStub
const inputProto = (domWindow.HTMLInputElement as { prototype: object })
  .prototype as Record<string, unknown>
if (Object.getOwnPropertyDescriptor(inputProto, 'checked') === undefined) {
  Object.defineProperty(inputProto, 'checked', {
    configurable: true,
    get(this: { _ldChecked?: boolean }) {
      return this._ldChecked ?? false
    },
    set(this: { _ldChecked?: boolean }, v: boolean) {
      this._ldChecked = v
    },
  })
}
g.chrome = { browserOS: {}, runtime: {}, tabs: { create: () => {} } }

// ---- alias -> real module shims (registered before anything loads) ----
const aliasMap: Record<string, string> = {
  '@/components/ui/button': '../../../components/ui/button',
  '@/components/ui/checkbox': '../../../components/ui/checkbox',
  '@/components/ui/command': '../../../components/ui/command',
  '@/components/ui/dialog': '../../../components/ui/dialog',
  '@/components/ui/form': '../../../components/ui/form',
  '@/components/ui/input': '../../../components/ui/input',
  '@/components/ui/label': '../../../components/ui/label',
  '@/components/ui/popover': '../../../components/ui/popover',
  '@/components/ui/select': '../../../components/ui/select',
  '@/lib/browseros/adapter': '../../../lib/browseros/adapter',
  '@/lib/browseros/capabilities': '../../../lib/browseros/capabilities',
  '@/lib/browseros/helpers': '../../../lib/browseros/helpers',
  '@/lib/browseros/prefs': '../../../lib/browseros/prefs',
  '@/lib/browseros/useBrowserOSProviders':
    '../../../lib/browseros/useBrowserOSProviders',
  '@/lib/browseros/useCapabilities': '../../../lib/browseros/useCapabilities',
  '@/lib/constants/analyticsEvents': '../../../lib/constants/analyticsEvents',
  '@/lib/env': '../../../lib/env',
  '@/lib/llm-providers/models-dev': '../../../lib/llm-providers/models-dev',
  '@/lib/llm-providers/providerTemplates':
    '../../../lib/llm-providers/providerTemplates',
  '@/lib/llm-providers/testProvider': '../../../lib/llm-providers/testProvider',
  '@/lib/llm-providers/types': '../../../lib/llm-providers/types',
  '@/lib/metrics/track': '../../../lib/metrics/track',
  '@/lib/utils': '../../../lib/utils',
}

for (const [alias, rel] of Object.entries(aliasMap)) {
  mock.module(alias, () => import(rel))
}

const { NewProviderDialog } = await import('./NewProviderDialog')
const React = await import('react')
const { createRoot } = await import('react-dom/client')

describe('probe', () => {
  it('renders client-side under linkedom', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const reactRoot = createRoot(root as unknown as HTMLElement)
    reactRoot.render(
      React.createElement(NewProviderDialog, {
        open: true,
        onOpenChange: 