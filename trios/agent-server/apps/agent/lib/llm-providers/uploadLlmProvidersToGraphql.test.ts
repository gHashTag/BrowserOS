/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Contract test for uploadLlmProvidersToGraphql: pins the traffic the
 * uploader sends to the GraphQL backend and the errors it swallows, so the
 * next change to that file has something to fail against. The suite runs
 * fully in memory - no network, no database, no container.
 *
 * Export coverage (the module exports exactly one symbol):
 *   - uploadLlmProvidersToGraphql: exercised by the test below against an
 *     in-memory fake of the GraphQL backend. No export had to be left out
 *     because of a live dependency.
 */

import { describe, it, mock } from 'bun:test'
import assert from 'node:assert'

import type { LlmProviderConfig } from './types'

// ---------------------------------------------------------------------------
// The fake backend.
//
// The subject touches the outside world through exactly two seams: the
// `execute` helper (every GraphQL request it makes) and
// `sentry.captureException` (where it reports failures). Both are replaced
// before the subject is imported, so the assertions below observe what the
// uploader actually sends, not how it is wired internally.
// ---------------------------------------------------------------------------

type ExecutedCall = {
  /** The GraphQL field the request targets, e.g. 'createLlmProvider'. */
  operation: string
  variables: unknown
}

/** The shape the subject sends for a create or update mutation. */
type MutationVariables = {
  input: {
    rowId?: string
    patch?: Record<string, unknown>
    llmProvider?: { rowId?: string } & Record<string, unknown>
  } & Record<string, unknown>
}

function asMutationVariables(call: ExecutedCall): MutationVariables {
  return call.variables as MutationVariables
}

type ReportedError = {
  error: unknown
  extra: Record<string, unknown>
}

const executed: ExecutedCall[] = []
const reported: ReportedError[] = []

let backend: {
  profileRowId: string | null
  remote: Array<Record<string, unknown>> | null
  /** Row ids the fake backend refuses to write, to exercise error paths. */
  failFor: Set<string>
}

function freshBackend() {
  backend = { profileRowId: 'profile-1', remote: [], failFor: new Set() }
}

/**
 * The fake reads the targeted GraphQL field straight out of the document,
 * the way a server would route the request, so the assertions stay about
 * observable traffic rather than module identity.
 */
function operationOf(document: unknown): string {
  const text = String(document)
  for (const field of [
    'createLlmProvider',
    'updateLlmProvider',
    'llmProviders',
    'profileByUserId',
  ]) {
    if (text.includes(`${field}(`)) return field
  }
  throw new Error(`fake backend received an unknown operation: ${text}`)
}

mock.module('@/lib/graphql/execute', () => ({
  execute: async (document: unknown, variables?: unknown) => {
    const operation = operationOf(document)
    const recorded: Record<string, unknown> =
      (variables as Record<string, unknown>) ?? {}
    executed.push({ operation, variables: recorded })

    if (operation === 'profileByUserId') {
      return {
        profileByUserId:
          backend.profileRowId === null
            ? null
            : { rowId: backend.profileRowId },
      }
    }
    if (operation === 'llmProviders') {
      return { llmProviders: { nodes: backend.remote } }
    }

    const input = recorded.input as MutationVariables['input']
    const written = input?.llmProvider?.rowId ?? input?.rowId
    if (backend.failFor.has(written)) {
      throw new Error(`fake backend refused ${operation} for ${written}`)
    }
    return {}
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (
      error: unknown,
      hint?: { extra?: Record<string, unknown> },
    ) => {
      reported.push({ error, extra: hint?.extra ?? {} })
      return 'fake-sentry-event-id'
    },
  },
}))

// The generated GraphQL tag is a build artifact that is not checked in. A
// pass-through tag that keeps the raw query text is all the fake backend
// needs, so the suite never has to generate it. Bun hands the tag the plain
// query string for substitution-less templates, so accept both shapes.
mock.module('@/generated/graphql/gql', () => ({
  graphql: (...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string') return first
    return (first as ReadonlyArray<string>).join('')
  },
}))

