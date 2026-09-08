/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * Contract suite for the gitbutler-vision-context tool — Issue #1672.
 *
 * The module exports exactly one symbol, `gitbutler_vision_context`, and the
 * single test below exercises that export end to end: the identity metadata
 * the bridge registers, the input schema's acceptance of arguments and its
 * documented defaults, the payload the handler emits through the response
 * object, that this payload satisfies the tool's own declared output schema,
 * and that the handler keeps working when the response offers no image
 * callback.
 *
 * No live dependency blocks any export: the handler's placeholder payload is
 * produced entirely in-process, so nothing had to be left untested.
 */

import { describe, expect, it } from 'bun:test'
import type { ToolResponse } from '../framework'
import { gitbutler_vision_context } from './gitbutler-vision-context'

/** Everything a handler pushes through a response object. */
interface RecordedResponses {
  texts: string[]
  payloads: unknown[]
  images: Array<[string, string | undefined]>
  errors: string[]
}

/**
 * Builds a response recorder. Pass false to build a response object that
 * offers no `image` callback at all, matching a caller that does not accept
 * image attachments.
 */
function makeResponse(withImageCallback: boolean): {
  response: ToolResponse<unknown>
  seen: RecordedResponses
} {
  const seen: RecordedResponses = {
    texts: [],
    payloads: [],
    images: [],
    errors: [],
  }
  const response: ToolResponse<unknown> = {
    text: (message) => {
      seen.texts.push(message)
    },
    data: (payload) => {
      seen.payloads.push(payload)
    },
    error: (message) => {
      seen.errors.push(message)
    },
  }
  if (withImageCallback) {
    response.image = (data, mimeType) => {
      seen.images.push([data, mimeType])
    }
  }
  return { response, seen }
}

describe('gitbutlerVisionContextContract', () => {
  it('gitbutler_vision_context: pins the tool contract the module exports today', async () => {
    // -- identity: the tool registers under its own name as an automation tool
    expect(gitbutler_vision_context.name).toBe('gitbutler_vision_context')
    expect(gitbutler_vision_context.approvalCategory).toBe('automation')
    expect(gitbutler_vision_context.description).toContain(
      'comprehensive Git repository context',
    )

    // -- input schema: omitted arguments fall back to the documented defaults
    expect(gitbutler_vision_context.input.parse({})).toEqual({
      max_files: 20,
      include_recent_commits: 5,
    })

    // -- input schema: provided arguments pass through, defaults still apply
    expect(
      gitbutler_vision_context.input.parse({
        include_ui_state: true,
        include_changes: false,
        include_branches: true,
        max_files: 50,
      }),
    ).toEqual({
      include_ui_state: true,
      include_changes: false,
      include_branches: true,
      max_files: 50,
      include_recent_commits: 5,
    })

    // -- input schema: out-of-range and wrongly typed arguments are rejected
    expect(() =>
      gitbutler_vision_context.input.parse({ max_files: 0 }),
    ).toThrow()
    expect(() =>
      gitbutler_vision_context.input.parse({ max_files: 51 }),
    ).toThrow()
    expect(() =>
      gitbutler_vision_context.input.parse({ include_recent_commits: 11 }),
    ).toThrow()
    expect(() =>
      gitbutler_vision_context.input.parse({ include_ui_state: 'yes' }),
    ).toThrow()

    // -- handler: reports progress, then emits one placeholder payload
    const recorded = makeResponse(true)
    await gitbutler_vision_context.handler(
      gitbutler_vision_context.input.parse({}),
      {},
      recorded.response,
    )
    expect(recorded.seen.texts).toEqual([
      'Retrieving GitButler repository context...',
    ])
    expect(recorded.seen.errors).toEqual([])
    expect(recorded.seen.payloads.length).toBe(1)
    const payload = recorded.seen.payloads[0]
    expect(payload).toEqual({
      repository_info: {
        name: 'BrowserOS',
        head: 'unknown',
        branch_count: 1,
        clean: true,
        total_files: 0,
        recent_commit_count: 0,
        total_commits: 0,
      },
      ui_state: {
        active_panel: 'ai-chat',
        visible_files: [],
        is_loading: false,
      },
      changes: [
        { type: 'file_modified', path: 'README.md', status: 'visible' },
      ],
      recent_commits: [],
    })

    // -- handler: the emitted payload satisfies the declared output schema
    expect(() => gitbutler_vision_context.output.parse(payload)).not.toThrow()

    // -- handler: offers a PNG image attachment when the response accepts one
    expect(recorded.seen.images.length).toBe(1)
    expect(recorded.seen.images[0]?.[1]).toBe('image/png')

    // -- handler: still emits its payload when the response has no image
    //    callback
    const bare = makeResponse(false)
    await gitbutler_vision_context.handler(
      gitbutler_vision_context.input.parse({}),
      {},
      bare.response,
    )
    expect(bare.seen.payloads.length).toBe(1)
    expect(bare.seen.texts).toEqual([
      'Retrieving GitButler repository context...',
    ])
  })
})
