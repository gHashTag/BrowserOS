/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Hono } from "hono";
import type { Browser } from "../../browser/browser";
import type { TriosProxyHandle } from "../services/trios-proxy";

interface HealthDeps {
	browser?: Browser;
	triosProxy?: TriosProxyHandle | null;
}

export function createHealthRoute(deps: HealthDeps = {}) {
	return new Hono().get("/", (c) => {
		const cdpConnected = deps.browser?.isCdpConnected();
		const triosConnected =
			deps.triosProxy !== null && deps.triosProxy !== undefined;
		const triosToolCount = deps.triosProxy?.tools.length ?? 0;

		return c.json({
			status: "ok",
			...(cdpConnected !== undefined && { cdpConnected }),
			trios: triosConnected
				? {
						connected: true,
						toolCount: triosToolCount,
					}
				: {
						connected: false,
						toolCount: 0,
					},
		});
	});
}
