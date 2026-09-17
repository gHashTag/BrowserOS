/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Starting the bee, not just picking it.
 *
 * The tick could choose long before it could dispatch, and a supervisor that
 * chooses without starting anything is a supervisor in name. This is the other
 * half: an isolated checkout, a briefing, and an agent turn that runs where the
 * files are.
 *
 * THE ORDER HERE IS THE DESIGN. Credentials are checked FIRST, before git is
 * touched at all. A worktree cut for a bee that cannot run is litter on a
 * volume, and a refusal that arrives after side effects is one somebody has to
 * clean up before they can even read it. Refusing costs nothing; refusing
 * halfway costs a directory and a branch.
 *
 * WHAT THIS CANNOT DO, and it is not a coding gap: the container holds no push
 * credential, by design. A bee commits inside it, and the commit leaves as a
 * patch that the Mac replays and pushes - proven end to end on 2026-08-29. So
 * dispatch here produces work that is finished but not yet published, and the
 * publication step still belongs to a machine that has the credential.
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { shellArgv } from '../../tools/filesystem/bash'
import { workerSystemPrompt } from './queen-tick'

/**
 * #1360. Every value the `outcome` column of `queen_dispatch` may carry,
 * enumerated in ONE place, because the column is read as a short label by
 * everything downstream: the board groups by it, the public status page
 * prints it, the reaper matchers prefix-match it (`NOT LIKE 'reaped%'`).
 *
 * What this replaces is measured, not hypothetical. Three production rows
 * (1331, 1330, 1326) held `provider refused: ` followed by an entire
 * serialized tool-output event - a `git log` dump with nothing to do with
 * why the turn stopped - because the writer pasted a raw payload behind a
 * guessed cause. `provider refused` named a cause nobody measured: what was
 * measured was that a tool event arrived where a completion was expected.
 *
 * Two rules follow, and both are enforced at the write sites:
 *
 * 1. `outcome` carries one of these labels (or a label extended with a
 *    closed parameter, like the quota code, still bounded by the cap below).
 *    The full payload that produced the ending goes to the row's `detail`
 *    column or to the `queen_transcript` feed - it moves, it is never
 *    discarded and never lands in `outcome`.
 *
 * 2. A cause that was not measured is not named. `endedUnexpectedly` exists
 *    precisely so an unknown cause can be recorded as unknown; a guessed
 *    cause is worse than an admitted gap.
 *
 * `tools/outcome-shape-audit.mjs` audits stored rows against these same two
 * rules (it mirrors the cap and this label in plain JS, with comments
 * pointing back here, because it runs under `node` with no build step).
 */
export const DISPATCH_OUTCOME_LABELS = {
  /** The turn reached its own completion frame and closed normally. */
  finished: 'finished',
  /** /chat answered 200 but its body had no readable stream to drain. */
  noStream: 'no stream',
  /**
   * The stream broke mid-turn. The transport's own error text went to
   * `queen_transcript` (kind `error`) and to the server log, never here.
   */
  streamEndedBadly: 'stream ended badly',
  /**
   * The stream closed without ever signalling completion - a tool event (or
   * anything else) arrived where a completion was expected, and nothing in
   * the stream says why. This is the honest label for the three production
   * rows above: the cause is NOT determined, so it is not named.
   */
  endedUnexpectedly: 'ended unexpectedly (cause undetermined)',
  /**
   * The dispatch never started (no credential, no key free, no worktree, no
   * turn). The full refusal text is the row's `detail` column, which is
   * where a reader looks for the reason; `outcome` only says it never ran.
   */
  refused: 'refused',
  /**
   * Base of the Z.ai quota classification (#1301); the writer appends the
   * documented business code, e.g. `provider quota exhausted (zai code
   * 1308)`. The response body itself stays off the row.
   */
  providerQuotaExhausted: 'provider quota exhausted',
  /**
   * Base of the boot reaper's ending; the writer appends the explanation.
   * Must keep the `reaped` prefix - queen-tick and queen-kanban match on it.
   */
  reapedAtBoot: 'reaped at boot',
  /**
   * Base of the stall reaper's ending; the writer appends the minute count.
   * Must keep the `reaped` prefix - queen-tick and queen-kanban match on it.
   */
  reapedStalled: 'reaped',
} as const

/** One label from the set, as a type. */
export type DispatchOutcomeLabel =
  (typeof DISPATCH_OUTCOME_LABELS)[keyof typeof DISPATCH_OUTCOME_LABELS]

/**
 * #1360. The longest `outcome` this module may ever write. A named constant
 * rather than a literal at each call site, so the column's contract is
 * stated once and the audit tool can mirror one number. Every label above,
 * and every parameterized extension of one, fits under it.
 */
export const DISPATCH_OUTCOME_MAX_LENGTH = 64

/**
 * The one place an outcome is bounded before it reaches a statement. A
 * backstop, not the rule: the writers pass labels from the set above, and
 * this exists so that no future caller can smuggle a payload through the
 * column even by accident.
 */
function boundedOutcome(outcome: string): string {
  return outcome.slice(0, DISPATCH_OUTCOME_MAX_LENGTH)
}

/**
 * Providers this deployment could use, in preference order, with the variable
 * that carries each one's key.
 *
 * Read per call rather than captured at import: a platform that injects
 * variables after module load would otherwise be reported as unconfigured
 * forever, which is the same defect shape as a config file full of zero-length
 * keys - it looks configured and supplies nothing.
 */
const WORKER_PROVIDERS: Array<{
  provider: string
  envVar: string
  model: string
}> = [
  { provider: 'zai', envVar: 'ZAI_API_KEY', model: 'glm-5.3' },
  {
    provider: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-5',
  },
  {
    provider: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    model: 'anthropic/claude-sonnet-4.5',
  },
  {
    provider: 'moonshot',
    envVar: 'MOONSHOT_API_KEY',
    model: 'kimi-k2-0905-preview',
  },
  { provider: 'openai', envVar: 'OPENAI_API_KEY', model: 'gpt-5' },
]

export interface WorkerProvider {
  provider: string
  model: string
  baseUrl?: string
  /** This server's own token, when the turn is aimed back at this server. */
  apiKey?: string
  rehearsal?: boolean
  /**
   * Which key was handed out. For the first endpoint pool (and every legacy
   * provider) this is the 0-based position in that pool's key list, exactly as
   * before. A key of an ADDITIONAL endpoint pool carries its pool in the same
   * integer - see POOL_KEY_STRIDE - because this is the value written to
   * `queen_dispatch.key_index`, and one durable column has to name both.
   */
  keyIndex?: number
  /** How many distinct keys the pool this key came from holds. */
  keyCount?: number
  /** 1-based number of the endpoint pool, present only when several are connected. */
  poolNumber?: number
  poolCount?: number
  /** Which concurrent lane on this credential was handed out, 0-based. */
  laneIndex?: number
  laneCount?: number
  /** Set when every configured worker lane is in use. */
  exhausted?: number
  /**
   * The model's REAL context window, when it is not the 200k default.
   *
   * Dispatch never sent this, so every worker ran against a 200,000-token
   * assumption and compaction did not fire until 180,000. Against a 16k model
   * that is not a tuning detail: the turn dies mid-sentence with no verdict
   * block, which is exactly the transcript this repository already measured -
   * 222,468 characters ending "Add temporary debu".
   */
  contextWindow?: number
}

/**
 * The first provider this deployment can actually pay for.
 *
 * An empty string counts as absent. `~/.trios/config.json` on the operator's
 * Mac has held two provider keys with ZERO-LENGTH values for months: it reads
 * as configured everywhere that checks for the name and supplies nothing to
 * anything that reads the value. The same trap exists in a platform's variable
 * editor, where saving an empty box leaves the name behind.
 */
/**
 * Every DISTINCT key this deployment holds for one provider, in index order.
 *
 * `ZAI_API_KEY`, then `ZAI_API_KEY_2`, `_3`, `_4`, ... The unsuffixed name is
 * index 0 so a deployment with one key needs no migration and reads exactly as
 * it did.
 *
 * Empty strings are skipped rather than counted. A platform variable saved with
 * an empty box leaves the NAME behind, and a rotation that hands a bee index 2
 * because the name exists gives it nothing to authenticate with - the same trap
 * `~/.trios/config.json` has been sitting in for months.
 *
 * Identical values collapse into the slot of their first occurrence (#1293). A
 * variable duplicated across names - the platform's copy button, an env block
 * pasted twice - is still ONE account with ONE rate limit, and counting it
 * twice promises the Queen parallel capacity that does not exist: the second
 * "free" slot hands a bee a secret its sibling is already spending, and the
 * 429 that follows is blamed on the work. Deduplicating HERE is what keeps
 * capacity reporting and key selection in agreement, because both read this
 * one function - the count a dashboard shows and the index a bee takes are the
 * same list, never two different stories about one secret. First occurrence
 * wins, so the unsuffixed variable stays index 0 in every ordering.
 *
 * Values are TRIMMED before they are judged (#1308). ' key' and 'key' pasted
 * into two boxes are one credential wearing its whitespace differently, and a
 * value that is nothing but whitespace is the empty box one paste later. The
 * trimmed value is also the one stored: a key that authenticates never needed
 * its padding, and handing the trimmed form out keeps the count and the
 * selection - which both read this list - from ever disagreeing.
 *
 * The suffix runs to MAX_KEYS_PER_POOL. It used to stop at 16, and 16 was never
 * a measurement: it was where the loop happened to end, equal by coincidence to
 * the policy ceiling on bees. They are different quantities. The ceiling bounds
 * how many bees RUN; this bounds how many credentials the rotation may SPREAD
 * them over, and a free key refuses its third concurrent request in under half
 * a second (`1302`), so a swarm at the ceiling wants more keys than bees, not
 * the same number. A seventeenth variable used to be read by nothing and
 * reported by nothing, which is the zero-length-key trap again: it looks
 * configured and supplies nothing. Widening the list does not widen the swarm -
 * `queenWorkerLimit` still decides that.
 *
 * 1024 rather than a round thousand so that this bound can never sit BELOW a
 * worker ceiling expressed as a power of two: with one lane per credential a
 * swarm of N bees needs N keys, and a key bound under the worker bound would be
 * a second, hidden ceiling that reports nothing when it is hit.
 */
export const MAX_KEYS_PER_POOL = 1024

function keysFor(envVar: string): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const admit = (value: string | undefined) => {
    const trimmed = (value ?? '').trim()
    if (trimmed.length === 0 || seen.has(trimmed)) return
    seen.add(trimmed)
    keys.push(trimmed)
  }
  admit(process.env[envVar])
  for (let i = 2; i <= MAX_KEYS_PER_POOL; i++) {
    admit(process.env[`${envVar}_${i}`])
  }
  return keys
}

/**
 * Concurrent coding projects allowed on each distinct credential.
 *
 * One remains the fail-safe default. Z.ai's published guidance is tier based
 * and dynamic (Lite 1, Pro 1-2, Max 2+), while an API key does not encode that
 * contract locally. The operator must therefore opt into a wider value after
 * checking the live plan. The bound prevents one typo from turning a paid
 * account into an unbounded request fan-out.
 */
export function configuredWorkerLanesPerCredential(
  raw = process.env.TRIOS_ZAI_CONCURRENCY_PER_KEY,
): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return Math.min(parsed, 4)
}

function workerLanesFor(provider: string): number {
  return provider === 'zai' ? configuredWorkerLanesPerCredential() : 1
}

/**
 * What the compiled Queen policy admits at once.
 *
 * This is a MIRROR, and the thing being mirrored is
 * `QueenDelegationPolicy.maximumConcurrentWorkers` in QueenDelegation.swift.
 * Two numbers written in two languages are two numbers that eventually differ,
 * and the direction they differ in decides which failure you get: telemetry
 * promising more than the policy allows sends an operator looking for a bug in
 * dispatch, and promising less hides capacity that was paid for.
 *
 * So both sides now read the SAME environment variable, with the same default
 * and the same ceiling. That ceiling is 1024 and it is a guard against a typo,
 * not a working value: capacity is decided by connected credentials times
 * lanes and by the number the operator sets. It used to be 16, which sat below
 * the credentials a deployment could connect once endpoint pools existed, and
 * said nothing when it bound. Review cost is still linear in running workers -
 * that is why the operator picks the VALUE by measurement. The Swift side
 * records the full reasoning.
 */
function queenWorkerLimit(): number {
  const parsed = Number(process.env.TRIOS_QUEEN_MAX_WORKERS)
  if (!Number.isInteger(parsed) || parsed < 1) return 4
  return Math.min(parsed, 1024)
}

/**
 * The closed, anonymous capacity breakdown every capacity number is made of
 * (#1308).
 *
 * `workers.capacity` answering 4 does not say WHICH 4: two subscriptions at a
 * lane each and one subscription at two lanes each are the same total with
 * completely different operator implications - the first hides a disconnected
 * paid subscription, the second promises parallelism a single rate limit
 * cannot back. This is the ONE authority both `configuredWorkerCapacity` and
 * the public research telemetry read, so the factorisation a dashboard shows
 * and the ceiling dispatch allocates against are the same statement, never two
 * different stories about one configuration.
 *
 * CLOSED means three integers and nothing else. No hashes, no key suffixes, no
 * slot indexes, no provider variable names, no values: anything shaped like a
 * credential is a disclosure, and a count cannot be inverted into one.
 */
export interface WorkerCapacityBreakdown {
  connectedCredentials: number
  lanesPerCredential: number
  effectiveCapacity: number
}

/**
 * Concurrent requests one REMOTE credential will actually carry.
 *
 * Fixed at 1 while that was the only safe assumption about an endpoint named
 * by URL. It is now a measurement. Fired four simultaneous completions at one
 * z.ai key on 2026-09-15: two returned 200 (11.6s, 12.4s) and two were refused
 * in under half a second with `1302 Rate limit reached for requests`. Two is
 * what the credential carries; a third is not slower, it is rejected.
 *
 * So this is configurable and defaults to the old conservative 1 - a number
 * measured on ONE provider must not silently become the assumption for every
 * other one someone points this at. The operator sets it after measuring their
 * own, exactly as TRIOS_ZAI_CONCURRENCY_PER_KEY expects for the paid path, and
 * the bound stops a typo turning a credential pool into a fan-out.
 */
function configuredRemoteLanesPerCredential(): number {
  const parsed = Number(process.env.TRIOS_QUEEN_WORKER_LANES_PER_KEY)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return Math.min(parsed, 4)
}

export function workerCapacityBreakdown(): WorkerCapacityBreakdown {
  const endpoint = configuredWorkerBaseUrl()
  if (endpoint) {
    // An explicitly configured Ollama is one measured inference server even
    // when it happens to have an access token. Multiple names for that token
    // are not independent compute. A remote API, by contrast, gets exactly one
    // conservative lane for every distinct credential - of EVERY connected
    // endpoint pool, because dispatch allocates against the same list.
    const provider = configuredWorkerProvider()
    const connectedCredentials = provider
      ? provider === 'ollama'
        ? 1
        : configuredEndpointPools().reduce(
            (total, pool) => total + pool.keys.length,
            0,
          )
      : 0
    const lanesPerCredential =
      provider === 'ollama' ? 1 : configuredRemoteLanesPerCredential()
    return {
      connectedCredentials,
      lanesPerCredential,
      effectiveCapacity: Math.min(
        connectedCredentials * lanesPerCredential,
        queenWorkerLimit(),
      ),
    }
  }
  for (const candidate of WORKER_PROVIDERS) {
    const keys = keysFor(candidate.envVar)
    if (keys.length > 0) {
      const lanesPerCredential = workerLanesFor(candidate.provider)
      return {
        connectedCredentials: keys.length,
        lanesPerCredential,
        effectiveCapacity: Math.min(
          keys.length * lanesPerCredential,
          queenWorkerLimit(),
        ),
      }
    }
  }
  // Nothing is connected. The lanes factor keeps its safe default rather than
  // zeroing, because it describes the bound the NEXT connected credential
  // would run under; the total is still zero, from zero credentials alone.
  return {
    connectedCredentials: 0,
    lanesPerCredential: configuredWorkerLanesPerCredential(),
    effectiveCapacity: 0,
  }
}

