/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Local Authorization Service
 *
 * Issues a short-lived, server-side access token and a long-lived refresh token
 * that only the local BrowserOS/TriOS app can obtain via the loopback-trusted
 * /auth/local-token endpoint. Refresh-token rotation invalidates prior refresh
 * tokens on every use, and reuse of an old refresh token revokes the entire
 * token family.
 *
 * Token families are persisted in SQLite so they survive server restarts;
 * only SHA-256 hashes of tokens are stored on disk.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type AuthAuditEvent,
  type FamilyAuditEvent,
  RateLimitError,
  SqliteTokenFamilyStore,
  type TokenFamilyStore,
} from './token-family-store'

export { RateLimitError }

export interface LocalAuthTokenInfo {
  token: string
  issuedAt: string // ISO-8601
  expiresAt: string // ISO-8601
  expiresInSeconds: number
  ttlSeconds: number
}

export type TokenFamilyStatus = 'active' | 'rotated' | 'revoked'

export interface TokenFamily {
  familyId: string
  status: TokenFamilyStatus
  accessTokenHash: string
  refreshTokenHash: string
  rotatedRefreshHashes: string[]
  createdAt: Date
  rotatedAt: Date | null
  accessTokenIssuedAt: Date
  accessTokenExpiresAt: Date
}

export interface LocalAuthTokenPair {
  accessToken: string
  refreshToken: string
  info: LocalAuthTokenInfo
}

export interface LocalAuthRateLimitConfig {
  localTokenWindowMs: number
  localTokenMaxAttempts: number
  refreshWindowMs: number
  refreshMaxAttempts: number
}

export interface LocalAuthRetentionConfig {
  familyRetentionMs: number
  auditRetentionMs: number
  rateLimitRetentionMs: number
}

export interface LocalAuthServiceOptions {
  ttlSeconds?: number
  store?: TokenFamilyStore
  /** SQLite path used when store is not provided. Defaults to trios state dir. */
  dbPath?: string
  rateLimit?: Partial<LocalAuthRateLimitConfig>
  retention?: Partial<LocalAuthRetentionConfig>
}

export class LocalAuthService {
  static readonly DEFAULT_TTL_SECONDS = 900 // 15 minutes
  static readonly TOKEN_BYTES = 32
  static readonly FAMILY_ID_BYTES = 16
  static readonly DEFAULT_LOCAL_TOKEN_WINDOW_MS = 60_000 // 1 minute
  static readonly DEFAULT_LOCAL_TOKEN_MAX_ATTEMPTS = 100
  static readonly DEFAULT_REFRESH_WINDOW_MS = 60_000 // 1 minute
  static readonly DEFAULT_REFRESH_MAX_ATTEMPTS = 100
  static readonly DEFAULT_FAMILY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  static readonly DEFAULT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000 // 90 days
  static readonly DEFAULT_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000 // 1 day

  private readonly store: TokenFamilyStore
  private readonly ttlSeconds: number
  private readonly rateLimit: LocalAuthRateLimitConfig
  private readonly retention: LocalAuthRetentionConfig
  private currentAccessToken = ''

  constructor(options: LocalAuthServiceOptions = {}) {
    this.ttlSeconds = options.ttlSeconds ?? LocalAuthService.DEFAULT_TTL_SECONDS
    this.store =
      options.store ?? new SqliteTokenFamilyStore({ dbPath: options.dbPath })
    this.rateLimit = {
      localTokenWindowMs:
        options.rateLimit?.localTokenWindowMs ??
        LocalAuthService.DEFAULT_LOCAL_TOKEN_WINDOW_MS,
      localTokenMaxAttempts:
        options.rateLimit?.localTokenMaxAttempts ??
        LocalAuthService.DEFAULT_LOCAL_TOKEN_MAX_ATTEMPTS,
      refreshWindowMs:
        options.rateLimit?.refreshWindowMs ??
        LocalAuthService.DEFAULT_REFRESH_WINDOW_MS,
      refreshMaxAttempts:
        options.rateLimit?.refreshMaxAttempts ??
        LocalAuthService.DEFAULT_REFRESH_MAX_ATTEMPTS,
    }
    this.retention = {
      familyRetentionMs:
        options.retention?.familyRetentionMs ??
        LocalAuthService.DEFAULT_FAMILY_RETENTION_MS,
      auditRetentionMs:
        options.retention?.auditRetentionMs ??
        LocalAuthService.DEFAULT_AUDIT_RETENTION_MS,
      rateLimitRetentionMs:
        options.retention?.rateLimitRetentionMs ??
        LocalAuthService.DEFAULT_RATE_LIMIT_RETENTION_MS,
    }
    const active = this.store.getActiveFamily()
    if (active) {
      this.currentAccessToken = ''
    }
  }

