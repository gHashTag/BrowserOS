/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface OpenClawStreamEvent {
  type:
    | 'text-delta'
    | 'thinking'
    | 'tool-start'
    | 'tool-end'
    | 'tool-output'
    | 'lifecycle'
    | 'done'
    | 'error'
  data: Record<string, unknown>
}
