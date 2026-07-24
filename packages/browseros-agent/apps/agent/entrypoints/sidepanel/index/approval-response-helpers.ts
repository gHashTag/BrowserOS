import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai'
import type { ApprovalResponseData } from '@/lib/messaging/server/buildChatRequestBody'

export function extractCurrentStepApprovalResponses(
  messages: UIMessage[],
): ApprovalResponseData[] | null {
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== 'assistant') return null

  const lastStepStartIndex = lastMessage.parts.reduce(
    (lastIndex, part, index) =>
      part.type === 'step-start' ? index : lastIndex,
    -1,
  )
  const approvals: ApprovalResponseData[] = []
  for (const part of lastMessage.parts.slice(lastStepStartIndex + 1)) {
    const candidate = part as {
      state?: string
      approval?: { id: string; approved?: boolean; reason?: string }
    }
    if (
      candidate.state === 'approval-responded' &&
      candidate.approval?.approved != null
    ) {
      approvals.push({
        approvalId: candidate.approval.id,
        approved: candidate.approval.approved,
        reason: candidate.approval.reason,
      })
    }
  }
  return approvals.length > 0 ? approvals : null
}

export function getCurrentApprovalBatchSubmissionDecision(options: {
  messages: UIMessage[]
  approvalJustResponded: boolean
  isAcpTarget: boolean
}): {
  shouldSubmit: boolean
  shouldClearApprovalSignal: boolean
} {
  if (!options.approvalJustResponded) {
    return {
      shouldSubmit: false,
      shouldClearApprovalSignal: false,
    }
  }
  if (options.isAcpTarget) {
    return {
      shouldSubmit: false,
      shouldClearApprovalSignal: true,
    }
  }

  const shouldSubmit = lastAssistantMessageIsCompleteWithApprovalResponses({
    messages: options.messages,
  })
  return {
    shouldSubmit,
    shouldClearApprovalSignal: shouldSubmit,
  }
}
