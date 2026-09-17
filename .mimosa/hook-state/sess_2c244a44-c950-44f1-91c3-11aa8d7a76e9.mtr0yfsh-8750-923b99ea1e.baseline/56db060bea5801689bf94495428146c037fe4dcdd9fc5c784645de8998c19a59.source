export interface AxisDefinition {
  name: string
  weight: number
  description: string
}

export interface AxisScore {
  axis: string
  score: number
  reasoning: string
}

export interface PerformanceEvalResponse {
  axes: AxisScore[]
}

export interface PreComputedMetrics {
  totalDurationMs: number
  totalToolCalls: number
  errorCount: number
  errorRate: number
  screenshotCount: number
  uniqueToolNames: string[]
  stepCount: number
  terminationReason: string
}

export interface PerformanceGraderOptions {
  axes?: AxisDefinition[]
  passThreshold?: number
  maxTurns?: number
  maxBudgetUsd?: number
}

export const PERFORMANCE_EVAL_SCHEMA = {
  type: 'object' as const,
  properties: {
    axes: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          axis: { type: 'string' as const },
          score: { type: 'number' as const },
          reasoning: { type: 'string' as const },
        },
        required: ['axis', 'score', 'reasoning'] as const,
      },
    },
  },
  required: ['axes'] as const,
}
