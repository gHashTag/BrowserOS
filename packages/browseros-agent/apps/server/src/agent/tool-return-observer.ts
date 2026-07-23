export interface ToolReturnObserver {
  readonly onResolved: (output: unknown) => void
  readonly onRejected: (error: unknown) => void
  readonly onCancelled: (lastOutput: unknown) => void
}

function notify(callback: (value: unknown) => void, value: unknown): void {
  try {
    callback(value)
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
        thenMethod.call(value, resolve, reject)
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

function observeAsyncIterable(
  value: AsyncIterable<unknown>,
  observer: ToolReturnObserver,
): AsyncIterable<unknown> {
  return (async function* () {
    let completed = false
    let lastOutput: unknown
    try {
      for await (const output of value) {
        lastOutput = output
        yield output
      }
      completed = true
      notify(observer.onResolved, lastOutput)
    } catch (error) {
      notify(observer.onRejected, error)
      throw error
    } finally {
      if (!completed) {
        notify(observer.onCancelled, lastOutput)
      }
    }
  })()
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
  if (typeof asyncIteratorMethod === 'function') {
    return observeAsyncIterable(value as AsyncIterable<unknown>, observer)
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
