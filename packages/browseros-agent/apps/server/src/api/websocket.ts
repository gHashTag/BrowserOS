/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createBunWebSocket } from 'hono/bun'
import type { ServerWebSocket } from 'bun'

export const { upgradeWebSocket, websocket } =
  createBunWebSocket<ServerWebSocket>()

