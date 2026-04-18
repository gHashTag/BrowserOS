/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Integration tests for TRIOS proxy service.
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert";

import { connectTriosProxy } from "../../../src/api/services/trios-proxy";

describe("TRIOS Proxy Integration Tests", () => {
	let triosHandle: any = null;

	beforeAll(async () => {
		// Skip tests if trios-server is not running
		try {
			triosHandle = await connectTriosProxy({
				url: process.env.TRIOS_MCP_URL || "http://localhost:9005/mcp",
			});
			console.log(
				"TRIOS proxy connected, found",
				triosHandle.tools.length,
				"tools",
			);
		} catch (error: any) {
			console.log(
				"Skipping TRIOS tests - trios-server not available:",
				error.message,
			);
			// Tests will be skipped if connection fails
		}
	});

	afterAll(async () => {
		if (triosHandle?.close) {
			console.log("Closing TRIOS proxy...");
			await triosHandle.close();
		}
	});

	it("should connect to trios-server and discover tools", async () => {
		if (!triosHandle) {
			console.log("Skipping - TRIOS server not available");
			return;
		}

		assert.ok(triosHandle.tools.length >= 7, "Should have at least 7 tools");

		const toolNames = triosHandle.tools.map((t: any) => t.name);
		assert.ok(
			toolNames.includes("git_status"),
			"Should include git_status tool",
		);
		assert.ok(
			toolNames.includes("git_commit"),
			"Should include git_commit tool",
		);
		assert.ok(
			toolNames.includes("gb_list_branches"),
			"Should include gb_list_branches tool",
		);
	});

	it("should call git_status tool successfully", async () => {
		if (!triosHandle) {
			console.log("Skipping - TRIOS server not available");
			return;
		}

		const result = await triosHandle.callTool("git_status", {
			repo_path: "/Users/playra/trios",
		});

		assert.ok(result, "Should return a result");
		assert.ok(!result.isError, "Should not return an error");
		assert.ok(result.content, "Should have content");
	});

	it("should have input schemas for all tools", async () => {
		if (!triosHandle) {
			console.log("Skipping - TRIOS server not available");
			return;
		}

		assert.ok(triosHandle.inputSchemas.size > 0, "Should have input schemas");

		for (const tool of triosHandle.tools) {
			const schema = triosHandle.inputSchemas.get((tool as any).name);
			assert.ok(schema, `Tool ${(tool as any).name} should have input schema`);
		}
	});
});
