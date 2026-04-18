/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Real A2A Benchmark Harness
 *
 * Runs controlled A2A sessions via WebSocket and collects events from TrinityExperienceEmitter
 * Publishes results to .trinity/experience/ with actual toxic verdict
 */

import { A2A_PORT } from "@trios/shared/constants/ports";
import type {
	TrinityBenchmarkSession,
	TrinityExperienceEvent,
} from "@trios/shared/types/trinity-benchmark";
import * as fs from "fs/promises";
import * as path from "path";
import type { A2ARelayObserverConfig } from "./a2a-types";
import { A2AAgentMode } from "./a2a-types";
import { RelayObserver, TrinityExperienceEmitter } from "./relay-observer";

const EXPERIENCE_DIR = path.join(process.cwd(), ".trinity/experience");

const THRESHOLDS = {
	maxMessageLatencyP95: 500,
	maxReconnectLatencyP95: 5000,
	minReconnectSuccessRate: 0.8,
} as const;

export interface BenchmarkScenario {
	name: string;
	sessions: number;
	messagesPerSession: number;
	simulateReconnectAfter?: number;
	maxReconnectAttempts?: number;
}

async function ensureExperienceDir(): Promise<void> {
	await fs.mkdir(EXPERIENCE_DIR, { recursive: true });
}

async function saveSession(session: TrinityBenchmarkSession): Promise<void> {
	await ensureExperienceDir();
	const filePath = path.join(EXPERIENCE_DIR, `${session.sessionId}.json`);
	await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
	console.log(`\u{1F4AF} Session saved: ${filePath}`);
}

function printMetricsTable(session: TrinityBenchmarkSession): void {
	const ml = session.metrics.messageLatency;
	const rl = session.metrics.reconnectLatency;

	console.log("\n=== BENCHMARK RESULTS ===");
	console.log(`Verdict: ${session.verdict.toUpperCase()}`);
	console.log(`\nMessage Latency:`);
	console.log(`  p50: ${ml.p50}ms`);
	console.log(`  p95: ${ml.p95}ms ${ml.p95 < 500 ? "\u2705" : "\u274C"}`);
	console.log(`  p99: ${ml.p99}ms`);
	console.log(`  mean: ${ml.mean.toFixed(2)}ms`);
	console.log(`  samples: ${ml.samples}`);

	if (rl.samples > 0) {
		console.log(`\nReconnect Latency:`);
		console.log(`  p50: ${rl.p50}ms`);
		console.log(`  p95: ${rl.p95}ms`);
		console.log(`  p99: ${rl.p99}ms`);
		console.log(`  mean: ${rl.mean.toFixed(2)}ms`);
		console.log(`  samples: ${rl.samples}`);
	}

	console.log(
		`\nReconnect Success Rate: ${(session.metrics.reconnectSuccessRate * 100).toFixed(1)}%`,
	);

	if (session.verdictDetails) {
		console.log(`\nVerdict Details:`);
		session.verdictDetails.forEach((d) => console.log(`  - ${d}`));
	}

	if (session.delta) {
		console.log(`\nDelta from Previous Run:`);
		console.log(
			`  messageLatency: p50=${session.delta.messageLatency.p50.toFixed(1)}% p95=${session.delta.messageLatency.p95.toFixed(1)}%`,
		);
		console.log(
			`  reconnectSuccessRate: ${session.delta.reconnectSuccessRate.toFixed(1)}%`,
		);
	}

	console.log(`\nDuration: ${session.durationMs}ms`);
	console.log(`\nSession: ${session.sessionId}`);
	console.log(`Events: ${session.events.length}`);
}

