/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Custom fetch for Moonshot API requests.
 * Filters out unsupported fields that cause 400 errors.
 */

export function createMoonshotFetch(): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		let body = init?.body;

		if (body && typeof body === "string") {
			try {
				const json = JSON.parse(body);

				delete json.parallel_tool_calls;

				if (
					json.response_format?.type === "json_schema" &&
					!json.response_format?.json_schema?.name
				) {
					delete json.response_format;
				}

				if (json.response_format?.strict !== undefined) {
					delete json.response_format.strict;
				}

				if (json.max_tokens === 0) {
					delete json.max_tokens;
				} else if (
					typeof json.max_tokens === "number" &&
					json.max_tokens > 98304
				) {
					json.max_tokens = 32768;
				}

				if (typeof json.frequency_penalty === "number") {
					json.frequency_penalty = 0;
				}
				if (typeof json.presence_penalty === "number") {
					json.presence_penalty = 0;
				}

				body = JSON.stringify(json);
			} catch {
				// Not JSON, send as-is
			}
		}

		return fetch(input, { ...init, body });
	};
}
