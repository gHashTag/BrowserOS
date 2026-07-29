import { del, get, keys, set } from 'idb-keyval'
import type { AgentConversation } from './types'

const PREFIX = 'agent-conv:'

export async function saveConversation(conv: AgentConversation): Promise<void> {
  await set(`${PREFIX}${conv.agentId}:${conv.sessionKey}`, conv)
}

export async function getLatestConversation(
  agentId: string,
): Promise<AgentConversation | undefined> {
  const allKeys = await keys()
  const agentKeys = (allKeys as string[]).filter((k) =>
    k.startsWith(`${PREFIX}${agentId}:`),
  )
  if (!agentKeys.length) return undefined

  const conversations = await Promise.all(
    agentKeys.map((k) => get<AgentConversation>(k)),
  )
  const valid = conversations.filter((c): c is AgentConversation => c != null)
  return valid.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? undefined
}

export async function deleteConversation(
  agentId: string,
  sessionKey: string,
): Promise<void> {
  await del(`${PREFIX}${agentId}:${sessionKey}`)
}
