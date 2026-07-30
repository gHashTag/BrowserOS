import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from './manifest'
import { stageCompiledArtifact } from './stage'
import type { BuildTarget, ResourceRule } from './types'

describe('server artifact staging', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('loads empty local-resource rules from the manifest', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'browseros-stage-test-'))
    const manifestPath = join(tempDir, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify({ resources: [] }))

    expect(loadManifest(manifestPath)).toEqual({
      resources: [],
    })
  })

  it('parses recursive local-resource rules from the manifest', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'browseros-stage-test-'))
    const manifestPath = join(tempDir, 'manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        resources: [
          {
            name: 'Drizzle migrations',
            source: {
              type: 'local',
              path: 'apps/server/src/lib/db/migrations',
            },
            destination: 'resources/db/migrations',
            recursive: true,
            os: ['macos'],
            arch: ['arm64', 'x64'],
          },
        ],
      }),
    )

    expect(loadManifest(manifestPath).resources[0]).toMatchObject({
      name: 'Drizzle migrations',
      recursive: true,
    })
  })

  it('copies recursive local resource directories', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'browseros-stage-test-'))
    const sourceRoot = join(tempDir, 'source')
    const distRoot = join(tempDir, 'dist')
    const binaryPath = join(tempDir, 'browseros-server')
    const migrationsDir = join(sourceRoot, 'apps/server/src/lib/db/migrations')
    await mkdir(join(migrationsDir, 'meta'), { recursive: true })
    await writeFile(binaryPath, 'server')
    await writeFile(join(migrationsDir, '0000_init.sql'), 'CREATE TABLE x;')
    await writeFile(
      join(migrationsDir, 'meta', '_journal.json'),
      '{"entries":[]}',
    )

    const artifact = await stageCompiledArtifact(
      distRoot,
      binaryPath,
      testTarget,
      '0.0.0-test',
      [migrationRule],
      sourceRoot,
    )

    expect(
      await readFile(
        join(artifact.resourcesDir, 'db/migrations/0000_init.sql'),
        'utf8',
      ),
    ).toBe('CREATE TABLE x;')
    expect(
      await readFile(
        join(artifact.resourcesDir, 'db/migrations/meta/_journal.json'),
        'utf8',
      ),
    ).toBe('{"entries":[]}')
  })
})

const testTarget: BuildTarget = {
  id: 'darwin-arm64',
  name: 'macOS ARM64',
  os: 'macos',
  arch: 'arm64',
  bunTarget: 'bun-darwin-arm64',
  serverBinaryName: 'browseros-server',
}

const migrationRule: ResourceRule = {
  name: 'Drizzle migrations',
  source: {
    type: 'local',
    path: 'apps/server/src/lib/db/migrations',
  },
  destination: 'resources/db/migrations',
  recursive: true,
  os: ['macos'],
  arch: ['arm64', 'x64'],
}
