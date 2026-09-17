/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function renderLimaTemplate(
  template: string,
  cfg: {
    vmStateDir: string
  },
): string {
  const mounts = [
    'mounts:',
    `- location: "${cfg.vmStateDir}"`,
    '  mountPoint: "/mnt/browseros/vm"',
    '  writable: true',
  ].join('\n')

  if (!template.includes('mounts: []')) {
    throw new Error('BrowserOS VM Lima template is missing mounts: [] marker')
  }

  return template.replace('mounts: []', mounts)
}
