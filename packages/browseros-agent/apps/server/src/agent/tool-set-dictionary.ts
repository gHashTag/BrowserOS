import type { ToolSet } from 'ai'

export function createToolSetDictionary(): ToolSet {
  return Object.create(null) as ToolSet
}

export function defineToolSetEntry(
  tools: ToolSet,
  name: string,
  value: ToolSet[string],
): void {
  Object.defineProperty(tools, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}