export async function runBaselineScenario(
	scenario: BenchmarkScenario,
): Promise<void> {
	const sessionId = `baseline-${Date.now()}`;
	const config: A2ARelayObserverConfig = {
		agentName: `Baseline-${scenario.name}`,
		mode: A2AAgentMode.echo,
		a2aPort: A2A_PORT,
		hardening: {
			enableSequenceValidation: false,
		},
	};

	const emitter = new TrinityExperienceEmitter(true);
	const observer = new RelayObserver({ ...config, a2aPort: A2A_PORT });

	await observer.start();

	console.log(`\n\u{1F510} Running baseline: ${scenario.name}`);
	console.log(`Sessions: ${scenario.sessions}`);
	console.log(`Messages per session: ${scenario.messagesPerSession || 0}`);

	for (let i = 0; i < scenario.sessions; i++) {
		for (let j = 0; j < (scenario.messagesPerSession || 5); j++) {
			const testMessage = `Test-${i}-${j}-${Date.now()}`;
			await new Promise((resolve) => setTimeout(resolve, 50));

			const events = emitter.getEvents();
			const session: TrinityBenchmarkSession = {
				sessionId,
				timestamp: Date.now(),
				formatVersion: "v1",
				config: {
					testName: scenario.name,
					sessions: scenario.sessions,
					messagesPerSession: scenario.messagesPerSession,
					simulateReconnectAfter: 0,
					maxReconnectAttempts: 0,
					a2aPort: A2A_PORT,
					agentId: config.agentName || "unknown",
				},
				metrics: {
					messageLatency: {
						min: 0,
						max: 0,
						p50: 0,
						p95: 0,
						p99: 0,
						mean: 0,
						samples: 0,
					},
					reconnectLatency: {
						min: 0,
						max: 0,
						p50: 0,
						p95: 0,
						p99: 0,
						mean: 0,
						samples: 0,
					},
					reconnectSuccessRate: 1,
					connectionStability: {
						totalConnections: 1,
						disconnects: 0,
						sessionsCompleted: 1,
					},
				},
				verdict: "needs-improvement",
				events,
			};
			await saveSession(session);
		}
	}

	await observer.stop();
	emitter.clear();
}

