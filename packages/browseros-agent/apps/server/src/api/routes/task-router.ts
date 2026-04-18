// Copyright 2025 TRIOS
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Task Router
// Routes portable agent tasks to appropriate handlers

import type {
	PortableAgentConfig,
	RelayObserverConfig,
} from "../../agent/portable/config-schema";
import { createPortableAgent } from "../../agent/portable/portable-agent";
import type { Browser } from "../../browser/browser";
import { logger } from "../../lib/logger";
import type { ToolRegistry } from "../../tools/tool-registry";

export function createTaskRouter(deps: {
	port: number;
	triosId: string;
	browser: Browser;
	registry: ToolRegistry;
	browserContext?: Record<string, unknown>;
}) {
	return {
		/**
		 * Handle relay observer task creation
		 */
		async createRelayObserver(
			conversationId: string,
			config: RelayObserverConfig,
		): Promise<{ success: boolean; message: string }> {
			const agentConfig: PortableAgentConfig = {
				apiVersion: "browseros.io/v1alpha1",
				kind: "PortableAgent",
				metadata: {
					name: "a2a-relay-observer",
					displayName: "A2A Relay Observer",
					description: "Relays A2A WebSocket messages to TRIOS chat",
				},
				spec: {
					llm: {
						provider: "anthropic",
						model: "claude-sonnet-4-20250514",
						apiKey: process.env.ANTHROPIC_API_KEY || "",
					},
					workspace: {
						defaultDir: config.workingDir,
					},
				},
			};

			const agent = await createPortableAgent({
				resolvedConfig: {
					conversationId,
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					apiKey: process.env.ANTHROPIC_API_KEY || "",
					baseUrl: "https://api.anthropic.com",
					userSystemPrompt: undefined,
					workingDir: config.workingDir,
					supportsImages: true,
					evalMode: false,
					chatMode: false,
					isScheduledTask: false,
					origin: "sidepanel",
					triosId: deps.triosId,
					toolApprovalConfig: undefined,
				},
				browser: deps.browser,
				registry: deps.registry,
				browserContext: config.browserContext || deps.browserContext,
				triosId: deps.triosId,
			});

			await agent.start();

			return {
				success: true,
				message: "A2A Relay Observer agent started",
			};
		},

		/**
		 * Handle all portable agent task requests
		 */
		async handlePortableTask(
			taskType: string,
			conversationId: string,
			config: any,
		): Promise<{ success: boolean; message: string }> {
			const agentConfig: PortableAgentConfig = {
				apiVersion: "browseros.io/v1alpha1",
				kind: "PortableAgent",
				metadata: {
					name: taskType.toLowerCase().replace(/\s+/g, "-"),
					displayName: taskType,
					description: `Portable agent task: ${taskType}`,
				},
				spec: {
					llm: {
						provider: config.provider || "anthropic",
						model: config.model || "claude-sonnet-4-20250514",
						apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
						baseUrl: config.baseUrl || "https://api.anthropic.com",
					},
					workspace: {
						defaultDir: config.workingDir,
					},
				},
			};

			const agent = await createPortableAgent({
				resolvedConfig: {
					conversationId,
					provider: config.provider || "anthropic",
					model: config.model || "claude-sonnet-4-20250514",
					apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
					baseUrl: config.baseUrl || "https://api.anthropic.com",
					userSystemPrompt: undefined,
					workingDir: config.workingDir,
					supportsImages: true,
					evalMode: false,
					chatMode: false,
					isScheduledTask: false,
					origin: "sidepanel",
					triosId: deps.triosId,
					toolApprovalConfig: undefined,
				},
				browser: deps.browser,
				registry: deps.registry,
				browserContext: config.browserContext || deps.browserContext,
				triosId: deps.triosId,
			});

			await agent.start();

			return {
				success: true,
				message: `${taskType} agent started`,
			};
		},
	};
}
