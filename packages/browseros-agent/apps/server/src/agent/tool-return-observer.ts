export interface ToolReturnObserver {
  readonly onResolved: (output: unknown) => void
  readonly onRejected: (error: unknown) => void
  readonly onCancelled: (lastOutput: unknown) => void
}

function notify(callback: (value: unknown) => void, value: unknown): void {
  try {
    Reflect.apply(callback, undefined, [value])
  } catch {
    // Return observation is telemetry-only and may not affect execution.
  }
}

function propertyValue(value: unknown, property: PropertyKey): unknown {
  if (value === null || value === undefined) {
    return undefined
  }
  return (value as Record<PropertyKey, unknown>)[property]
}

function observePromiseLike(
  value: object,
  thenMethod: (...args: unknown[]) => unknown,
  observer: ToolReturnObserver,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        Reflect.apply(thenMethod, value, [resolve, reject])
      } catch (error) {
        reject(error)
      }
    })
  }).then(
    (output) => {
      notify(observer.onResolved, output)
      return output
    },
    (error) => {
      notify(observer.onRejected, error)
      throw error
    },
  )
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  )
}

function iteratorMethod(
  iterator: object,
  property: 'next' | 'return' | 'throw',
  required: boolean,
): ((...args: unknown[]) => unknown) | undefined {
  const method = propertyValue(iterator, property)
  if (method === undefined && !required) {
    return undefined
  }
  if (typeof method !== 'function') {
    throw new TypeError(`Async iterator '${property}' must be callable`)
  }
  return method as (...args: unknown[]) => unknown
}

function observeAsyncIterator(
  sourceIterator: object,
  observer: ToolReturnObserver,
): AsyncIterator<unknown> & AsyncIterable<unknown> {
  let settled = false
  let cancellationRequested = false
  let lastOutput: unknown

  const resolveOnce = (): void => {
    if (settled) {
      return
    }
    settled = true
    notify(
      cancellationRequested ? observer.onCancelled : observer.onResolved,
      lastOutput,
    )
  }
  const rejectOnce = (error: unknown): void => {
    if (settled) {
      return
    }
    settled = true
    notify(observer.onRejected, error)
  }
  const observeResult = (result: unknown): IteratorResult<unknown> => {
    if (!isObjectLike(result)) {
      throw new TypeError('Async iterator result must be an object')
    }
    if (propertyValue(result, 'done')) {
      resolveOnce()
    } else {
      lastOutput = propertyValue(result, 'value')
    }
    return result as IteratorResult<unknown>
  }

  const observedIterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
    async next(...args: [] | [unknown]): Promise<IteratorResult<unknown>> {
      try {
        const method = iteratorMethod(sourceIterator, 'next', true)
        return observeResult(
          await Reflect.apply(
            method as (...args: unknown[]) => unknown,
            sourceIterator,
            args,
          ),
        )
      } catch (error) {
        rejectOnce(error)
        throw error
      }
    },
    async return(...args: [] | [unknown]): Promise<IteratorResult<unknown>> {
      cancellationRequested = true
      try {
        const method = iteratorMethod(sourceIterator, 'return', false)
        const result =
          method === undefined
            ? { done: true, value: args[0] }
            : await Reflect.apply(method, sourceIterator, args)
        return observeResult(result)
      } catch (error) {
        rejectOnce(error)
        throw error
      }
    },
    async throw(...args: [] | [unknown]): Promise<IteratorResult<unknown>> {
      try {
        const method = iteratorMethod(sourceIterator, 'throw', false)
        if (method === undefined) {
          throw args[0]
        }
        return observeResult(await Reflect.apply(method, sourceIterator, args))
      } catch (error) {
        rejectOnce(error)
        throw error
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return observedIterator
    },
  }
  return observedIterator
}

function observeAsyncIterable(
  value: object,
  asyncIteratorMethod: (...args: unknown[]) => unknown,
  observer: ToolReturnObserver,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      try {
        const sourceIterator = Reflect.apply(asyncIteratorMethod, value, [])
        if (!isObjectLike(sourceIterator)) {
          throw new TypeError('Async iterator must be an object')
        }
        return observeAsyncIterator(sourceIterator, observer)
      } catch (error) {
        notify(observer.onRejected, error)
        throw error
      }
    },
  }
}

/**
 * Mirror the AI SDK's return-shape observation order: AsyncIterable first,
 * PromiseLike second, then a synchronous value. All callbacks are observe-only.
 */
export function observeToolReturn(
  value: unknown,
  observer: ToolReturnObserver,
): unknown {
  let asyncIteratorMethod: unknown
  try {
    asyncIteratorMethod = propertyValue(value, Symbol.asyncIterator)
  } catch (error) {
    notify(observer.onRejected, error)
    throw error
  }
  if (typeof asyncIteratorMethod === 'function' && isObjectLike(value)) {
    return observeAsyncIterable(
      value,
      asyncIteratorMethod as (...args: unknown[]) => unknown,
      observer,
    )
  }

  let thenMethod: unknown
  try {
    thenMethod = propertyValue(value, 'then')
  } catch (error) {
    notify(observer.onRejected, error)
    throw error
  }
  if (
    typeof thenMethod === 'function' &&
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null
  ) {
    return observePromiseLike(
      value,
      thenMethod as (...args: unknown[]) => unknown,
      observer,
    )
  }

  notify(observer.onResolved, value)
  return value
}
