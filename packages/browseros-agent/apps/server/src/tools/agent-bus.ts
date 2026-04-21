/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Agent Event Bus — SSE broadcast bus for real-time agent orchestration.
 *
 * Singleton event bus that publishes agent events to all connected SSE clients.
 * Used by the sidepanel Chat tab (Phase 4) for real-time observability.
 * All traffic flows through MCP bridge per L24.
 */

import { logger } from "../lib/logger";

// ============================================================================
// Event types
// ============================================================================

export interface AgentEvent {
	/** Event type discriminator. */
	type: "agent_dispatched" | "agent_message" | "agent_status" | "conversation_updated";
	/** ISO timestamp. */
	ts: string;
	/** Conversation ID (if applicable). */
	conversationId?: string;
	/** Agent soul-name. */
	soulName?: string;
	/** Event payload. */
	data: Record<string, unknown>;
}

type EventListener = (event: AgentEvent) => void;

// ============================================================================
// Agent EventBus — singleton
// ============================================================================

class AgentEventBus {
	private listeners = new Set<EventListener>();
	private eventLog: AgentEvent[] = [];
	private readonly maxLogSize = 1000;

	/**
	 * Publish an event to all connected SSE clients.
	 * Also appends to the in-memory event log for late subscribers.
	 */
	publish(event: AgentEvent): void {
		this.eventLog.push(event);
		if (this.eventLog.length > this.maxLogSize) {
			this.eventLog.shift();
		}

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				logger.warn("AgentEventBus listener error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		logger.debug(`AgentEventBus: published ${event.type}`, {
			conversationId: event.conversationId,
			soulName: event.soulName,
			listeners: this.listeners.size,
		});
	}

	/**
	 * Subscribe to agent events. Returns an unsubscribe function.
	 */
	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Get recent events (for replay to newly connected SSE clients).
	 */
	getRecentEvents(since?: string): AgentEvent[] {
		if (!since) return [...this.eventLog];
		const sinceDate = new Date(since);
		return this.eventLog.filter((e) => new Date(e.ts) > sinceDate);
	}

	/** Number of active SSE listeners. */
	get listenerCount(): number {
		return this.listeners.size;
	}
}

/** Global singleton event bus. */
export const agentEventBus = new AgentEventBus();
