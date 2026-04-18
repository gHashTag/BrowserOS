/**
 * @license
 * Copyright 2025 TRIOS
 */

import { describe, expect, it } from 'bun:test'
import {
  parseTerminalClientMessage,
  serializeTerminalServerMessage,
} from '../../../src/api/services/terminal/terminal-protocol'
import {
  buildTerminalExecCommand,
  TERMINAL_HOME_DIR,
} from '../../../src/api/services/terminal/terminal-session'

describe('terminal protocol', () => {
  it('parses input messages', () => {
    expect(
      parseTerminalClientMessage('{"type":"input","data":"ls\\n"}'),
    ).toEqual({
      type: 'input',
      data: 'ls\n',
    })
  })

  it('parses resize messages', () => {
    expect(
      parseTerminalClientMessage('{"type":"resize","cols":120,"rows":40}'),
    ).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    })
  })

  it('returns null for malformed or invalid client messages', () => {
    expect(parseTerminalClientMessage('not-json')).toBeNull()
    expect(
      parseTerminalClientMessage('{"type":"resize","cols":0,"rows":40}'),
    ).toBeNull()
    expect(
      parseTerminalClientMessage(new Blob(['{"type":"input","data":"ls"}'])),
    ).toBeNull()
  })

  it('serializes server messages', () => {
    expect(
      serializeTerminalServerMessage({ type: 'output', data: 'hello' }),
    ).toBe('{"type":"output","data":"hello"}')
  })

  it('builds a podman exec command rooted in the container home dir', () => {
    expect(
      buildTerminalExecCommand(
        'podman',
        'trios-openclaw-openclaw-gateway-1',
        TERMINAL_HOME_DIR,
      ),
    ).toEqual([
      'podman',
      'exec',
      '-it',
      '-w',
      '/home/node/.openclaw',
      'trios-openclaw-openclaw-gateway-1',
      '/bin/sh',
    ])
  })
})
