/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * TRIOS Server Application
 *
 * Manages server lifecycle: initialization, startup, and shutdown.
 */

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODES } from "@trios/shared/constants/exit-codes";
import { createHttpServer } from "./api/server";
import { getOpenClawService } from "./api/services/openclaw/openclaw-service";
import { CdpBackend } from "./browser/backends/cdp";
import { Browser } from "./browser/browser";
import { NullBrowser } from "./browser/null-browser";
import type { ServerConfig } from "./config";
import { INLINED_ENV } from "./env";
import {
	cleanOldSessions,
	ensureBrowserosDir,
	removeServerConfigSync,
	writeServerConfig,
} from "./lib/trios-dir";
import { initializeDb } from "./lib/db";
import { identity } from "./lib/identity";
import { logger } from "./lib/logger";
import { metrics } from "./lib/metrics";
import { isPortInUseError } from "./lib/port-binding";
import { Sentry } from "./lib/sentry";
import { seedSoulTemplate } from "./lib/soul";
import { migrateBuiltinSkills } from "./skills/migrate";
import {
	startSkillSync,
	stopSkillSync,
	syncBuiltinSkills,
} from "./skills/remote-sync";
import { registry } from "./tools/registry";
import { VERSION } from "./version";

/**
 * Check if a port is available before attempting to bind.
 * Returns true if port is free, false if already in use.
 */
async function checkPortAvailable(port: number): Promise<boolean> {
	const net = await import("node:net");
	return new Promise<boolean>((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
			probe.close(() => resolve(true));
		});
	});
}

/**
 * Ensure a port is free by actively killing stale processes.
 * Uses lsof to find PIDs occupying the port and sends SIGKILL.
 * Retries up to `maxAttempts` times with a short delay between attempts.
 * Returns true if the port is free (either was free or successfully freed).
 */
async function ensurePortFree(port: number, maxAttempts = 3): Promise<boolean> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const available = await checkPortAvailable(port);
		if (available) {
			if (attempt > 1) {
				logger.info(`Port ${port} freed after ${attempt - 1} kill attempt(s)`);
			}
			return true;
		}

		logger.warn(
			`Port ${port} is occupied (attempt ${attempt}/${maxAttempts}), killing stale process...`,
		);

		// Use lsof to find PIDs on the port and kill them
		const result = Bun.spawnSync([
			"sh",
			"-c",
			`lsof -ti:${port} 2>/dev/null | xargs kill -9 2>/dev/null`,
		]);

		if (result.stderr && result.stderr.length > 0) {
			logger.debug(`lsof/kill stderr: ${result.stderr.toString().trim()}`);
		}

		// Wait for the OS to release the socket
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	// Final check
	const finalCheck = await checkPortAvailable(port);
	if (!finalCheck) {
		logger.error(
			`Port ${port} still occupied after ${maxAttempts} kill attempts`,
			{
				port,
				kill_command: `lsof -ti:${port} | xargs kill -9`,
			},
		);
	}
	return finalCheck;
}

export class Application {
	private config: ServerConfig;
	private db: Database | null = null;

