/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getHermesAgentHomeHostDir,
  getHermesHarnessHostDir,
  writeHermesPerAgentProvider,
} from '../../../../src/lib/agents/hermes/hermes-paths'
import { getHermesProviderMapping } from '../../../../src/lib/agents/hermes/hermes-provider-map'

describe('Hermes adapter helpers', () => {
  it('resolves Hermes state under the BrowserOS VM state root', () => {
    const browserosDir = '/tmp/browseros-test'

    expect(getHermesHarnessHostDir(browserosDir)).toBe(
      '/tmp/browseros-test/vm/hermes/harness',
    )
    expect(
      getHermesAgentHomeHostDir({ browserosDir, agentId: 'agent-1' }),
    ).toBe('/tmp/browseros-test/vm/hermes/harness/agent-1/home')
  })

  it('writes per-agent provider config from the Hermes provider map', async () => {
    const browserosDir = await mkdtemp(join(tmpdir(), 'browseros-hermes-'))
    try {
      const mapping = getHermesProviderMapping('openai')
      expect(mapping).toEqual({
        hermesProvider: 'custom',
        envVarName: 'OPENAI_API_KEY',
        requiresBaseUrl: false,
        defaultBaseUrl: 'https://api.openai.com/v1',
      })

      await writeHermesPerAgentProvider({
        browserosDir,
        agentId: 'agent-1',
        providerId: mapping?.hermesProvider as string,
        envVarName: mapping?.envVarName as string,
        apiKey: 'sk-test',
        modelId: 'gpt-5.5',
        baseUrl: mapping?.defaultBaseUrl,
      })

      const home = getHermesAgentHomeHostDir({
        browserosDir,
        agentId: 'agent-1',
      })
      await expect(readFile(join(home, 'config.yaml'), 'utf8')).resolves.toBe(
        [
          'model:',
          '  default: "gpt-5.5"',
          '  provider: "custom"',
          '  base_url: "https://api.openai.com/v1"',
          '',
        ].join('\n'),
      )
      await expect(readFile(join(home, '.env'), 'utf8')).resolves.toBe(
        ['OPENAI_API_KEY=sk-test', ''].join('\n'),
      )
    } finally {
      await rm(browserosDir, { recursive: true, force: true })
    }
  })
})
