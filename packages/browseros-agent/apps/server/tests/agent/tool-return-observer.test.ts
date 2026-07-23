import { describe, expect, it } from 'bun:test'
import { observeToolReturn } from '../../src/agent/tool-return-observer'

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
})
