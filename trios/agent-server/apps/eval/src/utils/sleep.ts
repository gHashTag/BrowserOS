/**
 * Shared sleep utility with optional abort signal support.
 */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(handle)
      reject(new Error('aborted'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
