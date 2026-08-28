/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Hono } from 'hono'
import type { Browser } from '../../browser/browser'

interface StateBackend {
  backendStatus(): {
    durable: boolean
    configured: boolean
    error: string | null
  }
}

interface HealthDeps {
  browser?: Browser
  /// Anything holding state that may or may not have reached a database.
  /// Structurally typed rather than importing A2aRegistryService so the health
  /// route keeps no dependency on the service graph.
  stateBackend?: StateBackend
}

export function createHealthRoute(deps: HealthDeps = {}) {
  return new Hono().get('/', (c) => {
    const cdpConnected = deps.browser?.isCdpConnected()
    // Whether agent state outlives this process. A server with an unreachable
    // database serves every request exactly like one with a healthy database,
    // so without this field the only way to tell them apart is to restart and
    // see what was lost.
    const state = deps.stateBackend?.backendStatus()
    // pid lets a supervisor attribute this answer to a specific process.
    // Without it, a launcher that just spawned a server can only infer from
    // timing whether the answer came from its child or from a pre-existing
    // server holding the port - and a measured incident had it report a dead
    // child as "started" on exactly that inference.
    return c.json({
      status: 'ok',
      pid: process.pid,
      ...(cdpConnected === undefined ? {} : { cdpConnected }),
      ...(state === undefined ? {} : { state }),
    })
  })
}
