/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Hono } from 'hono'
import type { Browser } from '../../browser/browser'

interface HealthDeps {
  browser?: Browser
}

export function createHealthRoute(deps: HealthDeps = {}) {
  return new Hono().get('/', (c) => {
    const cdpConnected = deps.browser?.isCdpConnected()
    // pid lets a supervisor attribute this answer to a specific process.
    // Without it, a launcher that just spawned a server can only infer from
    // timing whether the answer came from its child or from a pre-existing
    // server holding the port - and a measured incident had it report a dead
    // child as "started" on exactly that inference.
    return c.json(
      cdpConnected === undefined
        ? { status: 'ok', pid: process.pid }
        : { status: 'ok', cdpConnected, pid: process.pid },
    )
  })
}