// Imported only after every mock above is registered.
const { uploadLlmProvidersToGraphql } = await import(
  './uploadLlmProvidersToGraphql'
)

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function localProvider(
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig {
  return {
    id: 'provider-1',
    type: 'openai',
    name: 'Work relay',
    modelId: 'gpt-4o-mini',
    supportsImages: true,
    contextWindow: 128000,
    temperature: 0.7,
    createdAt: 1710000000000,
    updatedAt: 1720000000000,
    ...overrides,
  }
}

/** A provider as the backend would report it back, with optional fields materialised as null. */
function remoteCopy(
  provider: LlmProviderConfig,
  overrides: Record<string, unknown> = {},
) {
  return {
    rowId: provider.id,
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl ?? null,
    modelId: provider.modelId,
    supportsImages: provider.supportsImages,
    contextWindow: provider.contextWindow,
    temperature: provider.temperature,
    resourceName: provider.resourceName ?? null,
    region: provider.region ?? null,
    ...overrides,
  }
}

function callsTo(field: string): ExecutedCall[] {
  return executed.filter((call) => call.operation === field)
}

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

describe('uploadLlmProvidersToGraphqlContract', () => {
  it('uploadLlmProvidersToGraphql syncs local providers onto the backend without touching unchanged ones and survives failed uploads', async () => {
    // An empty local list performs no traffic at all.
    freshBackend()
    executed.length = 0
    await uploadLlmProvidersToGraphql([], 'user-1')
    assert.equal(
      executed.length,
      0,
      'an empty provider list must not produce any GraphQL call',
    )

    // A user without a profile stops the sync right after the lookup.
    freshBackend()
    backend.profileRowId = null
    executed.length = 0
    await uploadLlmProvidersToGraphql([localProvider()], 'user-1')
    assert.equal(
      executed.length,
      1,
      'a missing profile must stop the sync after the profile lookup',
    )
    assert.equal(executed[0]?.operation, 'profileByUserId')
    assert.deepEqual(executed[0]?.variables, { userId: 'user-1' })

    // A provider missing on the backend is created with its full record,
    // absent optional fields sent as null; a hosted browseros provider is
    // never uploaded even when the backend knows nothing about it.
    freshBackend()
    backend.remote = null
    executed.length = 0
    const hosted = localProvider({ id: 'hosted-1', type: 'browseros' })
    const fresh = localProvider({ id: 'fresh-1', name: 'Fresh relay' })
    await uploadLlmProvidersToGraphql([hosted, fresh], 'user-1')
    assert.equal(
      callsTo('profileByUserId').length,
      1,
      'the profile is looked up once',
    )
    assert.deepEqual(callsTo('llmProviders')[0]?.variables, {
      profileId: 'profile-1',
    })
    const creates = callsTo('createLlmProvider')
    assert.equal(
      creates.length,
      1,
      'exactly one provider is created - never the hosted one',
    )
    assert.deepEqual(creates[0]?.variables, {
      input: {
        llmProvider: {
          rowId: 'fresh-1',
          profileId: 'profile-1',
          type: 'openai',
          name: 'Fresh relay',
          baseUrl: null,
          modelId: 'gpt-4o-mini',
          supportsImages: true,
          contextWindow: 128000,
          temperature: 0.7,
          resourceName: null,
          region: null,
          createdAt: '2024-03-09T16:00:00.000Z',
          updatedAt: '2024-07-03T09:46:40.000Z',
        },
      },
    })
    assert.equal(
      callsTo('updateLlmProvider').length,
      0,
      'a brand-new provider must not be patched',
    )

    // A provider whose only differences are credentials, timestamps or
    // absent-versus-null optional fields is left alone.
    freshBackend()
    const steady = localProvider({
      apiKey: 'sk-local-only',
      accessKeyId: 'AKIA-local',
      baseUrl: undefined,
      createdAt: 1,
      updatedAt: 2,
    })
    backend.remote = [remoteCopy(steady)]
    executed.length = 0
    await uploadLlmProvidersToGraphql([steady], 'user-1')
    assert.equal(
      callsTo('createLlmProvider').length,
      0,
      'an already-known provider must not be re-created',
    )
    assert.equal(
      callsTo('updateLlmProvider').length,
      0,
      'a provider that differs only in ignored fields must not be re-uploaded',
    )

    // A provider whose content drifted is patched in place, not re-created.
    freshBackend()
    const drifted = localProvider({
      id: 'drift-1',
      name: 'Renamed relay',
      baseUrl: 'https://proxy.example/v1',
      resourceName: 'acme',
      region: 'us-east-1',
    })
    backend.remote = [remoteCopy(drifted, { name: 'Stale name' })]
    executed.length = 0
    await uploadLlmProvidersToGraphql([drifted], 'user-1')
    const updates = callsTo('updateLlmProvider')
    assert.equal(updates.length, 1, 'a drifted provider is patched once')
    assert.deepEqual(updates[0]?.variables, {
      input: {
        rowId: 'drift-1',
        patch: {
          type: 'openai',
          name: 'Renamed relay',
          baseUrl: 'https://proxy.example/v1',
          modelId: 'gpt-4o-mini',
          supportsImages: true,
          contextWindow: 128000,
          temperature: 0.7,
          resourceName: 'acme',
          region: 'us-east-1',
          updatedAt: '2024-07-03T09:46:40.000Z',
        },
      },
    })
    assert.equal(
      callsTo('createLlmProvider').length,
      0,
      'a known provider must not be duplicated by a create',
    )

    // A failed upload is reported once and does not stop the queue.
    freshBackend()
    backend.failFor.add('doomed-1')
    const doomed = localProvider({ id: 'doomed-1', name: 'Doomed relay' })
    const survivor = localProvider({ id: 'after-1', name: 'Survivor relay' })
    executed.length = 0
    reported.length = 0
    await uploadLlmProvidersToGraphql([doomed, survivor], 'user-1')
    assert.equal(
      reported.length,
      1,
      'a failed upload is reported to the error sink exactly once',
    )
    assert.ok(reported[0]?.error instanceof Error)
    assert.deepEqual(reported[0]?.extra, {
      providerId: 'doomed-1',
      providerName: 'Doomed relay',
    })
    const survivorCreates = callsTo('createLlmProvider').filter(
      (call) =>
        asMutationVariables(call).input.llmProvider?.rowId === 'after-1',
    )
    assert.equal(
      survivorCreates.length,
      1,
      'a provider queued after a failing one is still uploaded',
    )
  })
})
