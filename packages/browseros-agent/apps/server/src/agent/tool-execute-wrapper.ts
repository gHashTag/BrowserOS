import type { ToolSet } from 'ai'

export type RuntimeToolExecute = (this: unknown, ...args: unknown[]) => unknown

export type RuntimeToolExecuteWrapper = (
  sourceExecute: RuntimeToolExecute,
) => RuntimeToolExecute

type ExecuteDescriptorLookup =
  | { readonly state: 'missing' }
  | { readonly state: 'failed' }
  | { readonly state: 'found'; readonly descriptor: PropertyDescriptor }

const MAX_PROTOTYPE_DEPTH = 64

function findExecuteDescriptor(
  sourceTool: ToolSet[string],
): ExecuteDescriptorLookup {
  let current: object | null = sourceTool
  let depth = 0
  const visited = new WeakSet<object>()
  try {
    while (current !== null) {
      if (depth >= MAX_PROTOTYPE_DEPTH || visited.has(current)) {
        return { state: 'failed' }
      }
      visited.add(current)
      depth += 1
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

function receiverAwareExecute(
  sourceExecute: RuntimeToolExecute,
  wrapper: RuntimeToolExecuteWrapper,
  sourceTool: ToolSet[string],
  wrappedTool: () => ToolSet[string] | undefined,
): RuntimeToolExecute {
  const wrappedExecute = safelyWrapExecute(sourceExecute, wrapper)
  return function (this: unknown, ...args: unknown[]): unknown {
    const receiver = this === wrappedTool() ? sourceTool : this
    return Reflect.apply(wrappedExecute, receiver, args)
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
      let wrappedTool: ToolSet[string] | undefined
      const descriptors = Object.getOwnPropertyDescriptors(
        sourceTool,
      ) as PropertyDescriptorMap
      descriptors.execute = {
        ...(descriptors.execute ?? {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          writable: true,
        }),
        value: receiverAwareExecute(
          descriptor.value,
          wrapper,
          sourceTool,
          () => wrappedTool,
        ),
      }
      wrappedTool = Object.create(
        Object.getPrototypeOf(sourceTool),
        descriptors,
      ) as ToolSet[string]
      return wrappedTool
    } catch {
      return sourceTool
    }
  }

  try {
    let wrappedTool: ToolSet[string] | undefined
    const descriptors = Object.getOwnPropertyDescriptors(
      sourceTool,
    ) as PropertyDescriptorMap
    descriptors.execute = {
      configurable: descriptor.configurable ?? true,
      enumerable: descriptor.enumerable ?? false,
      get(this: unknown): unknown {
        const receiver = this === wrappedTool ? sourceTool : this
        const sourceExecute =
          descriptor.get === undefined
            ? undefined
            : Reflect.apply(descriptor.get, receiver, [])
        return typeof sourceExecute === 'function'
          ? receiverAwareExecute(
              sourceExecute,
              wrapper,
              sourceTool,
              () => wrappedTool,
            )
          : sourceExecute
      },
      set:
        descriptor.set === undefined
          ? undefined
          : function (this: unknown, value: unknown): void {
              const receiver = this === wrappedTool ? sourceTool : this
              Reflect.apply(
                descriptor.set as (value: unknown) => void,
                receiver,
                [value],
              )
            },
    }
    wrappedTool = Object.create(
      Object.getPrototypeOf(sourceTool),
      descriptors,
    ) as ToolSet[string]
    return wrappedTool
  } catch {
    return sourceTool
  }
}
