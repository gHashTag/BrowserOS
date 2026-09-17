import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { refinePrompt } from '../../lib/clients/llm/refine-prompt'
import { logger } from '../../lib/logger'
import { AgentLLMConfigSchema } from '../types'

const RefinePromptRequestSchema = AgentLLMConfigSchema.extend({
  prompt: z.string().min(1, 'Prompt cannot be empty'),
  name: z.string().min(1, 'Task name cannot be empty'),
})

interface RefinePromptRouteDeps {
  browserosId?: string
}

export function createRefinePromptRoutes(deps: RefinePromptRouteDeps = {}) {
  return new Hono().post(
    '/',
    zValidator('json', RefinePromptRequestSchema),
    async (c) => {
      const { prompt, name, ...llmConfig } = c.req.valid('json')

      logger.info('Refine prompt request', {
        provider: llmConfig.provider,
        model: llmConfig.model,
        taskName: name,
      })

      const result = await refinePrompt(
        llmConfig,
        { prompt, name },
        deps.browserosId,
      )

      logger.info('Refine prompt result', {
        provider: llmConfig.provider,
        success: result.success,
      })

      return c.json(result, result.success ? 200 : 400)
    },
  )
}
