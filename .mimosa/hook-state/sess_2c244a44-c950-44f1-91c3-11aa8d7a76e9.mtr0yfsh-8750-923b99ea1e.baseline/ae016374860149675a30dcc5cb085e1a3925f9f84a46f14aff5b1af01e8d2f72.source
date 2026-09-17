/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  HERMES_AGENT_NAME,
  HERMES_IMAGE,
} from '@browseros/shared/constants/hermes'
import {
  OPENCLAW_AGENT_NAME,
  OPENCLAW_IMAGE,
} from '@browseros/shared/constants/openclaw'
import { ContainerCliError, ImageLoadError } from '../vm/errors'
import type { ContainerCli } from './container-cli'
import type { LogFn } from './types'

export class ImageLoader {
  constructor(private readonly cli: ContainerCli) {}

  /** Ensure an image ref exists in the VM's persistent containerd store. */
  async ensureImageLoaded(ref: string, onLog?: LogFn): Promise<void> {
    if (await this.cli.imageExists(ref)) return

    try {
      await this.cli.pullImage(ref, onLog)
    } catch (error) {
      if (error instanceof ContainerCliError) {
        throw new ImageLoadError(ref, `pull failed: ${error.stderr}`, error)
      }
      throw error
    }

    if (!(await this.cli.imageExists(ref))) {
      throw new ImageLoadError(ref, 'image not present after successful pull')
    }
  }

  /** Resolve BrowserOS agent names to image refs and ensure the image exists. */
  async ensureAgentImageLoaded(name: string, onLog?: LogFn): Promise<string> {
    if (name === OPENCLAW_AGENT_NAME) {
      await this.ensureImageLoaded(OPENCLAW_IMAGE, onLog)
      return OPENCLAW_IMAGE
    }
    if (name === HERMES_AGENT_NAME) {
      await this.ensureImageLoaded(HERMES_IMAGE, onLog)
      return HERMES_IMAGE
    }
    throw new ImageLoadError(name, `no agent image mapping: ${name}`)
  }
}
