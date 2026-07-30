import type { ExecutorResult } from '../orchestrator-executor/types'

export type ExecutorBackendKind = 'tool-loop' | 'clado'
export type DelegationResult = ExecutorResult

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolResultInfo {
  toolCallId: string
  toolName: string
  output: unknown
}

export interface ExecutorCallbacks {
  onToolCallStart?: (toolCall: ToolCallInfo) => void
  onToolCallFinish?: () => Promise<void>
  onStepFinish?: (step: {
    toolCalls?: ReadonlyArray<ToolCallInfo>
    toolResults?: ReadonlyArray<ToolResultInfo>
    text?: string
  }) => Promise<void>
}

export interface ExecutorBackend {
  readonly kind: ExecutorBackendKind
  execute(instruction: string, signal?: AbortSignal): Promise<DelegationResult>
  close(): Promise<void>
  getTotalSteps(): number
}
