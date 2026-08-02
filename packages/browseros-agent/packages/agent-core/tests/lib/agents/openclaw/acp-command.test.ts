/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'bun:test'
import { OPENCLAW_GATEWAY_CONTAINER_PORT } from '@browseros/shared/constants/openclaw'
import {
  type OpenclawGatewayAccessor,
  resolveOpenclawAcpCommand,
} from '../../../../src/lib/agents/openclaw/acp-command'

describe('resolveOpenclawAcpCommand', () => {
  const gateway: OpenclawGatewayAccessor = {
    getContainerName: () => 'browseros-openclaw-openclaw-gateway-1',
    getLimaHomeDir: () => '/Users/dev/.browseros-dev/lima',
    getLimactlPath: () => '/Applications/BrowserOS.app/limactl',
    getVmName: () => 'browseros-vm',
  }

  it('builds the in-gateway ACP bridge command', () => {
    const command = resolveOpenclawAcpCommand(gateway, 'agent:oc-123:main')

    expect(command).toContain('env LIMA_HOME=/Users/dev/.browseros-dev/lima')
    expect(command).toContain(
      '/Applications/BrowserOS.app/limactl shell --workdir / browseros-vm --',
    )
    expect(command).toContain('nerdctl exec -i')
    expect(command).toContain('-e OPENCLAW_HIDE_BANNER=1')
    expect(command).toContain('-e OPENCLAW_SUPPRESS_NOTES=1')
    expect(command).toContain('browseros-openclaw-openclaw-gateway-1')
    expect(command).toContain(
      `openclaw acp --url ws://127.0.0.1:${OPENCLAW_GATEWAY_CONTAINER_PORT}`,
    )
    expect(command).toContain('--session agent:oc-123:main')
  })

  it('maps legacy non-agent session keys onto the main gateway agent', () => {
    const command = resolveOpenclawAcpCommand(
      gateway,
      'openai-user:browseros:abc/def',
    )

    expect(command).toContain(
      '--session agent:main:openai-user-browseros-abc-def',
    )
  })
})
