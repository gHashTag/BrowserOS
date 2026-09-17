/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { describe, expect, it } from 'bun:test'
import {
  ContainerCliError,
  ImageLoadError,
  LimaCommandError,
  VmError,
  VmNotReadyError,
  VmStateCorruptedError,
} from '../../../src/lib/vm/errors'
import { VM_TELEMETRY_EVENTS } from '../../../src/lib/vm/telemetry'

describe('VM errors', () => {
  it('keeps all VM domain errors under VmError', () => {
    const errors = [
      new VmError('base'),
      new VmNotReadyError('not ready'),
      new VmStateCorruptedError('corrupt'),
      new LimaCommandError('limactl start', 7, 'bad lima'),
      new ContainerCliError('nerdctl pull', 8, 'bad nerdctl'),
      new ImageLoadError('openclaw:v1', 'bad image'),
    ]

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(VmError)
    }
  })

  it('carries command failure details', () => {
    const lima = new LimaCommandError('limactl start', 12, 'stderr text')
    const container = new ContainerCliError(
      'nerdctl pull',
      13,
      'nerdctl stderr',
    )

    expect(lima.exitCode).toBe(12)
    expect(lima.stderr).toBe('stderr text')
    expect(container.exitCode).toBe(13)
    expect(container.stderr).toBe('nerdctl stderr')
  })

  it('exports VM telemetry event names', () => {
    expect(Object.keys(VM_TELEMETRY_EVENTS)).toEqual([
      'ensureReadyStart',
      'ensureReadyOk',
      'ensureReadyBranch',
      'create',
      'start',
      'stop',
      'resetDetected',
      'resetOk',
      'nerdctlWaitStart',
      'nerdctlWaitOk',
      'nerdctlWaitPoll',
      'nerdctlWaitTimeout',
      'migrationOpenClawMoved',
      'limaSpawn',
      'limaExit',
      'limaStderrChunk',
      'provisionYamlWrite',
      'provisionCreateStart',
      'provisionCreateOk',
      'provisionStartBegin',
      'provisionStartOk',
    ])
    expect(VM_TELEMETRY_EVENTS.ensureReadyStart).toBe('vm.ensure_ready.start')
    expect(VM_TELEMETRY_EVENTS.nerdctlWaitTimeout).toBe(
      'vm.nerdctl_wait.timeout',
    )
    expect(VM_TELEMETRY_EVENTS.migrationOpenClawMoved).toBe(
      'vm.migration.openclaw_moved',
    )
  })
})
