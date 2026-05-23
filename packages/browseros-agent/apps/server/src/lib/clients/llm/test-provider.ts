/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TIMEOUTS } from "@trios/shared/constants/timeouts";
import type { LLMConfig } from "@trios/shared/schemas/llm";
import { generateText } from "ai";
import { logger } from "../../logger";
import { resolveLLMConfig } from "./config";
import { createLLMProvider } from "./provider";

export interface ProviderTestConfig extends LLMConfig {
	model: string;
	upstreamProvider?: string;
}

export interface ProviderTestResult {
	success: boolean;
	message: string;
	responseTime?: number;
}

const TEST_PROMPT = "Respond with exactly: 'ok'";

export async function testProviderConnection(
	config: ProviderTestConfig,
	triosId?: string,
): Promise<ProviderTestResult> {
	const startTime = performance.now();

	try {
		logger.debug("testProviderConnection start", {
			provider: config.provider,
			model: config.model,
			baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
			hasApiKey: !!config.apiKey,
			triosId: triosId ?? undefined,
		});
		const resolvedConfig = await resolveLLMConfig(config, triosId);
		const model = createLLMProvider(resolvedConfig);

		// Use generateText for testing to get clear API errors (streamText wraps
		// APICallError in NoOutputGeneratedError and loses responseBody details).
		const result = await generateText({
			model,
			messages: [{ role: "user", content: TEST_PROMPT }],
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(TIMEOUTS.TEST_PROVIDER),
		});
		const text = result.text;
		const responseTime = Math.round(performance.now() - startTime);

		if (text) {
			const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
			return {
				success: true,
				message: `Connection successful. Response: "${preview}"`,
				responseTime,
			};
		}

		return {
			success: true,
			message: "Connection successful. Provider responded.",
			responseTime,
		};
	} catch (error) {
		const responseTime = Math.round(performance.now() - startTime);
		const errorMessage = extractProviderErrorMessage(error, config.provider);
		logger.error("testProviderConnection failed", {
			provider: config.provider,
			model: config.model,
			errorMessage,
			errorStack: error instanceof Error ? error.stack : undefined,
			responseTimeMs: responseTime,
		});

		return {
			success: false,
			message: `[${config.provider}] ${errorMessage}`,
			responseTime,
		};
	}
}

function extractProviderErrorMessage(
	error: unknown,
	_provider: string,
): string {
	// Check for API call error with response body (generateText preserves
	// APICallError directly, so responseBody is available on the error object)
	if (
		error != null &&
		typeof error === "object" &&
		"responseBody" in error &&
		typeof (error as { responseBody?: string }).responseBody === "string"
	) {
		try {
			const parsed = JSON.parse(
				(error as { responseBody: string }).responseBody,
			);
			const msg =
				parsed?.error?.message ||
				parsed?.message ||
				parsed?.error?.code ||
				(error instanceof Error ? error.message : String(error));
			return msg;
		} catch {
			// Not valid JSON, fall through
		}
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
