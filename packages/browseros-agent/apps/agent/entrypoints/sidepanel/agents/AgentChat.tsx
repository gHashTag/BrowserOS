/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * AgentChat — Sidepanel tab for real-time agent event observability.
 *
 * Connects to /agent-events SSE endpoint via useAgentEvents hook.
 * Displays dispatch events, chat messages, and status updates in real-time.
 * Phase 4 of Trinity Agent Bridge chat architecture.
 */

import { Bot, Loader2, Radio, RefreshCw, Send, Wifi, WifiOff } from 'lucide-react'
import { type FormEvent, useRef } from 'react'
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
					{event.data.text && <span className="text-foreground">{String(event.data.text).slice(0, 100)}</span>}
					{event.data.prompt && <span className="text-foreground">{String(event.data.prompt).slice(0, 100)}</span>}
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

	const visibleEvents = events.filter((e) => e.type !== 'heartbeat')

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault()
		// Phase 5 will add actual message sending via MCP tools
	}

	return (
		<div className="flex h-full flex-col">
			{/* Header */}
			<div className="flex items-center gap-2 border-b px-4 py-2">
				<Bot className="h-4 w-4 text-primary" />
				<span className="text-sm font-semibold">Agent Events</span>
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
							Dispatch tasks via <code className="rounded bg-muted px-1 py-0.5 font-mono">agent_dispatch</code> MCP tool
						</p>
					</div>
				) : (
					visibleEvents.map((event, i) => (
						<EventCard key={`${event.ts}-${i}`} event={event} />
					))
				)}
			</div>

			{/* Footer — placeholder for Phase 5 message input */}
			<div className="border-t px-4 py-2">
				<form onSubmit={handleSubmit} className="flex gap-2">
					<input
						type="text"
						placeholder="Agent chat coming in Phase 5…"
						disabled
						className="flex-1 rounded-md border bg-muted px-3 py-1.5 text-sm text-muted-foreground"
					/>
					<button
						type="submit"
						disabled
						className="rounded-md bg-primary/50 px-3 py-1.5 text-sm text-primary-foreground opacity-50"
					>
						<Send className="h-4 w-4" />
					</button>
				</form>
			</div>
		</div>
	)
}
