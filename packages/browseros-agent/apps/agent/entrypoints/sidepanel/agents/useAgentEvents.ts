/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * useAgentEvents — React hook for SSE connection to agent event bus.
 *
 * Connects to /agent-events SSE endpoint on the BrowserOS server.
 * Handles reconnection with exponential backoff.
 * Lives in sidepanel.html (not SW) to survive MV3 service worker death.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAgentServerUrl } from '@/lib/trios/helpers'

export interface AgentEvent {
	type: 'agent_dispatched' | 'agent_message' | 'agent_status' | 'conversation_updated' | 'heartbeat'
	ts: string
	conversationId?: string
	soulName?: string
	data: Record<string, unknown>
}

interface UseAgentEventsReturn {
	events: AgentEvent[]
	connected: boolean
	error: string | null
	reconnect: () => void
}

const MAX_EVENTS = 200
const MAX_BACKOFF_MS = 30_000
const INITIAL_BACKOFF_MS = 1_000

export function useAgentEvents(): UseAgentEventsReturn {
	const [events, setEvents] = useState<AgentEvent[]>([])
	const [connected, setConnected] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const esRef = useRef<EventSource | null>(null)
	const backoffRef = useRef(INITIAL_BACKOFF_MS)
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const connect = useCallback(async () => {
		// Clean up existing connection
		if (esRef.current) {
			esRef.current.close()
			esRef.current = null
		}

		try {
			const baseUrl = await getAgentServerUrl()
			const url = `${baseUrl}/agent-events`

			const es = new EventSource(url)
			esRef.current = es

			es.onopen = () => {
				setConnected(true)
				setError(null)
				backoffRef.current = INITIAL_BACKOFF_MS
			}

			es.onerror = () => {
				setConnected(false)
				es.close()
				esRef.current = null

				// Exponential backoff reconnection
				const delay = backoffRef.current
				backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS)
				setError(`Connection lost, retrying in ${Math.round(delay / 1000)}s…`)

				reconnectTimerRef.current = setTimeout(() => {
					connect()
				}, delay)
			}

			// Listen for specific event types
			const eventTypes = ['agent_dispatched', 'agent_message', 'agent_status', 'conversation_updated', 'heartbeat'] as const
			for (const eventType of eventTypes) {
				es.addEventListener(eventType, (e: MessageEvent) => {
					try {
						const event = JSON.parse(e.data) as AgentEvent
						setEvents((prev) => {
							const next = [...prev, event]
							return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
						})
					} catch {
						// Ignore malformed events
					}
				})
			}
		} catch (err) {
			setConnected(false)
			setError(err instanceof Error ? err.message : 'Failed to connect')
		}
	}, [])

	// Connect on mount, disconnect on unmount
	useEffect(() => {
		connect()
		return () => {
			if (esRef.current) {
				esRef.current.close()
				esRef.current = null
			}
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current)
			}
		}
	}, [connect])

	const reconnect = useCallback(() => {
		if (reconnectTimerRef.current) {
			clearTimeout(reconnectTimerRef.current)
		}
		backoffRef.current = INITIAL_BACKOFF_MS
		connect()
	}, [connect])

	return { events, connected, error, reconnect }
}
