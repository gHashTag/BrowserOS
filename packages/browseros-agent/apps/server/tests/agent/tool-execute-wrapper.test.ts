import { describe, expect, it } from 'bun:test'
import type { ToolSet } from 'ai'
import {
  type RuntimeToolExecute,
  wrapToolExecuteProperty,
} from '../../src/agent/tool-execute-wrapper'

const passthroughWrapper = (
  sourceExecute: RuntimeToolExecute,
): RuntimeToolExecute =>
  function (this: unknown, ...args: unknown[]): unknown {
    return Reflect.apply(sourceExecute, this, args)
  }

function asTool(value: object): ToolSet[string] {
  return value as ToolSet[string]
}

function defaultExecute(tool: ToolSet[string]): unknown {
  return (
    tool as ToolSet[string] & {
      execute(): unknown
    }
  ).execute()
}

describe('wrapToolExecuteProperty receiver safety', () => {
  it('preserves a WeakMap-branded own execute default and explicit receiver', () => {
    const sourceOutput = { receiver: 'source' }
    const customOutput = { receiver: 'custom' }
    const brands = new WeakMap<object, unknown>()
    const sourceTool = {
      execute(this: object) {
        if (!brands.has(this)) {
          throw new TypeError('invalid WeakMap receiver')
        }
        return brands.get(this)
      },
    }
    const customReceiver = {}
    brands.set(sourceTool, sourceOutput)
    brands.set(customReceiver, customOutput)

    const wrapped = wrapToolExecuteProperty(
      asTool(sourceTool),
      passthroughWrapper,
    )
    const execute = Reflect.get(wrapped, 'execute') as RuntimeToolExecute

    expect(defaultExecute(wrapped)).toBe(sourceOutput)
    expect(Reflect.apply(execute, customReceiver, [])).toBe(customOutput)
  })

  it('preserves a private-branded inherited execute default and explicit receiver', () => {
    class BrandedTool {
      readonly #output: unknown

      constructor(output: unknown) {
        this.#output = output
      }

      execute(): unknown {
        return this.#output
      }
    }

    const sourceOutput = { receiver: 'source' }
    const customOutput = { receiver: 'custom' }
    const sourceTool = new BrandedTool(sourceOutput)
    const customReceiver = new BrandedTool(customOutput)
    const wrapped = wrapToolExecuteProperty(
      asTool(sourceTool),
      passthroughWrapper,
    )
    const execute = Reflect.get(wrapped, 'execute') as RuntimeToolExecute

    expect(defaultExecute(wrapped)).toBe(sourceOutput)
    expect(Reflect.apply(execute, customReceiver, [])).toBe(customOutput)
  })

  it('preserves private-branded accessor lookup and call defaults while leaving explicit receivers unchanged', () => {
    const lookups: object[] = []
    class AccessorTool {
      readonly #output: unknown

      constructor(output: unknown) {
        this.#output = output
      }

      get execute(): RuntimeToolExecute {
        lookups.push(this)
        void this.#output
        return this.read
      }

      private read(): unknown {
        return this.#output
      }
    }

    const sourceOutput = { receiver: 'source' }
    const customOutput = { receiver: 'custom-call' }
    const sourceTool = new AccessorTool(sourceOutput)
    const customLookupReceiver = new AccessorTool({ receiver: 'lookup' })
    const customCallReceiver = new AccessorTool(customOutput)
    const wrapped = wrapToolExecuteProperty(
      asTool(sourceTool),
      passthroughWrapper,
    )

    expect(defaultExecute(wrapped)).toBe(sourceOutput)
    const customExecute = Reflect.get(
      wrapped,
      'execute',
      customLookupReceiver,
    ) as RuntimeToolExecute
    expect(Reflect.apply(customExecute, customCallReceiver, [])).toBe(
      customOutput,
    )
    expect(lookups).toEqual([sourceTool, customLookupReceiver])
  })

  it('returns the source unchanged for an apparently cyclic prototype proxy', () => {
    let prototypeReads = 0
    let cyclicTool: object
    cyclicTool = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => undefined,
        getPrototypeOf: () => {
          prototypeReads += 1
          return prototypeReads < 100 ? cyclicTool : null
        },
      },
    )

    const wrapped = wrapToolExecuteProperty(
      asTool(cyclicTool),
      passthroughWrapper,
    )

    expect(wrapped).toBe(cyclicTool)
    expect(prototypeReads).toBeLessThanOrEqual(2)
  })

  it('returns the source unchanged within a bounded hostile prototype chain', () => {
    let prototypeReads = 0
    const createLevel = (): object =>
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => undefined,
          getPrototypeOf: () => {
            prototypeReads += 1
            return prototypeReads < 100 ? createLevel() : null
          },
        },
      )
    const sourceTool = createLevel()

    const wrapped = wrapToolExecuteProperty(
      asTool(sourceTool),
      passthroughWrapper,
    )

    expect(wrapped).toBe(sourceTool)
    expect(prototypeReads).toBeLessThanOrEqual(64)
  })
})
