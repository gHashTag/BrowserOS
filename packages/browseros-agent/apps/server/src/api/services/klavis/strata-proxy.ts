/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TIMEOUTS } from "@trios/shared/constants/timeouts";
import { z } from "zod";
import { jsonSchemaObjectToZodRawShape } from "zod-from-json-schema";
import { KlavisClient } from "../../../lib/clients/klavis/klavis-client";
import { OAUTH_MCP_SERVERS } from "../../../lib/clients/klavis/oauth-mcp-servers";
import { logger } from "../../../lib/logger";
import { metrics } from "../../../lib/metrics";
import { klavisStrataCache } from "./strata-cache";

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timerId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_, reject) => {
		timerId = setTimeout(
			() => reject(new Error(`Klavis ${label} timed out`)),
			TIMEOUTS.KLAVIS_FETCH,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

export interface KlavisProxyHandle {
	triosId: string;
	tools: Tool[];
	inputSchemas: Map<string, Record<string, never>>;
	callTool: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<CallToolResult>;
	close: () => Promise<void>;
}

interface ConnectDeps {
	klavisClient: KlavisClient;
	triosId: string;
}

// One-time async setup: connect to Klavis Strata and discover tools
export async function connectKlavisProxy(
	deps: ConnectDeps,
): Promise<KlavisProxyHandle> {
	// Use the full curated OAuth server list so all tools are exposed,
	// even unauthenticated ones (Klavis handles auth prompts on call)
	const allServers = OAUTH_MCP_SERVERS.map((s) => s.name);

	const strata = await klavisStrataCache.getOrFetch(
		deps.klavisClient,
		deps.triosId,
		allServers,
	);

	// Connect MCP client to Strata endpoint
	const client = new Client({
		name: "trios-klavis-proxy",
		version: "1.0.0",
	});
	const transport = new StreamableHTTPClientTransport(
		new URL(strata.strataServerUrl),
	);
	await withTimeout(client.connect(transport), "connect");

	const { tools } = await withTimeout(client.listTools(), "listTools");

	// Pre-compute Zod schemas once so registerKlavisTools avoids per-request conversion.
	// Double cast works around TS2589 in registerTool's recursive generics.
	const inputSchemas = new Map(
		tools.map((t) => [
			t.name,
			jsonSchemaObjectToZodRawShape(
				t.inputSchema as never,
			) as unknown as Record<string, never>,
		]),
	);

	logger.info("Klavis proxy connected", {
		toolCount: tools.length,
		serverCount: allServers.length,
	});

	return {
		triosId: deps.triosId,
		tools,
		inputSchemas,
		callTool: (name, args) =>
			client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
		close: () => client.close(),
	};
}

const serverNames = OAUTH_MCP_SERVERS.map((s) => s.name) as [
	string,
	...string[],
];

const serverDescriptions = OAUTH_MCP_SERVERS.map(
	(s) => `${s.name} (${s.description})`,
).join(", ");

// Double cast works around TS2589 in registerTool's recursive generics.
const connectorInputSchema = {
	server_name: z
		.enum(serverNames)
		.describe(
			`The name of the service to check. Available: ${serverDescriptions}`,
		),
} as unknown as Record<string, never>;

export function registerKlavisTools(
	mcpServer: McpServer,
	handle: KlavisProxyHandle,
): void {
	// Register the connector discovery tool
	mcpServer.registerTool(
		"connector_mcp_servers",
		{
			description:
				"Check if an external service is connected and ready for use with Strata MCP tools (discover_server_categories_or_actions, execute_action, etc.). Call this BEFORE using any Strata integration tool. If connected, proceed with Strata tools. If not connected, returns an authUrl — prompt the user to open it and authenticate.",
			inputSchema: connectorInputSchema,
		},
		async (args: Record<string, unknown>) => {
			const startTime = performance.now();
			const server_name = args.server_name as string;

			try {
				const klavisClient = new KlavisClient();
				const integrations = await klavisClient.getUserIntegrations(
					handle.triosId,
				);

				const integration = integrations.find((i) => i.name === server_name);
				const isConnected = integration?.isAuthenticated === true;

				if (isConnected) {
					metrics.log("tool_executed", {
						tool_name: "connector_mcp_servers",
						source: "mcp",
						duration_ms: Math.round(performance.now() - startTime),
						success: true,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									connected: true,
									server_name,
								}),
							},
						],
					};
				}

				// Not connected — get auth URL
				const strata = await klavisClient.createStrata(handle.triosId, [
					server_name,
				]);
				const authUrl =
					strata.oauthUrls?.[server_name] ??
					strata.apiKeyUrls?.[server_name] ??
					null;

				metrics.log("tool_executed", {
					tool_name: "connector_mcp_servers",
					source: "mcp",
					duration_ms: Math.round(performance.now() - startTime),
					success: true,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								connected: false,
								server_name,
								authUrl,
								message: authUrl
									? `${server_name} is not connected. Ask the user to open this URL to authenticate: ${authUrl}`
									: `${server_name} is not connected. Could not retrieve auth URL.`,
							}),
						},
					],
				};
			} catch (error) {
				const errorText =
					error instanceof Error ? error.message : String(error);

				metrics.log("tool_executed", {
					tool_name: "connector_mcp_servers",
					source: "mcp",
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

	// Register Strata proxy tools
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
						source: "mcp",
						duration_ms: Math.round(performance.now() - startTime),
						success: !result.isError,
					});

					return result;
				} catch (error) {
					const errorText =
						error instanceof Error ? error.message : String(error);

					metrics.log("tool_executed", {
						tool_name: tool.name,
						source: "mcp",
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

	logger.debug("Registered Klavis tools on MCP server", {
		count: handle.tools.length + 1,
	});
}
