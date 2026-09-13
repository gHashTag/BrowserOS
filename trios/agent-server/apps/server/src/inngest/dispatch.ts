/**
 * The two things a function does when it fires, against the GitHub REST API:
 *
 * - `workflow-dispatch` a cron card whose HOST is github-actions
 *   (`POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches`, ref =
 *   the repository's default branch, read from the API, never assumed);
 * - open the Queen issue for a skill card (`SKILL_DISPATCH = "queen-issue"`),
 *   reusing an OPEN issue with the same title (`SKILL_ISSUE_DEDUP`).
 *
 * `fetch` is injected so the tests run these against a fake API.
 */

import type { SchedulerSpec, SkillCard } from './spec-catalog'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GitHubApi {
  fetch: FetchLike
  token: string | undefined
  apiBase?: string
}

const API = 'https://api.github.com'

function headers(api: GitHubApi, extra: Record<string, string> = {}) {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 't27-queen-scheduler',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  }
  if (api.token) h.Authorization = `Bearer ${api.token}`
  return h
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    detail: string,
  ) {
    super(`${status} ${url}: ${detail}`)
  }
}

async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return text.slice(0, 300)
}

export async function defaultBranch(
  api: GitHubApi,
  owner: string,
  repo: string,
): Promise<string> {
  const url = `${api.apiBase ?? API}/repos/${owner}/${repo}`
  const res = await api.fetch(url, { headers: headers(api) })
  if (!res.ok) throw new GitHubError(res.status, url, await detailOf(res))
  const body = (await res.json()) as { default_branch?: string }
  if (!body.default_branch)
    throw new GitHubError(res.status, url, 'no default_branch in response')
  return body.default_branch
}

export interface DispatchResult {
  ok: true
  status: number
  ref: string
  workflow: string
  repo: string
}

/** Fire one workflow. Throws (so Inngest retries) on anything but 204. */
export async function dispatchWorkflow(
  api: GitHubApi,
  opts: {
    owner: string
    repo: string
    workflowFile: string
    inputs?: Record<string, string>
  },
): Promise<DispatchResult> {
  if (!api.token)
    throw new Error(
      `no GitHub token: cannot dispatch ${opts.repo}/${opts.workflowFile}`,
    )
  const ref = await defaultBranch(api, opts.owner, opts.repo)
  const url = `${api.apiBase ?? API}/repos/${opts.owner}/${opts.repo}/actions/workflows/${encodeURIComponent(
    opts.workflowFile,
  )}/dispatches`
  const res = await api.fetch(url, {
    method: 'POST',
    headers: headers(api, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref, inputs: opts.inputs ?? {} }),
  })
  if (res.status !== 204)
    throw new GitHubError(res.status, url, await detailOf(res))
  return {
    ok: true,
    status: res.status,
    ref,
    workflow: opts.workflowFile,
    repo: `${opts.owner}/${opts.repo}`,
  }
}

export interface IssueResult {
  number: number
  url: string
  reused: boolean
  repo: string
}

/**
 * The body the Queen's bees can accept: it carries the two sections the brief
 * requires (`SKILL_ISSUE_SECTIONS`) and names the card so a bee reads the spec.
 */
export function skillIssueBody(
  card: SkillCard,
  s: SchedulerSpec,
  ctx: { triggeredBy: string; eventId?: string },
): string {
  const [criteria, boundary] = s.skillIssueSections
  const specs = card.specs.length
    ? card.specs.map((x) => `- \`${x}\``).join('\n')
    : '- (none declared)'
  return [
    `Skill \`${card.id}\` requested by the Queen's scheduler (Inngest app \`${s.appId}\`).`,
    '',
    `- Card: \`${card.file}\` on t27.ai (#/skills?skill=${card.id})`,
    `- Body: \`${card.source}\` in \`${s.githubOwner}/${card.repo}\``,
    `- Command: ${card.command ? `\`${card.command}\`` : '(none declared)'}`,
    `- Timeout: ${card.timeoutMin} min`,
    `- Triggered by: ${ctx.triggeredBy}${ctx.eventId ? ` (event ${ctx.eventId})` : ''}`,
    '',
    `Summary: ${card.summary}`,
    '',
    'Declared specs:',
    specs,
    '',
    criteria,
    `- The skill body \`${card.source}\` was followed and its own success criteria are met.`,
    '- Every measured value in the closing comment carries a command, a sha and a date.',
    `- The run finished within ${card.timeoutMin} minutes or says why it did not.`,
    '',
    boundary,
    `- Only what \`${card.id}\` describes; no unrequested adjacent work.`,
    '- No `--bless`, no ratchet raised, no merge without approval.',
    `- Tags: ${card.tags.join(', ') || '(none)'}`,
  ].join('\n')
}

/** Open the issue or reuse an open one with the same title. */
export async function openOrReuseIssue(
  api: GitHubApi,
  opts: {
    owner: string
    repo: string
    title: string
    body: string
    label: string
  },
): Promise<IssueResult> {
  if (!api.token)
    throw new Error(
      `no GitHub token: cannot open "${opts.title}" in ${opts.repo}`,
    )
  const base = `${api.apiBase ?? API}/repos/${opts.owner}/${opts.repo}`
  const repo = `${opts.owner}/${opts.repo}`
  const listUrl = `${base}/issues?state=open&labels=${encodeURIComponent(opts.label)}&per_page=100`
  const listRes = await api.fetch(listUrl, { headers: headers(api) })
  if (!listRes.ok)
    throw new GitHubError(listRes.status, listUrl, await detailOf(listRes))
  const open = (await listRes.json()) as Array<{
    number: number
    title: string
    html_url: string
    pull_request?: unknown
  }>
  const same = open.find((i) => !i.pull_request && i.title === opts.title)
  if (same)
    return { number: same.number, url: same.html_url, reused: true, repo }

  const createUrl = `${base}/issues`
  const res = await api.fetch(createUrl, {
    method: 'POST',
    headers: headers(api, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      title: opts.title,
      body: opts.body,
      labels: [opts.label],
    }),
  })
  if (res.status !== 201)
    throw new GitHubError(res.status, createUrl, await detailOf(res))
  const created = (await res.json()) as { number: number; html_url: string }
  return { number: created.number, url: created.html_url, reused: false, repo }
}
