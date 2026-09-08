/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * First suite for src/api/types.ts, gHashTag/trios#1649. Until now no test
 * in the corpus named either of the module's runtime exports; this suite
 * pins the behaviour they have today so the next change to the module has
 * something to fail against.
 *
 * Coverage ledger - every export the issue counts is pinned; nothing was
 * silently left out:
 *   - AgentLLMConfigSchema -> exercised below (the agent-layer LLM config
 *     contract: which configs parse, which are rejected and at which field,
 *     and how the shared LLMConfigSchema is tightened here - model stops
 *     being optional and must be a non-empty string).
 *   - ChatRequestSchema -> exercised below (the chat request contract: the
 *     UUID gate on conversationId, every default the schema fills in, the
 *     closed mode/origin enums, and the previousConversation normalisation
 *     from a plain string into turns).
 * No export was blocked by a live dependency: both schemas are pure
 * validation over plain values, so the suite needs no network, no database
 * and no container. The module's remaining exports are re-exports from
 * @browseros/shared/schemas/browser-context plus type-only declarations,
 * which define no behaviour of this module's own.
 */

import { describe, expect, it } from 'bun:test'
import type { z } from 'zod'
import { AgentLLMConfigSchema, ChatRequestSchema } from '../../src/api/types'

/** Parses with the schema, asserting success and returning the parsed output. */
function parsed(schema: z.ZodType, input: unknown): unknown {
  const result = schema.safeParse(input)
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(JSON.stringify(result.error.issues))
  return result.data
}

/** Parses with the schema, asserting rejection, and returns the reported field paths. */
function rejectedPaths(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input)
  expect(result.success).toBe(false)
  if (result.success) throw new Error(JSON.stringify(result.data))
  return result.error.issues.map((issue) => issue.path.join('.'))
}

const UUID = '123e4567-e89b-12d3-a456-426614174000'

describe('typesContract', () => {
  describe('AgentLLMConfigSchema', () => {
    it('pins the agent LLM config contract as it stands today', () => {
      // A minimal config parses, and the output invents nothing beyond
      // what was supplied.
      expect(
        parsed(AgentLLMConfigSchema, {
          provider: 'anthropic',
          model: 'claude-sonnet-4',
        }),
      ).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })

      // The provider-specific optional fields inherited from the shared
      // LLMConfigSchema survive the extension untouched.
      expect(
        parsed(AgentLLMConfigSchema, {
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'sk-test',
          baseUrl: 'https://example.test/v1',
        }),
      ).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        baseUrl: 'https://example.test/v1',
      })

      // The agent-specific upstreamProvider field is kept when supplied.
      expect(
        parsed(AgentLLMConfigSchema, {
          provider: 'openrouter',
          model: 'm',
          upstreamProvider: 'groq',
        }),
      ).toEqual({
        provider: 'openrouter',
        model: 'm',
        upstreamProvider: 'groq',
      })

      // The extension tightens the shared schema: a config with no model
      // is rejected at the model field, where the base LLMConfigSchema
      // would have accepted the config because model is optional there.
      expect(
        rejectedPaths(AgentLLMConfigSchema, { provider: 'anthropic' }),
      ).toContain('model')

      // An empty model name is rejected with the message the module
      // spells out.
      const emptyModel = AgentLLMConfigSchema.safeParse({
        provider: 'anthropic',
        model: '',
      })
      expect(emptyModel.success).toBe(false)
      if (emptyModel.success) throw new Error('unreachable')
      expect(
        emptyModel.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      ).toContain('model: Model name is required')

      // A provider outside the shared enum is rejected at the provider
      // field.
      expect(
        rejectedPaths(AgentLLMConfigSchema, {
          provider: 'not-a-real-provider',
          model: 'm',
        }),
      ).toContain('provider')
    })
  })

  describe('ChatRequestSchema', () => {
    it('pins the chat request contract as it stands today', () => {
      // A minimal request parses and fills in every default the schema
      // declares, exactly as declared.
      expect(
        parsed(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          conversationId: UUID,
        }),
      ).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        conversationId: UUID,
        message: '',
        isScheduledTask: false,
        supportsImages: true,
        mode: 'agent',
        origin: 'sidepanel',
      })

      // Explicitly supplied values win over every one of those defaults.
      expect(
        parsed(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          conversationId: UUID,
          message: 'summarise this page',
          isScheduledTask: true,
          supportsImages: false,
          mode: 'chat',
          origin: 'newtab',
        }),
      ).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        conversationId: UUID,
        message: 'summarise this page',
        isScheduledTask: true,
        supportsImages: false,
        mode: 'chat',
        origin: 'newtab',
      })

      // conversationId must be a UUID.
      expect(
        rejectedPaths(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'm',
          conversationId: 'not-a-uuid',
        }),
      ).toContain('conversationId')

      // The model requirement inherited from AgentLLMConfigSchema still
      // holds here: a chat request without a model is rejected, not
      // defaulted.
      expect(
        rejectedPaths(ChatRequestSchema, {
          provider: 'anthropic',
          conversationId: UUID,
        }),
      ).toContain('model')

      // mode and origin are closed enums, not free-form strings.
      expect(
        rejectedPaths(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'm',
          conversationId: UUID,
          mode: 'bogus',
        }),
      ).toContain('mode')
      expect(
        rejectedPaths(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'm',
          conversationId: UUID,
          origin: 'bogus',
        }),
      ).toContain('origin')

      // A previousConversation given as a plain string becomes a single
      // user turn, kept verbatim - surrounding spaces included.
      expect(
        parsed(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'm',
          conversationId: UUID,
          previousConversation: '  read this first  ',
        }),
      ).toEqual({
        provider: 'anthropic',
        model: 'm',
        conversationId: UUID,
        message: '',
        isScheduledTask: false,
        supportsImages: true,
        mode: 'agent',
        origin: 'sidepanel',
        previousConversation: [
          { role: 'user', content: '  read this first  ' },
        ],
      })

      // A whitespace-only string is dropped rather than turned into an
      // empty user turn: the parsed request reads previousConversation as
      // undefined (zod leaves the key on the output, with no value).
      const blank = parsed(ChatRequestSchema, {
        provider: 'anthropic',
        model: 'm',
        conversationId: UUID,
        previousConversation: '   ',
      })
      expect(
        (blank as { previousConversation?: unknown }).previousConversation,
      ).toBeUndefined()

      // An array-shaped previousConversation passes through untouched,
      // assistant turns included.
      expect(
        parsed(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'm',
          conversationId: UUID,
          previousConversation: [
            { role: 'assistant', content: 'earlier answer' },
          ],
        }),
      ).toEqual({
        provider: 'anthropic',
        model: 'm',
        conversationId: UUID,
        message: '',
        isScheduledTask: false,
        supportsImages: true,
        mode: 'agent',
        origin: 'sidepanel',
        previousConversation: [
          { role: 'assistant', content: 'earlier answer' },
        ],
      })

      // A turn whose role is neither user nor assistant is rejected.
      expect(
        rejectedPaths(ChatRequestSchema, {
          provider: 'anthropic',
          model: 'm',
          conversationId: UUID,
          previousConversation: [{ role: 'system', content: 'x' }],
        }),
      ).toContain('previousConversation')
    })
  })
})
