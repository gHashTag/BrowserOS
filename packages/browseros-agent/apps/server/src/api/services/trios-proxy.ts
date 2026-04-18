/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { jsonSchemaObjectToZodRawShape } from "zod-from-json-schema";
import { logger } from "../../lib/logger";
import { metrics } from "../../lib/metrics";

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
	url: string;
}

// One-time async setup: connect to trios-server and discover tools
export async function connectTriosProxy(
	deps: ConnectDeps,
): Promise<TriosProxyHandle> {
	// Connect MCP client to trios-server endpoint
	const client = new Client({
		name: "browseros-trios-proxy",
		version: "1.0.0",
	});
	const transport = new StreamableHTTPClientTransport(new URL(deps.url));
	await client.connect(transport);

	const { tools } = await client.listTools();

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
		url: deps.url,
		toolCount: tools.length,
	});

	return {
		tools,
		inputSchemas,
		callTool: (name, args) =>
			client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
		close: () => client.close(),
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
