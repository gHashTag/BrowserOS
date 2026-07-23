import { describe, expect, it } from 'bun:test'
import { observeToolReturn } from '../../src/agent/tool-return-observer'

function poisonCallAndApply<T extends (...args: never[]) => unknown>(
  callable: T,
): T {
  const poisoned = () => {
    throw new Error('poisoned callable helper')
  }
  Object.defineProperties(callable, {
    apply: { configurable: true, value: poisoned },
    call: { configurable: true, value: poisoned },
  })
  return callable
}

describe('observeToolReturn', () => {
  it('queues captured then invocation with native receiver and rejection identity', async () => {
    const rejection = new Error('exact queued rejection')
    const order: string[] = []
    let getterCalls = 0
    let thenReceiver: unknown
    let observedRejection: unknown
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        getterCalls += 1
        order.push('get-then')
        return function (this: unknown) {
          thenReceiver = this
          order.push('call-then')
          throw rejection
        }
      },
    })

    const pending = observeToolReturn(thenable, {
      onResolved: () => order.push('resolved'),
      onRejected: (error) => {
        observedRejection = error
        order.push('rejected')
      },
      onCancelled: () => order.push('cancelled'),
    })
    order.push('after-observe')

    expect(getterCalls).toBe(1)
    expect(order).toEqual(['get-then', 'after-observe'])
    try {
      await pending
      throw new Error('Expected queued thenable to reject')
    } catch (error) {
      expect(error).toBe(rejection)
    }
    expect(thenReceiver).toBe(thenable)
    expect(observedRejection).toBe(rejection)
    expect(order).toEqual([
      'get-then',
      'after-observe',
      'call-then',
      'rejected',
    ])
  })

  it('uses a one-shot async-iterator accessor once and preserves next results', async () => {
    const chunk = { chunk: 1 }
    const yielded = { done: false, value: chunk }
    const completed = { done: true, value: 'source completion' }
    const sourceResults = [yielded, completed]
    let accessorReads = 0
    let iteratorFactoryCalls = 0
    let nextCalls = 0
    let iteratorFactoryReceiver: unknown
    let nextReceiver: unknown
    const resolved: unknown[] = []
    const sourceIterator = {
      next: poisonCallAndApply(async function (this: unknown) {
        nextCalls += 1
        nextReceiver = this
        return sourceResults[nextCalls - 1]
      }),
    }
    const iteratorFactory = poisonCallAndApply(function (this: unknown) {
      iteratorFactoryCalls += 1
      iteratorFactoryReceiver = this
      return sourceIterator
    })
    const source = Object.defineProperty({}, Symbol.asyncIterator, {
      get() {
        accessorReads += 1
        if (accessorReads > 1) {
          throw new Error('async iterator accessor is one-shot')
        }
        return iteratorFactory
      },
    })

    const observed = observeToolReturn(source, {
      onResolved: (output) => resolved.push(output),
      onRejected: () => {},
      onCancelled: () => {},
    }) as AsyncIterable<unknown>
    const iterator = observed[Symbol.asyncIterator]()

    expect(await iterator.next()).toBe(yielded)
    expect(await iterator.next()).toBe(completed)
    expect(accessorReads).toBe(1)
    expect(iteratorFactoryCalls).toBe(1)
    expect(iteratorFactoryReceiver).toBe(source)
    expect(nextCalls).toBe(2)
    expect(nextReceiver).toBe(sourceIterator)
    expect(resolved).toEqual([chunk])
  })

  it('forwards return before the first next and reports cancellation once', async () => {
    const returned = { done: true, value: 'closed' }
    let iteratorFactoryCalls = 0
    let returnCalls = 0
    let returnReceiver: unknown
    let returnArgument: unknown
    const cancelled: unknown[] = []
    const sourceIterator = {
      next: async () => ({ done: false, value: 'unreachable' }),
      return: poisonCallAndApply(async function (
        this: unknown,
        value: unknown,
      ) {
        returnCalls += 1
        returnReceiver = this
        returnArgument = value
        return returned
      }),
    }
    const source = {
      [Symbol.asyncIterator]: poisonCallAndApply(() => {
        iteratorFactoryCalls += 1
        return sourceIterator
      }),
    }
    const observed = observeToolReturn(source, {
      onResolved: () => {},
      onRejected: () => {},
      onCancelled: (output) => cancelled.push(output),
    }) as AsyncIterable<unknown>
    const iterator = observed[Symbol.asyncIterator]()

    expect(await iterator.return?.('stop')).toBe(returned)
    expect(iteratorFactoryCalls).toBe(1)
    expect(returnCalls).toBe(1)
    expect(returnReceiver).toBe(sourceIterator)
    expect(returnArgument).toBe('stop')
    expect(cancelled).toEqual([undefined])
  })

  it('forwards iterator throw and preserves rejection identity', async () => {
    const rejection = new Error('exact iterator rejection')
    let throwReceiver: unknown
    let throwArgument: unknown
    const rejected: unknown[] = []
    const sourceIterator = {
      next: async () => ({ done: false, value: 'unreachable' }),
      throw: poisonCallAndApply(async function (this: unknown, error: unknown) {
        throwReceiver = this
        throwArgument = error
        throw rejection
      }),
    }
    const source = {
      [Symbol.asyncIterator]: () => sourceIterator,
    }
    const observed = observeToolReturn(source, {
      onResolved: () => {},
      onRejected: (error) => rejected.push(error),
      onCancelled: () => {},
    }) as AsyncIterable<unknown>
    const iterator = observed[Symbol.asyncIterator]()

    try {
      await iterator.throw?.('source-error')
      throw new Error('Expected iterator throw to reject')
    } catch (error) {
      expect(error).toBe(rejection)
    }
    expect(throwReceiver).toBe(sourceIterator)
    expect(throwArgument).toBe('source-error')
    expect(rejected).toEqual([rejection])
  })

  it('invokes a thenable whose own call and apply helpers are poisoned', async () => {
    const output = { exact: true }
    const then = poisonCallAndApply(function (
      this: unknown,
      resolve: (value: unknown) => void,
    ) {
      resolve(output)
    })
    const thenable = { then }

    expect(
      await observeToolReturn(thenable, {
        onResolved: () => {},
        onRejected: () => {},
        onCancelled: () => {},
      }),
    ).toBe(output)
  })
})
