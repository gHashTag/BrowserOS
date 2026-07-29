import type { ResolvedAgentConfig } from '@browseros/server/agent/types'
import type {
  DelegationResult,
  ExecutorBackend,
  ExecutorCallbacks,
} from '../../executor-backend'
import { CladoActionExecutor } from './clado-action-executor'

export interface CladoExecutorBackendOptions {
  configTemplate: ResolvedAgentConfig
  serverUrl: string
  initialPageId?: number
  callbacks?: ExecutorCallbacks
}

/** Executes delegated goals through the Clado visual action model. */
export class CladoExecutorBackend implements ExecutorBackend {
  readonly kind = 'clado'
  private executor: CladoActionExecutor | null = null

  constructor(private readonly options: CladoExecutorBackendOptions) {}

  async execute(
    instruction: string,
    signal?: AbortSignal,
  ): Promise<DelegationResult> {
    const executor = this.getExecutor()
    const result = await executor.execute(instruction, signal)
    return result
  }

  async close(): Promise<void> {
    await this.executor?.close()
  }

  getTotalSteps(): number {
    return this.executor?.getTotalSteps() ?? 0
  }

  private getExecutor(): CladoActionExecutor {
    if (this.executor) return this.executor

    this.executor = new CladoActionExecutor(
      {
        provider: this.options.configTemplate.provider,
        model: this.options.configTemplate.model,
        apiKey: this.options.configTemplate.apiKey ?? '',
        baseUrl: this.options.configTemplate.baseUrl,
      },
      this.options.serverUrl,
      this.options.initialPageId,
    )
    this.executor.setCallbacks(this.options.callbacks ?? {})
    return this.executor
  }
}
