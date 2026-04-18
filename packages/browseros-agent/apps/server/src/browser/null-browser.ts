/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BrowserContext } from '@trios/shared/schemas/browser-context'

/**
 * Fallback browser implementation when CDP is unavailable.
 * Allows the HTTP server (including /chat and /a2a) to boot in a degraded mode.
 */
export class NullBrowser {
  isCdpConnected(): boolean {
    return false
  }

  async resolveTabIds(_tabIds: number[]): Promise<Map<number, number>> {
    return new Map()
  }

  async newPage(): Promise<number> {
    throw new Error('CDP unavailable: cannot create pages')
  }

  async listPages(): Promise<Array<{ pageId: number; windowId?: number }>> {
    return []
  }

  async closePage(_pageId: number): Promise<void> {}

  // Some callers pass browserContext through; keep signature-compatible.
  async getBrowserContext(
    ctx?: BrowserContext,
  ): Promise<BrowserContext | undefined> {
    return ctx
  }
}
