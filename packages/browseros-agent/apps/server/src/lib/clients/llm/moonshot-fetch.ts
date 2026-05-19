/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Custom fetch wrapper for Moonshot API requests.
 * Filters out unsupported fields that cause 400 errors.
 */

export function createMoonshotFetch() {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		let body = init?.body;

		if (body && typeof body === "string") {
			try {
				const json = JSON.parse(body);

				// Remove unsupported fields
				delete json.parallel_tool_calls;

				// Remove response_format if it's json_schema without name
				if (
					json.response_format?.type === "json_schema" &&
					!json.response_format?.json_schema?.name
				) {
					delete json.response_format;
				}

				// Remove strict flag from response_format (unsupported by Moonshot)
				if (json.response_format?.strict !== undefined) {
					delete json.response_format.strict;
				}

				// Remove max_tokens if 0 or clamp to 32768 if exceeds Moonshot limit
				if (json.max_tokens === 0) {
					delete json.max_tokens;
				} else if (
					typeof json.max_tokens === "number" &&
					json.max_tokens > 98304
				) {
					json.max_tokens = 32768;
				}

				// Moonshot only supports 0 for these penalties
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
