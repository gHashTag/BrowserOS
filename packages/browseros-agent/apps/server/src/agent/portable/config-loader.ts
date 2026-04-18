/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_CONFIG_FILE,
	AGENT_ENV_FILE,
	AGENTS_DIR,
	SHARED_DIR,
} from "@trios/shared/constants/portable-agent";
import { logger } from "../../lib/logger";

// Simple YAML parser for basic config files
function parseYaml(content: string): unknown {
	const lines = content.split("\n");
	const result: Record<string, unknown> = {};
	const stack: Array<{ obj: Record<string, unknown>; level: number }> = [
		{ obj: result, level: -1 },
	];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const indent = line.search(/\S/);
		const [key, ...valueParts] = trimmed.split(":");
		const value = valueParts.join(":").trim();

		// Pop stack to correct level
		while (stack.length > 1 && stack[stack.length - 1].level >= indent) {
			stack.pop();
		}

		const current = stack[stack.length - 1].obj;

		if (value === "") {
			// Object or array
			current[key] = {};
			stack.push({
				obj: current[key] as Record<string, unknown>,
				level: indent,
			});
		} else if (value.startsWith("|")) {
			// Multiline string - not supported in simple parser
			current[key] = "";
		} else if (value.startsWith(">")) {
			// Folded string - not supported in simple parser
			current[key] = "";
		} else if (value === "true" || value === "false") {
			current[key] = value === "true";
		} else if (value === "null" || value === "~") {
			current[key] = null;
		} else if (/^-?\d+$/.test(value)) {
			current[key] = Number.parseInt(value, 10);
		} else if (/^-?\d+\.\d+$/.test(value)) {
			current[key] = Number.parseFloat(value);
		} else if (/^["'].*["']$/.test(value)) {
			current[key] = value.slice(1, -1);
		} else if (value.startsWith("[") && value.endsWith("]")) {
			// Simple array
			const items = value
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim());
			current[key] = items;
		} else {
			current[key] = value;
		}
	}

	return result;
}

function loadConfigLike(content: string): unknown {
	const trimmed = content.trim();
	if (!trimmed) return {};

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(trimmed) as unknown;
	}

	return parseYaml(trimmed);
}

function loadEnvLike(content: string): Record<string, string> {
	const trimmed = content.trim();
	if (!trimmed) return {};

	const hasEqualsLine = trimmed
		.split("\n")
		.some(
			(line) =>
				line.trim() && !line.trim().startsWith("#") && line.includes("="),
		);

	if (hasEqualsLine) {
		const envLines = trimmed.split("\n");
		const envVars: Record<string, string> = {};

		for (const line of envLines) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const [key, ...valueParts] = t.split("=");
			if (!key || valueParts.length === 0) continue;
			envVars[key.trim()] = valueParts.join("=").trim();
		}

		return envVars;
	}

	const parsed = loadConfigLike(trimmed);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return {};

	const envVars: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof v === "string") envVars[k] = v;
	}
	return envVars;
}

import {
	type PortableAgentConfig,
	PortableAgentConfigSchema,
} from "./config-schema";
import { ErrorCode } from "./errors";

const CONFIG_CACHE = new Map<string, PortableAgentConfig>();
const ENV_CACHE = new Map<string, Record<string, string>>();

export class ConfigLoadError extends Error {
	constructor(
		message: string,
		public code: ErrorCode,
		public agentName?: string,
	) {
		super(message);
		this.name = "ConfigLoadError";
	}
}

function getEnv(key: string): string | undefined {
	return process.env[key];
}

function resolveEnvPlaceholder(value: string): string {
	const match = value.match(/^\${([^:}]+)(?::([^}]*))?\}$/);
	if (!match) return value;

	const envVar = match[1];
	const defaultValue = match[2];

	const envValue = getEnv(envVar);
	if (envValue !== undefined) return envValue;
	if (defaultValue !== undefined) return defaultValue;

	throw new ConfigLoadError(
		`Environment variable '${envVar}' is not set and no default provided`,
		ErrorCode.ENV_VAR_NOT_FOUND,
	);
}

function expandEnvPlaceholders(obj: unknown): unknown {
	if (typeof obj !== "object" || obj === null) return obj;
	if (Array.isArray(obj)) return obj.map((item) => expandEnvPlaceholders(item));

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string") {
			result[key] = resolveEnvPlaceholder(value);
		} else if (typeof value === "object" && value !== null) {
			result[key] = expandEnvPlaceholders(value);
		} else if (Array.isArray(value)) {
			result[key] = value.map((item) => expandEnvPlaceholders(item));
		} else {
			result[key] = value;
		}
	}
	return result;
}

