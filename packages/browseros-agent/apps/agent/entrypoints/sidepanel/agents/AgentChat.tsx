/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * AgentChat — Sidepanel tab for real-time agent event observability + chat.
 *
 * Connects to /agent-events SSE endpoint via useAgentEvents hook.
 * Displays dispatch events, chat messages, and status updates in real-time.
 * Enables sending messages to agents via REST API (Phase 5).
 */

import { Bot, Loader2, Radio, RefreshCw, Send, Wifi, WifiOff } from 'lucide-react'
import { type FormEvent, useCallback, useRef, useState } from 'react'
import { getAgentServerUrl } from '@/lib/trios/helpers'
import { useAgentEvents } from './useAgentEvents'

const EVENT_ICONS: Record<string, string> = {
	agent_dispatched: '🚀',
	agent_message: '💬',
	agent_status: '📡',
	conversation_updated: '🔄',
	heartbeat: '💓',
}

const EVENT_COLORS: Record<string, string> = {
	agent_dispatched: 'border-blue-500/30 bg-blue-500/5',
	agent_message: 'border-green-500/30 bg-green-500/5',
	agent_status: 'border-yellow-500/30 bg-yellow-500/5',
	conversation_updated: 'border-purple-500/30 bg-purple-500/5',
	heartbeat: 'border-gray-500/30 bg-gray-500/5',
}

function formatTime(ts: string): string {
	const d = new Date(ts)
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function EventCard({ event }: { event: ReturnType<typeof useAgentEvents>['events'][number] }) {
	if (event.type === 'heartbeat') return null

	const icon = EVENT_ICONS[event.type] ?? '📋'
	const color = EVENT_COLORS[event.type] ?? 'border-gray-500/30 bg-gray-500/5'

	return (
		<div className={`rounded-md border px-3 py-2 text-sm ${color}`}>
			<div className="flex items-center gap-2">
				<span>{icon}</span>
				<span className="font-medium text-foreground">{event.type.replace('agent_', '').replace('_', ' ')}</span>
				<span className="ml-auto text-xs text-muted-foreground">{formatTime(event.ts)}</span>
			</div>
			{event.soulName && (
				<div className="mt-1 text-xs text-muted-foreground">
					Agent: <span className="font-mono text-foreground">{event.soulName}</span>
				</div>
			)}
			{event.conversationId && (
				<div className="text-xs text-muted-foreground">
					Conv: <span className="font-mono text-foreground">{event.conversationId.slice(0, 20)}…</span>
				</div>
			)}
			{event.data && Object.keys(event.data).length > 0 && (
				<div className="mt-1 text-xs text-muted-foreground">
					{Boolean(event.data.text) && <span className="text-foreground">{String(event.data.text).slice(0, 100)}</span>}
					{Boolean(event.data.prompt) && <span className="text-foreground">{String(event.data.prompt).slice(0, 100)}</span>}
					{!event.data.text && !event.data.prompt && (
						<span className="font-mono">{JSON.stringify(event.data).slice(0, 80)}</span>
					)}
				</div>
			)}
		</div>
	)
}

export function AgentChat() {
	const { events, connected, error, reconnect } = useAgentEvents()
	const scrollRef = useRef<HTMLDivElement>(null)
	const [input, setInput] = useState('')
	const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
	const [sending, setSending] = useState(false)

	const visibleEvents = events.filter((e) => e.type !== 'heartbeat')

	const sendMessage = useCallback(async (message: string) => {
		if (!message.trim()) return

		setSending(true)
		try {
			const baseUrl = await getAgentServerUrl()

			// If no active conversation, dispatch a new task
			if (!activeConversationId) {
				const res = await fetch(`${baseUrl}/agent-events/dispatch`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						soulName: 'comet',
						prompt: message,
					}),
				})
				const data = await res.json()
				if (data.conversationId) {
					setActiveConversationId(data.conversationId)
				}
			} else {
				// Send to existing conversation
				await fetch(`${baseUrl}/agent-events/chat`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						conversationId: activeConversationId,
						message,
					}),
				})
			}
		} catch (err) {
			console.error('Failed to send agent message:', err)
		} finally {
			setSending(false)
		}
	}, [activeConversationId])

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault()
		const msg = input.trim()
		if (!msg || sending) return
		setInput('')
		sendMessage(msg)
	}

	return (
		<div className="flex h-full flex-col">
			{/* Header */}
			<div className="flex items-center gap-2 border-b px-4 py-2">
				<Bot className="h-4 w-4 text-primary" />
				<span className="text-sm font-semibold">Agent Events</span>
				{activeConversationId && (
					<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
						{activeConversationId.slice(0, 16)}…
					</span>
				)}
				<div className="ml-auto flex items-center gap-2">
					{connected ? (
						<div className="flex items-center gap-1 text-xs text-green-600">
							<Wifi className="h-3 w-3" />
							<span>Live</span>
						</div>
					) : (
						<div className="flex items-center gap-1 text-xs text-red-500">
							<WifiOff className="h-3 w-3" />
							<span>Disconnected</span>
						</div>
					)}
					<button
						type="button"
						onClick={reconnect}
						className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
						title="Reconnect"
					>
						<RefreshCw className="h-3 w-3" />
					</button>
				</div>
			</div>

			{/* Error bar */}
			{error && (
				<div className="bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
					{error}
				</div>
			)}

			{/* Event stream */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
				{visibleEvents.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
						<Radio className="h-8 w-8 opacity-50" />
						<p className="text-sm">Waiting for agent events…</p>
						<p className="text-xs opacity-70">
							Type a message below to dispatch a task to the Comet agent
						</p>
					</div>
				) : (
					visibleEvents.map((event, i) => (
						<EventCard key={`${event.ts}-${i}`} event={event} />
					))
				)}
			</div>

			{/* Chat input */}
			<div className="border-t px-4 py-2">
				<form onSubmit={handleSubmit} className="flex gap-2">
					<input
						type="text"
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder={activeConversationId ? 'Send message…' : 'Dispatch a task to Comet…'}
						disabled={sending}
						className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
					/>
					<button
						type="submit"
						disabled={sending || !input.trim()}
						className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					>
						{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
					</button>
				</form>
			</div>
		</div>
	)
}
