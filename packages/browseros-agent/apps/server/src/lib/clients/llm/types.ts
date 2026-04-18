/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Internal types for LLM client.
 */

import type { LLMConfig } from "@trios/shared/schemas/llm";

export interface ResolvedLLMConfig extends LLMConfig {
	model: string;
	upstreamProvider?: string;
	triosId?: string;
	accountId?: string;
}
