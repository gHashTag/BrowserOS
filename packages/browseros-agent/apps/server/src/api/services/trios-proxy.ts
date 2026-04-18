/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { jsonSchemaObjectToZodRawShape } from "zod-from-json-schema";
import { logger } from "../../lib/logger";
import { metrics } from "../../lib/metrics";

/**
 * Handle for the TRIOS REST proxy.
 *
 * Unlike the Klavis strata-proxy (which uses MCP Streamable HTTP),
 * trios-server exposes custom REST endpoints:
 *   POST /mcp/tools/list  → ListToolsResult
 *   POST /mcp/tools/call  → CallToolResult
 *
 * This proxy uses plain fetch() to call those endpoints directly.
 */
export interface TriosProxyHandle {
	tools: Tool[];
	inputSchemas: Map<string, Record<string, never>>;
	callTool: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<CallToolResult>;
	close: () => Promise<void>;
}

interface ConnectDeps {
	/** Base URL of trios-server, e.g. "http://localhost:9005" */
	url: string;
	/** Optional Bearer token (from TRIOS_API_KEY env var) */
	apiKey?: string;
}

// One-time async setup: discover tools from trios-server REST API
export async function connectTriosProxy(
	deps: ConnectDeps,
): Promise<TriosProxyHandle> {
	const baseUrl = deps.url.replace(/\/+$/, ""); // trim trailing slashes

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (deps.apiKey) {
		headers["Authorization"] = `Bearer ${deps.apiKey}`;
	}

	// Fetch tool list from trios-server REST endpoint
	const listResponse = await fetch(`${baseUrl}/mcp/tools/list`, {
		method: "POST",
		headers,
		body: "{}",
	});

	if (!listResponse.ok) {
		throw new Error(
			`TRIOS proxy list tools failed: ${listResponse.status} ${listResponse.statusText}`,
		);
	}

	const listResult = (await listResponse.json()) as { tools: Tool[] };
	const tools = listResult.tools;

	// Pre-compute Zod schemas once so registerTriosTools avoids per-request conversion.
	const inputSchemas = new Map(
		tools.map((t) => [
			t.name,
			jsonSchemaObjectToZodRawShape(
				t.inputSchema as never,
			) as unknown as Record<string, never>,
		]),
	);

	logger.info("TRIOS proxy connected", {
		url: baseUrl,
		toolCount: tools.length,
	});

	return {
		tools,
		inputSchemas,
		callTool: async (name, args) => {
			const response = await fetch(`${baseUrl}/mcp/tools/call`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name, arguments: args }),
			});

			if (!response.ok) {
				throw new Error(
					`TRIOS proxy call tool "${name}" failed: ${response.status} ${response.statusText}`,
				);
			}

			return (await response.json()) as CallToolResult;
		},
		// No persistent connection to close for REST-based proxy
		close: async () => {},
	};
}

export function registerTriosTools(
	mcpServer: McpServer,
	handle: TriosProxyHandle,
): void {
	// Register TRIOS proxy tools
	for (const tool of handle.tools) {
		const inputSchema = handle.inputSchemas.get(tool.name);

		mcpServer.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema,
			},
			async (args: Record<string, unknown>) => {
				const startTime = performance.now();
				try {
					const result = await handle.callTool(tool.name, args);

					metrics.log("tool_executed", {
						tool_name: tool.name,
						source: "trios-proxy",
						duration_ms: Math.round(performance.now() - startTime),
						success: !result.isError,
					});

					return result;
				} catch (error) {
					const errorText =
						error instanceof Error ? error.message : String(error);

					metrics.log("tool_executed", {
						tool_name: tool.name,
						source: "trios-proxy",
						duration_ms: Math.round(performance.now() - startTime),
						success: false,
						error_message: errorText,
					});

					return {
						content: [{ type: "text" as const, text: errorText }],
						isError: true,
					};
				}
			},
		);
	}

	logger.info("Registered TRIOS proxy tools on MCP server", {
		count: handle.tools.length,
	});
}