/**
 * Number of genuinely independent worker credentials available to the first
 * configured provider, multiplied by that provider's lanes. The values never
 * leave this module; the public research projection uses only the count to
 * show whether paid capacity is idle. Delegates to the breakdown authority so
 * the number allocated against and the number explained publicly can never
 * diverge (#1308).
 */
export function configuredWorkerCapacity(): number {
  return workerCapacityBreakdown().effectiveCapacity
}

/**
 * A worker endpoint named by URL. It can be a keyless local Ollama or a remote
 * OpenAI-compatible API backed by the generic worker-key pool.
 *
 * It is consulted before every paid candidate because setting it is an explicit
 * operator choice - "use this, not the key" - and unsetting it restores the
 * previous behaviour with no code change and no deploy.
 *
 * The plumbing for this already existed and was one field short of usable:
 * `baseUrl` travels to /chat in dispatchBee and provider-factory builds an
 * openai-compatible client from it, but the zai branch of resolveWorkerProvider
 * returned no baseUrl at all, so the factory fell through to the hardcoded
 * EXTERNAL_URLS.ZAI_API. TRIOS_QUEEN_WORKER_MODEL could therefore rename the
 * model and still send the turn to api.z.ai - a switch that read as
 * configurable and was not. Verified by enumerating every process.env name the
 * server reads: no worker base-URL variable existed.
 */
const DEFAULT_LOCAL_WORKER_MODEL = 'qwen3:1.7b'
const DEFAULT_LOCAL_CONTEXT_WINDOW = 16_384
const GENERIC_WORKER_KEY_ENV = 'TRIOS_QUEEN_WORKER_API_KEY'
const CONFIGURED_ENDPOINT_PROVIDERS = new Set([
  'ollama',
  'openai-compatible',
  'zai',
])

function configuredWorkerBaseUrl(): string | undefined {
  const raw = process.env.TRIOS_QUEEN_WORKER_BASE_URL
  return raw?.trim() ? raw.trim().replace(/\/+$/, '') : undefined
}

function configuredWorkerContextWindow(): number {
  const parsed = Number(process.env.TRIOS_QUEEN_WORKER_CONTEXT)
  if (!Number.isInteger(parsed) || parsed < 2048) {
    return DEFAULT_LOCAL_CONTEXT_WINDOW
  }
  return parsed
}

function configuredWorkerProvider(): string | null {
  const provider = process.env.TRIOS_QUEEN_WORKER_PROVIDER?.trim() || 'ollama'
  return CONFIGURED_ENDPOINT_PROVIDERS.has(provider) ? provider : null
}

/**
 * Select the least-used available credential, scanning circularly after the
 * last durable assignment. This preserves parallel spreading while ensuring
 * a four-Bee policy can exercise a six-key pool across successive rounds.
 */
function availableKeyIndex(
  occupancy: number[],
  laneCount: number,
  afterKeyIndex?: number,
): number {
  const leastBusy = Math.min(
    ...occupancy.filter((busy) => busy < laneCount),
    Number.POSITIVE_INFINITY,
  )
  if (!Number.isFinite(leastBusy)) return -1
  const start =
    typeof afterKeyIndex === 'number' && Number.isInteger(afterKeyIndex)
      ? ((afterKeyIndex % occupancy.length) + occupancy.length + 1) %
        occupancy.length
      : 0
  for (let offset = 0; offset < occupancy.length; offset++) {
    const index = (start + offset) % occupancy.length
    if (occupancy[index] === leastBusy) return index
  }
  return -1
}

/**
 * More than one endpoint at once.
 *
 * One endpoint was the whole model: a single TRIOS_QUEEN_WORKER_BASE_URL, a
 * single model, and every generic key sent there. A deployment that holds
 * credentials for two providers could therefore use one of them - the second
 * set of keys had nowhere to go, because a key handed to a bee is only as good
 * as the URL the bee sends it to. Measured on 2026-09-17: ten Z.ai keys carried
 * sixteen bees while three working NVIDIA keys sat unused next to them.
 *
 * So the FIRST pool is exactly the variables that already exist, unchanged in
 * name and meaning, and further pools are numbered from 2:
 *
 *   TRIOS_QUEEN_WORKER_POOL_<n>_BASE_URL   the endpoint (required)
 *   TRIOS_QUEEN_WORKER_POOL_<n>_MODEL      the model THAT endpoint serves (required)
 *   TRIOS_QUEEN_WORKER_POOL_<n>_PROVIDER   openai-compatible (default) or zai
 *   TRIOS_QUEEN_WORKER_POOL_<n>_CONTEXT    that model's context window
 *   TRIOS_QUEEN_WORKER_POOL_<n>_API_KEY, _API_KEY_2 ... (MAX_KEYS_PER_POOL)
 *
 * A pool is REMOTE credentials by definition. A local Ollama stays what it was
 * measured to be - one inference slot - and does not join a credential pool,
 * so additional pools are read only when the first endpoint is a remote one.
 *
 * The model is required per pool and never inherited: the first pool's model
 * name sent to a second provider is a 404 that arrives blamed on the work.
 * Lanes per credential stay ONE number for the deployment
 * (TRIOS_QUEEN_WORKER_LANES_PER_KEY), which keeps the closed capacity
 * breakdown (#1308) an exact statement: credentials x lanes, bounded by the
 * policy ceiling.
 */
const MAX_ENDPOINT_POOLS = 8
const REMOTE_ENDPOINT_PROVIDERS = new Set(['openai-compatible', 'zai'])

/**
 * The durable name of a key in an additional pool.
 *
 * `queen_dispatch.key_index` is one integer, read back every tick to learn
 * which credentials are busy. Keys of the first pool keep the index they have
 * always had (0, 1, 2 ...), so rows written before this change still mean what
 * they meant. A key of pool n is `(n - 1) * POOL_KEY_STRIDE + position`: pool
 * 2's first key is 10000. The pool NUMBER is used, not its rank among the pools
 * that happen to be valid today, so disconnecting pool 2 does not silently
 * rename every busy key of pool 3. A pool holds at most MAX_KEYS_PER_POOL keys,
 * which is below the stride, so the stride can never be reached from inside
 * one - a test holds the two constants to that.
 */
export const POOL_KEY_STRIDE = 10_000

interface EndpointPool {
  /** 1-based; 1 is the pool made of the unnumbered variables. */
  number: number
  provider: string
  baseUrl: string
  model: string
  contextWindow: number
  keys: string[]
}

function poolVariable(poolNumber: number, name: string): string {
  return `TRIOS_QUEEN_WORKER_POOL_${poolNumber}_${name}`
}

function cleanBaseUrl(raw: string | undefined): string | undefined {
  return raw?.trim() ? raw.trim().replace(/\/+$/, '') : undefined
}

function contextWindowFrom(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 2048) {
    return DEFAULT_LOCAL_CONTEXT_WINDOW
  }
  return parsed
}

/**
 * Why a numbered pool that someone started to configure is not connected.
 *
 * A pool with a URL and no model, or keys and an unsupported provider, reads as
 * configured in a variable editor and supplies nothing - the same trap as an
 * empty key box. Dispatch ignores such a pool rather than guessing, and this is
 * the sentence that says so. Variable NAMES only; never a value.
 */
export function endpointPoolProblems(): string[] {
  const problems: string[] = []
  for (let n = 2; n <= MAX_ENDPOINT_POOLS; n++) {
    const baseUrl = cleanBaseUrl(process.env[poolVariable(n, 'BASE_URL')])
    const keys = keysFor(poolVariable(n, 'API_KEY'))
    if (!baseUrl && keys.length === 0) continue
    if (!baseUrl) {
      problems.push(
        `${poolVariable(n, 'API_KEY')} is set but ${poolVariable(n, 'BASE_URL')} is not`,
      )
      continue
    }
    const provider =
      process.env[poolVariable(n, 'PROVIDER')]?.trim() || 'openai-compatible'
    if (!REMOTE_ENDPOINT_PROVIDERS.has(provider)) {
      problems.push(
        `${poolVariable(n, 'PROVIDER')} must be one of ${[...REMOTE_ENDPOINT_PROVIDERS].join(', ')}`,
      )
    }
    if (!process.env[poolVariable(n, 'MODEL')]?.trim()) {
      problems.push(`${poolVariable(n, 'MODEL')} is not set`)
    }
    if (keys.length === 0) {
      problems.push(`${poolVariable(n, 'API_KEY')} is not set`)
    }
  }
  return problems
}

/**
 * Every endpoint pool dispatch may hand a key from, first pool first.
 *
 * Empty when no endpoint is configured (the legacy provider path decides) or
 * when the first endpoint's provider is unsupported - an explicit endpoint is
 * authoritative, including its refusal, and a valid second pool must not
 * quietly take over from a broken first one.
 */
