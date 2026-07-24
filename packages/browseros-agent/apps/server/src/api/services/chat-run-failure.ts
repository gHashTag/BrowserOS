/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  EvidenceEvent,
  ExecutionEffectState,
  ToolEffect,
} from '../../agent/execution-types'

const MUTATING_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  'filesystem-write',
  'command',
  'browser-write',
  'external-write',
])

function hasMutatingEffect(event: EvidenceEvent): boolean {
  return event.effects.some((effect) => MUTATING_EFFECTS.has(effect))
}

export function deriveFailureEffectState(
  evidence: readonly EvidenceEvent[],
): ExecutionEffectState {
  const settledToolCalls = new Set(
    evidence
      .filter((event) => event.kind === 'settled')
      .map((event) => event.toolCallId),
  )
  let hasKnownEffect = false

  for (const event of evidence) {
    if (event.result?.effectStatus === 'unknown') {
      return 'unknown'
    }
    if (
      event.kind === 'settled' &&
      event.result === undefined &&
      hasMutatingEffect(event)
    ) {
      return 'unknown'
    }
    if (
      event.result?.effectStatus === 'applied' ||
      event.result?.effectStatus === 'partial'
    ) {
      hasKnownEffect = true
    }
  }

  const hasUnresolvedMutation = evidence.some(
    (event) =>
      event.kind === 'requested' &&
      hasMutatingEffect(event) &&
      !settledToolCalls.has(event.toolCallId),
  )
  if (hasUnresolvedMutation) {
    return 'unknown'
  }
  return hasKnownEffect ? 'partial' : 'none'
}
