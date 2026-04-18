/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ServerWebSocket } from "bun";
import { createBunWebSocket } from "hono/bun";

export const { upgradeWebSocket, websocket } =
	createBunWebSocket<ServerWebSocket>();
