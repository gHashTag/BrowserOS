/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { join } from "node:path";

export const AGENTS_DIR = join(process.env.HOME || "", ".trios", "agents");
export const AGENT_CONFIG_FILE = "agent.yaml";
export const AGENT_ENV_FILE = "env.yaml";
export const SHARED_DIR = join(AGENTS_DIR, "shared");
export const MAX_LOG_ENTRIES = 1000;
export const MAX_TASK_QUEUE_SIZE = 100;
export const DEFAULT_AGENT_TIMEOUT = 3600000;
export const DEFAULT_MAX_TURNS = 50;
