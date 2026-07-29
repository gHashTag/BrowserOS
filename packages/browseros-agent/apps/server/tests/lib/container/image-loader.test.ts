/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import { OPENCLAW_IMAGE } from '@browseros/shared/constants/openclaw'
import type { ContainerCli } from '../../../src/lib/container/container-cli'
import { ImageLoader } from '../../../src/lib/container/image-loader'
import { ContainerCliError, ImageLoadError } from '../../../src/lib/vm/errors'

describe('ImageLoader', () => {
  it('returns without pulling when the image already exists', async () => {
    const cli = new FakeContainerCli([true])
    const loader = new ImageLoader(cli as never)

    await loader.ensureImageLoaded(OPENCLAW_IMAGE)

    expect(cli.pullCalls).toEqual([])
    expect(cli.existsCalls).toEqual([OPENCLAW_IMAGE])
  })

  it('pulls a missing image and verifies it exists', async () => {
    const cli = new FakeContainerCli([false, true])
    const loader = new ImageLoader(cli as never)

    await loader.ensureImageLoaded(OPENCLAW_IMAGE)

    expect(cli.pullCalls).toEqual([OPENCLAW_IMAGE])
    expect(cli.existsCalls).toEqual([OPENCLAW_IMAGE, OPENCLAW_IMAGE])
  })

  it('loads the OpenClaw agent image by manifest name', async () => {
    const cli = new FakeContainerCli([false, true])
    const loader = new ImageLoader(cli as never)

    await expect(loader.ensureAgentImageLoaded('openclaw')).resolves.toBe(
      OPENCLAW_IMAGE,
    )

    expect(cli.pullCalls).toEqual([OPENCLAW_IMAGE])
  })

  it('throws ImageLoadError for unknown agent names', async () => {
    const cli = new FakeContainerCli([])
    const loader = new ImageLoader(cli as never)

    await expect(loader.ensureAgentImageLoaded('missing')).rejects.toThrow(
      ImageLoadError,
    )
    expect(cli.pullCalls).toEqual([])
  })

  it('throws ImageLoadError when pull succeeds but image is still absent', async () => {
    const cli = new FakeContainerCli([false, false])
    const loader = new ImageLoader(cli as never)

    await expect(loader.ensureImageLoaded(OPENCLAW_IMAGE)).rejects.toThrow(
      ImageLoadError,
    )
  })

  it('wraps ContainerCliError pull failures as ImageLoadError', async () => {
    const cli = new FakeContainerCli([false])
    cli.pullError = new ContainerCliError('nerdctl pull', 1, 'network failed')
    const loader = new ImageLoader(cli as never)

    const error = await loader
      .ensureImageLoaded(OPENCLAW_IMAGE)
      .catch((err) => err)

    expect(error).toBeInstanceOf(ImageLoadError)
    expect(error.cause).toBe(cli.pullError)
  })
})

class FakeContainerCli
  implements Pick<ContainerCli, 'imageExists' | 'pullImage'>
{
  existsCalls: string[] = []
  pullCalls: string[] = []
  pullError: Error | null = null

  constructor(private readonly existsResponses: boolean[]) {}

  async imageExists(ref: string): Promise<boolean> {
    this.existsCalls.push(ref)
    return this.existsResponses.shift() ?? false
  }

  async pullImage(ref: string): Promise<void> {
    this.pullCalls.push(ref)
    if (this.pullError) throw this.pullError
  }
}
