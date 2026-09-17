import { CLADO_REQUEST_TIMEOUT_MS } from '../../../../constants'
import { formatCladoHistory } from './clado-actions'
import type { CladoAction, CladoActionResponse } from './types'

export interface CladoActionClientOptions {
  baseUrl?: string
  apiKey?: string
}

export interface CladoActionPredictionInput {
  instruction: string
  imageBase64: string
  actionHistory: CladoAction[]
  signal?: AbortSignal
}

/** Calls the Clado action model without exposing credentials in process arguments or artifacts. */
export class CladoActionClient {
  constructor(private readonly options: CladoActionClientOptions) {}

  async requestActionPrediction(
    input: CladoActionPredictionInput,
  ): Promise<CladoActionResponse> {
    if (!this.options.baseUrl) {
      throw new Error('executor.baseUrl must be set for clado-action provider')
    }

    const requestController = new AbortController()
    const onAbort = () => requestController.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })

    const timeoutHandle = setTimeout(() => {
      requestController.abort()
    }, CLADO_REQUEST_TIMEOUT_MS)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (this.options.apiKey) {
        headers.Authorization = `Bearer ${this.options.apiKey}`
      }

      const response = await fetch(this.options.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instruction: input.instruction,
          image_base64: input.imageBase64,
          history: formatCladoHistory(input.actionHistory),
        }),
        signal: requestController.signal,
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${body.slice(0, 400)}`,
        )
      }

      return (await response.json()) as CladoActionResponse
    } finally {
      clearTimeout(timeoutHandle)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}
