/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Consolidated HTTP Server
 *
 * This server combines:
 * - Agent HTTP routes (chat, klavis, provider)
 * - MCP HTTP routes (using @hono/mcp transport)
 */

import { OPENCLAW_GATEWAY_CONTAINER_NAME } from "@trios/shared/constants/openclaw";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpAgentError } from "../agent/errors";
import { INLINED_ENV } from "../env";
import { KlavisClient } from "../lib/clients/klavis/klavis-client";
import { initializeOAuth } from "../lib/clients/oauth";
import { getDb } from "../lib/db";
import { logger } from "../lib/logger";
import { Sentry } from "../lib/sentry";
import { GitOrchestrator } from "../services/git/git-orchestrator";
import { createA2ARoutes } from "./routes/a2a";
import { createAgentBridgeRoutes } from "./routes/agent-bridge";
import { createChatRoutes } from "./routes/chat";
import { createCreditsRoutes } from "./routes/credits";
import { createGitRoutes } from "./routes/git";
import { createHealthRoute } from "./routes/health";
import { createKlavisRoutes } from "./routes/klavis";
import { createMcpRoutes } from "./routes/mcp";
import { createMemoryRoutes } from "./routes/memory";
import { createOAuthRoutes } from "./routes/oauth";
import { createOpenClawRoutes } from "./routes/openclaw";
import { createProviderRoutes } from "./routes/provider";
import { createRefinePromptRoutes } from "./routes/refine-prompt";
import { createSdkRoutes } from "./routes/sdk";
import { createShutdownRoute } from "./routes/shutdown";
import { createSkillsRoutes } from "./routes/skills";
import { createSoulRoutes } from "./routes/soul";
import { createStatusRoute } from "./routes/status";
import { createTerminalRoutes } from "./routes/terminal";
import {
	connectKlavisProxy,
	type KlavisProxyHandle,
} from "./services/klavis/strata-proxy";
import { getPodmanRuntime } from "./services/openclaw/podman-runtime";
import {
	connectTriosProxy,
	type TriosProxyHandle,
} from "./services/trios-proxy";
import type { Env, HttpServerConfig } from "./types";
import { defaultCorsConfig } from "./utils/cors";
import { requireTrustedAppOrigin } from "./utils/request-auth";
import { websocket } from "./websocket";

async function assertPortAvailable(port: number): Promise<void> {
	const net = await import("node:net");
	return new Promise((resolve, reject) => {
		const probe = net.createServer();

		probe.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				reject(
					Object.assign(new Error(`Port ${port} is already in use`), {
						code: "EADDRINUSE",
					}),
				);
			} else {
				reject(err);
			}
		});

		probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
			probe.close(() => resolve());
		});
	});
}

/**
 * Try to start server on a port with retry logic.
 * If port is busy, wait 2s and retry once before failing.
 * Prevents race conditions between port check and server startup.
 */
async function tryListen(
	port: number,
	maxRetries: number = 3,
	app: Hono<Env>,
	host?: string,
	config?: HttpServerConfig,
): Promise<{ server: ReturnType<typeof Bun.serve>; didRetry: boolean }> {
	const net = await import("node:net");

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			logger.info(
				`Starting server on port ${port} (attempt ${attempt}/${maxRetries})`,
			);

			// Quick check if port is still free right before binding
			const portCheck = new Promise<void>((checkResolve, checkReject) => {
				const probe = net.createServer();
				probe.once("error", (err) => {
					if ((err as any).code === "EADDRINUSE") {
						checkReject(err);
					} else {
						checkResolve();
					}
				});
				probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
					probe.close(() => checkResolve());
				});
			});

			await portCheck;

			// Port is free, try to start server
			const server = Bun.serve({
				fetch: (req: Request, srv: any) => app.fetch(req, { server: srv }),
				port,
				hostname: host ?? "0.0.0.0",
				idleTimeout: 0,
				websocket,
			});

			logger.info("Consolidated HTTP Server started", { port, host });

			if (config?.aiSdkDevtoolsEnabled) {
				logger.info(
					"AI SDK DevTools enabled — run `npx @ai-sdk/devtools` to open the viewer",
				);
			}

			return { server, didRetry: attempt > 1 };
		} catch (err: any) {
			const errObj = err as Error;

			if (attempt < maxRetries && errObj.message.includes("already in use")) {
				logger.warn(
					`Port ${port} busy, retrying in 2s... (attempt ${attempt + 1}/${maxRetries})`,
				);
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}

			// Final failure after all retries exhausted
			logger.error(
				`Failed to start server after ${maxRetries} attempts: ${errObj.message}`,
			);
			throw errObj;
		}
	}

	throw new Error("Should not reach here - loop completed without return");
}

