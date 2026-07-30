import type { WSMessageReceive } from 'hono/ws'
import { z } from 'zod'

const TerminalInputMessageSchema = z.object({
  type: z.literal('input'),
  data: z.string(),
})

const TerminalResizeMessageSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

const TerminalClientMessageSchema = z.discriminatedUnion('type', [
  TerminalInputMessageSchema,
  TerminalResizeMessageSchema,
])

const TerminalOutputMessageSchema = z.object({
  type: z.literal('output'),
  data: z.string(),
})

const TerminalExitMessageSchema = z.object({
  type: z.literal('exit'),
  exitCode: z.number().int(),
})

const TerminalErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
})

const TerminalServerMessageSchema = z.discriminatedUnion('type', [
  TerminalOutputMessageSchema,
  TerminalExitMessageSchema,
  TerminalErrorMessageSchema,
])

export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>

function readSocketMessage(data: WSMessageReceive): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return null
}

export function parseTerminalClientMessage(
  data: WSMessageReceive,
): TerminalClientMessage | null {
  const text = readSocketMessage(data)
  if (!text) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  const result = TerminalClientMessageSchema.safeParse(parsed)
  return result.success ? result.data : null
}

export function serializeTerminalServerMessage(
  message: TerminalServerMessage,
): string {
  return JSON.stringify(TerminalServerMessageSchema.parse(message))
}
