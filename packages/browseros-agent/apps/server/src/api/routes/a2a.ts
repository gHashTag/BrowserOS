/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A2A Relay Stream Endpoint
 * Handles SSE streaming from A2A server to WebSocket client
 */

import { A2A_PORT } from "@trios/shared/constants/ports";
import { Hono } from "hono";
import type {
	A2AAgentMode,
	A2ARelayObserverConfig,
} from "../../agent/portable/a2a-types";
import { RelayObserver } from "../../agent/portable/relay-observer";
import { logger } from "../../lib/logger";
import type { Env } from "../types";

export interface A2ARoutesConfig {
	port?: number;
	a2aKey?: string;
}

export function createA2ARoutes(config: A2ARoutesConfig) {
	const port = config.port ?? A2A_PORT;
	const { a2aKey } = config;

	logger.info("A2A routes initialized", { port });

	return new Hono<Env>()
		.get("/health", async (c) => {
			return c.json({
				status: "ok",
				port,
				timestamp: Date.now(),
			});
		})
		.get("/experience", async (c) => {
			const agentId = c.req.query("agentId");
			if (!agentId) {
				return c.json({ error: "agentId required" }, 400);
			}

			return c.json({
				agentId,
				events: [],
				stats: {
					totalEvents: 0,
					connections: 0,
					disconnects: 0,
					messagesSent: 0,
					messagesReceived: 0,
					reconnectAttempts: 0,
					reconnectSuccesses: 0,
					reconnectFailures: 0,
				},
			});
		})
		.get("/sse", async (c) => {
			const conversationId = c.req.query("conversationId") || "default";
			const encoder = new TextEncoder();

			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));

					const interval = setInterval(() => {
						controller.enqueue(encoder.encode(": ping\n\n"));
					}, 15000);

					c.req.raw.signal.addEventListener("abort", () => {
						clearInterval(interval);
						controller.close();
					});
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		})
		.get("/ws", async (c) => {
			const providedKey = c.req.header("x-a2a-key");
			if (a2aKey && a2aKey !== providedKey) {
				logger.warn("A2A unauthorized - key mismatch");
				return c.text("Unauthorized", 401);
			}

			const relayConfig: A2ARelayObserverConfig = {
				a2aPort: port,
				a2aKey,
				conversationId: c.req.query("conversationId") || undefined,
				mode: (c.req.query("mode") as A2AAgentMode) || "echo",
				agentName: c.req.query("agentName") || "RelayObserver",
			};

			const observer = new RelayObserver(relayConfig);

			logger.info("A2A WebSocket connected", {
				agentId: relayConfig.agentName,
				mode: relayConfig.mode,
			});

			return c.json({ type: "ready" });
		});
}
