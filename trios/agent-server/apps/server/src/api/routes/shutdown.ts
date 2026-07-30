/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Hono } from 'hono'
import { requireLocalAuth } from '../utils/require-local-auth'

interface ShutdownRouteConfig {
  onShutdown: () => void
}

interface ShutdownRouteDeps extends ShutdownRouteConfig {
  localAuth?: import('../utils/require-local-auth').LocalAuthValidator
}

export function createShutdownRoute(deps: ShutdownRouteDeps) {
  const { onShutdown, localAuth } = deps
  return new Hono().post('/', requireLocalAuth(localAuth), (c) => {
    setImmediate(onShutdown)
    return c.json({ status: 'ok' })
  })
}
