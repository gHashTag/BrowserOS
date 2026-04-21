/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Agent Events SSE Route — real-time event stream for agent orchestration.
 *
 * GET /agent-events — SSE stream of all agent events (dispatch, chat, status).
 * GET /agent-events/history — JSON array of recent events (for replay on reconnect).
 *
 * The sidepanel Chat tab connects via EventSource to this endpoint (Phase 4).
 */

import { Hono } from "hono";
import type { AgentEvent } from "../../tools/agent-bus";
import { agentEventBus } from "../../tools/agent-bus";
import type { Env } from "../types";

/**
 * Encode an SSE event as a string.
 * Format: `event: <type>\ndata: <json>\n\n`
 */
function encodeSSE(event: AgentEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createAgentEventsRoutes() {
	return new Hono<Env>()
		/**
		 * GET / — SSE stream of agent events.
		 * Query params:
		 *   - since: ISO timestamp to replay events since (optional)
		 */
		.get("/", (c) => {
			const since = c.req.query("since");

			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();

					// Replay recent events if `since` is provided
					if (since) {
						const recent = agentEventBus.getRecentEvents(since);
						for (const event of recent) {
							controller.enqueue(encoder.encode(encodeSSE(event)));
						}
					}

					// Subscribe to new events
					const unsubscribe = agentEventBus.subscribe((event) => {
						try {
							controller.enqueue(encoder.encode(encodeSSE(event)));
						} catch {
							// Stream closed — unsubscribe
							unsubscribe();
						}
					});

					// Send initial heartbeat so client knows connection is alive
					controller.enqueue(
						encoder.encode(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`),
					);

					// Clean up on abort
					const abortHandler = () => {
						unsubscribe();
					};
					c.req.raw.signal.addEventListener("abort", abortHandler, { once: true });
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no", // Disable nginx buffering
				},
			});
		})

		/**
		 * GET /history — JSON array of recent events (for debugging / replay).
		 * Query params:
		 *   - since: ISO timestamp to filter events after (optional)
		 */
		.get("/history", (c) => {
			const since = c.req.query("since");
			const events = agentEventBus.getRecentEvents(since);
			return c.json({
				events,
				count: events.length,
				activeListeners: agentEventBus.listenerCount,
			});
		});
}
