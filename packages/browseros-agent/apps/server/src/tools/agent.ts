/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Agent tools — MCP tools for multi-agent orchestration.
 *
 * These tools enable the Comet orchestrator and sidepanel Chat tab
 * to dispatch tasks, list agents, and retrieve conversation history.
 * All traffic flows through the MCP bridge per L24.
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "./framework";
import { ToolResponse } from "./response";
import { agentEventBus } from "./agent-bus";

// ============================================================================
// In-memory agent registry (Phase 2 will persist to .trinity/)
// ============================================================================

interface RegisteredAgent {
	soulName: string;
	status: "online" | "offline" | "busy";
	endpoint: string;
	currentIssue?: number;
	currentTask?: string;
	lastHeartbeat: string;
}

interface ConversationMessage {
	ts: string;
	role: "user" | "agent" | "tool" | "system";
	soulName: string;
	text: string;
	toolCall?: Record<string, unknown>;
}

interface Conversation {
	id: string;
	agentSoulName: string;
	issue?: number;
	createdAt: string;
	messages: ConversationMessage[];
}

/** Global agent registry — shared across all tool invocations. */
const agentRegistry = new Map<string, RegisteredAgent>();

/** Global conversation store — append-only per L21. */
const conversations = new Map<string, Conversation>();

/** Simple ID generator. */
function generateId(): string {
	return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Exported state access for REST routes (Phase 5)
// ============================================================================

/** Dispatch a task to an agent — used by both MCP tool and REST endpoint. */
export function dispatchTask(params: {
	soulName: string;
	prompt: string;
	issue?: number;
	cwd?: string;
}): { conversationId: string; accepted: boolean } {
	const { soulName, prompt, issue } = params;

	if (!agentRegistry.has(soulName)) {
		agentRegistry.set(soulName, {
			soulName,
			status: "busy",
			endpoint: `agent://${soulName}`,
			currentIssue: issue,
			currentTask: prompt,
			lastHeartbeat: new Date().toISOString(),
		});
	} else {
		const agent = agentRegistry.get(soulName)!;
		agent.status = "busy";
		agent.currentTask = prompt;
		agent.currentIssue = issue;
		agent.lastHeartbeat = new Date().toISOString();
	}

	const conversationId = generateId();
	const now = new Date().toISOString();
	const conversation: Conversation = {
		id: conversationId,
		agentSoulName: soulName,
		issue,
		createdAt: now,
		messages: [
			{ ts: now, role: "user", soulName: "orchestrator", text: prompt },
		],
	};
	conversations.set(conversationId, conversation);

	// Broadcast dispatch event
	agentEventBus.publish({
		type: "agent_dispatched",
		ts: now,
		conversationId,
		soulName,
		data: { prompt, issue, accepted: true },
	});

	return { conversationId, accepted: true };
}

/** Send a message to an existing conversation — used by both MCP tool and REST endpoint. */
export function sendChatMessage(params: {
	conversationId: string;
	message: string;
	role?: "user" | "orchestrator";
}): { accepted: boolean; messageId: string; error?: string } {
	const { conversationId, message, role = "user" } = params;

	const conversation = conversations.get(conversationId);
	if (!conversation) {
		return { accepted: false, messageId: "", error: "Conversation not found" };
	}

	const msgId = `msg-${Date.now()}`;
	const now = new Date().toISOString();
	conversation.messages.push({
		ts: now,
		role: role === "orchestrator" ? "system" : "user",
		soulName: role,
		text: message,
	});

	// Broadcast chat event
	agentEventBus.publish({
		type: "agent_message",
		ts: now,
		conversationId,
		soulName: conversation.agentSoulName,
		data: { messageId: msgId, role, text: message },
	});

	return { accepted: true, messageId: msgId };
}

/** List all registered agents. */
export function listAgents(): RegisteredAgent[] {
	return Array.from(agentRegistry.values());
}

/** Get a conversation by ID. */
export function getConversation(
	conversationId: string,
): Conversation | undefined {
	return conversations.get(conversationId);
}

// ============================================================================
// Tool: agent_list
// ============================================================================

export const agentList = defineTool({
	name: "agent_list",
	description:
		"List all registered agents with soul-names, status (online/offline/busy), " +
		"current task, and last heartbeat. Used by Comet orchestrator and sidepanel Agents tab.",
	approvalCategory: "data-modification",
	input: z.object({}),
	output: z.object({
		agents: z.array(
			z.object({
				soulName: z.string(),
				status: z.enum(["online", "offline", "busy"]),
				endpoint: z.string(),
				currentIssue: z.number().optional(),
				currentTask: z.string().optional(),
				lastHeartbeat: z.string(),
			}),
		),
		count: z.number(),
	}),
	handler: async (_args: unknown, _ctx: ToolContext, response: ToolResponse) => {
		const agents = Array.from(agentRegistry.values());
		const data = { agents, count: agents.length };
		response.text(`Registered agents: ${agents.length}`);
		response.data(data);
	},
});

// ============================================================================
// Tool: agent_dispatch
// ============================================================================

export const agentDispatch = defineTool({
	name: "agent_dispatch",
	description:
		"Send a task to a specific agent by soul-name. Creates a conversation, " +
		"returns conversationId. Task is appended to conversation log (L21 append-only).",
	approvalCategory: "assistant",
	input: z.object({
		soulName: z.string().describe("Agent soul-name to dispatch to"),
		prompt: z.string().describe("Task prompt for the agent"),
		issue: z.number().optional().describe("GitHub issue number"),
		cwd: z.string().optional().describe("Working directory for the agent"),
	}),
	output: z.object({
		conversationId: z.string(),
		accepted: z.boolean(),
		queuePosition: z.number().optional(),
	}),
	handler: async (
		args: { soulName: string; prompt: string; issue?: number; cwd?: string },
		_ctx: ToolContext,
		response: ToolResponse,
	) => {
		const { soulName, prompt, issue } = args;

		// Register agent if not seen before
		if (!agentRegistry.has(soulName)) {
			agentRegistry.set(soulName, {
				soulName,
				status: "busy",
				endpoint: `agent://${soulName}`,
				currentIssue: issue,
				currentTask: prompt,
				lastHeartbeat: new Date().toISOString(),
			});
		} else {
			// Update existing agent status
			const agent = agentRegistry.get(soulName)!;
			agent.status = "busy";
			agent.currentTask = prompt;
			agent.currentIssue = issue;
			agent.lastHeartbeat = new Date().toISOString();
		}

		// Create conversation (append-only, L21)
		const conversationId = generateId();
		const conversation: Conversation = {
			id: conversationId,
			agentSoulName: soulName,
			issue,
			createdAt: new Date().toISOString(),
			messages: [
				{
					ts: new Date().toISOString(),
					role: "user",
					soulName: "orchestrator",
					text: prompt,
				},
			],
		};
		conversations.set(conversationId, conversation);

		// Broadcast dispatch event to SSE listeners (Phase 3)
		agentEventBus.publish({
			type: "agent_dispatched",
			ts: new Date().toISOString(),
			conversationId,
			soulName,
			data: { prompt, issue, accepted: true },
		});

		const data = {
			conversationId,
			accepted: true,
			queuePosition: 1,
		};
		response.text(
			`Task dispatched to ${soulName} (conversation: ${conversationId})`,
		);
		response.data(data);
	},
});

// ============================================================================
// Tool: agent_chat
// ============================================================================

export const agentChat = defineTool({
	name: "agent_chat",
	description:
		"Send a message into an existing conversation. Supports multi-turn. " +
		"Events stream via /events SSE endpoint for sidepanel observability.",
	approvalCategory: "assistant",
	input: z.object({
		conversationId: z.string().describe("Existing conversation ID"),
		message: z.string().describe("Message text"),
		role: z
			.enum(["user", "orchestrator"])
			.default("user")
			.describe("Message role"),
	}),
	output: z.object({
		accepted: z.boolean(),
		messageId: z.string(),
	}),
	handler: async (
		args: { conversationId: string; message: string; role?: string },
		_ctx: ToolContext,
		response: ToolResponse,
	) => {
		const { conversationId, message, role = "user" } = args;

		const conversation = conversations.get(conversationId);
		if (!conversation) {
			const data = {
				accepted: false,
				messageId: "",
			};
			response.text(`Conversation ${conversationId} not found`);
			response.data(data);
			return;
		}

		// Append message (L21 — append-only)
		const msgId = `msg-${Date.now()}`;
		const now = new Date().toISOString();
		conversation.messages.push({
			ts: now,
			role: role === "orchestrator" ? "system" : "user",
			soulName: role,
			text: message,
		});

		// Broadcast chat message to SSE listeners (Phase 3)
		agentEventBus.publish({
			type: "agent_message",
			ts: now,
			conversationId,
			soulName: conversation.agentSoulName,
			data: { messageId: msgId, role, text: message },
		});

		const data = {
			accepted: true,
			messageId: msgId,
		};
		response.text(`Message sent to conversation ${conversationId}`);
		response.data(data);
	},
});

// ============================================================================
// Tool: conversation_history
// ============================================================================

export const conversationHistory = defineTool({
	name: "conversation_history",
	description:
		"Retrieve a conversation log. Read-only (L21 enforced). " +
		"Returns all messages in chronological order.",
	approvalCategory: "data-modification",
	input: z.object({
		conversationId: z.string().describe("Conversation ID to retrieve"),
		since: z
			.string()
			.optional()
			.describe("ISO timestamp to filter messages after"),
	}),
	output: z.object({
		messages: z.array(
			z.object({
				ts: z.string(),
				role: z.enum(["user", "agent", "tool", "system"]),
				soulName: z.string(),
				text: z.string(),
				toolCall: z.record(z.unknown()).optional(),
			}),
		),
		count: z.number(),
	}),
	handler: async (
		args: { conversationId: string; since?: string },
		_ctx: ToolContext,
		response: ToolResponse,
	) => {
		const { conversationId, since } = args;

		const conversation = conversations.get(conversationId);
		if (!conversation) {
			const data = { messages: [], count: 0 };
			response.text(`Conversation ${conversationId} not found`);
			response.data(data);
			return;
		}

		let messages = conversation.messages;
		if (since) {
			const sinceDate = new Date(since);
			messages = messages.filter((m) => new Date(m.ts) > sinceDate);
		}

		const data = { messages, count: messages.length };
		response.text(
			`Conversation ${conversationId}: ${messages.length} messages`,
		);
		response.data(data);
	},
});
