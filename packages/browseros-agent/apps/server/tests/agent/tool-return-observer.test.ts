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

    const observedYielded = await iterator.next()
    const observedCompleted = await iterator.next()
    expect(observedYielded).toEqual(yielded)
    expect(observedYielded.value).toBe(chunk)
    expect(observedCompleted).toEqual({ done: true, value: undefined })
    expect(accessorReads).toBe(1)
    expect(iteratorFactoryCalls).toBe(1)
    expect(iteratorFactoryReceiver).toBe(source)
    expect(nextCalls).toBe(2)
    expect(nextReceiver).toBe(sourceIterator)
    expect(resolved).toEqual([chunk])
  })

  it('captures a stateful next accessor once like native for-await', async () => {
    const rejection = new Error('exact second-pull rejection')
    const accessorError = new Error('next accessor read twice')
    const createSource = (label: string) => {
      const yielded = { done: false, value: { label } }
      let accessorReads = 0
      let pulls = 0
      const sourceIterator = Object.defineProperty({}, 'next', {
        get() {
          accessorReads += 1
          if (accessorReads > 1) {
            throw accessorError
          }
          return async () => {
            pulls += 1
            if (pulls === 1) {
              return yielded
            }
            throw rejection
          }
        },
      })
      return {
        accessorReads: () => accessorReads,
        iterable: {
          [Symbol.asyncIterator]: () => sourceIterator,
        },
        pulls: () => pulls,
        yielded,
      }
    }

    const baseline = createSource('baseline')
    const baselineValues: unknown[] = []
    let baselineError: unknown
    try {
      for await (const value of baseline.iterable) {
        baselineValues.push(value)
      }
    } catch (error) {
      baselineError = error
    }
    expect(baselineValues).toEqual([baseline.yielded.value])
    expect(baselineError).toBe(rejection)
    expect(baseline.accessorReads()).toBe(1)
    expect(baseline.pulls()).toBe(2)

    const source = createSource('observed')
    const observedRejections: unknown[] = []
    const observed = observeToolReturn(source.iterable, {
      onResolved: () => {},
      onRejected: (error) => observedRejections.push(error),
      onCancelled: () => {},
    }) as AsyncIterable<unknown>
    const iterator = observed[Symbol.asyncIterator]()

    const observedYielded = await iterator.next()
    expect(observedYielded).toEqual(source.yielded)
    expect(observedYielded.value).toBe(source.yielded.value)
    let observedError: unknown
    try {
      await iterator.next()
    } catch (error) {
      observedError = error
    }
    expect(observedError).toBe(rejection)
    expect(observedRejections).toEqual([rejection])
    expect(source.accessorReads()).toBe(1)
    expect(source.pulls()).toBe(2)
  })

  it('matches native for-await with one read of stateful done and value accessors', async () => {
    const duplicateReadError = new Error('iterator result accessor read twice')
    const createSource = (label: string) => {
      const reads = [
        { done: 0, value: 0 },
        { done: 0, value: 0 },
      ]
      const values = [
        { label, index: 0 },
        { label, index: 1 },
      ]
      const results = values.map((value, index) =>
        Object.defineProperties(
          {},
          {
            done: {
              get() {
                reads[index].done += 1
                if (reads[index].done > 1) {
                  throw duplicateReadError
                }
                return false
              },
            },
            value: {
              get() {
                reads[index].value += 1
                if (reads[index].value > 1) {
                  throw duplicateReadError
                }
                return value
              },
            },
          },
        ),
      )
      let pulls = 0
      let returnCalls = 0
      return {
        iterable: {
          [Symbol.asyncIterator]: () => ({
            next: async () => results[pulls++],
            return: async () => {
              returnCalls += 1
              return { done: true, value: undefined }
            },
          }),
        },
        reads,
        returnCalls: () => returnCalls,
        values,
      }
    }
    const collectTwo = async (iterable: AsyncIterable<unknown>) => {
      const values: unknown[] = []
      let error: unknown
      try {
        for await (const value of iterable) {
          values.push(value)
          if (values.length === 2) {
            break
          }
        }
      } catch (caught) {
        error = caught
      }
      return { error, values }
    }

    const baseline = createSource('baseline')
    const baselineResult = await collectTwo(baseline.iterable)
    expect(baselineResult).toEqual({
      error: undefined,
      values: baseline.values,
    })
    expect(baseline.reads).toEqual([
      { done: 1, value: 1 },
      { done: 1, value: 1 },
    ])
    expect(baseline.returnCalls()).toBe(1)

    const source = createSource('observed')
    const cancelled: unknown[] = []
    const rejected: unknown[] = []
    const observed = observeToolReturn(source.iterable, {
      onResolved: () => {},
      onRejected: (error) => rejected.push(error),
      onCancelled: (value) => cancelled.push(value),
    }) as AsyncIterable<unknown>
    const observedResult = await collectTwo(observed)

    expect(observedResult).toEqual({
      error: undefined,
      values: source.values,
    })
    expect(source.reads).toEqual([
      { done: 1, value: 1 },
      { done: 1, value: 1 },
    ])
    expect(source.returnCalls()).toBe(1)
    expect(rejected).toEqual([])
    expect(cancelled).toEqual([source.values[1]])
  })

  it('does not read a terminal iterator-result value accessor', async () => {
    const terminalValueError = new Error('terminal value must not be read')
    const reads = { done: 0, value: 0 }
    const terminalResult = Object.defineProperties(
      {},
      {
        done: {
          get() {
            reads.done += 1
            return true
          },
        },
        value: {
          get() {
            reads.value += 1
            throw terminalValueError
          },
        },
      },
    )
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => terminalResult,
      }),
    }
    const resolved: unknown[] = []
    const rejected: unknown[] = []
    const observed = observeToolReturn(source, {
      onResolved: (value) => resolved.push(value),
      onRejected: (error) => rejected.push(error),
      onCancelled: () => {},
    }) as AsyncIterable<unknown>

    const result = await observed[Symbol.asyncIterator]().next()

    expect(result).toEqual({ done: true, value: undefined })
    expect(reads).toEqual({ done: 1, value: 0 })
    expect(resolved).toEqual([undefined])
    expect(rejected).toEqual([])
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

    expect(await iterator.return?.('stop')).toEqual({
      done: true,
      value: undefined,
    })
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
