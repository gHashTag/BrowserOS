/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Browser } from "../../../browser/browser";
import type { ToolRegistry } from "../../../tools/tool-registry";
import {
	type KlavisProxyHandle,
	registerKlavisTools,
} from "../klavis/strata-proxy";
import { registerTriosTools, type TriosProxyHandle } from "../trios-proxy";
import { MCP_INSTRUCTIONS } from "./mcp-prompt";
import { registerTools } from "./register-mcp";

export interface McpServiceDeps {
	version: string;
	registry: ToolRegistry;
	browser: Browser;
	executionDir: string;
	resourcesDir: string;
	klavisProxy?: KlavisProxyHandle | null;
	triosProxy?: TriosProxyHandle | null;
}

export function createMcpServer(deps: McpServiceDeps): McpServer {
	const server = new McpServer(
		{
			name: "trios_mcp",
			title: "TRIOS MCP server",
			version: deps.version,
		},
		{ capabilities: { logging: {} }, instructions: MCP_INSTRUCTIONS },
	);

	server.server.setRequestHandler(SetLevelRequestSchema, () => {
		return {};
	});

	// Register browser tools
	registerTools(server, deps.registry, {
		browser: deps.browser,
		directories: {
			workingDir: deps.executionDir,
			resourcesDir: deps.resourcesDir,
		},
	});

	// Register Klavis proxy tools (if connected)
	if (deps.klavisProxy) {
		registerKlavisTools(server, deps.klavisProxy);
	}

	// Register TRIOS proxy tools (if connected)
	if (deps.triosProxy) {
		registerTriosTools(server, deps.triosProxy);
	}

	return server;
}