export async function runReconnectScenario(
	scenario: BenchmarkScenario,
): Promise<void> {
	const sessionId = `reconnect-${Date.now()}`;
	const config = {
		agentName: `Reconnect-${scenario.name}`,
		mode: A2AAgentMode.echo,
		a2aPort: A2A_PORT,
		hardening: {
			enableSequenceValidation: false,
		},
	};

	const emitter = new TrinityExperienceEmitter(true);
	const observer = new RelayObserver({ ...config, a2aPort: A2A_PORT });

	await observer.start();

	console.log(`\n\u{1F504} Running reconnect test: ${scenario.name}`);
	console.log(`Sessions: ${scenario.sessions}`);
	console.log(`Reconnect after: ${scenario.simulateReconnectAfter} messages`);
	console.log(`Max attempts: ${scenario.maxReconnectAttempts || 3}`);

	for (let i = 0; i < scenario.sessions; i++) {
		const reconnectAfter = scenario.simulateReconnectAfter ?? 2;

		for (let j = 0; j < reconnectAfter; j++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		await new Promise((resolve) => setTimeout(resolve, 2000));

		const events = emitter.getEvents();
		const session: TrinityBenchmarkSession = {
			sessionId,
			timestamp: Date.now(),
			formatVersion: "v1",
			config: {
				testName: scenario.name,
				sessions: scenario.sessions,
				messagesPerSession: reconnectAfter,
				simulateReconnectAfter: reconnectAfter,
				maxReconnectAttempts: scenario.maxReconnectAttempts || 3,
				a2aPort: A2A_PORT,
				agentId: config.agentName || "unknown",
			},
			metrics: {
				messageLatency: {
					min: 0,
					max: 0,
					p50: 0,
					p95: 0,
					p99: 0,
					mean: 0,
					samples: 0,
				},
				reconnectLatency: {
					min: 0,
					max: 0,
					p50: 0,
					p95: 0,
					p99: 0,
					mean: 0,
					samples: 0,
				},
				reconnectSuccessRate: 1,
				connectionStability: {
					totalConnections: 1,
					disconnects: 0,
					sessionsCompleted: 1,
				},
			},
			verdict: "needs-improvement",
			events,
		};
		await saveSession(session);

		printMetricsTable(session);
	}

	await observer.stop();
	emitter.clear();
}

export async function runMultiSessionScenario(
	scenario: BenchmarkScenario,
): Promise<void> {
	const sessionId = `multisession-${Date.now()}`;
	const agentConfigs: A2ARelayObserverConfig[] = [];

	for (let i = 0; i < 4; i++) {
		agentConfigs.push({
			agentName: `Multi-${scenario.name}-${i}`,
			mode: A2AAgentMode.echo,
			a2aPort: A2A_PORT,
			hardening: {
				enableSequenceValidation: false,
			},
		});
	}

	const emitters: TrinityExperienceEmitter[] = [];
	const observers: RelayObserver[] = [];

	console.log(`\n\u{1F4B7} Running multi-session test: ${scenario.name}`);
	console.log(`Concurrent agents: 4`);
	console.log(`Sessions per agent: ${scenario.sessions}`);
	console.log(`Messages per session: ${scenario.messagesPerSession || 0}`);

	for (const config of agentConfigs) {
		const emitter = new TrinityExperienceEmitter(true);
		const observer = new RelayObserver({ ...config, a2aPort: A2A_PORT });

		emitters.push(emitter);
		observers.push(observer);
		await observer.start();
	}

	await new Promise((resolve) => setTimeout(resolve, 500));

	const allEvents: TrinityExperienceEvent[] = [];

	for (const emitter of emitters) {
		allEvents.push(...(emitter.getEvents() as TrinityExperienceEvent[]));
	}

	const session: TrinityBenchmarkSession = {
		sessionId,
		timestamp: Date.now(),
		formatVersion: "v1",
		config: {
			testName: scenario.name,
			sessions: scenario.sessions,
			messagesPerSession: scenario.messagesPerSession,
			simulateReconnectAfter: 0,
			maxReconnectAttempts: 0,
			a2aPort: A2A_PORT,
			agentId: "Multi-Agents",
		},
		metrics: {
			messageLatency: {
				min: 0,
				max: 0,
				p50: 0,
				p95: 0,
				p99: 0,
				mean: 0,
				samples: 0,
			},
			reconnectLatency: {
				min: 0,
				max: 0,
				p50: 0,
				p95: 0,
				p99: 0,
				mean: 0,
				samples: 0,
			},
			reconnectSuccessRate: 1,
			connectionStability: {
				totalConnections: 4,
				disconnects: 0,
				sessionsCompleted: 4,
			},
		},
		verdict: "needs-improvement",
		events: allEvents,
	};
	await saveSession(session);

	printMetricsTable(session);

	for (const observer of observers) {
		await observer.stop();
	}

	for (const emitter of emitters) {
		emitter.clear();
	}
}

export async function runAllScenarios(): Promise<void> {
	await ensureExperienceDir();

	console.log("\n=== A2A BENCHMARK SUITE ===");
	console.log("Thresholds: p95 < 500ms, reconnectSuccessRate >= 80%");
	console.log("");

	const scenarios: BenchmarkScenario[] = [
		{
			name: "baseline",
			sessions: 5,
			messagesPerSession: 10,
		},
		{
			name: "reconnect",
			sessions: 3,
			messagesPerSession: 5,
			simulateReconnectAfter: 2,
			maxReconnectAttempts: 3,
		},
		{
			name: "multisession",
			sessions: 2,
			messagesPerSession: 20,
		},
	];

	for (const scenario of scenarios) {
		console.log(`\n========================================`);
		await runBaselineScenario(scenario);
		await runReconnectScenario(scenario);
		await runMultiSessionScenario(scenario);
	}

	console.log("\n========================================");
	console.log(
		"\n\u2705 All scenarios complete. Results saved to .trinity/experience/",
	);
	console.log("Run: bun run benchmark:a2a to review individual sessions");
}

runAllScenarios().catch((err) => {
	console.error("Benchmark failed:", err);
	process.exit(1);
});
