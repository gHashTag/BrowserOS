import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  extractCurrentStepApprovalResponses,
  getCurrentApprovalBatchSubmissionDecision,
} from './approval-response-helpers'

type MessagePart = UIMessage['parts'][number]

function stepStart(): MessagePart {
  return { type: 'step-start' }
}

function approvalPart(
  approvalId: string,
  state: 'approval-requested' | 'approval-responded',
  approved?: boolean,
  reason?: string,
): MessagePart {
  if (state === 'approval-requested') {
    return {
      type: 'dynamic-tool',
      toolCallId: `call-${approvalId}`,
      toolName: 'filesystem_write',
      state,
      input: { path: `/tmp/${approvalId}` },
      approval: { id: approvalId },
    }
  }

  return {
    type: 'dynamic-tool',
    toolCallId: `call-${approvalId}`,
    toolName: 'filesystem_write',
    state,
    input: { path: `/tmp/${approvalId}` },
    approval: {
      id: approvalId,
      approved: approved ?? false,
      ...(reason === undefined ? {} : { reason }),
    },
  }
}

function assistantMessage(parts: MessagePart[]): UIMessage {
  return {
    id: 'assistant-approval',
    role: 'assistant',
    parts,
  }
}

describe('approval response helpers', () => {
  it('submits only once every current-step approval has a response', () => {
    const partial = [
      assistantMessage([
        stepStart(),
        approvalPart('approval-a', 'approval-responded', true),
        approvalPart('approval-b', 'approval-requested'),
      ]),
    ]
    const complete = [
      assistantMessage([
        stepStart(),
        approvalPart('approval-a', 'approval-responded', true),
        approvalPart('approval-b', 'approval-responded', false),
      ]),
    ]

    expect(
      getCurrentApprovalBatchSubmissionDecision({
        messages: partial,
        approvalJustResponded: true,
        isAcpTarget: false,
      }),
    ).toEqual({
      shouldSubmit: false,
      shouldClearApprovalSignal: false,
    })
    expect(
      getCurrentApprovalBatchSubmissionDecision({
        messages: complete,
        approvalJustResponded: true,
        isAcpTarget: false,
      }),
    ).toEqual({
      shouldSubmit: true,
      shouldClearApprovalSignal: true,
    })
    expect(
      getCurrentApprovalBatchSubmissionDecision({
        messages: complete,
        approvalJustResponded: false,
        isAcpTarget: false,
      }),
    ).toEqual({
      shouldSubmit: false,
      shouldClearApprovalSignal: false,
    })
  })

  it('does not auto-submit approval responses for ACP targets', () => {
    const complete = [
      assistantMessage([
        stepStart(),
        approvalPart('approval-a', 'approval-responded', true),
      ]),
    ]

    expect(
      getCurrentApprovalBatchSubmissionDecision({
        messages: complete,
        approvalJustResponded: true,
        isAcpTarget: true,
      }),
    ).toEqual({
      shouldSubmit: false,
      shouldClearApprovalSignal: true,
    })
  })

  it('extracts only responses from the current assistant step', () => {
    const messages = [
      assistantMessage([
        stepStart(),
        approvalPart('approval-a', 'approval-responded', true),
        stepStart(),
        approvalPart(
          'approval-b',
          'approval-responded',
          false,
          'Use a safer alternative',
        ),
      ]),
    ]

    expect(extractCurrentStepApprovalResponses(messages)).toEqual([
      {
        approvalId: 'approval-b',
        approved: false,
        reason: 'Use a safer alternative',
      },
    ])
  })
})
