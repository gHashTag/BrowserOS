import type {
  MonitoringSessionContext,
  MonitoringToolCallRecord,
} from '../types'

export type LazyMonitoringVerdict =
  | 'safe'
  | 'needs_review'
  | 'suspicious'
  | 'unsafe'

export type LazyMonitoringReviewMode = 'llm'

export type LazyMonitoringPolicyDimension =
  | 'scope_mismatch'
  | 'unexpected_side_effect'
  | 'destructive_action'
  | 'communication_risk'
  | 'data_access'

export interface LazyMonitoringJudgeInput {
  run: MonitoringSessionContext
  priorToolCalls: MonitoringToolCallRecord[]
  currentToolCall: MonitoringToolCallRecord
}

export interface LazyMonitoringJudgment {
  monitoringSessionId: string
  agentId: string
  toolCallId: string
  toolName: string
  verdict: LazyMonitoringVerdict
  summary: string
  destructive: boolean
  shouldInterrupt: boolean
  mode: LazyMonitoringReviewMode
  categories: string[]
  matchedIntentCategories: string[]
  policyDimensions: LazyMonitoringPolicyDimension[]
  policyVersion: string
  model?: string
}