  private generateToken(): string {
    return randomBytes(LocalAuthService.TOKEN_BYTES).toString('base64url')
  }

  private generateFamilyId(): string {
    return randomBytes(LocalAuthService.FAMILY_ID_BYTES).toString('base64url')
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url')
  }

  private timingSafeHashEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    if (leftBuffer.length !== rightBuffer.length) return false
    return timingSafeEqual(leftBuffer, rightBuffer)
  }

  private buildInfo(
    accessToken: string,
    issuedAt: Date,
    expiresAt: Date,
  ): LocalAuthTokenInfo {
    return {
      token: accessToken,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.max(
        0,
        Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      ),
      ttlSeconds: this.ttlSeconds,
    }
  }

  private audit(event: Omit<FamilyAuditEvent, 'timestamp'>): void {
    this.store.appendAudit({ ...event, timestamp: new Date() })
  }

  private recordRouteAudit(
    event: Omit<import('./token-family-store').AuthAuditEvent, 'timestamp'>,
  ): void {
    this.store.recordAuthAudit({ ...event, timestamp: new Date() })
  }

  private checkRateLimit(
    key: string,
    windowMs: number,
    maxAttempts: number,
    socketAddress?: string,
    context?: { eventType: AuthAuditEvent['eventType']; familyId?: string },
  ): void {
    const result = this.store.checkRateLimit(key, windowMs, maxAttempts)
    if (!result.allowed) {
      this.recordRouteAudit({
        eventType: context?.eventType ?? 'rate-limited',
        familyId: context?.familyId,
        socketAddress,
        details: `key=${key}`,
      })
      throw new RateLimitError(result.retryAfterMs)
    }
  }

  issueInitialTokens(socketAddress?: string): LocalAuthTokenPair {
    const rateKey = `local-token:${socketAddress ?? 'unknown'}`
    this.checkRateLimit(
      rateKey,
      this.rateLimit.localTokenWindowMs,
      this.rateLimit.localTokenMaxAttempts,
      socketAddress,
    )

    this.store.revokeAllFamilies()
    const familyId = this.generateFamilyId()
    const accessToken = this.generateToken()
    const refreshToken = this.generateToken()
    const now = Date.now()
    const issuedAt = new Date(now)
    const expiresAt = new Date(now + this.ttlSeconds * 1000)
    const family: TokenFamily = {
      familyId,
      status: 'active',
      accessTokenHash: this.hashToken(accessToken),
      refreshTokenHash: this.hashToken(refreshToken),
      rotatedRefreshHashes: [],
      createdAt: issuedAt,
      rotatedAt: null,
      accessTokenIssuedAt: issuedAt,
      accessTokenExpiresAt: expiresAt,
    }
    this.store.createFamily(family)
    this.store.setActiveFamily(familyId)
    this.currentAccessToken = accessToken
    this.audit({ eventType: 'created', familyId })
    this.recordRouteAudit({
      eventType: 'local-token-issued',
      familyId,
      socketAddress,
    })
    return {
      accessToken,
      refreshToken,
      info: this.buildInfo(accessToken, issuedAt, expiresAt),
    }
  }

  getToken(): string {
    return this.currentAccessToken
  }

  /**
   * Return metadata for the active family. Does not create a new family.
   * If no active family exists or the raw access token is not in memory
   * (e.g., after a server restart), returns a default expired info object.
   */
  getTokenInfo(): LocalAuthTokenInfo {
    const family = this.store.getActiveFamily()
    if (!family || !this.currentAccessToken) {
      return {
        token: '',
        issuedAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
        expiresInSeconds: 0,
        ttlSeconds: this.ttlSeconds,
      }
    }
    return this.buildInfo(
      this.currentAccessToken,
      family.accessTokenIssuedAt,
      family.accessTokenExpiresAt,
    )
  }

  getActiveFamily(): TokenFamily | null {
    return this.store.getActiveFamily()
  }

  listFamilies(options?: {
    status?: TokenFamilyStatus
    limit?: number
    offset?: number
  }): TokenFamily[] {
    return this.store.listFamilies(options)
  }

  /**
   * Run retention cleanup on revoked families, audit rows, and stale
   * rate-limit buckets. Returns the number of deleted rows per category.
   */
  cleanup(options?: Partial<LocalAuthRetentionConfig> & { nowMs?: number }) {
    return this.store.cleanup({
      familyRetentionMs:
        options?.familyRetentionMs ?? this.retention.familyRetentionMs,
      auditRetentionMs:
        options?.auditRetentionMs ?? this.retention.auditRetentionMs,
      rateLimitRetentionMs:
        options?.rateLimitRetentionMs ?? this.retention.rateLimitRetentionMs,
      nowMs: options?.nowMs,
    })
  }

  /**
   * Rotate a refresh token into a new access/refresh pair in the same family.
   * Returns the new pair on success, 'revoked' if the family was invalidated
   * due to reuse, or null if the refresh token is unrecognized.
   *
   * Throws RateLimitError if the per-IP refresh bucket is exhausted.
   */
  rotateRefreshToken(
    refreshToken: string,
    socketAddress?: string,
  ): LocalAuthTokenPair | 'revoked' | null {
    const hash = this.hashToken(refreshToken)
    const rateKey = `refresh:${socketAddress ?? 'unknown'}`
    this.checkRateLimit(
      rateKey,
      this.rateLimit.refreshWindowMs,
      this.rateLimit.refreshMaxAttempts,
      socketAddress,
    )

    this.recordRouteAudit({
      eventType: 'refresh-attempt',
      refreshHash: hash,
      socketAddress,
    })

    const newAccessToken = this.generateToken()
    const newRefreshToken = this.generateToken()
    const now = Date.now()
    const issuedAt = new Date(now)
    const expiresAt = new Date(now + this.ttlSeconds * 1000)

    const result = this.store.rotateRefreshToken(
      hash,
      this.hashToken(newAccessToken),
      this.hashToken(newRefreshToken),
      issuedAt,
      expiresAt,
    )

    if (result === 'not-found') {
      this.recordRouteAudit({
        eventType: 'refresh-not-found',
        refreshHash: hash,
        socketAddress,
      })
      return null
    }
    if (result === 'revoked') {
      this.audit({ eventType: 'revoked', refreshHash: hash })
      this.recordRouteAudit({
        eventType: 'refresh-revoked',
        refreshHash: hash,
        socketAddress,
      })
      this.currentAccessToken = ''
      return 'revoked'
    }

    const family = this.store.getActiveFamily()
    if (family) {
      this.store.setActiveFamily(family.familyId)
    }
    this.currentAccessToken = newAccessToken
    this.audit({
      eventType: 'rotated',
      familyId: family?.familyId,
      refreshHash: hash,
    })
    this.recordRouteAudit({
      eventType: 'refresh-success',
      familyId: family?.familyId,
      refreshHash: hash,
      socketAddress,
    })
    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      info: this.buildInfo(newAccessToken, issuedAt, expiresAt),
    }
  }

  revokeFamily(familyId: string): boolean {
    const family = this.store.findFamilyById(familyId)
    if (!family) return false
    this.store.revokeFamily(familyId)
    this.audit({ eventType: 'revoked', familyId })
    const active = this.store.getActiveFamily()
    if (active?.familyId === familyId) {
      this.currentAccessToken = ''
    }
    return true
  }

  revokeAllFamilies(): void {
    this.store.revokeAllFamilies()
    this.currentAccessToken = ''
    this.audit({ eventType: 'revoked-all' })
  }

  isExpired(): boolean {
    const family = this.store.getActiveFamily()
    if (!family || !this.currentAccessToken) return true
    return family.accessTokenExpiresAt.getTime() <= Date.now()
  }

  validate(headerValue: string | undefined): boolean {
    if (!headerValue) return false
    if (this.isExpired()) return false
    const family = this.store.getActiveFamily()
    if (!family || family.status !== 'active') return false
    return this.timingSafeHashEqual(
      this.hashToken(headerValue),
      family.accessTokenHash,
    )
  }
}
