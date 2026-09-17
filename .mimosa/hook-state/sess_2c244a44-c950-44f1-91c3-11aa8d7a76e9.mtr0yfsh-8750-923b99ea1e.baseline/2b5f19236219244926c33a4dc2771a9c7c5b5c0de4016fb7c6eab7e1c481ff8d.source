/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import type {
  LocalAuthService,
  TokenFamily,
} from '../services/local-auth-service'
import { RateLimitError } from '../services/local-auth-service'
import type { Env } from '../types'
import { requireLocalAuth } from '../utils/require-local-auth'

interface LocalAuthRouteDeps {
  service: LocalAuthService
}

function redactHash(hash: string): string {
  if (hash.length <= 12) return '***'
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`
}

function familyToAdminDto(family: TokenFamily) {
  return {
    familyId: family.familyId,
    status: family.status,
    accessTokenHash: redactHash(family.accessTokenHash),
    refreshTokenHash: redactHash(family.refreshTokenHash),
    rotatedRefreshHashCount: family.rotatedRefreshHashes.length,
    createdAt: family.createdAt.toISOString(),
    rotatedAt: family.rotatedAt?.toISOString() ?? null,
    accessTokenIssuedAt: family.accessTokenIssuedAt.toISOString(),
    accessTokenExpiresAt: family.accessTokenExpiresAt.toISOString(),
  }
}

function getSocketAddress(c: Context<Env>): string | undefined {
  const server = c.env?.server
  if (!server || typeof server.requestIP !== 'function') return undefined
  try {
    const info = server.requestIP(c.req.raw)
    return info?.address
  } catch {
    return undefined
  }
}

function rateLimitResponse(c: Context<Env>, retryAfterMs: number) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return c.json({ error: 'Too many requests' }, 429, {
    'Retry-After': String(retryAfterSeconds),
  })
}

export function createLocalAuthRoutes(deps: LocalAuthRouteDeps) {
  const adminAuth = requireLocalAuth(deps.service)

  return new Hono<Env>()
    .get('/local-token', async (c) => {
      const socketAddress = getSocketAddress(c)
      try {
        const pair = deps.service.issueInitialTokens(socketAddress)
        return c.json({
          token: pair.accessToken,
          refreshToken: pair.refreshToken,
          issuedAt: pair.info.issuedAt,
          expiresAt: pair.info.expiresAt,
          expiresInSeconds: pair.info.expiresInSeconds,
          ttlSeconds: pair.info.ttlSeconds,
        })
      } catch (err) {
        if (err instanceof RateLimitError) {
          return rateLimitResponse(c, err.retryAfterMs)
        }
        throw err
      }
    })
    .post('/refresh', async (c) => {
      const socketAddress = getSocketAddress(c)
      let body: Record<string, unknown> = {}
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid request body' }, 400)
      }

      const refreshToken =
        typeof body.refreshToken === 'string' ? body.refreshToken : undefined
      if (!refreshToken) {
        return c.json({ error: 'Missing refresh token' }, 400)
      }

      try {
        const result = deps.service.rotateRefreshToken(
          refreshToken,
          socketAddress,
        )
        if (result === null) {
          return c.json({ error: 'Local authorization required' }, 403)
        }
        if (result === 'revoked') {
          return c.json({ error: 'refresh token revoked/reused' }, 401)
        }

        return c.json({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          info: result.info,
        })
      } catch (err) {
        if (err instanceof RateLimitError) {
          return rateLimitResponse(c, err.retryAfterMs)
        }
        throw err
      }
    })
    .get('/admin/families', adminAuth, async (c) => {
      const status =
        typeof c.req.query('status') === 'string'
          ? (c.req.query('status') as 'active' | 'rotated' | 'revoked')
          : undefined
      const limit =
        typeof c.req.query('limit') === 'string'
          ? parseInt(c.req.query('limit') as string, 10)
          : undefined
      const offset =
        typeof c.req.query('offset') === 'string'
          ? parseInt(c.req.query('offset') as string, 10)
          : undefined

      const families = deps.service.listFamilies({
        status,
        limit,
        offset,
      })
      return c.json({
        families: families.map(familyToAdminDto),
        total: families.length,
      })
    })
    .post('/admin/families/:familyId/revoke', adminAuth, async (c) => {
      const familyId = c.req.param('familyId')
      const family = deps.service.getActiveFamily()
      if (family?.familyId === familyId) {
        deps.service.revokeFamily(familyId)
        return c.json({ revoked: true })
      }
      const existing = deps.service
        .listFamilies({ limit: 1 })
        .find((f) => f.familyId === familyId)
      if (!existing) {
        return c.json({ error: 'Family not found' }, 404)
      }
      deps.service.revokeFamily(familyId)
      return c.json({ revoked: true })
    })
    .post('/admin/cleanup', adminAuth, async (c) => {
      let body: Record<string, unknown> = {}
      try {
        body = await c.req.json()
      } catch {
        // No body means use default retention.
      }
      const retention = {
        familyRetentionMs:
          typeof body.familyRetentionMs === 'number'
            ? body.familyRetentionMs
            : undefined,
        auditRetentionMs:
          typeof body.auditRetentionMs === 'number'
            ? body.auditRetentionMs
            : undefined,
        rateLimitRetentionMs:
          typeof body.rateLimitRetentionMs === 'number'
            ? body.rateLimitRetentionMs
            : undefined,
      }
      const result = deps.service.cleanup(retention)
      return c.json(result)
    })
}