export async function createHttpServer(config: HttpServerConfig) {
	const {
		port,
		host = "0.0.0.0",
		triosId,
		executionDir,
		resourcesDir,
		version,
		browser,
		registry,
	} = config;

	const { onShutdown } = config;

	// Initialize OAuth token manager (callback server binds lazily on first PKCE login)
	const tokenManager = triosId ? initializeOAuth(getDb(), triosId) : null;

	// Connect Klavis proxy (non-blocking: browser tools still work if this fails)
	let klavisProxy: KlavisProxyHandle | null = null;
	if (triosId) {
		try {
			klavisProxy = await connectKlavisProxy({
				klavisClient: new KlavisClient(),
				triosId,
			});
		} catch (error) {
			logger.warn(
				"Failed to connect Klavis proxy, MCP will serve browser tools only",
				{
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	// Connect TRIOS proxy (non-blocking: browser tools still work if this fails)
	let triosProxy: TriosProxyHandle | null = null;
	const triosMcpUrl = process.env.TRIOS_MCP_URL || "http://localhost:9005/mcp";
	try {
		triosProxy = await connectTriosProxy({
			url: triosMcpUrl,
		});
	} catch (error) {
		logger.warn(
			"Failed to connect TRIOS proxy, MCP will serve browser tools only",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	const clawRoutes = new Hono<Env>()
		.use("/*", requireTrustedAppOrigin())
		.route("/", createOpenClawRoutes());

	const terminalRoutes = new Hono<Env>()
		.use("/*", requireTrustedAppOrigin())
		.route(
			"/",
			createTerminalRoutes({
				containerName: OPENCLAW_GATEWAY_CONTAINER_NAME,
				podmanPath: getPodmanRuntime().getPodmanPath(),
			}),
		);

	const app = new Hono<Env>()
		.use("/*", cors(defaultCorsConfig))
		.route("/health", createHealthRoute({ browser, triosProxy }))
		.route("/a2a", createA2ARoutes({ a2aKey: process.env.trios_A2A_KEY }))
		.route(
			"/agent",
			createAgentBridgeRoutes({
				browser,
				registry,
				triosId: triosId ?? "",
			}),
		)
		.route(
			"/shutdown",
			createShutdownRoute({
				onShutdown: () => {
					tokenManager?.stopCallbackServer();
					klavisProxy?.close().catch((err) =>
						logger.warn("Failed to close Klavis proxy transport", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
					triosProxy?.close().catch((err) =>
						logger.warn("Failed to close TRIOS proxy transport", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
					onShutdown?.();
				},
			}),
		)
		.route("/status", createStatusRoute({ browser }))
		.route("/soul", createSoulRoutes())
		.route("/memory", createMemoryRoutes())
		.route("/skills", createSkillsRoutes())
		.route("/test-provider", createProviderRoutes({ triosId }))
		.route("/refine-prompt", createRefinePromptRoutes({ triosId }))
		.route(
			"/oauth",
			tokenManager
				? createOAuthRoutes({ tokenManager })
				: new Hono().all("/*", (c) =>
						c.json({ error: "OAuth not available" }, 503),
					),
		)
		.route("/klavis", createKlavisRoutes({ triosId: triosId || "" }))
		.route(
			"/credits",
			createCreditsRoutes({
				triosId,
				gatewayBaseUrl: INLINED_ENV.trios_CONFIG_URL
					? new URL(INLINED_ENV.trios_CONFIG_URL).origin
					: undefined,
			}),
		)
		.route(
			"/mcp",
			createMcpRoutes({
				version,
				registry,
				browser,
				executionDir,
				resourcesDir,
				klavisProxy,
				triosProxy,
			}),
		)
		.route(
			"/chat",
			createChatRoutes({
				browser,
				registry,
				triosId,
				aiSdkDevtoolsEnabled: config.aiSdkDevtoolsEnabled,
				port,
			}),
		)
		.route(
			"/sdk",
			createSdkRoutes({
				port,
				browser,
				triosId,
			}),
		)
		.route("/claw", clawRoutes);

	// Initialize Git Orchestrator and routes
	const gitOrchestrator = await GitOrchestrator.create({
		workingDir: executionDir,
	});

	app.route("/api/git", createGitRoutes({ orchestrator: gitOrchestrator }));

	// Error handler
	app.onError((err, c) => {
		const error = err as Error;

		if (error instanceof HttpAgentError) {
			logger.warn("HTTP Agent Error", {
				name: error.name,
				message: error.message,
				code: error.code,
				statusCode: error.statusCode,
			});
			return c.json(error.toJSON(), error.statusCode as ContentfulStatusCode);
		}

		Sentry.withScope((scope) => {
			scope.setTag("route", c.req.path);
			scope.setTag("method", c.req.method);
			Sentry.captureException(error);
		});

		logger.error("Unhandled Error", {
			message: error.message,
			stack: error.stack,
		});

		return c.json(
			{
				error: {
					name: "InternalServerError",
					message: error.message || "An unexpected error occurred",
					code: "INTERNAL_SERVER_ERROR",
					statusCode: 500,
				},
			},
			500,
		);
	});

	app.route("/terminal", terminalRoutes);

	const { server, didRetry } = await tryListen(port, 3, app, host, config);

	if (didRetry) {
		logger.info("Server started after port conflict was resolved");
	}

	return {
		app,
		server,
		config,
	};
}