	constructor(config: ServerConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		logger.info(`Starting TRIOS Server v${VERSION}`);
		logger.debug("Directory config", {
			executionDir: path.resolve(this.config.executionDir),
			resourcesDir: path.resolve(this.config.resourcesDir),
		});

		await this.initCoreServices();

		const allowNoCdp = process.env.trios_ALLOW_NO_CDP === "1";

		let browser: Browser | NullBrowser;
		if (!this.config.cdpPort) {
			if (!allowNoCdp) {
				logger.error("CDP port is required (--cdp-port)");
				process.exit(EXIT_CODES.GENERAL_ERROR);
			}
			logger.warn("Starting without CDP (trios_ALLOW_NO_CDP=1)");
			browser = new NullBrowser();
		} else {
			const cdp = new CdpBackend({ port: this.config.cdpPort });
			try {
				logger.debug(`Connecting to CDP on port ${this.config.cdpPort}`);
				await cdp.connect();
				logger.info(`Connected to CDP on port ${this.config.cdpPort}`);
				browser = new Browser(cdp);
			} catch (error) {
				if (!allowNoCdp) {
					return this.handleStartupError("CDP", this.config.cdpPort, error);
				}
				logger.warn("CDP unavailable, starting in degraded mode", {
					port: this.config.cdpPort,
					error: error instanceof Error ? error.message : String(error),
				});
				browser = new NullBrowser();
			}
		}

		logger.info(`Loaded ${registry.names().length} unified tools`);

		// Pre-flight: ensure port is free — kill stale processes from previous runs
		const serverPort = this.config.serverPort;
		if (!(await ensurePortFree(serverPort))) {
			console.error(
				`\n[FATAL] Port ${serverPort} is still occupied after kill attempts.`,
			);
			console.error(
				`Kill manually with: lsof -ti:${serverPort} | xargs kill -9`,
			);
			process.exit(EXIT_CODES.PORT_CONFLICT);
		}

		try {
			await createHttpServer({
				port: this.config.serverPort,
				host: "0.0.0.0",
				version: VERSION,
				browser: browser as Browser,
				registry,
				triosId: identity.getTRIOSId(),
				executionDir: this.config.executionDir,
				resourcesDir: this.config.resourcesDir,
				codegenServiceUrl: this.config.codegenServiceUrl,
				aiSdkDevtoolsEnabled: this.config.aiSdkDevtoolsEnabled,

				onShutdown: () => this.stop("shutdown-endpoint"),
			});
		} catch (error) {
			this.handleStartupError("HTTP server", this.config.serverPort, error);
		}

		try {
			await writeServerConfig({
				server_port: this.config.serverPort,
				url: `http://127.0.0.1:${this.config.serverPort}`,
				server_version: VERSION,
				trios_version: this.config.instanceBrowserosVersion,
				chromium_version: this.config.instanceChromiumVersion,
				trios_id: identity.getTRIOSId(),
			});
		} catch (error) {
			logger.warn("Failed to write server config for auto-discovery", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		logger.info(
			`HTTP server listening on http://127.0.0.1:${this.config.serverPort}`,
		);
		logger.info(
			`Health endpoint: http://127.0.0.1:${this.config.serverPort}/health`,
		);

		this.logStartupSummary();
		startSkillSync();

		getOpenClawService(this.config.serverPort)
			.tryAutoStart()
			.catch((err) =>
				logger.warn("OpenClaw auto-start failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);

		metrics.log("http_server.started", { version: VERSION });
	}

	stop(reason?: string): void {
		logger.info("Shutting down server...", { reason });
		stopSkillSync();
		getOpenClawService()
			.shutdown()
			.catch(() => {});
		removeServerConfigSync();

		// Immediate exit without graceful shutdown. Chromium may kill us on update/restart,
		// and we need to free the port instantly so the HTTP port doesn't keep switching.
		// Exit 0 only for managed shutdowns (POST /shutdown from Chromium).
		// Signal kills exit non-zero so Chromium's OnProcessExited restarts us.
		const code =
			reason === "SIGTERM" || reason === "SIGINT"
				? EXIT_CODES.SIGNAL_KILL
				: EXIT_CODES.SUCCESS;
		process.exit(code);
	}

	private async initCoreServices(): Promise<void> {
		this.configureLogDirectory();
		await ensureBrowserosDir();
		await cleanOldSessions();
		await seedSoulTemplate();
		await migrateBuiltinSkills();
		await syncBuiltinSkills();

		const dbPath = path.join(
			this.config.executionDir || this.config.resourcesDir,
			"trios.db",
		);
		this.db = initializeDb(dbPath);

		identity.initialize({
			installId: this.config.instanceInstallId,
			db: this.db,
		});

		const triosId = identity.getTRIOSId();
		logger.info("TRIOS ID initialized", {
			triosId: triosId.slice(0, 12),
			fromConfig: !!this.config.instanceInstallId,
		});

		metrics.initialize({
			client_id: this.config.instanceClientId,
			install_id: this.config.instanceInstallId,
			trios_version: this.config.instanceBrowserosVersion,
			chromium_version: this.config.instanceChromiumVersion,
			server_version: VERSION,
		});

		if (!metrics.isEnabled()) {
			logger.warn("Metrics disabled: missing POSTHOG_API_KEY");
		}

		if (!INLINED_ENV.SENTRY_DSN) {
			logger.debug("Sentry disabled: missing SENTRY_DSN");
		}

		Sentry.setUser({ id: triosId });
		Sentry.setContext("trios", {
			client_id: this.config.instanceClientId,
			install_id: this.config.instanceInstallId,
			trios_version: this.config.instanceBrowserosVersion,
			chromium_version: this.config.instanceChromiumVersion,
			server_version: VERSION,
		});
	}

	private configureLogDirectory(): void {
		const logDir = this.config.executionDir;
		const resolvedDir = path.isAbsolute(logDir)
			? logDir
			: path.resolve(process.cwd(), logDir);

		try {
			fs.mkdirSync(resolvedDir, { recursive: true });
			logger.setLogFile(resolvedDir);
		} catch (error) {
			console.warn(
				`Failed to configure log directory ${resolvedDir}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private handleStartupError(
		serverName: string,
		port: number,
		error: unknown,
	): never {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to start ${serverName}`, { port, error: errorMsg });
		if (error instanceof Error && error.stack) {
			logger.error("Startup error stack", { stack: error.stack });
		}
		console.error(
			`[FATAL] Failed to start ${serverName} on port ${port}: ${errorMsg}`,
		);

		if (isPortInUseError(error)) {
			console.error(
				`[FATAL] Port ${port} is already in use. Chromium should try a different port.`,
			);
			process.exit(EXIT_CODES.PORT_CONFLICT);
		}

		Sentry.captureException(error);
		process.exit(EXIT_CODES.GENERAL_ERROR);
	}

	private logStartupSummary(): void {
		logger.info("");
		logger.info("Services running:");
		logger.info(`  HTTP Server: http://127.0.0.1:${this.config.serverPort}`);
		logger.info("");
	}
}
