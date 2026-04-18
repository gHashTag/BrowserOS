/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LLMProvider } from "@trios/shared/schemas/llm";
import { z } from "zod";

export const PortableAgentConfigSchema = z.object({
	apiVersion: z.literal("browseros.io/v1alpha1"),
	kind: z.literal("PortableAgent"),
	metadata: z.object({
		name: z.string().regex(/^[a-z][a-z0-9-]*$/),
		displayName: z.string(),
		description: z.string().optional(),
		version: z.string().optional(),
		tags: z.array(z.string()).optional(),
	}),
	spec: z.object({
		llm: z.object({
			provider: z.string(),
			model: z.string(),
			baseUrl: z.string().url().optional(),
			apiKey: z.string().optional(),
			reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
		}),
		systemPrompt: z.string().optional(),
		tools: z
			.object({
				categories: z.record(z.boolean()).optional(),
				allowList: z.array(z.string()).optional(),
				denyList: z.array(z.string()).optional(),
			})
			.optional(),
		workspace: z
			.object({
				defaultDir: z.string().optional(),
				allowedPaths: z.array(z.string()).optional(),
			})
			.optional(),
		limits: z
			.object({
				maxTurns: z.number().int().positive().optional(),
				maxDuration: z.number().int().positive().optional(),
				maxTokens: z.number().int().positive().optional(),
			})
			.optional(),
		env: z
			.array(
				z.object({
					name: z.string(),
					value: z.string(),
					required: z.boolean().optional().default(true),
				}),
			)
			.optional(),
		template: z.string().optional(),
	}),
});

export type PortableAgentConfig = z.infer<typeof PortableAgentConfigSchema>;

export const AgentTaskSchema = z.object({
	message: z.string(),
	context: z
		.object({
			conversationId: z.string().optional(),
			browserContext: z.record(z.unknown()).optional(),
			metadata: z.record(z.unknown()).optional(),
		})
		.optional(),
});

export type AgentTask = z.infer<typeof AgentTaskSchema>;

export type AgentStatus = "idle" | "busy" | "error" | "starting" | "stopped";

export interface AgentStatusResponse {
	name: string;
	status: AgentStatus;
	uptime: number | null;
	taskCount: number;
	lastActivity: string | null;
	error: string | null;
	config: {
		displayName: string;
		model: string;
		provider: string;
	};
}

export interface AgentLogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	message: string;
	data?: Record<string, unknown>;
}

export type TaskEvent =
	| { type: "start"; taskId: string }
	| { type: "text-delta"; text: string }
	| { type: "tool-start"; toolName: string; args: unknown }
	| { type: "tool-end"; toolName: string; result: unknown }
	| { type: "done"; result: unknown }
	| { type: "error"; error: string };

/**
 * Relay Observer configuration for A2A (Agent-to-Agent) communication
 */
export const RelayObserverConfigSchema = z.object({
	browserContext: z.record(z.unknown()).optional(),
	workingDir: z.string().optional(),
});

export type RelayObserverConfig = z.infer<typeof RelayObserverConfigSchema>;