function resolveTemplate(
	template: string | undefined,
	config: PortableAgentConfig,
): PortableAgentConfig {
	if (!template) return config;

	const templatePath = join(SHARED_DIR, template);
	if (!existsSync(templatePath)) {
		logger.warn(`Template file not found: ${templatePath}`);
		return config;
	}

	try {
		const templateContent = readFileSync(templatePath, "utf-8");
		const templateConfig = loadConfigLike(
			templateContent,
		) as PortableAgentConfig;

		const merged: PortableAgentConfig = {
			apiVersion: templateConfig.apiVersion || config.apiVersion,
			kind: templateConfig.kind || config.kind,
			metadata: { ...templateConfig.metadata, ...config.metadata },
			spec: {
				llm: { ...templateConfig.spec.llm, ...config.spec.llm },
				systemPrompt:
					templateConfig.spec?.systemPrompt || config.spec?.systemPrompt,
				tools: { ...templateConfig.spec?.tools, ...config.spec?.tools },
				workspace: {
					...templateConfig.spec?.workspace,
					...config.spec?.workspace,
				},
				limits: { ...templateConfig.spec?.limits, ...config.spec?.limits },
				env: [...(templateConfig.spec?.env || []), ...(config.spec?.env || [])],
				template: undefined,
			},
		};

		return merged;
	} catch (error) {
		logger.warn(`Failed to parse template: ${templatePath}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return config;
	}
}

function injectEnvironment(config: PortableAgentConfig): PortableAgentConfig {
	const result = expandEnvPlaceholders(config);
	return result as PortableAgentConfig;
}

export class ConfigLoader {
	static loadAgentConfig(agentName: string): PortableAgentConfig {
		const agentDir = join(AGENTS_DIR, agentName);
		const configPath = join(agentDir, AGENT_CONFIG_FILE);

		if (!existsSync(configPath)) {
			throw new ConfigLoadError(
				`Agent config not found at ${configPath}`,
				ErrorCode.CONFIG_NOT_FOUND,
				agentName,
			);
		}

		try {
			const content = readFileSync(configPath, "utf-8");
			const rawConfig = loadConfigLike(content);

			const schemaResult = PortableAgentConfigSchema.safeParse(rawConfig);
			if (!schemaResult.success) {
				throw new ConfigLoadError(
					`Invalid agent configuration: ${schemaResult.error.message}`,
					ErrorCode.CONFIG_INVALID,
					agentName,
				);
			}

			let config = schemaResult.data;

			config = resolveTemplate(config.spec.template, config);
			config = injectEnvironment(config);

			return config;
		} catch (error) {
			if (error instanceof ConfigLoadError) throw error;

			throw new ConfigLoadError(
				`Failed to load agent configuration: ${error instanceof Error ? error.message : String(error)}`,
				ErrorCode.CONFIG_PARSE_ERROR,
				agentName,
			);
		}
	}

	static loadAllConfigs(): Map<string, PortableAgentConfig> {
		const configs = new Map<string, PortableAgentConfig>();

		if (!existsSync(AGENTS_DIR)) return configs;

		const entries = statSync(AGENTS_DIR).isDirectory()
			? readdirSync(AGENTS_DIR, { withFileTypes: true })
			: [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				try {
					const agentName = entry.name;
					const config = ConfigLoader.loadAgentConfig(agentName);
					configs.set(agentName, config);
				} catch (error) {
					logger.warn(`Failed to load config for ${entry.name}`, {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		return configs;
	}

	static getAgentNames(): string[] {
		if (!existsSync(AGENTS_DIR)) return [];

		const entries = statSync(AGENTS_DIR).isDirectory()
			? readdirSync(AGENTS_DIR, { withFileTypes: true })
			: [];

		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	}

	static loadAgentEnv(agentName: string): Record<string, string> {
		const cacheKey = `env:${agentName}`;
		if (ENV_CACHE.has(cacheKey)) {
			const cached = ENV_CACHE.get(cacheKey);
			return cached ?? {};
		}

		const agentDir = join(AGENTS_DIR, agentName);
		const envPath = join(agentDir, AGENT_ENV_FILE);

		if (!existsSync(envPath)) {
			return {};
		}

		try {
			const envFile = readFileSync(envPath, "utf-8");
			const envVars = loadEnvLike(envFile);

			ENV_CACHE.set(cacheKey, envVars);
			return envVars;
		} catch (error) {
			logger.warn(`Failed to load env file for ${agentName}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			return {};
		}
	}

	static clearCache(): void {
		CONFIG_CACHE.clear();
		ENV_CACHE.clear();
	}

	static validateName(name: string): void {
		const validPattern = /^[a-z][a-z0-9-]*$/;
		if (!validPattern.test(name)) {
			throw new ConfigLoadError(
				`Invalid agent name '${name}'. Names must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.`,
				ErrorCode.CONFIG_INVALID,
				name,
			);
		}
	}
}
