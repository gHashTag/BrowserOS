import {
  LazyMonitoringJudgeError,
  RemoteLazyMonitoringJudgeClient,
  resolveLazyMonitoringJudgeConfig,
} from './llm-judge'
import type { LazyMonitoringJudgeInput, LazyMonitoringJudgment } from './types'

export interface LazyMonitoringJudgeClient {
  judge(input: LazyMonitoringJudgeInput): Promise<LazyMonitoringJudgment>
}

export class LazyMonitoringJudgeService {
  constructor(private readonly client?: LazyMonitoringJudgeClient) {}

  async evaluate(
    input: LazyMonitoringJudgeInput,
  ): Promise<LazyMonitoringJudgment> {
    if (!this.client) {
      throw new LazyMonitoringJudgeError(
        'lazy monitoring judge is not configured',
      )
    }

    return this.client.judge(input)
  }
}

export function createLazyMonitoringJudgeService(): LazyMonitoringJudgeService {
  const config = resolveLazyMonitoringJudgeConfig()
  return new LazyMonitoringJudgeService(
    config ? new RemoteLazyMonitoringJudgeClient(config) : undefined,
  )
}
