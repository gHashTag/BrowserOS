/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Replaced at build time via `define` in scripts/build/server.ts
declare const __trios_VERSION__: string;

export const VERSION: string =
	typeof __trios_VERSION__ !== "undefined" ? __trios_VERSION__ : "0.0.0-dev";
