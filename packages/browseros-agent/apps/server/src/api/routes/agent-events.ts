/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Agent Events SSE + REST Route — real-time event stream and REST API for agent orchestration.
 *
 * GET  /agent-events         — SSE stream of all agent events (dispatch, chat, status).
 * GET  /agent-events/history — JSON array of recent events (for replay on reconnect).
 * POST /agent-events/dispatch — Dispatch a task to an agent (creates conversation).
 * POST /agent-events/chat     — Send a message to an existing conversation.
 * GET  /agent-events/agents   — List all registered agents.
 *
 * The sidepanel Chat tab connects via EventSource to GET / and uses POST / for interaction (Phase 5).
 */

import { Hono } from "hono";
import type { AgentEvent } from "../../tools/agent-bus";
import { agentEventBus } from "../../tools/agent-bus";
import {
	dispatchTask,
	getConversation,
	listAgents,
	sendChatMessage,
} from "../../tools/agent";
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
		})

		/**
		 * GET /agents — List all registered agents.
		 */
		.get("/agents", (c) => {
			const agents = listAgents();
			return c.json({ agents, count: agents.length });
		})

		/**
		 * POST /dispatch — Dispatch a task to an agent.
		 * Body: { soulName: string, prompt: string, issue?: number, cwd?: string }
		 */
		.post("/dispatch", async (c) => {
			const body = await c.req.json<{
				soulName?: string;
				prompt?: string;
				issue?: number;
				cwd?: string;
			}>();

			if (!body.soulName || !body.prompt) {
				return c.json(
					{ error: "soulName and prompt are required" },
					400,
				);
			}

			const result = dispatchTask({
				soulName: body.soulName,
				prompt: body.prompt,
				issue: body.issue,
				cwd: body.cwd,
			});

			return c.json(result);
		})

		/**
		 * POST /chat — Send a message to an existing conversation.
		 * Body: { conversationId: string, message: string, role?: "user" | "orchestrator" }
		 */
		.post("/chat", async (c) => {
			const body = await c.req.json<{
				conversationId?: string;
				message?: string;
				role?: "user" | "orchestrator";
			}>();

			if (!body.conversationId || !body.message) {
				return c.json(
					{ error: "conversationId and message are required" },
					400,
				);
			}

			const result = sendChatMessage({
				conversationId: body.conversationId,
				message: body.message,
				role: body.role,
			});

			if (!result.accepted) {
				return c.json({ error: result.error }, 404);
			}

			return c.json(result);
		})

		/**
		 * GET /conversation/:id — Get conversation history.
		 */
		.get("/conversation/:id", (c) => {
			const id = c.req.param("id");
			const conversation = getConversation(id);
			if (!conversation) {
				return c.json({ error: "Conversation not found" }, 404);
			}
			return c.json({
				id: conversation.id,
				agentSoulName: conversation.agentSoulName,
				issue: conversation.issue,
				createdAt: conversation.createdAt,
				messages: conversation.messages,
				count: conversation.messages.length,
			});
		});
}
