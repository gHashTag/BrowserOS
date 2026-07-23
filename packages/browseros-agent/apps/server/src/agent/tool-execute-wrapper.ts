import type { ToolSet } from 'ai'

export type RuntimeToolExecute = (this: unknown, ...args: unknown[]) => unknown

export type RuntimeToolExecuteWrapper = (
  sourceExecute: RuntimeToolExecute,
) => RuntimeToolExecute

type ExecuteDescriptorLookup =
  | { readonly state: 'missing' }
  | { readonly state: 'failed' }
  | { readonly state: 'found'; readonly descriptor: PropertyDescriptor }

function findExecuteDescriptor(
  sourceTool: ToolSet[string],
): ExecuteDescriptorLookup {
  let current: object | null = sourceTool
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'execute')
      if (descriptor !== undefined) {
        return { state: 'found', descriptor }
      }
      current = Object.getPrototypeOf(current)
    }
  } catch {
    return { state: 'failed' }
  }
  return { state: 'missing' }
}

function safelyWrapExecute(
  sourceExecute: RuntimeToolExecute,
  wrapper: RuntimeToolExecuteWrapper,
): RuntimeToolExecute {
  try {
    return wrapper(sourceExecute)
  } catch {
    return sourceExecute
  }
}

export function wrapToolExecuteProperty(
  sourceTool: ToolSet[string],
  wrapper: RuntimeToolExecuteWrapper,
): ToolSet[string] {
  const lookup = findExecuteDescriptor(sourceTool)
  if (lookup.state !== 'found') {
    return sourceTool
  }

  const descriptor = lookup.descriptor
  if (Object.hasOwn(descriptor, 'value')) {
    if (typeof descriptor.value !== 'function') {
      return sourceTool
    }
    try {
      const descriptors = Object.getOwnPropertyDescriptors(
        sourceTool,
      ) as PropertyDescriptorMap
      descriptors.execute = {
        ...(descriptors.execute ?? {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          writable: true,
        }),
        value: safelyWrapExecute(descriptor.value, wrapper),
      }
      return Object.create(
        Object.getPrototypeOf(sourceTool),
        descriptors,
      ) as ToolSet[string]
    } catch {
      return sourceTool
    }
  }

  try {
    const descriptors = Object.getOwnPropertyDescriptors(
      sourceTool,
    ) as PropertyDescriptorMap
    descriptors.execute = {
      configurable: descriptor.configurable ?? true,
      enumerable: descriptor.enumerable ?? false,
      get(this: unknown): unknown {
        const sourceExecute = descriptor.get?.call(this)
        return typeof sourceExecute === 'function'
          ? safelyWrapExecute(sourceExecute, wrapper)
          : sourceExecute
      },
      set: descriptor.set,
    }
    return Object.create(
      Object.getPrototypeOf(sourceTool),
      descriptors,
    ) as ToolSet[string]
  } catch {
    return sourceTool
  }
}
