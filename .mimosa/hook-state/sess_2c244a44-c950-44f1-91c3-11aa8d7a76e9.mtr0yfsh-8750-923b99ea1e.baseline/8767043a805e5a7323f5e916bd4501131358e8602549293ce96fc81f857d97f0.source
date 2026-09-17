import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { readSoul, writeSoul } from '../../lib/soul'
import { requireLocalAuth } from '../utils/require-local-auth'

const WriteSoulSchema = z.object({
  content: z.string(),
})

interface SoulRouteDeps {
  localAuth?: import('../utils/require-local-auth').LocalAuthValidator
}

export function createSoulRoutes(deps: SoulRouteDeps = {}) {
  return new Hono()
    .get('/', async (c) => {
      const content = await readSoul()
      return c.json({ content })
    })
    .put(
      '/',
      requireLocalAuth(deps.localAuth),
      zValidator('json', WriteSoulSchema),
      async (c) => {
        const { content } = c.req.valid('json')
        const result = await writeSoul(content)
        return c.json(result)
      },
    )
}
