/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Browser } from "../../browser/browser";
import type { ToolRegistry } from "../../tools/tool-registry";
import type { AiSdkAgent } from "../ai-sdk-agent";
import type {
	AgentLogEntry,
	AgentStatus,
	AgentStatusResponse,
	AgentTask,
	PortableAgentConfig,
	TaskEvent,
} from "./config-schema";
import { LogCollector } from "./log-collector";

export interface PortableAgentDeps {
	triosId: string;
	browserContext?: Record<string, unknown>;
}

export class PortableAgent {
	private agent: AiSdkAgent | null = null;
	private status: AgentStatus = "idle";
	private startTime: number | null = null;
	private taskCount = 0;
	private conversationId: string | null = null;

	constructor(
		public readonly config: PortableAgentConfig,
		private readonly browser: Browser,
		private readonly registry: ToolRegistry,
		private readonly deps: PortableAgentDeps,
		private readonly logs = new LogCollector(),
	) {
		this.logs.info(`PortableAgent initialized for '${config.metadata.name}'`, {
			displayName: config.metadata.displayName,
			model: config.spec.llm.model,
		});
	}

	async start(): Promise<void> {
		if (this.status !== "idle" && this.status !== "stopped") {
			this.logs.warn(`Agent already in state '${this.status}', cannot start`);
			return;
		}

		this.status = "starting";
		this.startTime = Date.now();
		this.logs.info(`Starting agent '${this.config.metadata.name}'`);

		try {
			const { AiSdkAgent } = await import("../ai-sdk-agent");

			const resolvedConfig = this.buildResolvedConfig();
			this.agent = await AiSdkAgent.create({
				resolvedConfig,
				browser: this.browser,
				registry: this.registry,
				browserContext: this.deps.browserContext,
				klavisClient: undefined,
				triosId: this.deps.triosId,
			});

			this.conversationId = crypto.randomUUID();
			this.status = "idle";
			this.logs.info(
				`Agent '${this.config.metadata.name}' started successfully`,
			);
		} catch (error) {
			this.status = "error";
			this.logs.error(`Failed to start agent '${this.config.metadata.name}'`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.status === "stopped" || this.status === "starting") {
			return;
		}

		this.logs.info(`Stopping agent '${this.config.metadata.name}'`);

		try {
			if (this.agent) {
				await this.agent.dispose();
				this.agent = null;
			}

			this.status = "stopped";
			this.startTime = null;
			this.conversationId = null;
			this.logs.info(`Agent '${this.config.metadata.name}' stopped`);
		} catch (error) {
			this.logs.error(`Failed to stop agent '${this.config.metadata.name}'`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async dispose(): Promise<void> {
		await this.stop();
		this.logs.clear();
	}

	async sendTask(task: AgentTask): Promise<ReadableStream<TaskEvent>> {
		if (this.status !== "idle") {
			throw new Error(`Agent not ready. Current status: ${this.status}`);
		}

		this.status = "busy";
		this.taskCount++;
		this.logs.info(`Task submitted to agent '${this.config.metadata.name}'`, {
			taskLength: task.message.length,
		});

		if (!this.agent) {
			throw new Error("Agent not initialized");
		}

		try {
			// Stream task events from the agent's tool loop
			const agent = this.agent;
			if (!agent?.toolLoopAgent) {
				throw new Error("Agent tool loop not initialized");
			}

			return new ReadableStream<TaskEvent>({
				start: async (controller) => {
					controller.enqueue({ type: "start", taskId: crypto.randomUUID() });
					try {
						// Send the task message and collect the text response
						const messages = this.buildMessages(task);
						const result = await agent.toolLoopAgent.generate({
							messages,
							abortSignal: new AbortController().signal,
						});
						controller.enqueue({
							type: "text-delta",
							text: result.text ?? "",
						});
						controller.enqueue({ type: "done", result: result.text });
					} catch (error) {
						controller.enqueue({
							type: "error",
							error: error instanceof Error ? error.message : "Unknown error",
						});
					} finally {
						this.status = "idle";
						controller.close();
					}
				},
			});
		} catch (error) {
			this.status = "error";
			this.logs.error(`Task execution failed`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	getStatus(): AgentStatusResponse {
		const uptime = this.startTime
			? Math.floor((Date.now() - this.startTime) / 1000)
			: null;

		return {
			name: this.config.metadata.name,
			status: this.status,
			uptime,
			taskCount: this.taskCount,
			lastActivity: this.logs.getRecent(1)[0]?.timestamp || null,
			error:
				this.status === "error"
					? this.logs
							.getRecent(5)
							.reverse()
							.find((l) => l.level === "error")?.message || null
					: null,
			config: {
				displayName: this.config.metadata.displayName,
				model: this.config.spec.llm.model,
				provider: this.config.spec.llm.provider,
			},
		};
	}

	getLogs(): AgentLogEntry[] {
		return this.logs.get();
	}

	getLogsStream(): ReadableStream<AgentLogEntry> {
		return new ReadableStream({
			start: (controller) => {
				const _unsubscribe = this.logs.onLogEntry((entry) => {
					controller.enqueue(entry);
				});
			},
		});
	}

	private buildResolvedConfig() {
		const apiKey = this.resolveApiKey();
		const baseUrl = this.config.spec.llm.baseUrl;

		return {
			conversationId: this.conversationId || crypto.randomUUID(),
			provider: this.config.spec.llm.provider as any,
			model: this.config.spec.llm.model,
			apiKey,
			baseUrl,
			userSystemPrompt: this.config.spec.systemPrompt,
			workingDir: this.config.spec.workspace?.defaultDir,
			supportsImages: true,
			evalMode: false,
			chatMode: false,
			isScheduledTask: false,
			origin: "sidepanel" as const,
			triosId: this.deps.triosId,
			toolApprovalConfig: undefined,
		};
	}

	private buildMessages(task: AgentTask) {
		const messages: Array<{ role: "user" | "system"; content: string }> = [
			{
				role: "user",
				content: task.message,
			},
		];

		if (task.context?.browserContext) {
			messages.unshift({
				role: "system",
				content: JSON.stringify(task.context.browserContext),
			});
		}

		return messages;
	}

	private resolveApiKey(): string | undefined {
		const { apiKey } = this.config.spec.llm;

		if (!apiKey) {
			if (this.deps.browserContext?.apiKey) {
				return this.deps.browserContext.apiKey as string;
			}
			return undefined;
		}

		const match = apiKey.match(/^\${([^}]+)}$/);
		if (!match) return apiKey;

		const envVar = match[1];
		return process.env[envVar];
	}
}

export interface CreatePortableAgentOptions {
	resolvedConfig: {
		conversationId: string;
		provider: any;
		model: string;
		apiKey: string | undefined;
		baseUrl: string | undefined;
		userSystemPrompt: string | undefined;
		workingDir: string | undefined;
		supportsImages: boolean;
		evalMode: boolean;
		chatMode: boolean;
		isScheduledTask: boolean;
		origin: "newtab" | "sidepanel";
		triosId: string;
		toolApprovalConfig: unknown;
	};
	browser: Browser;
	registry: ToolRegistry;
	browserContext?: Record<string, unknown>;
	triosId: string;
	klavisClient?: unknown;
}

export async function createPortableAgent(
	options: CreatePortableAgentOptions,
): Promise<PortableAgent> {
	const config: PortableAgentConfig = {
		apiVersion: "trios.io/v1alpha1",
		kind: "PortableAgent",
		metadata: {
			name: "portable-agent",
			displayName: "Portable Agent",
			description: "Dynamically created portable agent",
		},
		spec: {
			llm: {
				provider: options.resolvedConfig.provider,
				model: options.resolvedConfig.model,
				apiKey: options.resolvedConfig.apiKey,
				baseUrl: options.resolvedConfig.baseUrl,
			},
			systemPrompt: options.resolvedConfig.userSystemPrompt,
			workspace: {
				defaultDir: options.resolvedConfig.workingDir,
			},
		},
	};

	const agent = new PortableAgent(config, options.browser, options.registry, {
		triosId: options.triosId,
		browserContext: options.browserContext,
	});

	return agent;
}