function configuredEndpointPools(): EndpointPool[] {
  const baseUrl = configuredWorkerBaseUrl()
  const provider = configuredWorkerProvider()
  if (!baseUrl || !provider) return []
  const seen = new Set<string>()
  const distinct = (keys: string[]) =>
    keys.filter((key) => {
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const pools: EndpointPool[] = [
    {
      number: 1,
      provider,
      baseUrl,
      model: process.env.TRIOS_QUEEN_WORKER_MODEL || DEFAULT_LOCAL_WORKER_MODEL,
      contextWindow: configuredWorkerContextWindow(),
      keys: distinct(keysFor(GENERIC_WORKER_KEY_ENV)),
    },
  ]
  if (provider === 'ollama') return pools
  for (let n = 2; n <= MAX_ENDPOINT_POOLS; n++) {
    const poolUrl = cleanBaseUrl(process.env[poolVariable(n, 'BASE_URL')])
    const poolProvider =
      process.env[poolVariable(n, 'PROVIDER')]?.trim() || 'openai-compatible'
    const model = process.env[poolVariable(n, 'MODEL')]?.trim()
    if (!poolUrl || !model || !REMOTE_ENDPOINT_PROVIDERS.has(poolProvider)) {
      continue
    }
    // The same secret under two pools is still one account with one rate
    // limit (#1293); the first pool that names it keeps it.
    const keys = distinct(keysFor(poolVariable(n, 'API_KEY')))
    if (keys.length === 0) continue
    pools.push({
      number: n,
      provider: poolProvider,
      baseUrl: poolUrl,
      model,
      contextWindow: contextWindowFrom(process.env[poolVariable(n, 'CONTEXT')]),
      keys,
    })
  }
  return pools
}

/**
 * The least-used credential across every pool, scanning circularly after the
 * last durable assignment.
 *
 * Every credential is one slot wherever it points, so a wave of bees spreads
 * over both providers before any key carries a second lane - the same rule
 * `availableKeyIndex` applies inside one pool, over the concatenated list.
 */
function endpointPoolProvider(
  pools: EndpointPool[],
  takenKeyIndices: number[],
  afterKeyIndex?: number,
): WorkerProvider {
  const slots = pools.flatMap((pool) =>
    pool.keys.map((key, position) => ({
      pool,
      key,
      durableIndex: (pool.number - 1) * POOL_KEY_STRIDE + position,
    })),
  )
  const laneCount = configuredRemoteLanesPerCredential()
  const occupancy = slots.map(
    (slot) =>
      takenKeyIndices.filter((taken) => taken === slot.durableIndex).length,
  )
  // The cursor is a durable index, not a position: translate it, and start
  // from the top when it names a key that is no longer connected.
  const cursor = slots.findIndex((slot) => slot.durableIndex === afterKeyIndex)
  const position = availableKeyIndex(
    occupancy,
    laneCount,
    cursor >= 0 ? cursor : undefined,
  )
  if (position < 0) {
    return {
      provider: pools[0].provider,
      model: pools[0].model,
      exhausted: slots.length * laneCount,
    }
  }
  const { pool, key, durableIndex } = slots[position]
  return {
    provider: pool.provider,
    model: pool.model,
    baseUrl: pool.baseUrl,
    apiKey: key,
    keyIndex: durableIndex,
    keyCount: pool.keys.length,
    poolNumber: pool.number,
    poolCount: pools.length,
    laneIndex: occupancy[position],
    laneCount,
    contextWindow: pool.contextWindow,
  }
}

function configuredEndpointProvider(
  override: string | undefined,
  takenKeyIndices: number[],
  afterKeyIndex?: number,
): WorkerProvider | null {
  const baseUrl = configuredWorkerBaseUrl()
  if (!baseUrl) return null
  // Several connected pools: one allocator over all of them. A single pool
  // takes the path below, byte for byte what it was.
  const pools = configuredEndpointPools()
  if (pools.length > 1) {
    if (pools[0].keys.length === 0) return null
    return endpointPoolProvider(pools, takenKeyIndices, afterKeyIndex)
  }
  const model = override || DEFAULT_LOCAL_WORKER_MODEL
  const provider = configuredWorkerProvider()
  if (!provider) return null
  const local = provider === 'ollama'
  const keys = keysFor(GENERIC_WORKER_KEY_ENV)

  if (local) {
    // ONE lane, and that is a measurement rather than caution: the Ollama this
    // points at was proven to serve a single inference slot. More token names
    // cannot make the inference server parallel.
    const busy = takenKeyIndices.filter((taken) => taken === 0).length
    if (busy >= 1) return { provider: 'ollama', model, exhausted: 1 }
    return {
      provider: 'ollama',
      model,
      baseUrl,
      // Ollama ignores the fallback; the SDK requires one to be present.
      apiKey: keys[0] || 'local',
      keyIndex: 0,
      keyCount: 1,
      laneIndex: busy,
      laneCount: 1,
      contextWindow: configuredWorkerContextWindow(),
    }
  }

  // A remote endpoint is not local compute and cannot authenticate with a
  // fabricated token. Refuse before worktree creation when no real key exists.
  if (keys.length === 0) return null

  const occupancy = keys.map(
    (_, candidateIndex) =>
      takenKeyIndices.filter((taken) => taken === candidateIndex).length,
  )
  const laneCount = configuredRemoteLanesPerCredential()
  const index = availableKeyIndex(occupancy, laneCount, afterKeyIndex)
  if (index < 0) {
    return { provider, model, exhausted: keys.length * laneCount }
  }
  return {
    provider,
    model,
    baseUrl,
    apiKey: keys[index],
    keyIndex: index,
    keyCount: keys.length,
    laneIndex: occupancy[index],
    laneCount,
    contextWindow: configuredWorkerContextWindow(),
  }
}

/**
 * A bounded number of concurrent lanes per distinct credential.
 *
 * Four bees sharing one credential share one rate limit, so the swarm's real
 * ceiling becomes whatever that single key allows rather than what the Queen's
 * policy permits - and the failure arrives as a 429 blamed on the work.
 *
 * Assignment is by SLOT, not by issue number. Issue numbers look random and are
 * not: the four issues in flight when this was written were 1176, 1216, 1240
 * and 1244, and every one of them is 0 mod 4. A hash of the issue would have
 * put all four bees on the same key and looked like rotation while doing
 * nothing.
 *
 * So the caller passes the credential indices already in use. Selection first
 * spreads work across distinct credentials, then fills the next lane on the
 * least-loaded credential. The credential index is stored with the dispatch,
 * so repeated 429s remain attributable without publishing a secret.
 */
export function resolveWorkerProvider(
  takenKeyIndices: number[] = [],
  afterKeyIndex?: number,
): WorkerProvider | null {
  const override = process.env.TRIOS_QUEEN_WORKER_MODEL
  // An explicit endpoint is authoritative, including its refusal. Falling
  // through when it has no key would silently send the bee to a different
  // provider configured by a legacy variable.
  if (configuredWorkerBaseUrl()) {
    return configuredEndpointProvider(override, takenKeyIndices, afterKeyIndex)
  }
  for (const candidate of WORKER_PROVIDERS) {
    const keys = keysFor(candidate.envVar)
    if (keys.length > 0) {
      const laneCount = workerLanesFor(candidate.provider)
      const occupancy = keys.map(
        (_, index) => takenKeyIndices.filter((taken) => taken === index).length,
      )
      const index = availableKeyIndex(occupancy, laneCount, afterKeyIndex)
      // Every lane busy. Reusing one again would be the quiet version of this
      // problem, so report the actual logical capacity reached.
      if (index < 0) {
        return {
          provider: candidate.provider,
          model: override || candidate.model,
          exhausted: keys.length * laneCount,
        }
      }
      const key = keys[index]
      // The key travels WITH the choice, and leaving it out was a real defect:
      // `/chat` resolves a provider from what the CALLER supplies, because its
      // usual caller is an app on someone's laptop holding its own credentials.
      // The server does not go looking in its own environment. So a deployment
      // with ZAI_API_KEY set got past the credential precheck and then died at
      // the chat route with the same sentence the precheck exists to prevent -
      //
      //   chat answered 500: "z.ai provider requires apiKey"
      //
      // - which reads like a missing key and was a key that was never handed
      // over. Measured on the first round after the operator set one.
      return {
        provider: candidate.provider,
        model: override || candidate.model,
        apiKey: key,
        keyIndex: index,
        keyCount: keys.length,
        laneIndex: occupancy[index],
        laneCount,
      }
    }
  }
  // No key anywhere. If this deployment has been told to rehearse, aim the
  // turn at the recorded stream inside this process instead of refusing.
  //
  // Explicitly opt-in, and it must never be the silent fallback on a
  // deployment that HAS a key: a hive that quietly rehearses instead of
  // working is worse than one that stops, because it reports success.
  if (process.env.TRIOS_QUEEN_REHEARSAL) {
    const port = process.env.PORT || '8080'
    return {
      provider: 'openai-compatible',
      model: override || 'rehearsal',
      baseUrl: `http://127.0.0.1:${port}/queen/rehearsal`,
      apiKey: process.env.TRIOS_API_TOKEN,
      rehearsal: true,
    }
  }
  return null
}

/**
 * Every credential lane a one-shot REVIEW may use right now, across every
 * connected pool and every legacy provider that holds a key.
 *
 * Additive, and it reads the allocator's own inputs rather than restating
 * them: the pools, the keys, the lanes per credential and the durable
 * `key_index` numbering are exactly the ones `resolveWorkerProvider` hands to
 * bees. A lane is offered only while its credential carries fewer requests than
 * its lane count - so a review never becomes the third concurrent request on a
 * z.ai key already carrying two bees, which measured 2026-09-15 is refused in
 * under half a second with `1302`, and a refusal there would be blamed on the
 * review rather than on the arithmetic.
 *
 * Legacy providers after the first are offered too, with no occupancy: bees
 * only ever run on the FIRST provider that holds a key, so a second vendor's
 * key is idle by construction - and it is exactly the second model the
 * adversarial reviewer (#1127) wants. Rehearsal is never offered: a recorded
 * stream cannot judge anything.
 */
export function reviewLaneCandidates(
  takenKeyIndices: number[] = [],
): WorkerProvider[] {
  const busy = (index: number) =>
    takenKeyIndices.filter((taken) => taken === index).length
  const out: WorkerProvider[] = []
  if (configuredWorkerBaseUrl()) {
    for (const pool of configuredEndpointPools()) {
      const local = pool.provider === 'ollama'
      const keys = local
        ? [keysFor(GENERIC_WORKER_KEY_ENV)[0] || 'local']
        : pool.keys
      const laneCount = local ? 1 : configuredRemoteLanesPerCredential()
      keys.forEach((key, position) => {
        const durableIndex = (pool.number - 1) * POOL_KEY_STRIDE + position
        const occupancy = busy(durableIndex)
        if (occupancy >= laneCount) return
        out.push({
          provider: pool.provider,
          model: pool.model,
          baseUrl: pool.baseUrl,
          apiKey: key,
          keyIndex: durableIndex,
          keyCount: keys.length,
          poolNumber: pool.number,
          laneIndex: occupancy,
          laneCount,
          contextWindow: pool.contextWindow,
        })
      })
    }
    return out
  }
  let first = true
  for (const candidate of WORKER_PROVIDERS) {
    const keys = keysFor(candidate.envVar)
    if (keys.length === 0) continue
    const laneCount = workerLanesFor(candidate.provider)
    keys.forEach((key, index) => {
      const occupancy = first ? busy(index) : 0
      if (occupancy >= laneCount) return
      out.push({
        provider: candidate.provider,
        // The worker model override names a model of the bees' provider;
        // sent to a second vendor it is a 404 blamed on the review.
        model: first
          ? process.env.TRIOS_QUEEN_WORKER_MODEL || candidate.model
          : candidate.model,
        apiKey: key,
        // Only the bees' own provider shares the durable index space; a
        // second vendor's index would collide with a bee's and mean nothing.
        keyIndex: first ? index : undefined,
        keyCount: keys.length,
        laneIndex: occupancy,
        laneCount,
      })
    })
    first = false
  }
  return out
}

/** One line naming what is missing, and who can supply it. */
export function missingProviderRefusal(): string {
  const endpoint = configuredWorkerBaseUrl()
  const provider = configuredWorkerProvider()
  const variables = endpoint
    ? [GENERIC_WORKER_KEY_ENV]
    : WORKER_PROVIDERS.map((candidate) => candidate.envVar)
  const providerHint =
    endpoint && !provider
      ? ` and set TRIOS_QUEEN_WORKER_PROVIDER to one of ${[
          ...CONFIGURED_ENDPOINT_PROVIDERS,
        ].join(', ')}`
      : ''
  return (
    'no provider credential in this deployment - set one of ' +
    variables.join(', ') +
    providerHint +
    '. Only the operator can: a key typed by anything else is a key that ' +
    'passed through a place it should not have.'
  )
}

/**
 * Run a command as the bee, not as the server.
 *
 * The image splits the two uids deliberately and the entrypoint says so out
 * loud: "git runs as bee; root does not enter the checkout". Running git as
 * root against a bee-owned tree is not merely impolite, git refuses it -
 * measured on the first dispatch that got past the credential check:
 *
 *   git fetch failed: fatal: detected dubious ownership in repository at
 *   '/workspace/BrowserOS'
 *
 * The tempting fix is `safe.directory`, and it is the wrong one: it tells git
 * to stop minding that a root process is operating on another user's tree,
 * which is the thing the uid split exists to prevent. Dropping to bee - through
 * the same helper every agent shell command already uses - keeps the split and
 * makes git happy for the real reason.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number; out: string }> {
  const quoted = [command, ...args]
    .map((a) => `'${a.replaceAll("'", `'\\''`)}'`)
    .join(' ')
  const argv = shellArgv(quoted)
  return new Promise((resolve) => {
    // `detached` is what makes a process GROUP exist to kill. Without it the
    // timeout below can only reach `su`, and `su` is never the process that
    // hangs.
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true })
    let out = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (code: number, extra = '') => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (hardTimer) clearTimeout(hardTimer)
      resolve({ code, out: (out + extra).trim() })
    }

    // SIGKILL on `su` alone leaves the git it spawned alive, and that grandchild
    // holds the inherited stdio pipes this promise waits on - so 'close', which
    // needs EOF on them, cannot fire and the round hangs FOR EVER holding its
    // lease. Measured on the live swarm: seven consecutive rounds each chose
    // issue #1540 and not one reached a "Queen dispatch" log line of either
    // polarity, while each stuck round kept its heartbeat alive and every 300s
    // tick added another. Killing the whole group is what this timeout always
    // meant to do.
    killTimer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    // Belt and braces. If anything still holds a pipe after the group kill, do
    // not wait on it: a wrong answer is recoverable, a wedged round is not.
    hardTimer = setTimeout(
      () => finish(-1, '\n[run] timed out and never closed'),
      timeoutMs + 5_000,
    )

    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('error', (e) => finish(-1, String(e)))
    child.on('close', (code) => finish(code ?? -1))
  })
}

/**
 * WHICH files a bee's branch actually changed.
 *
 * Lives here because `run` here drops to the bee before touching git. A first
 * version of this counted from the tick and would have run git as root against
 * a bee-owned tree - the dubious-ownership refusal this repository already paid
 * for once, reintroduced two files away from its own fix.
 *
 * The names, not the count. The count was all that ever left this module, and
 * the diff that produced it is the only measurement of where a bee wrote: the
 * `boundary` question `queend` has been able to answer since it was written
 * (queend/main.swift, case "boundary") compares written paths against
 * `owned_paths` and has never had a caller, because the one place holding the
 * paths threw them away at `.length`. Handing back the list costs nothing and
 * is the half of that comparison that lives on this side.
 *
 * Empty on any failure. The review policy treats zero committed files as
 * grounds to escalate rather than accept, so an unreadable branch cannot be
 * mistaken for finished work.
 */
/**
 * The ref a review compares against.
 *
 * Two files disagreed about what TRIOS_REPO_REF means. queen-export.ts reads it
 * as a BRANCH NAME and prefixes origin/; this file read it raw, with a default
 * of origin/dev that is already qualified. Production sets it to `master`, so
 * export resolved origin/master while every review compared against the LOCAL
 * `master` -- a branch the container checked out once and never moved.
 *
 * Measured 2026-09-16: the review reported `oracle="fail"` on branches whose
 * defect is present on real master, and `pre-broken` never appeared once in
 * several hundred reviews. Bees were being sent back for failures they did not
 * cause, because the thing they were compared against had drifted ~100 commits
 * behind. Setting the variable to `origin/master` to compensate produced
 * `origin/origin/master` in the export path and broke publishing outright --
 * the variable was never the place to fix it.
 *
 * One resolver for both files: qualify a bare branch name, leave a qualified
 * ref alone. `master` and `origin/master` now mean the same thing.
 */
export function baseRef(): string {
  const v = process.env.TRIOS_REPO_REF?.trim()
  if (!v) return 'origin/dev'
  return v.includes('/') ? v : `origin/${v}`
}

/**
 * The files a bee's branch committed against the base ref.
 *
 * WHAT THE EMPTY ARRAY MEANS. A diff that fails and a diff that finds nothing
 * both return `[]`, and the callers cannot tell them apart: the review reads
 * the result as "this bee committed no files", and `boundaryStrays` reads it as
 * "no file fell outside the boundary" - clearing a bee that may have strayed
 * all over the checkout. A missing ref, a missing branch, a workspace that is
 * not there: every one of them is exonerating evidence produced by a failure.
 *
 * Some callers legitimately want the empty list (several suites point the
 * workspace at a directory that does not exist precisely to get it), so the
 * return type stays as it is - but the failure is no longer silent. Git's own
 * message, the ref it could not resolve and the directory it ran in are
 * journalled, so an empty list that came from a broken diff can be told from an
 * empty list that came from a clean branch by reading the record.
 */
export async function committedFiles(issue: number): Promise<string[]> {
  const result = await committedFilesResult(issue)
  return result.ok ? result.files : []
}

/**
 * The same diff, with the failure kept apart from the empty branch.
 *
 * `committedFiles` returns `[]` for both, and the review could therefore not
 * release an EMPTY attempt without also releasing a BROKEN diff. Measured on
 * the live board 2026-09-17: of ~180 cards in review only ~41 were live waits,
 * and most of those were attempts that committed nothing at all - turns killed
 * by deploy restarts (188 of 541 dispatches in 24h never finished), z.ai
 * 1302/429 ending a turn within seconds, edits left uncommitted in a reused
 * worktree. Such an attempt is safe to hand back at once. A diff that FAILED is
 * not: the branch may carry a finished commit nobody could read, and releasing
 * it would cut a fresh bee over it. So the two answers are two shapes here,
 * and `committedFiles` stays the thin wrapper every other caller already uses.
 */
export async function committedFilesResult(
  issue: number,
): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  const base = baseRef()
  const root = workspaceRoot()
  const out = await run(
    'git',
    ['diff', '--name-only', `${base}...queen-${issue}`],
    root,
    60_000,
  )
  if (out.code !== 0) {
    const error = out.out.trim().slice(0, 300)
    logger.warn('The committed-file diff failed; no file can be named', {
      issue,
      base,
      branch: `queen-${issue}`,
      root,
      code: out.code,
      // `run` merges the two streams, so git's diagnosis is in `out`.
      error,
    })
    return { ok: false, error: error || `git diff exited ${out.code}` }
  }
  return {
    ok: true,
    files: out.out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  }
}

/** A full commit id, or null. `run` trims, so a good answer is exactly 40 hex. */
function shaFrom(out: { code: number; out: string }): string | null {
  if (out.code !== 0) return null
  const sha = out.out.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

/**
 * The commit a bee's branch points at, or null when it cannot be read.
 *
 * Half of the reviewer's cache key: an adversarial review is a paid model call,
 * and a `wait` row is re-read every round. A verdict about a head that has not
 * moved is still a verdict about the same work, so it is reused rather than
 * bought again.
 */
export async function branchHeadSha(issue: number): Promise<string | null> {
  return shaFrom(
    await run(
      'git',
      ['rev-parse', '--verify', `queen-${issue}^{commit}`],
      workspaceRoot(),
      30_000,
    ),
  )
}

/** The commit the base ref points at - the other half of the cache key. */
export async function baseHeadSha(): Promise<string | null> {
  return shaFrom(
    await run(
      'git',
      ['rev-parse', '--verify', `${baseRef()}^{commit}`],
      workspaceRoot(),
      30_000,
    ),
  )
}

/**
 * What the branch changed, as a patch a reviewer can cite line by line.
 *
 * Bounded, and the bound is SAID: a patch silently cut at N characters reads
 * as a patch that ends there, and a reviewer told nothing would judge the
 * missing half as absent work. The marker names how much was dropped so the
 * reviewer answers could-not-check for what it cannot see. Null when the diff
 * fails, for the same reason `committedFilesResult` keeps failure apart.
 */
export async function branchPatch(
  issue: number,
  maxChars: number,
): Promise<string | null> {
  const out = await run(
    'git',
    ['diff', '--no-color', `${baseRef()}...queen-${issue}`],
    workspaceRoot(),
    60_000,
  )
  if (out.code !== 0) return null
  if (out.out.length <= maxChars) return out.out
  const dropped = out.out.length - maxChars
  return `${out.out.slice(0, maxChars)}\n[truncated ${dropped} chars]`
}

/**
 * How many uncommitted paths the issue's worktree holds, or null when there is
 * no worktree or git cannot read it.
 *
 * An attempt that committed nothing may still have EDITED something - the
 * measured case is a turn that ran out before `git commit`. The count goes on
 * the record so an operator can tell "did nothing" from "did not commit", and
 * nothing is cleaned: a redispatch reuses this worktree (`prepareWorktree`), so
 * the next bee finds the leftovers where the last one stopped.
 */
export async function worktreeDirtCount(issue: number): Promise<number | null> {
  const path = `${workspaceRoot()}/.worktrees/queen-${issue}`
  if (!pathExists(path)) return null
  const dirty = await run('git', ['status', '--porcelain'], path, 60_000)
  if (dirty.code !== 0) return null
  return dirty.out.split('\n').filter((l) => l.trim().length > 0).length
}

/** The same measurement, counted. One rule, asked two ways. */
export async function committedFileCount(issue: number): Promise<number> {
  return (await committedFiles(issue)).length
}

/**
 * What `t27c` says about ONE `.t27` file a bee committed.
 *
 * `present` is false for a file the branch deleted - there is no spec to read.
 * `baseTypechecks` is null for a file the branch created - there is no earlier
 * version to regress against.
 */
export interface SpecWitness {
  file: string
  present: boolean
  /** `t27c parse` exited 0 - no hard parse error. */
  parses: boolean
  /** `t27c parse-complete` consumed the whole file: no TRUNCATE, no DISCARD. */
  complete: boolean
  discardedTokens: number
  /** Occurrences of the literal `TODO: Implement` stub marker. */
  stubMarkers: number
  /** Bodies the codegen refused to lower: a signature with nothing in it. */
  emptyBodies: number
  /** `t27c typecheck` exited 0 on the committed file. */
  typechecks: boolean
  /** The same, on the base ref's version of the file; null when it is new. */
  baseTypechecks: boolean | null
  /** The first error line the compiler printed, or ''. */
  error: string
  /**
   * Whether the Zig this spec generates compiles and passes its own tests.
   *
   * `null` means NOT MEASURED -- no zig on the image, no generated tree, a file
   * outside specs/ -- and must never be read as a pass. Everything else in this
   * record says whether the spec parses; this is the only field that says
   * whether it works.
   */
  oracle: boolean | null
  /** When `oracle` is false: the file the error was in, and the error. */
  oracleError: string
  /**
   * The base ref did not compile either, so this failure is inherited, not
   * caused. 384 of 946 specs are in that state; a review that blamed a bee for
   * landing on one of them would stop the queue, which is the failure this
   * whole loop exists to avoid.
   */
  oraclePreBroken: boolean
}

/**
 * The machine's side of a review.
 *
 * `absent` means the compiler is not on this image (or cannot run): nothing
 * was measured, and the caller must not read that as "nothing failed".
 */
export type Witness =
  | { kind: 'absent'; detail: string }
  | { kind: 'witnessed'; t27c: string; specs: SpecWitness[] }

/** The compiler the review runs. `T27C_BIN` overrides for a test or a Mac. */
function t27cBinary(): string {
  return process.env.T27C_BIN || 't27c'
}

/**
 * The witness script, one file at a time, run AS THE BEE in the repository
 * root. Positional: $1 branch, $2 file, $3 base ref, $4 t27c binary.
 *
 * Everything is read from the COMMIT (`git show branch:file`), never from the
 * worktree, because the worktree may hold edits the bee never committed and
 * the commit is the deliverable. Each measurement prints one `W ` line; the
 * TypeScript side parses those and nothing else, so compiler chatter cannot be
 * mistaken for a result.
 */
const WITNESS_SCRIPT = String.raw`
set -u
branch="$1"; file="$2"; base="$3"; t27c="$4"
ORACLE_TREE=/usr/local/share/t27-oracle-tree
# printenv, not a braced default: this script is a String.raw template and a
# dollar-brace would be read as a TypeScript interpolation.
oracle_tree_override="$(printenv TRIOS_ORACLE_TREE 2>/dev/null || true)"
if [ -n "$oracle_tree_override" ]; then ORACLE_TREE="$oracle_tree_override"; fi
tmp="$(mktemp -d)" || exit 97
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/specs/one"
spec="$tmp/specs/one/$(basename "$file")"
if ! git show "$branch:$file" > "$spec" 2>/dev/null; then echo 'W absent'; exit 0; fi
if "$t27c" parse "$spec" > "$tmp/parse.out" 2>&1; then
  echo 'W parse ok'
else
  echo "W parse fail $(grep -m1 -i 'error' "$tmp/parse.out" | cut -c1-240)"
fi
"$t27c" parse-complete --specs-dir "$tmp/specs" 2>&1 | grep -E 'consume all|TRUNCATE|DISCARD|do not parse' | sed 's/^ */W pc /'
echo "W todo $(grep -c 'TODO: Implement' "$spec" || true)"
# EMPTINESS BY THE CODEGEN, because the marker above is blind to most of it.
# Much of the corpus writes '// TODO: Implement from .tri spec' in a body it
# never wrote, and the grep finds those. But four of the capability specs write
# '// Implementation: ...' instead, and 198 files hold 854 bodies that contain
# only a comment of some shape - on every one of those the marker count is 0 and
# the file reads as finished. The codegen cannot be fooled that way: a body with
# no statement lowers to 'not yet implemented' whatever the comment says.
# Measured on all six capability specs, this count equalled a brace-matching
# empty-body detector exactly: 13/19/33/21/3/7.
echo "W empty $("$t27c" gen "$spec" 2>&1 | grep -c 'not yet implemented' || true)"
if "$t27c" typecheck "$spec" > /dev/null 2>&1; then echo 'W typecheck ok'; else echo 'W typecheck fail'; fi
# THE ORACLE. Everything above asks whether the spec PARSES; this asks whether
# what it generates RUNS. Measured 2026-09-16 across the whole corpus: 541 of
# 946 specs pass, 384 do not compile at all. A bee can satisfy every stated
# criterion with code in that second group, and has.
#
# Three details are load-bearing, each learned by getting it wrong first:
#   - The tree MIRRORS specs/. Generated files import each other by relative
#     path, so a flat directory fails everything with "import of file outside
#     module path", which reads like a toolchain problem and is not.
#   - A shim at the tree ROOT is what makes the tree one Zig module. Zig takes
#     the module root from the root source file's directory and 0.15/0.16 have
#     no flag to override it.
#   - The shared tree is hardlink-copied per review before the reviewed file is
#     REMOVED and rewritten. Writing through a hardlink would edit the cache
#     every other concurrent review is reading.
#
# NO BRACED PARAMETER EXPANSION ANYWHERE BELOW. This script is a String.raw
# template literal in TypeScript, so a dollar-brace is read by the compiler as
# an interpolation and the file stops parsing. sed does the trimming instead.
#
# Silent on every failure that is not the spec's: no zig, no cache, a file
# outside specs/. A missing verdict means "not measured" and the review falls
# back to what it did before; only a real compile is allowed to say "fail".
zigbin="$(command -v zig 2>/dev/null || true)"
case "$file" in specs/*) inspecs=1 ;; *) inspecs=0 ;; esac
if [ -n "$zigbin" ] && [ "$inspecs" = 1 ]; then
  ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache
  export ZIG_GLOBAL_CACHE_DIR
  # Baked at image build (see Dockerfile). NOT generated here: the mirror is
  # ~950 t27c runs, the witness is killed at 120s, and a killed witness records
  # the spec as failing to parse -- a bee blamed for a defect it does not have.
  # No tree, no verdict: TRIOS_ORACLE_TREE lets a test point somewhere else.
  cache="$ORACLE_TREE"
  rel="$(printf '%s' "$file" | sed -e 's|^specs/||' -e 's|\.t27$|.zig|')"
  # A MIRRORED spec path, not the flat $spec the checks above use. t27c writes
  # each import as a path relative to where the SPEC sits, so the same file
  # generated from specs/one/quick_sort.t27 emits "../base/types.zig" and from
  # specs/tri/sort/quick_sort.t27 emits "../../base/types.zig". Handing the
  # flat copy to the oracle makes every import miss by one directory and every
  # spec fail with FileNotFound -- which reads exactly like a broken spec.
  relt="$(printf '%s' "$file" | sed -e 's|^specs/||')"
  # The WHOLE specs tree, not just this file. t27c resolves a use against the
  # FILESYSTEM: a use of fpga::fifo::Fifo emits "../fifo.zig".Fifo when
  # specs/fpga/fifo.t27 is present next to it, and falls back to
  # "../fifo/Fifo.zig" when it is not. A one-file mirror therefore made every
  # spec that uses a neighbour generate an import to a path nothing produces,
  # and the oracle reported FileNotFound on 20+ branches that were fine. I
  # filed an issue blaming the corpus for it before checking.
  mirror_root="$tmp/mirror"
  mkdir -p "$mirror_root"
  cp -al specs "$mirror_root/specs" 2>/dev/null || cp -a specs "$mirror_root/specs" 2>/dev/null || true
  mirror="$mirror_root/specs/$relt"
  mkdir -p "$(dirname "$mirror")"
  # rm first: the copy above may be hardlinks, and writing through one would
  # edit the worktree's own spec.
  rm -f "$mirror"
  git show "$branch:$file" > "$mirror" 2>/dev/null || true
  # Reference every non-generic top-level function from a comptime block, so
  # Zig analyses its body. Zig is lazy: zig test checks only what a test
  # reaches, and a private function no test calls is never type-checked at all.
  # std.testing.refAllDecls does not help -- reflection sees only pub
  # declarations, and 82 percent of generated functions are private. Measured
  # on the 189 specs that pass: 8 hid body errors this way.
  #
  # Whole-file read, so a signature split over lines is seen whole: a generic
  # function must be skipped, because taking its address is itself an error and
  # would blame a bee for nothing. Verified to reproduce a separate measurement
  # of the same 189 specs exactly, 181 clean and 8 not, with 0 disagreements.
  force_bodies() {
    perl -e 'local $/; my $s = <STDIN>; my %seen; my @names;
      while ($s =~ /^(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/mg) {
        my ($n, $p) = ($1, $2);
        next if $p =~ /\bcomptime\b|\banytype\b|:\s*type\b/;
        push @names, $n unless $seen{$n}++;
      }
      print $s;
      if (@names) { print "\ncomptime {\n"; print "    _ = &$_;\n" for @names; print "}\n"; }' \
      < "$1" > "$1.forced" 2>/dev/null && mv "$1.forced" "$1"
  }
  mine="$tmp/tree"
  # cp -al first: 856 files as hardlinks costs nothing. It fails across mount
  # points, and the tree lives in an image layer while $tmp is under /tmp, so
  # on the real container that is exactly what happens -- the first production
  # telemetry read oracle="not measured" on every review that reached a spec,
  # with no error anywhere, because this test simply returned false. A real
  # copy is the fallback; it is slower and still well inside the witness's
  # budget.
  copied=0
  if [ -d "$cache" ]; then
    if cp -al "$cache" "$mine" 2>/dev/null; then copied=1
    elif cp -a "$cache" "$mine" 2>/dev/null; then copied=1
    else echo "W oracle skipped could not stage the tree"; fi
  fi
  if [ "$copied" = 1 ]; then
    mkdir -p "$(dirname "$mine/$rel")"
    rm -f "$mine/$rel"
    if "$t27c" gen "$mirror" > "$mine/$rel" 2>/dev/null && [ -s "$mine/$rel" ]; then
      force_bodies "$mine/$rel"
      printf 'test { _ = @import("%s"); }\n' "$rel" > "$mine/_witness.zig"
      if oracle_out="$(cd "$mine" && "$zigbin" test _witness.zig 2>&1)"; then
        echo 'W oracle pass'
      else
        # Name the file the error is IN. 343 of 361 failures in the first full
        # run were inherited from an import, not produced by the file under
        # test, and a count that ignores that sends bees to fix correct code.
        where="$(printf '%s' "$oracle_out" | grep -m1 -oE '^[^ :]+\.zig:[0-9]+' | cut -d: -f1)"
        [ -n "$where" ] || where='?'
        why="$(printf '%s' "$oracle_out" | grep -m1 'error:' | sed 's/.*error: //' | cut -c1-160)"
        # A failure is only the BEE'S failure if the base compiled. 384 of 946
        # specs do not compile today; holding a bee responsible for arriving at
        # one of those is how a review queue stops moving, and this swarm has
        # already spent a night stopped. So measure the base too, and say which
        # of the two this is.
        # Does this branch fail to COMPILE, or does it compile and fail when
        # RUN? --test-no-exec builds the test binary without running it, and
        # the difference decides who is responsible. 21 specs in this corpus
        # compile and then panic on an unimplemented body; judged with plain
        # zig test their base always "fails", so a bee could break compilation
        # on any of them and be told the breakage was pre-existing. Measured on
        # fifo_tb, which did exactly that.
        branch_compiles=0
        compile_out="$(cd "$mine" && "$zigbin" test --test-no-exec _witness.zig 2>&1)" && branch_compiles=1
        # Report the COMPILE error when there is one. The run output leads with
        # "test command terminated with signal ABRT", which names the symptom
        # of a panicking test and says nothing about the syntax error that
        # stopped the build -- a blocking verdict has to say what to fix.
        if [ "$branch_compiles" = 0 ]; then
          where="$(printf '%s' "$compile_out" | grep -m1 -oE '[^ :]+\.zig:[0-9]+' | cut -d: -f1)"
          [ -n "$where" ] || where='?'
          why="$(printf '%s' "$compile_out" | grep -m1 'error:' | sed 's/.*error: //' | cut -c1-160)"
        fi
        # Paths come back absolute because the tree lives under a mktemp dir,
        # and an operator reading a verdict needs the path in the corpus.
        where="$(printf '%s' "$where" | sed -e "s|^$mine/||" -e 's|^.*/tree/||')"

        basebroke=1
        base_compiles=0
        base_exists=0
        rm -f "$mirror"
        if git show "$base:$file" > "$mirror" 2>/dev/null; then
          base_exists=1
          rm -f "$mine/$rel"
          if "$t27c" gen "$mirror" > "$mine/$rel" 2>/dev/null && [ -s "$mine/$rel" ]; then
            force_bodies "$mine/$rel"
            (cd "$mine" && "$zigbin" test --test-no-exec _witness.zig > /dev/null 2>&1) && base_compiles=1
            (cd "$mine" && "$zigbin" test _witness.zig > /dev/null 2>&1) && basebroke=0
          fi
        fi
        # Held against the bee when the base compiled and this does not, or
        # when both compile and the base's tests passed while these do not --
        # or when there is no base at all.
        #
        # pre-broken means the base was already broken, so the failure was
        # inherited. A file the base does not contain inherited nothing: the
        # bee brought it into being, so a file that arrives failing is the
        # bee's failure outright. Treating no base as a broken base filed every
        # new spec under pre-broken, which is exactly the verdict that lets a
        # failure through unowned -- and the porting feeder produces nothing
        # BUT new specs.
        regressed=1
        if [ "$base_exists" = 0 ]; then
          regressed=0
        elif [ "$base_compiles" = 1 ] && [ "$branch_compiles" = 0 ]; then
          regressed=0
        elif [ "$basebroke" = 0 ]; then
          regressed=0
        fi
        if [ "$regressed" = 0 ]; then
          echo "W oracle fail [$where] $why"
        else
          echo "W oracle pre-broken [$where] $why"
        fi
      fi
    fi
  fi
fi
if git show "$base:$file" > "$tmp/base.t27" 2>/dev/null; then
  if "$t27c" typecheck "$tmp/base.t27" > /dev/null 2>&1; then echo 'W base ok'; else echo 'W base fail'; fi
else
  echo 'W base new'
fi
`

/**
 * Turn the witness script's `W ` lines into one record. Exported for the
 * tests: the shell is the part that needs a container, the reading is not.
 */
export function readWitnessLines(file: string, out: string): SpecWitness {
  const w: SpecWitness = {
    file,
    present: true,
    parses: false,
    complete: false,
    discardedTokens: 0,
    stubMarkers: 0,
    emptyBodies: 0,
    typechecks: false,
    baseTypechecks: null,
    error: '',
    oracle: null,
    oracleError: '',
    oraclePreBroken: false,
  }
  // The completeness report is four counters; the file is complete only when
  // the one spec scanned landed in "parse and consume all". A report that
  // never arrived (compiler crashed, output cut) leaves `complete` false: an
  // unmeasured file is not a clean one.
  let consumedAll = -1
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('W ')) continue
    const body = line.slice(2)
    if (body === 'absent') {
      w.present = false
      return w
    }
    if (body.startsWith('empty ')) {
      const n = Number(body.slice('empty '.length).trim())
      if (Number.isInteger(n)) w.emptyBodies = n
    } else if (body.startsWith('oracle skipped')) {
      // Measured nothing, and said why. Distinct from silence so the telemetry
      // can tell "no zig on this image" from "the tree would not stage".
      w.oracle = null
      w.oracleError = body.slice('oracle skipped'.length).trim()
    } else if (body === 'oracle pass') {
      w.oracle = true
      w.oraclePreBroken = false
    } else if (body.startsWith('oracle pre-broken')) {
      w.oracle = false
      w.oraclePreBroken = true
      w.oracleError = body.slice('oracle pre-broken'.length).trim()
    } else if (body.startsWith('oracle fail')) {
      w.oracle = false
      w.oraclePreBroken = false
      w.oracleError = body.slice('oracle fail'.length).trim()
    } else if (body === 'parse ok') w.parses = true
    else if (body.startsWith('parse fail')) {
      w.parses = false
      w.error = body.slice('parse fail'.length).trim()
    } else if (body.startsWith('pc ')) {
      const m = body.match(/^pc\s+(.*?)\s+(\d+)(?:\s+\((\d+) token)?/)
      if (!m) continue
      const [, label, count, tokens] = m
      if (label.includes('consume all')) consumedAll = Number(count)
      else if (label.includes('DISCARD'))
        w.discardedTokens = Number(tokens ?? count)
    } else if (body.startsWith('todo ')) {
      w.stubMarkers = Number(body.slice(5).trim()) || 0
    } else if (body === 'typecheck ok') w.typechecks = true
    else if (body === 'typecheck fail') w.typechecks = false
    else if (body === 'base ok') w.baseTypechecks = true
    else if (body === 'base fail') w.baseTypechecks = false
    else if (body === 'base new') w.baseTypechecks = null
  }
  w.complete = w.parses && consumedAll === 1 && w.discardedTokens === 0
  return w
}

/**
 * WHAT the compiler says about the `.t27` files a bee's branch changed.
 *
 * The review used to accept on the bee's own "met" lines. Harvested on
 * 2026-09-10 (gHashTag/t27#3560): of 34 finished bee branches whose verdict
 * blocks were read as met, 20 did not parse, 4 parsed with DISCARDED tokens
 * and 1 regressed typecheck - 9 of 34 held up when `t27c` was run on the
 * commit. The bee's word is the claim; this is the measurement, taken by the
 * same three commands the operator ran by hand, on the same commit.
 *
 * Only `.t27` files are witnessed; a branch that changed none returns an
 * empty `specs`. A missing compiler returns `absent`, which the review treats
 * as "could not check" - never as a pass.
 */
export async function witnessSpecs(
  issue: number,
  files: string[],
): Promise<Witness> {
  const specs = files.filter((f) => f.endsWith('.t27'))
  const bin = t27cBinary()
  if (specs.length === 0) return { kind: 'witnessed', t27c: bin, specs: [] }
  const root = workspaceRoot()
  const version = await run(bin, ['--version'], root, 15_000)
  if (version.code !== 0) {
    return {
      kind: 'absent',
      detail: `${bin} --version exited ${version.code}: ${version.out.slice(0, 200)}`,
    }
  }
  const base = baseRef()
  // Fetch, or refresh the base before judging is something nobody does.
  //
  // The workspace fetches when a worktree is PREPARED, and a dispatch row can
  // then sit in review for hours while master moves. `git show origin/master:f`
  // in this root returns whatever the last fetch left behind, so the branch is
  // compared against a base that has drifted -- and a defect fixed upstream, or
  // already present upstream, is attributed to whoever touched the file last.
  //
  // Measured 2026-09-16: `fpga/testbench/fifo_tb.t27` fails on real master with
  // `local variable shadows declaration of 'wr_en'`, and the review kept
  // reporting it as this bee's regression across every tick. Cheap when there
  // is nothing to fetch, and it runs once per reviewed issue, not per file.
  const fetched = await run('git', ['fetch', '--quiet', 'origin'], root, 60_000)
  if (fetched.code !== 0) {
    logger.warn(
      'Could not refresh the base before a review; it may have drifted',
      {
        issue,
        detail: fetched.out.slice(0, 200),
      },
    )
  }
  const branch = `queen-${issue}`
  const out: SpecWitness[] = []
  for (const file of specs) {
    const r = await run(
      'sh',
      ['-c', WITNESS_SCRIPT, 'witness', branch, file, base, bin],
      root,
      120_000,
    )
    const w = readWitnessLines(file, r.out)
    if (r.code !== 0 && r.code !== 1) {
      // The script itself failed (mktemp, kill on timeout): nothing measured.
      w.present = true
      w.parses = false
      w.complete = false
      w.error = w.error || `witness script exited ${r.code}`
    }
    out.push(w)
  }
  return {
    kind: 'witnessed',
    t27c: version.out.split('\n')[0].trim(),
    specs: out,
  }
}

/**
 * The witness as verdict lines, in the shape the review policy already
 * weighs. One line per measurement per file, met or unmet, so `queend`'s one
 * rule decides send-back versus escalate and nothing is decided here.
 *
 * The typecheck line is a RATCHET, not a gate, matching the repository's own
 * corpus check: a file that failed typecheck before the bee touched it may
 * still fail; a file that passed, or did not exist, must pass.
 */
export function witnessVerdicts(
  witness: Witness,
): Array<{ criterion: string; met: boolean }> {
  if (witness.kind !== 'witnessed') return []
  const lines: Array<{ criterion: string; met: boolean }> = []
  for (const s of witness.specs) {
    if (!s.present) continue
    const why = s.error
      ? ` (${s.error})`
      : s.discardedTokens > 0
        ? ` (parse-complete DISCARDED ${s.discardedTokens} token(s))`
        : s.parses && !s.complete
          ? ' (parse-complete did not consume the whole file)'
          : ''
    lines.push({
      criterion: `t27c: ${s.file} parses clean${s.complete ? '' : why}`,
      met: s.complete,
    })
    lines.push({
      criterion: `t27c: ${s.file} has no 'TODO: Implement' stub markers${
        s.stubMarkers > 0 ? ` (${s.stubMarkers} found)` : ''
      }`,
      met: s.stubMarkers === 0,
    })
    const regressed = !s.typechecks && s.baseTypechecks !== false
    lines.push({
      criterion: `t27c: ${s.file} has no empty function body${
        s.emptyBodies > 0 ? ` (${s.emptyBodies} left)` : ''
      }`,
      met: s.emptyBodies === 0,
    })
    lines.push({
      criterion: `t27c: ${s.file} typecheck does not regress${
        regressed
          ? s.baseTypechecks === null
            ? ' (new file fails typecheck)'
            : ' (passed on the base ref, fails on this branch)'
          : ''
      }`,
      met: !regressed,
    })
    // The only criterion here about the code WORKING rather than PARSING.
    // Omitted when `oracle` is null -- no zig on the image, no generated tree
    // -- because an unmeasured file must never read as a passing one. Omitted
    // too when the base was already broken: 384 of 946 specs do not compile,
    // and charging a bee for landing on one of those stops the queue rather
    // than improving it.
    if (s.oracle !== null && !s.oraclePreBroken) {
      lines.push({
        criterion: `zig: ${s.file} compiles and passes its own tests${
          s.oracle ? '' : ` (${s.oracleError})`
        }`,
        met: s.oracle,
      })
    }
  }
  return lines
}

export function workspaceRoot(): string {
  // The directory name is DERIVED from the repo URL, exactly as the entrypoint
  // derives it — `REPO_NAME="$(basename "$TRIOS_REPO_URL" .git)"`. Hardcoding
  // "BrowserOS" here made the two agree only by coincidence of that one URL:
  // point TRIOS_REPO_URL at any other repository and the entrypoint clones to
  // /workspace/<that name> while this function keeps looking in
  // /workspace/BrowserOS, so every dispatch fails on a checkout that is present
  // and simply not where the server looks.
  //
  // One input, one rule, two readers.
  const dir = process.env.WORKSPACE_DIR || '/workspace'
  const url = process.env.TRIOS_REPO_URL || ''
  const name =
    url
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
      .split('/')
      .pop() || 'BrowserOS'
  return `${dir}/${name}`
}

/**
 * An isolated checkout for one bee.
 *
 * Not a nicety. Two bees sharing a checkout is the failure this whole branch
 * kept re-learning: neither the resume path nor the send-back path prepared a
 * worktree, so two workers edited the same files and each committed the other's
 * half-finished work. The worktree IS the isolation - the boundary rules only
 * decide who is allowed to want a file.
 *
 * Idempotent: an existing worktree for this issue is reused rather than
 * treated as an error, because a round that crashed after cutting one must be
 * able to run again.
 */
/**
 * How full the volume this server writes to actually is.
 *
 * Returns null when it cannot be measured, and every caller treats that as
 * UNKNOWN rather than as room - a guard that reads an unmeasurable disk as
 * empty is a guard that disables itself exactly when the filesystem is unwell.
 */
export function volumeUsedPercent(dir = workspaceRoot()): number | null {
  // `df -P`, NOT statfs arithmetic - and the difference is not academic.
  //
  // The first version computed `(blocks - bavail) / blocks` from statfs. On a
  // Linux container that is exact. On an APFS shared container it is not:
  // `statfs` reports the CONTAINER's size while df reports this volume's own
  // usage, so a Mac at 57% measured 97% and the guard refused every dispatch in
  // a unit test that merely cut a worktree in a temp directory.
  //
  // POSIX `df -P` gives one line, one capacity column, the same number the
  // operating system shows a person and the same one the external reaper has
  // been reading correctly all night. One subprocess per dispatch, and
  // dispatches are minutes apart.
  try {
    const out = execFileSync('df', ['-P', dir], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = out.trim().split('\n').pop() ?? ''
    const m = line.match(/(\d+)%/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/**
 * GARBAGE COLLECTION BELONGS ON THE NODE.
 *
 * THE INCIDENT, 2026-09-05. `/workspace` reached 100% - 71 MB of 46 GB, sixty
 * worktrees - and every dispatch died in its first second with
 * `git worktree add failed: unable to write file docs/images/...`. An issue
 * handed to the swarm never ran a line.
 *
 * A reaper existed and had not run, because it lived OUTSIDE: it reached the
 * volume through `railway ssh`, and railway refuses a connection while the
 * application is unhealthy - which it was, BECAUSE the volume was full. The tool
 * that repairs the failure reached through the thing the failure breaks. A retry
 * thirty seconds later happened to succeed; nothing guaranteed it would.
 *
 * Every system that has met this problem answers it the same way. kubelet
 * garbage-collects images on the NODE against high and low watermarks, not from
 * the control plane. CI runners clean their own disks, because a control plane
 * cannot reach a wedged runner. ext4 reserves 5% so root can still act on a
 * "full" filesystem. The common sentence: the collector must not depend on the
 * thing whose failure it collects for.
 *
 * So the server reaps its own volume, on the same watermark model the external
 * reaper uses - above HIGH, remove until LOW - and the external one becomes a
 * fallback rather than the only hand.
 *
 * WHAT IT WILL NEVER REMOVE. A worktree holding uncommitted work. This container
 * carries no push credential by design, so unpublished work in a tree is the
 * ONLY copy of it, and `prepareWorktree` already refuses to clean a reused tree
 * for exactly that reason. A dirty tree is somebody's unfinished turn; the disk
 * is never worth it. Nor does it touch the newest few, which are likely to be
 * running right now.
 */
export async function reapWorktrees(
  opts: {
    high?: number
    low?: number
    keepNewest?: number
    volumeUsed?: (dir: string) => number | null
  } = {},
): Promise<{
  before: number | null
  after: number | null
  removed: string[]
  keptDirty: string[]
  refused: string[]
}> {
  const high = opts.high ?? Number(process.env.QUEEN_VOLUME_HIGH ?? 80)
  const low = opts.low ?? Number(process.env.QUEEN_VOLUME_LOW ?? 55)
  const keepNewest =
    opts.keepNewest ?? Number(process.env.QUEEN_VOLUME_KEEP ?? 6)
  const root = workspaceRoot()
  const measure = opts.volumeUsed ?? volumeUsedPercent
  const before = measure(root)
  const result = {
    before,
    after: before,
    removed: [] as string[],
    keptDirty: [] as string[],
    refused: [] as string[],
  }
  // Unknown is not room. Below the mark is not an emergency.
  if (before === null || before < high) return result

  const listed = await run('git', ['worktree', 'list', '--porcelain'], root)
  const paths = listed.out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9))
    .filter((p) => p.includes('/.worktrees/'))

  // Oldest first: the newest are the ones most likely to be running.
  const withAge: Array<{ path: string; mtime: number }> = []
  for (const p of paths) {
    try {
      withAge.push({ path: p, mtime: statSync(p).mtimeMs })
    } catch {
      // A recorded worktree whose directory is gone: prune will clear it.
      withAge.push({ path: p, mtime: 0 })
    }
  }
  withAge.sort((a, b) => a.mtime - b.mtime)
  const candidates = withAge.slice(0, Math.max(0, withAge.length - keepNewest))

  for (const c of candidates) {
    const now = measure(root)
    if (now !== null && now <= low) break

    const dirty = await run('git', ['status', '--porcelain'], c.path, 60_000)
    // Unreadable is not clean. A tree whose state cannot be read might hold the
    // only copy of a turn's work.
    if (dirty.code !== 0 || dirty.out.trim().length > 0) {
      result.keptDirty.push(c.path)
      continue
    }
    // No `--force`, here or anywhere else in this project. A tree that refuses
    // to go is a tree a person should look at.
    const removedOne = await run(
      'git',
      ['worktree', 'remove', c.path],
      root,
      120_000,
    )
    if (removedOne.code === 0) result.removed.push(c.path)
    else result.refused.push(c.path)
  }

  await run('git', ['worktree', 'prune'], root, 60_000)
  result.after = measure(root)
  return result
}

/**
 * Link this worktree's node_modules into a shared store instead of installing.
 *
 * WHY AT CREATION AND NOT AFTER. Every dispatch ran `bun install` and wrote
 * about 2.5 GB of its own node_modules; the loop's `share-modules` reclaimed it
 * afterwards, which bounded the damage and never stopped it. Six worktrees were
 * carrying 15.4 GB of the same packages when this was written.
 *
 * PROVEN BY INTERVENTION before a line of this existed, on a scratch worktree
 * cut from the same HEAD:
 *
 *   bare checkout                                     159 MB
 *   with the farm built, before any install           159 MB
 *   after `bun install --frozen-lockfile`             159 MB
 *     "Checked 2250 installs across 2424 packages (no changes) [580.00ms]"
 *   and its test suite: 8 tests, 0 fail, through the farm
 *
 * The earlier attempt at this was recorded in the loop's own notes as REFUTED -
 * "a pre-built farm cannot survive bun install", 159M becoming 2562M. That was a
 * bug in the farm builder: a POSIX glob that does not match dotfiles left out
 * `.bun`, which is bun's entire isolated store. With it linked, bun sees the
 * tree as satisfied and writes nothing.
 *
 * WHAT IT WILL NOT DO. It does nothing at all unless a store already exists for
 * this exact lockfile hash, so a worktree whose dependencies differ installs
 * normally and the first tree of any new lockfile donates its install. And it
 * never fails a dispatch: this is an optimisation, and a bee that installs its
 * own copy is slower and correct.
 */
export async function farmNodeModules(
  worktree: string,
  root: string,
): Promise<string> {
  const store = process.env.TRIOS_MODULE_STORE || `${root}/.node_modules_store`
  // One shell, because this is filesystem work and splitting it into a dozen
  // spawns would be slower and no clearer.
  const script = [
    'set -e',
    `W=${JSON.stringify(worktree)}`,
    `STORE=${JSON.stringify(store)}`,
    'L="$W/trios/agent-server/bun.lock"',
    '[ -f "$L" ] || L="$W/trios/agent-server/bun.lockb"',
    '[ -f "$L" ] || { echo "NOFARM no lockfile"; exit 0; }',
    'H=$(md5sum "$L" 2>/dev/null | cut -c1-12)',
    'S="$STORE/$H"',
    '[ -d "$S" ] || { echo "NOFARM no store for $H"; exit 0; }',
    'n=0',
    'for rel in $(cd "$S" && find . -maxdepth 6 -name node_modules -type d -prune 2>/dev/null | sed "s|^\\./||"); do',
    '  src="$S/$rel"',
    '  rm -rf "$W/$rel"; mkdir -p "$W/$rel"',
    // Dotfiles included. `.bun` is 2242 entries and 2.37 GB of it, and leaving
    // it out is what made this look impossible the first time.
    '  for e in "$src"/* "$src"/.[!.]*; do [ -e "$e" ] || continue; ln -s "$e" "$W/$rel/$(basename "$e")" 2>/dev/null || true; done',
    // A workspace links its OWN packages by relative path inside node_modules.
    // Shared away they resolve against the store and find nothing, so they are
    // pointed back at this worktree's sources.
    '  if [ -d "$src/@browseros" ]; then',
    '    rm -f "$W/$rel/@browseros"; mkdir -p "$W/$rel/@browseros"',
    '    for w in "$src/@browseros"/*; do',
    '      real=$(readlink -f "$w" 2>/dev/null || echo "")',
    '      mapped=$(echo "$real" | sed "s|$S|$W|")',
    '      if [ -d "$mapped" ]; then ln -s "$mapped" "$W/$rel/@browseros/$(basename "$w")"',
    '      else ln -s "$w" "$W/$rel/@browseros/$(basename "$w")"; fi',
    '    done',
    '  fi',
    '  n=$((n+1))',
    'done',
    'echo "FARMED $n directories against $H"',
  ].join('\n')

  try {
    const r = await run('sh', ['-c', script], root, 120_000)
    const m = r.out.match(/FARMED (\d+) directories against (\S+)/)
    if (m) return `; linked ${m[1]} node_modules into the store for ${m[2]}`
    const no = r.out.match(/NOFARM (.+)/)
    return no ? `; installed its own modules (${no[1].trim()})` : ''
  } catch (error) {
    // An optimisation that throws is worse than one that does not run - but one
    // that fails SILENTLY is how a gap survives. It says so and carries on.
    return `; the module farm could not be built (${
      error instanceof Error ? error.message.slice(0, 80) : 'unknown'
    })`
  }
}

/**
 * Does this path exist at all?
 *
 * Deliberately not `git worktree list`: the case this guards is precisely the
 * one where those two answers disagree.
 */
function pathExists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

export async function prepareWorktree(
  issue: number,
  deps: {
    // INJECTED, and the test that forced it is the argument for it.
    //
    // The first version read the real filesystem unconditionally, so a unit test
    // that cuts a worktree in a temp directory started passing or failing
    // according to how full the DEVELOPER'S disk was. It failed on a machine at
    // 57% because `statfs` on an APFS shared container reports the container's
    // size, not this volume's usage - `(blocks - bavail) / blocks` came out at
    // 97% where `df` says 57.
    //
    // In the Linux container this guard actually runs in, statfs is exact. On a
    // developer's Mac it is not, and a guard whose behaviour depends on the host
    // filesystem is a guard no test can pin. So the measurement is a dependency
    // with a real default, like the pool and the clock everywhere else here.
    volumeUsed?: (dir: string) => number | null
  } = {},
): Promise<{ ok: boolean; path: string; detail: string }> {
  const measure = deps.volumeUsed ?? volumeUsedPercent
  const root = workspaceRoot()
  const branch = `queen-${issue}`
  const path = `${root}/.worktrees/${branch}`

  const existing = await run('git', ['worktree', 'list', '--porcelain'], root)
  if (existing.out.includes(path)) {
    // Reuse is not a fresh checkout, and saying "reused an existing worktree"
    // let that pass unnoticed: the next bee inherits whatever the last one left
    // uncommitted, and both the dispatch row and the brief read as if it had
    // started from `origin/dev`. So count the leftovers and say so - the same
    // sentence reaches the board, the operator and the reviewer.
    //
    // It counts and does not clean. The container holds no push credential by
    // design, so unpushed work in that tree is the ONLY copy of it; a reset
    // here would destroy the predecessor's turn to make this one tidy.
    const dirty = await run('git', ['status', '--porcelain'], path, 60_000)
    if (dirty.code !== 0) {
      return {
        ok: true,
        path,
        detail: 'reused an existing worktree (its state could not be read)',
      }
    }
    const changed = dirty.out
      .split('\n')
      .filter((l) => l.trim().length > 0).length
    // A REUSED TREE NEEDS THE FARM AS MUCH AS A FRESH ONE.
    //
    // The farm was added after `git worktree add` and this path returns before
    // reaching it, so every reused worktree kept whatever node_modules it had.
    // Found the same day: #1627, cut after the change went live, lockfile hash
    // matching an existing store, and still carrying 2,562 MB of its own
    // packages - because its dispatch says "reused an existing worktree
    // (clean)".
    //
    // One tree of fifteen, which is exactly how a gap like this hides: the
    // aggregate looked fixed.
    const reusedFarm = await farmNodeModules(path, root)
    return {
      ok: true,
      path,
      detail:
        (changed === 0
          ? 'reused an existing worktree (clean)'
          : `reused an existing worktree (${changed} uncommitted file(s) ` +
            'left by a previous attempt)') + reusedFarm,
    }
  }

  // A DIRECTORY CAN EXIST WHILE GIT DOES NOT LIST IT, and the reuse branch
  // above cannot see that because it asks git rather than the disk.
  //
  // A container that dies between `git worktree add` and its metadata write
  // leaves the checkout on the volume with nothing in .git/worktrees pointing
  // at it. Every later round for that issue then dies on
  //
  //   fatal: '/workspace/BrowserOS/.worktrees/queen-1540' already exists
  //
  // which is exactly what wedged #1540: seven consecutive rounds chose it, each
  // recorded `started: false`, and the swarm reported four idle lanes while
  // having no way to use one. The dispatch row carried the sentence the whole
  // time; nothing read it out loud.
  //
  // Prune first. When the admin entry is merely stale that IS the repair, and
  // it costs one cheap git call - so the question the next lines ask, "is this
  // path registered?", is asked of a registry that has just been made accurate.
  await run('git', ['worktree', 'prune'], root, 60_000)
  const registered = await run(
    'git',
    ['worktree', 'list', '--porcelain'],
    root,
    60_000,
  )
  if (!registered.out.includes(path) && pathExists(path)) {
    // An orphan: present on disk, unknown to git.
    //
    // NOT DELETED. This container holds no push credential by design, so
    // anything uncommitted in that tree is the ONLY copy of a predecessor's
    // turn - the same reason the reuse branch above counts and does not clean.
    // Moving it aside frees the path for a fresh cut and keeps the evidence
    // under a name that says what it is.
    const parked = `${path}.orphan-${Date.now()}`
    const moved = await run('mv', [path, parked], root, 60_000)
    if (moved.code !== 0) {
      return {
        ok: false,
        path,
        detail:
          `an unregistered worktree occupies ${path} and could not be moved ` +
          `aside: ${moved.out.slice(0, 200)}`,
      }
    }
    logger.warn('Parked an unregistered worktree directory', {
      issue,
      path,
      parked,
    })
  }

  // BEFORE THE FETCH, because a fetch onto a full volume fails the same way and
  // the reason it reports is about refs rather than about space. The dispatch
  // that exposed this died with "cannot update the ref ... unable to write file",
  // which sent the reader looking at git rather than at df.
  const used = measure(root)
  const highMark = Number(process.env.QUEEN_VOLUME_HIGH ?? 80)
  if (used !== null && used >= highMark) {
    const gc = await reapWorktrees({ volumeUsed: measure })
    logger.warn('Queen reaped worktrees before cutting a new one', {
      before: gc.before,
      after: gc.after,
      removed: gc.removed.length,
      keptDirty: gc.keptDirty.length,
      refused: gc.refused.length,
    })
    const still = gc.after
    if (still !== null && still >= 95) {
      // REFUSE, and say what is true. Dying at `git worktree add` reports a git
      // error for a disk problem, and every reader of that message has looked in
      // the wrong place. A refusal that names the number is a refusal somebody
      // can act on.
      return {
        ok: false,
        path,
        detail:
          `volume ${still}% full after reaping ${gc.removed.length} worktree(s); ` +
          `${gc.keptDirty.length} held uncommitted work and were kept. ` +
          'Not cutting a worktree that would fail part-way',
      }
    }
  }

  const fetched = await run(
    'git',
    ['fetch', '--quiet', 'origin'],
    root,
    180_000,
  )
  if (fetched.code !== 0) {
    return {
      ok: false,
      path,
      detail: `git fetch failed: ${fetched.out.slice(0, 200)}`,
    }
  }

  const base = baseRef()
  const added = await run(
    'git',
    ['worktree', 'add', '-B', branch, path, base],
    root,
    180_000,
  )
  if (added.code !== 0) {
    return {
      ok: false,
      path,
      detail: `git worktree add failed: ${added.out.slice(0, 300)}`,
    }
  }
  const farmed = await farmNodeModules(path, root)
  return { ok: true, path, detail: `cut from ${base}${farmed}` }
}

/**
 * The turn, over this server's own HTTP surface.
 *
 * In-process would be fewer moving parts and the wrong choice: `/chat` is where
 * auth, model resolution, persistence and tool wiring are decided, and a second
 * entry point past all of that is a second set of rules that agrees until it
 * does not. The bee gets in the same way every other client does, with the same
 * token, through the same gate.
 *
 * The stream is drained in the background. Dropping the connection would cancel
 * the turn, and blocking the round on it would mean one bee's half hour is the
 * whole hive's half hour.
 */
async function startTurn(
  pool: Pool,
  issue: number,
  conversationId: string,
  brief: string,
  workingDirectory: string,
  chosen: WorkerProvider,
  ownedPaths: string[],
): Promise<{ ok: boolean; detail: string; beginDrain?: () => void }> {
  const token = process.env.TRIOS_API_TOKEN
  if (!token)
    return {
      ok: false,
      detail: 'this server has no TRIOS_API_TOKEN to call itself with',
    }
  const port = process.env.PORT || '8080'

  try {
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        conversationId,
        message: brief,
        mode: 'agent',
        origin: 'sidepanel',
        provider: chosen.provider,
        model: chosen.model,
        ...(chosen.baseUrl && { baseUrl: chosen.baseUrl }),
        ...(chosen.apiKey && { apiKey: chosen.apiKey }),
        // Without this the agent takes the 200k default and compaction waits
        // until 180k, which against a 16k model means the turn is cut off long
        // before it writes "## VERDICT" - and an unverdicted dispatch sits in
        // `wait` for six hours holding its issue and its file boundaries.
        ...(chosen.contextWindow && {
          contextWindowSize: chosen.contextWindow,
        }),
        // `userWorkingDir`, not `workingDirectory`. The schema names it the
        // first way and ignores unknown keys, so the wrong name was accepted
        // in silence and the bee would have run against the shared checkout
        // instead of its own worktree - its edits and its branch in different
        // trees, which is the failure the worktree exists to prevent.
        userWorkingDir: workingDirectory,
        // The standing identity, in the field the server reads (types.ts:42 ->
        // prompt.ts:649). The brief is the task; this is who is doing it.
        userSystemPrompt: workerSystemPrompt(
          issue,
          process.env.TRIOS_GITHUB_REPO || 'gHashTag/trios',
          workingDirectory,
          ownedPaths,
        ),
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        detail: `chat answered ${response.status}: ${body.slice(0, 200)}`,
      }
    }
    // HANDED BACK, NOT FIRED. The reader used to start here, and the row it
    // eventually closes was written by the CALLER afterwards - so the two raced,
    // and the reader could win.
    //
    // Measured by a skeptic on a real stream: a turn whose frames are all
    // NOISE (start, finish) does no database work of its own, so it reached
    // `closeDispatch` before `recordDispatch` had inserted anything. The ending
    // UPDATE then matched ZERO rows - silently, because an UPDATE that changes
    // nothing does not throw - and the upsert that followed wrote
    // started=true, finished_at NULL. A bee that had already stopped appeared
    // to be running and held its files until the 120-minute reaper.
    //
    // That is the exact phantom `closeDispatch`'s own logging was added to
    // catch, arriving by a path with no database failure in it at all.
    return {
      ok: true,
      detail: 'turn accepted',
      // The provider travels with the drain so that a quota stop at the end
      // of the stream can name whose quota it was (#1301).
      beginDrain: () =>
        void drain(pool, response, conversationId, issue, chosen.provider),
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Turns the bee's stream into rows a person can read.
 *
 * Two things it must not do. It must not write a row per token - a turn emits
 * thousands of text deltas and a row each would make the table the expensive
 * part of watching. And it must not wait for the turn to end before writing
 * anything, or "live" means "ten minutes late".
 *
 * So text is coalesced and flushed on a size or time bound, whichever comes
 * first, while a tool call or an error flushes immediately: those are the
 * events somebody watching is actually waiting for, and batching them to save a
 * round trip would hide the one frame that mattered.
 */
class Scribe {
  private seq = 0
  private buffer = ''
  private lastFlush = Date.now()
  /**
   * What the turn cost, as the stream reported it.
   *
   * Undefined until a `usage` frame arrives, and undefined is not zero: a turn
   * killed mid-stream never reaches its usage frame, and writing 0 tokens for
   * it would price a real turn at nothing instead of admitting it is unknown.
   */
  tokens: TokenUsage | undefined

  /**
   * The turn's terminal stream error, if it had one (#1301).
   *
   * An `error` frame is terminal: `finishWithError` emits it and then closes
   * the stream (lib/agents/acp-ui-message-stream.ts), and this is the frame a
   * provider refusal travels in, because /chat answers 200 and streams the
   * failure rather than answering non-ok. Kept unread until the ending, where
   * it may close the dispatch as a quota stop instead of a finish.
   */
  streamError: string | undefined

  /**
   * Whether the stream ever said it was done (#1360).
   *
   * A `finish` frame is the turn's own voice saying it ended - every path in
   * acp-ui-message-stream.ts that closes a healthy stream enqueues one. A
   * stream that closes WITHOUT one did not reach its own end, and nothing in
   * it says why: that is the situation the three production rows of #1360
   * were mislabelled about, and it is recorded as cause-undetermined rather
   * than guessed at.
   */
  sawCompletion = false

  constructor(
    private pool: Pool,
    private conversationId: string,
    private issue: number,
  ) {}

  /**
   * Frames that carry no information for a reader.
   *
   * The model's stream is mostly bookkeeping: a step opening, a step closing,
   * reasoning starting, a text block starting. Storing them filled the feed
   * with lines like {"type":"start-step"} between every sentence, which is
   * exactly what made it unreadable to anyone who had not written the parser.
   */
  private static readonly NOISE = new Set([
    'start',
    'start-step',
    'finish-step',
    'finish',
    'text-start',
    'text-end',
    'reasoning-start',
    'reasoning-end',
    'tool-input-start',
    'tool-input-delta',
  ])

  async frame(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(payload) as Record<string, unknown>
    } catch {
      await this.note('raw', payload.slice(0, 2000))
      return
    }
    const type = String(event.type ?? 'event')
    // The completion frame is remembered before the NOISE filter drops it
    // (#1360): `finish` carries nothing for a reader, but its PRESENCE is the
    // difference between a turn that ended and a stream that merely stopped.
    if (type === 'finish') this.sawCompletion = true
    if (Scribe.NOISE.has(type)) return

    const text =
      (event.text as string) ??
      (event.delta as string) ??
      (event.errorText as string) ??
      ''

    // Reasoning and answer both read as the bee talking. Separating them in the
    // feed would ask a reader to care about a distinction the model makes for
    // its own reasons.
    if (type.includes('delta') || type === 'text' || type === 'reasoning') {
      this.buffer += text
      const old = Date.now() - this.lastFlush > 2500
      if (this.buffer.length > 400 || old) await this.flush()
      return
    }

    await this.flush()

    // What the turn cost, read rather than stringified.
    //
    // This frame was falling through to the default branch and being stored as
    // 800 characters of JSON, which was the only place a price existed: no
    // column on `queen_dispatch` carried a token count, so pricing one round
    // meant string-parsing one transcript row. The row is still written - the
    // feed keeps its line - and the numbers now also leave here as numbers.
    const usage = type === 'usage' ? Scribe.usageIn(event) : undefined
    if (usage) {
      this.tokens = usage
      await this.note(
        'usage',
        `${usage.inputTokens} in / ${usage.outputTokens} out tokens`,
      )
      return
    }

    // Tool traffic, rendered as a sentence rather than as a payload.
    //
    // A tool call is the most interesting thing in a turn and it arrived as
    // 2 KB of JSON with the command buried in it. What a reader wants is the
    // verb and the object: which tool, and what it was pointed at.
    if (type === 'tool-input-available') {
      const name = String(event.toolName ?? 'tool')
      const input = (event.input ?? {}) as Record<string, unknown>
      const what =
        (input.command as string) ??
        (input.path as string) ??
        (input.pattern as string) ??
        JSON.stringify(input)
      await this.note('tool', `${name}  ${String(what).slice(0, 600)}`)
      return
    }
    if (type === 'tool-output-available') {
      const out = (event.output ?? {}) as Record<string, unknown>
      const body = String(out.text ?? JSON.stringify(out))
      const lines = body.split('\n').length
      const head = body.slice(0, 400).trimEnd()
      // The head plus a count, not the whole thing. A grep can return a
      // thousand lines and none of them is the point; the point is that it
      // answered and roughly what it said.
      await this.note(
        'result',
        out.isError
          ? `FAILED  ${head}`
          : `${head}${lines > 8 ? `\n... ${lines} lines` : ''}`,
      )
      return
    }
    // The terminal error frame is the one a provider quota refusal arrives
    // in. Remembered for the ending to classify (#1301) and still noted: the
    // feed keeps the provider's own words, while the stored outcome keeps
    // only the closed classification - never the body, never the credential.
    if (type === 'error' && text.length > 0) this.streamError = text
    await this.note(type, text || JSON.stringify(event).slice(0, 800))
  }

  /**
   * The token counts in a usage frame, or nothing if it carries none.
   *
   * The shape is the one this server emits (chat-service.ts, `withUsageFrame`
   * -> {"type":"usage","usage":{"inputTokens":n,"outputTokens":n}}). The
   * unnested form is read too, because a provider stream that arrives without
   * that transform puts the same two fields at the top level.
   *
   * A frame with neither field returns nothing rather than a pair of zeros, so
   * it falls through and is stored whole - an unrecognised usage shape should
   * be visible in the feed, not silently priced at nothing.
   */
  private static usageIn(
    event: Record<string, unknown>,
  ): TokenUsage | undefined {
    const nested = event.usage
    const raw = (
      typeof nested === 'object' && nested !== null ? nested : event
    ) as Record<string, unknown>
    const input = Number(raw.inputTokens)
    const output = Number(raw.outputTokens)
    if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined
    return {
      inputTokens: Number.isFinite(input) ? input : 0,
      outputTokens: Number.isFinite(output) ? output : 0,
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const text = this.buffer
    this.buffer = ''
    this.lastFlush = Date.now()
    await this.note('say', text)
  }

  async note(kind: string, text: string): Promise<void> {
    this.seq += 1
    await this.pool
      .query(
        `INSERT INTO queen_transcript (conversation_id, seq, issue, kind, text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id, seq) DO NOTHING`,
        [this.conversationId, this.seq, this.issue, kind, text.slice(0, 8000)],
      )
      .catch(() => {
        // A transcript row that will not save must not take the bee down with
        // it. Watching is a convenience; the work is not.
      })
  }
}

/**
 * #1301. Z.ai business codes whose documented meaning is that a quota
 * window, a plan, or a balance is spent (docs.z.ai, "Errors": every one of
 * them arrives as HTTP 429).
 *
 * Coding Plan removed the synthetic USD start gate (#1300), which makes these
 * responses the authoritative stop signal: a bee that hits one cannot be
 * helped by another retry until the provider resets the window or the
 * operator pays. A generic worker failure hides that distinction, so the
 * dispatch boundary keeps it as a closed list.
 *
 * The transient 429s are deliberately NOT here. 1302 is a request-rate limit
 * and 1305 a temporary overload; both clear on their own, and closing a bee
 * as quota-stopped over either would retire work another retry could have
 * finished. `1113` is also matched at the transport
 * (lib/provider-error-classifier.ts) to stop SDK retries; this list is about
 * the ending, not the retry.
 */
const ZAI_QUOTA_EXHAUSTED_CODES: ReadonlySet<string> = new Set([
  '1113', // Insufficient balance or no resource package. Please recharge.
  '1308', // Usage limit reached for a window; resets at a stated time.
  '1309', // GLM Coding Plan package expired.
  '1310', // Weekly/monthly limit exhausted.
  '1311', // Subscription plan does not include the model.
  '1313', // Fair Usage Policy limit on the account.
  '1314', // Enterprise package expired.
  '1315', // Key limited to enterprise coding package scenarios.
  '1316', // 5-hour usage limit; no balance for extra usage.
  '1317', // 7-day usage limit; no balance for extra usage.
  '1318', // 5-hour usage limit; monthly spend limit reached.
  '1319', // 7-day usage limit; monthly spend limit reached.
  '1320', // 5-hour usage limit; monthly spend limit reached.
  '1321', // 7-day usage limit; monthly spend limit reached.
])

/**
 * The one ending a quota-stopped bee closes with (#1301).
 *
 * Provider and code only. The response body stays off the row - the message
 * prose names accounts, windows and reset times, and a credential never
 * belongs in a column at all - while the code is the documented, enumerable
 * token a person can look up, not a fragment of prose. Deterministic by
 * construction: the same failure closes with the same words every time.
 */
export function classifyQuotaExhaustion(
  provider: string,
  errorText: string,
): string | null {
  // No Z.ai state may be inferred about any other provider. Another provider
  // answering with the same code, or the same words, is answering for itself;
  // the Coding Plan window this classification names belongs to Z.ai alone.
  if (provider !== 'zai') return null
  for (const code of zaiCodesIn(errorText)) {
    if (ZAI_QUOTA_EXHAUSTED_CODES.has(code)) {
      // The label base is enumerated with every other outcome (#1360); the
      // code is the one closed parameter it may carry.
      return `${DISPATCH_OUTCOME_LABELS.providerQuotaExhausted} (zai code ${code})`
    }
  }
  return null
}

/**
 * The Z.ai business codes a turn's terminal error text carries.
 *
 * Only the two code-bearing shapes that can reach this module are read: the
 * `[1113] message` prefix this server's own transport builds
 * (lib/openrouter-fetch.ts), and the documented envelope field
 * `{"error":{"code":"1113",...}}` for when a raw body surfaces inside a
 * message. Bracket tokens are read first, then envelope tokens, each in text
 * order. No prose is matched and nothing else is parsed, so an undocumented
 * code - or digits that merely look like one - returns nothing and the ending
 * stays whatever it was (#1301, FR-002).
 */
function zaiCodesIn(errorText: string): string[] {
  const found: string[] = []
  const shapes = [/\[(\d{4})\]/g, /"code"\s*:\s*"(\d{4})"/g]
  for (const shape of shapes) {
    for (const match of errorText.matchAll(shape)) {
      const code = match[1]
      if (code !== undefined && !found.includes(code)) found.push(code)
    }
  }
  return found
}

/**
 * Read the stream to its end, and write down that it ended.
 *
 * The recording is the point, not the reading. A dispatch with no way to finish
 * holds its boundary for ever, and every issue overlapping those paths is
 * skipped for ever with it - which is exactly the defect this repository
 * already carries in `awaitingReview`, where a state that is not terminal
 * parked #1286 for five days and blocked everything it touched.
 *
 * A stream that ends badly still ends. The outcome is written on the error path
 * too, because a bee whose connection dropped is a bee that is not working, and
 * treating it as still running is how the boundary leaks.
 */
export async function drain(
  pool: Pool,
  response: Response,
  conversationId: string,
  issue: number,
  /**
   * Who ran this turn (#1301). Optional because every pre-existing caller
   * closes without it and must keep closing exactly as it did: with no
   * provider there is no quota classification, only the endings that have
   * always existed.
   */
  provider?: string,
): Promise<void> {
  let outcome: string = DISPATCH_OUTCOME_LABELS.finished
  const scribe = new Scribe(pool, conversationId, issue)
  try {
    const reader = response.body?.getReader()
    if (!reader) {
      outcome = DISPATCH_OUTCOME_LABELS.noStream
    } else {
      const decoder = new TextDecoder()
      let carry = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // The bytes are the point now. They were read and discarded here, which
        // is why a running bee had nothing anyone could look at.
        carry += decoder.decode(value, { stream: true })
        const lines = carry.split('\n')
        // The last fragment may be half a line; carry it to the next chunk
        // rather than parsing a truncated JSON object and losing the frame.
        carry = lines.pop() ?? ''
        for (const line of lines) await scribe.frame(line)
      }
    }
    await scribe.flush()
    logger.info('Queen worker turn finished', { conversationId, issue })
  } catch (error) {
    // #1360: the label is closed and the words are kept, in the two places a
    // reader already looks for them - the transcript row below (kind `error`,
    // bounded by that table's own 8000-character column) and the log line,
    // which is unbounded. `outcome` itself carries only the label.
    outcome = DISPATCH_OUTCOME_LABELS.streamEndedBadly
    const detail = `stream ended badly: ${
      error instanceof Error ? error.message : String(error)
    }`
    logger.warn('Queen worker stream ended badly', {
      conversationId,
      issue,
      error: detail,
    })
    await scribe.note('error', detail).catch(() => {})
  }
  // A quota-limited bee stops truthfully (#1301). Coding Plan removed the
  // synthetic USD gate, so the provider's documented quota response is the
  // authoritative stop signal, and a turn that reached its own end with one
  // as its last word closes as exactly that: a closed classification naming
  // the provider and the code, never the response body and never the
  // credential. Nothing else moves - the close mechanics, the refill signal,
  // the reaper and the board see the same transition they always did,
  // because a quota stop is an ending the turn really reached, not a failure
  // to end. The ended-badly path keeps its own outcome: a dropped connection
  // is a transport failure, not a documented provider answer.
  if (
    outcome === DISPATCH_OUTCOME_LABELS.finished &&
    provider !== undefined &&
    scribe.streamError !== undefined
  ) {
    const quota = classifyQuotaExhaustion(provider, scribe.streamError)
    if (quota !== null) outcome = quota
  }
  // #1360. A stream that closed without ever signalling completion ended in a
  // way nobody measured: something - a tool event, a truncation, anything -
  // arrived where a completion was expected, and the stream's own words about
  // why, if it had any, are in the transcript (every frame Scribe read is a
  // row there; nothing was dropped). The ending says the cause is NOT
  // DETERMINED. It does not say `provider refused`: that names a cause this
  // code never measured, and a guessed cause is worse than an admitted gap.
  //
  // Quota classification above runs first, because a documented Z.ai quota
  // code in a terminal error frame IS a measured cause and keeps its closed
  // classification even when the completion frame that should have followed
  // never came.
  if (outcome === DISPATCH_OUTCOME_LABELS.finished && !scribe.sawCompletion) {
    outcome = DISPATCH_OUTCOME_LABELS.endedUnexpectedly
    logger.warn('Queen worker turn ended without a completion frame', {
      conversationId,
      issue,
    })
    await scribe
      .note(
        'error',
        'stream closed without a completion frame; outcome recorded as cause undetermined',
      )
      .catch(() => {})
  }
  await closeDispatch(pool, issue, conversationId, outcome, scribe.tokens)
}

/** What one turn cost, as its own stream reported it. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * Who is told when a bee's ending actually landed (#1295).
 *
 * Installed by the tick loop and by nothing else: a deployment running
 * without the loop (local development, the app alongside) closes dispatches
 * exactly as before, because a completion with no listener is a normal
 * minute, not an error - there is simply nobody local to refill.
 *
 * It is a function, not a queue and not a policy. It may not dispatch, may
 * not retry and may not decide anything; it may only ASK for a round, and the
 * round it asks for is the same `runQueenTickOnce` the timer runs - lease,
 * fencing, `queend` and all. A hook that could start work of its own would be
 * a second supervisor wearing the first one's name.
 */
export type DurableCloseListener = (issue: number) => void

let durableCloseListener: DurableCloseListener | undefined

/** Install (or clear) the refill listener. The tick loop owns this. */
export function setDurableCloseListener(
  listener: DurableCloseListener | undefined,
): void {
  durableCloseListener = listener
}

/**
 * Write the ending, and if it cannot be written, say so out loud.
 *
 * This was `finishDispatch(...).catch(() => {})` - an empty catch on the ONLY
 * statement that ends a turn, inside a function that is itself `void`ed, so no
 * caller could see the failure either. What it produces is a phantom: the row
 * keeps `finished_at IS NULL` and `started = true`, which the board reads as
 * `running` (queen-tick.ts, `state: finished ? 'awaitingReview' : 'running'`),
 * so a bee that has stopped holds its boundary against every overlapping issue
 * until the 120-minute stall sweep reaps it - and reaping RELEASES the issue
 * for retry, which is how the same issue gets picked six times.
 *
 * One retry, then silence, because the stall reaper is the real backstop and a
 * loop here would hold a dead stream open. The first failure is the part that
 * matters: it is the only signal separating a phantom running bee from a real
 * one, and it used to produce no line anywhere.
 *
 * AND WHEN THE ENDING LANDS, IT SAYS SO (#1295). A durable running-to-finished
 * transition is the one moment a healthy paid key becomes free, and until this
 * the next eligible mission waited out the periodic tick for it. The listener
 * is fired only on a close that landed - first attempt or retry - and never on
 * the zero-row or failed paths, which keep the retry and the stall reaper as
 * their authority.
 */
export async function closeDispatch(
  pool: Pool,
  issue: number,
  conversationId: string,
  outcome: string,
  tokens?: TokenUsage,
): Promise<void> {
  // Whether the row reads finished on the database when this returns. That is
  // the ONLY condition under which the slot may be announced as free: a signal
  // about a row that still says `running` wakes a round that sees the bee as
  // in flight and skips the very work the signal promised.
  let closedDurably = false
  try {
    const closed = await finishDispatch(
      pool,
      issue,
      outcome,
      tokens,
      conversationId,
    )
    // AN UPDATE THAT CHANGED NOTHING IS NOT AN ENDING.
    //
    // It does not throw, so a `try` alone cannot see it: "I wrote the ending"
    // and "I matched no row" were the same answer, which is the shape of the
    // defect this function was written to end, one layer further out.
    //
    // Zero rows means either the row is not there yet - which the drain
    // handshake in `startTurn` now prevents - or another writer already closed
    // it. Both are worth a line: the bee is about to look like it is running.
    if (closed === 0) {
      logger.error('Queen dispatch ending matched no row', {
        issue,
        conversationId,
        outcome,
      })
    } else {
      closedDurably = true
    }
  } catch (error) {
    logger.error('Queen dispatch could not be closed', {
      issue,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
    // The retry decides. A retry that lands closes the row as surely as a
    // first attempt would have, so it signals too - a flaky database is no
    // reason to hand the slot back half an hour late. A retry that fails
    // returns 0 here, and 0 is also what a zero-row retry lands as, so one
    // comparison covers both not-durable outcomes.
    closedDurably =
      (await finishDispatch(pool, issue, outcome, tokens, conversationId).catch(
        () => 0,
      )) > 0
  }
  if (closedDurably && durableCloseListener) {
    // #1295: the row says finished, so the key this bee held is free and the
    // next eligible mission should not wait out the periodic tick for it.
    try {
      durableCloseListener(issue)
    } catch (error) {
      // A listener that breaks must not take the ending with it - the row is
      // closed, and that fact stands whatever the refill does.
      logger.warn('Queen refill signal failed', {
        issue,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export async function finishDispatch(
  pool: Pool,
  issue: number,
  outcome: string,
  tokens?: TokenUsage,
  /**
   * The turn this ending belongs to.
   *
   * Keyed by issue ALONE, a stream from a previous attempt that finishes late
   * closes the CURRENT attempt's row - and writes its token counts onto it,
   * straight through the COALESCE that exists to protect a price. The reaper
   * releases an issue for retry while the old container's stream may still be
   * alive, so this is routine rather than exotic; it is the six-turns-on-#1244
   * shape from the other side.
   *
   * Optional so the reaper, which legitimately closes a row whose conversation
   * is gone, can still call it.
   */
  conversationId?: string,
): Promise<number> {
  const result = await pool.query(
    // COALESCE, not assignment: a turn that ended without a usage frame must
    // not overwrite a price with NULL. Unknown and free are different answers,
    // and only one of them can be added up.
    `UPDATE queen_dispatch
        SET finished_at = now(), outcome = $2,
            input_tokens = COALESCE($3::bigint, input_tokens),
            output_tokens = COALESCE($4::bigint, output_tokens)
      WHERE issue = $1 AND finished_at IS NULL
        AND ($5::text IS NULL OR conversation_id::text = $5::text)`,
    [
      issue,
      // #1360: bounded by the named cap, not a bare literal - and callers
      // pass labels from DISPATCH_OUTCOME_LABELS, so this slice is a
      // backstop for a future caller, not the rule.
      boundedOutcome(outcome),
      tokens?.inputTokens ?? null,
      tokens?.outputTokens ?? null,
      conversationId ?? null,
    ],
  )
  return result.rowCount ?? 0
}

/**
 * Release dispatches that have stopped without saying so.
 *
 * A container redeployed mid-turn takes its streams with it, and nothing is
 * left to write the ending. Without a sweep those rows stay `started` and
 * unfinished for ever, and the issue they name can never be chosen again - a
 * permanent hole in the board, caused by a deploy.
 *
 * Returns what it reaped so the round can say so out loud. A reaper that works
 * silently is indistinguishable from one that is not running.
 */
/**
 * Everything in flight belonged to a process that no longer exists.
 *
 * Called once at startup. A container that has just booted is not running any
 * turn it dispatched before - the stream, the agent session and the process are
 * all gone with the old container - so a row still marked in-flight is a
 * phantom, and it holds its boundary against every overlapping issue until the
 * two-hour stall sweep eventually notices.
 *
 * Measured 2026-08-31: the board reported four bees running while the container
 * held ONE worktree and zero commits. Three of the four had been killed by
 * redeploys and the board had no way to know. A supervisor whose board says
 * "busy" about work that no longer exists will refuse real work on its behalf.
 */
export async function reapDispatchesFromPreviousBoot(
  pool: Pool,
): Promise<number[]> {
  const reaped = await pool.query(
    // The label base is enumerated with every other outcome (#1360); the
    // explanation is appended and the whole value stays under the cap.
    `UPDATE queen_dispatch
        SET finished_at = now(),
            outcome = '${DISPATCH_OUTCOME_LABELS.reapedAtBoot}: the container running this turn was replaced'
      WHERE started = true AND finished_at IS NULL
      RETURNING issue`,
  )
  return reaped.rows.map((r) => r.issue as number)
}

export async function reapStalledDispatches(
  pool: Pool,
  stallMinutes = 120,
): Promise<number[]> {
  const reaped = await pool.query(
    // The label base is enumerated with every other outcome (#1360); the
    // minute count is the one closed parameter it carries, and the whole
    // value stays under the cap for any sane bound.
    `UPDATE queen_dispatch
        SET finished_at = now(),
            outcome = '${DISPATCH_OUTCOME_LABELS.reapedStalled}: no completion within ' || $1 || ' minutes'
      WHERE started = true
        AND finished_at IS NULL
        AND dispatched_at < now() - make_interval(mins => $1)
      RETURNING issue`,
    [stallMinutes],
  )
  return reaped.rows.map((r) => r.issue as number)
}

export interface DispatchOutcome {
  started: boolean
  issue: number
  branch: string
  detail: string
  conversationId?: string
  /** Which provider key this bee took, so the next one takes a different one. */
  keyIndex?: number
}

/**
 * Choose already made; this starts the bee or says precisely why it did not.
 */
export async function dispatchBee(
  pool: Pool,
  issue: number,
  brief: string,
  ownedPaths: string[],
  takenKeyIndices: number[] = [],
  afterKeyIndex?: number,
  /**
   * What this bee will be judged by, recorded WITH the dispatch.
   *
   * On the row rather than re-read from the issue at review time, because the
   * issue can be edited while the bee works and the contract a worker was given
   * is the one it must be judged against. Editing an issue mid-flight to add a
   * criterion is how a bee fails for something it was never told.
   */
  criteria: string[] = [],
  criteriaSource = 'none',
): Promise<DispatchOutcome> {
  const branch = `queen-${issue}`

  const chosen = resolveWorkerProvider(takenKeyIndices, afterKeyIndex)
  if (chosen?.exhausted !== undefined) {
    // Not a missing credential: every key this deployment has is already
    // carrying a bee. Named separately because the fix is different - one more
    // key, not a first one.
    const keyVariable = configuredWorkerBaseUrl()
      ? GENERIC_WORKER_KEY_ENV
      : WORKER_PROVIDERS.find(
          (candidate) => candidate.provider === chosen.provider,
        )?.envVar
    const nextKey = keyVariable
      ? `${keyVariable}_${chosen.exhausted + 1}`
      : 'the matching provider variable'
    // A numbered pool someone began to configure and dispatch ignored is the
    // likeliest reason the swarm is narrower than the operator believes.
    const ignoredPools = configuredWorkerBaseUrl() ? endpointPoolProblems() : []
    const detail =
      `all ${chosen.exhausted} provider key(s) are already in use by bees in ` +
      `flight. Add another with ${nextKey} to widen the swarm.` +
      (ignoredPools.length > 0
        ? ` Not connected: ${ignoredPools.join('; ')}.`
        : '')
    logger.warn('Queen tick chose an issue but every key is busy', {
      issue,
      detail,
    })
    await recordDispatch(pool, issue, branch, false, detail, ownedPaths)
    return { started: false, issue, branch, detail }
  }
  if (!chosen) {
    const detail = missingProviderRefusal()
    logger.warn('Queen tick chose an issue but cannot dispatch', {
      issue,
      detail,
    })
    await recordDispatch(pool, issue, branch, false, detail, ownedPaths)
    return { started: false, issue, branch, detail }
  }

  const worktree = await prepareWorktree(issue)
  if (!worktree.ok) {
    await recordDispatch(
      pool,
      issue,
      branch,
      false,
      worktree.detail,
      ownedPaths,
    )
    return { started: false, issue, branch, detail: worktree.detail }
  }

  // The PROJECT inside the checkout, not the checkout root. A worktree is a
  // clone of the repository and this project is a directory inside it, so
  // standing at the root makes every project-relative boundary resolve one
  // level too high - the bee writes `<worktree>/docs/x.md` where the committer
  // looks for `trios/docs/x.md`, and its work reads as no work at all.
  // The PROJECT inside the checkout — which is not always a subdirectory.
  //
  // This was hardcoded to `/trios`, which is right for BrowserOS and wrong for
  // every other repository: aimed at a repo whose code sits at its root, the
  // bee would be handed a path that does not exist. TRIOS_REPO_SUBDIR names it,
  // and defaults to `trios` so the existing deployment behaves exactly as
  // before; set it empty for a repo whose project IS its root.
  const subdir = (process.env.TRIOS_REPO_SUBDIR ?? 'trios').replace(
    /^\/+|\/+$/g,
    '',
  )
  const workingDirectory = subdir ? `${worktree.path}/${subdir}` : worktree.path

  const conversationId = randomUUID()
  const turn = await startTurn(
    pool,
    issue,
    conversationId,
    brief,
    workingDirectory,
    chosen,
    ownedPaths,
  )
  const detail = turn.ok
    ? `${worktree.detail}; ${chosen.provider}/${chosen.model}` +
      (chosen.poolCount && chosen.poolCount > 1
        ? ` pool ${chosen.poolNumber}`
        : '') +
      (chosen.keyCount && chosen.keyCount > 1
        ? ` key ${((chosen.keyIndex ?? 0) % POOL_KEY_STRIDE) + 1}/${chosen.keyCount}`
        : '') +
      (chosen.laneCount && chosen.laneCount > 1
        ? ` lane ${(chosen.laneIndex ?? 0) + 1}/${chosen.laneCount}`
        : '') +
      (chosen.rehearsal ? ' (REHEARSAL - a recorded stream, not a model)' : '')
    : turn.detail

  await recordDispatch(
    pool,
    issue,
    branch,
    turn.ok,
    detail,
    ownedPaths,
    conversationId,
    chosen.keyIndex,
    criteria,
    criteriaSource,
    chosen.provider,
    chosen.model,
  )
  // ONLY NOW may the stream be read. Everything that reads the bee's output
  // eventually writes to the row above, and a writer that can outrun the row's
  // creation is a writer that silently updates nothing.
  turn.beginDrain?.()
  logger.info('Queen dispatch', { issue, branch, started: turn.ok, detail })
  return {
    started: turn.ok,
    issue,
    branch,
    detail,
    conversationId,
    keyIndex: chosen.keyIndex,
  }
}

export async function recordDispatch(
  pool: Pool,
  issue: number,
  branch: string,
  started: boolean,
  detail: string,
  ownedPaths: string[],
  conversationId?: string,
  keyIndex?: number,
  criteria: string[] = [],
  criteriaSource = 'none',
  /**
   * Who ran this bee and on what. Written because the daily spend cap could
   * not see a single cloud bee without them: `estimatedCostUSD` returns nil
   * unless a task carries BOTH, so every cloud dispatch summed to nothing and
   * the ceiling measured only the Mac app.
   */
  provider?: string,
  model?: string,
): Promise<void> {
  // #1360. A dispatch that never started is recorded with its ending, and the
  // ending is ONE WORD. It used to be the refusal detail verbatim, which is
  // how a raw payload reached the `outcome` column: `detail` can carry an
  // entire error body - an exception message has no length limit of its own -
  // and anything that groups or renders `outcome` then received a blob.
  // The full refusal words are not discarded: they move to (stay in) the
  // `detail` column ($4 below), which is where a reader looks for the reason,
  // and `outcome` says only that the dispatch refused to start.
  const outcome = started
    ? null
    : boundedOutcome(DISPATCH_OUTCOME_LABELS.refused)
  // Keep the attempt this one replaces.
  //
  // `queen_dispatch` is keyed by issue alone, so the upsert below overwrites
  // detail, conversation_id, dispatched_at, finished_at, outcome and key_index
  // in place: after a second dispatch of the same issue, attempt N-1 cannot be
  // recovered from this table at all - which key it took, how long it ran, or
  // why it ended. The transcript survives (queen_transcript is keyed by
  // conversation_id and seq) but nothing left points at the conversation.
  //
  // Stored as `to_jsonb(queen_dispatch)` rather than as a copied column list.
  // A second column list is the defect this repository keeps shipping: two
  // statements of one rule that agree until someone adds a column to one of
  // them. This captures whatever the row holds today and whatever is added to
  // it later, with no second place to edit.
  //
  // Separate from the upsert, and its failure does not stop the dispatch: on a
  // database that has not run this migration the archive is the part worth
  // losing, not the round.
  await pool
    .query(
      `INSERT INTO queen_dispatch_history (issue, snapshot)
       SELECT issue, to_jsonb(queen_dispatch) FROM queen_dispatch
        WHERE issue = $1`,
      [issue],
    )
    .catch((error) => {
      logger.warn('Queen dispatch history could not be kept', {
        issue,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  await pool.query(
    // A dispatch that never started is already over, so it is written with its
    // ending. Leaving `finished_at` null for a refusal would put it on the board
    // looking like work in progress - and "refused an hour ago" and "running for
    // an hour" are the two states an operator most needs to tell apart.
    //
    // #1360: the ending is the `refused` LABEL ($12), never the detail. The
    // reason a reader wants is the `detail` column ($4); `outcome` is the
    // short label everything else groups by.
    `INSERT INTO queen_dispatch
       (issue, branch, started, detail, owned_paths, conversation_id,
        dispatched_at, finished_at, outcome, key_index,
        criteria, criteria_source, provider, model)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(),
             CASE WHEN $3 THEN NULL ELSE now() END,
             CASE WHEN $3 THEN NULL ELSE $12 END,
             $7, $8::jsonb, $9, $10, $11)
     ON CONFLICT (issue) DO UPDATE
       SET branch = EXCLUDED.branch,
           started = EXCLUDED.started,
           detail = EXCLUDED.detail,
           owned_paths = EXCLUDED.owned_paths,
           conversation_id = EXCLUDED.conversation_id,
           dispatched_at = EXCLUDED.dispatched_at,
           finished_at = EXCLUDED.finished_at,
           outcome = EXCLUDED.outcome,
           key_index = EXCLUDED.key_index,
           -- A price belongs to the turn that spent it. Left in place it would
           -- be read as this attempt's cost: measured on a scratch database
           -- while this was being written, a second dispatch of #1244
           -- inherited the first one's 18308 input tokens and reported them
           -- again. The archived row above still holds them.
           input_tokens = NULL,
           output_tokens = NULL,
           criteria = EXCLUDED.criteria,
           criteria_source = EXCLUDED.criteria_source,
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           -- A dispatch that starts again is new work, so last turn's verdict
           -- no longer describes anything. Left in place it would exclude the
           -- row from review for good: the reviewer only looks at dispatches
           -- whose review_state IS NULL.
           review_state = CASE WHEN EXCLUDED.started THEN NULL
                               ELSE queen_dispatch.review_state END,
           review_note = CASE WHEN EXCLUDED.started THEN NULL
                              ELSE queen_dispatch.review_note END`,
    [
      issue,
      branch,
      started,
      detail,
      JSON.stringify(ownedPaths),
      conversationId ?? null,
      keyIndex ?? null,
      JSON.stringify(criteria),
      criteriaSource,
      provider ?? null,
      model ?? null,
      outcome,
    ],
  )
}
