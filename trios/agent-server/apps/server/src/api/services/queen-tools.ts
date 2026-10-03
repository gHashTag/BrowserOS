/**
 * THE TOOLS WE ALREADY HAVE, handed to every bee at spawn.
 *
 * A bee that does not know a command exists writes a script for it. Three
 * programs called `tri` (t27's, trinity's and this repository's loop CLI) and
 * a dozen MCP servers already cover a lot of the jobs bees are given, and the
 * site documents every one of them as a .t27 card under
 * `apps/website/public/t27/files/specs/tools/` in gHashTag/trinity.
 *
 * WHERE THE INDEX COMES FROM. Not from this file. `queen-tool-index.json` is
 * GENERATED from the site's catalog by `bun queen-tools.ts generate --site
 * <trinity>/apps/website`, which reads it through the site's own
 * `readToolCatalog()` (the one reader that joins and verifies the part files)
 * rather than a copy of it here. The file records the catalog's commit and
 * content hash, and regenerating at the same commit is a no-op. Nothing in the
 * container reaches the network for it: the index ships with the image.
 *
 * WHAT THE QUEEN DOES WITH IT. The Queen is code, not a model: the review
 * reads the bee's tool calls from its transcript, counts them, names the
 * indexed commands among them, and lists any `missing-tool:` line the bee
 * wrote - the efficiency signal in the round's log.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One indexed command: the program it belongs to, its name and purpose. */
export interface ToolEntry {
  program: string
  name: string
  purpose: string
}

export interface ToolIndex {
  version: 1
  source: {
    repo: string
    path: string
    commit: string
    contentSha256: string
  }
  programs: Record<string, string>
  tools: ToolEntry[]
}

/** The committed, generated index beside this file. */
export const TOOL_INDEX_PATH = fileURLToPath(
  new URL('./queen-tool-index.json', import.meta.url),
)

/** A purpose is cut here: the index is one line per command, not the card. */
export const PURPOSE_MAX_CHARS = 64

/**
 * The programs the catalog documents, keyed `<repo> <family>`, with where each
 * one is. Said so a bee does not assume a program is installed where it runs.
 */
const PROGRAMS: Record<string, { key: string; where: string }> = {
  'gHashTag/BrowserOS tri-cli': {
    key: 'trios-tri',
    where:
      'trios tri - `trios/bin/tri` in a BrowserOS checkout (many commands reach the worker container and run only on the owner machine)',
  },
  'gHashTag/trinity tri-cli': {
    key: 'trinity-tri',
    where: 'trinity tri - the Zig CLI of gHashTag/trinity (`src/tri/main.zig`)',
  },
  'gHashTag/t27 tri-cli': {
    key: 't27-tri',
    where: 't27 tri - the Rust CLI of gHashTag/t27',
  },
  mcp: {
    key: 'mcp',
    where: 'MCP servers - available only where a client has them configured',
  },
}

let cached: ToolIndex | null | undefined

/** The committed index, or null when it is absent or unreadable. Never throws. */
export function loadToolIndex(path = TOOL_INDEX_PATH): ToolIndex | null {
  const memo = path === TOOL_INDEX_PATH && cached !== undefined
  if (memo) return cached ?? null
  let index: ToolIndex | null = null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ToolIndex
    const shaped = parsed?.version === 1 && Array.isArray(parsed.tools)
    index = shaped ? parsed : null
  } catch {
    index = null
  }
  const isDefault = path === TOOL_INDEX_PATH
  if (isDefault) cached = index
  return index
}

/** The brief's section: the rule, then the index, one line per command. */
export function toolIndexSection(index: ToolIndex | null): string[] {
  const rule = [
    '## Tools you already have',
    '',
    'Before you write a new script or do a multi-step job by hand, look the job up in this index. If a command does it, use that command. If none does and the job is one that will come up again, add the line `missing-tool: <what the tool would do>` under the criterion lines of your verdict block, so the Queen can see the gap. Not every program here is installed where you run: check with `command -v` before relying on one.',
    '',
  ]
  const none = index === null || index.tools.length === 0
  if (none) {
    return [
      ...rule,
      'The index was not shipped with this build, so there is nothing to look up; the `missing-tool:` rule still applies.',
      '',
    ]
  }
  const out = [
    ...rule,
    `Generated from the tool catalog of ${index.source.repo} at ${index.source.commit.slice(0, 12)} (${index.tools.length} commands).`,
  ]
  for (const [program, where] of Object.entries(index.programs)) {
    const mine = index.tools.filter((t) => t.program === program)
    const empty = mine.length === 0
    if (empty) continue
    out.push('', `${where}:`)
    for (const t of mine) out.push(`- ${t.name} - ${t.purpose}`)
  }
  out.push('')
  return out
}

/** What one job used, read from its transcript's `tool` rows. */
export interface ToolUse {
  /** Every tool call the bee made. */
  calls: number
  /** Calls per tool name (`bash`, `read`, ...), most used first. */
  byTool: Array<[string, number]>
  /** Indexed commands the bee ran through the shell, deduplicated, in first-use order. */
  indexed: string[]
}

/**
 * Count a job's tool calls. A transcript `tool` row is `<toolName>  <what>`
 * (queen-dispatch.ts); for a shell call `<what>` is the command line, which
 * is matched against the index's command names. Matching is by word: `tri
 * cast check` counts `tri cast`, and `t27c` alone counts nothing indexed.
 */
export function toolUse(rows: unknown, index: ToolIndex | null): ToolUse {
  const list = Array.isArray(rows) ? rows.map((r) => String(r ?? '')) : []
  const counts = new Map<string, number>()
  const names = (index?.tools ?? [])
    .flatMap((t) => t.name.split(', '))
    .sort((a, b) => b.length - a.length)
  const seen: string[] = []
  for (const row of list) {
    const gap = row.indexOf('  ')
    const tool = (gap < 0 ? row : row.slice(0, gap)).trim() || 'tool'
    counts.set(tool, (counts.get(tool) ?? 0) + 1)
    const what = gap < 0 ? '' : row.slice(gap + 2)
    for (const name of names) {
      const at = wordAt(what, name)
      const fresh = at && !seen.includes(name)
      if (fresh) seen.push(name)
    }
  }
  const byTool = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return { calls: list.length, byTool, indexed: seen }
}

function wordAt(text: string, name: string): boolean {
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+')
  return new RegExp(`(^|[\\s;&|(/])${escaped}(?=$|[\\s;&|)])`).test(text)
}

/** One sentence for the review note: what the job used and what it missed. */
export function toolUseSentence(use: ToolUse, missing: string[]): string {
  const tools = use.byTool.map(([t, n]) => `${t} ${n}`).join(', ')
  const head =
    use.calls === 0
      ? 'Tools: no tool call recorded'
      : `Tools: ${use.calls} call(s) (${tools})`
  const indexed =
    use.indexed.length > 0
      ? `; from the index: ${use.indexed.join(', ')}`
      : '; nothing from the index'
  const gaps = missing.length > 0 ? `; missing-tool: ${missing.join('; ')}` : ''
  return `${head}${indexed}${gaps}.`
}

// ---------------------------------------------------------------------------
// The generator. Run on a machine holding a gHashTag/trinity checkout; the
// container only ever reads its output.
// ---------------------------------------------------------------------------

/** The catalog's cards, as the site's readToolCatalog() returns them. */
interface Card {
  id?: string
  repo?: string
  family?: string
  command?: string
  enabled?: boolean
  name?: { en?: string }
  fields?: Record<string, unknown>
}

/** Build the index from the joined catalog. Pure, so it can be tested. */
export function indexFromCatalog(
  catalog: { contentSha256?: string; tools: Card[] },
  commit: string,
): ToolIndex {
  const tools: ToolEntry[] = []
  const programs: Record<string, string> = {}
  for (const card of catalog.tools) {
    const off = card.enabled === false
    if (off) continue
    const family = String(card.family ?? '')
    const isMcp = family === 'mcp'
    const program = PROGRAMS[isMcp ? 'mcp' : `${card.repo} ${family}`]
    const unknown = program === undefined
    if (unknown) continue
    programs[program.key] = program.where
    const name = isMcp
      ? String(card.id ?? '')
      : String(card.command ?? card.name?.en ?? card.id ?? '')
    const fields = card.fields ?? {}
    const purpose = oneLine(
      String(fields.WHEN_TO_USE ?? fields.ABOUT ?? fields.DESCRIPTION ?? ''),
    )
    tools.push({ program: program.key, name, purpose })
  }
  const order = Object.values(PROGRAMS).map((p) => p.key)
  // Aliases (`tri anom` and `tri anomalies`) share a purpose word for word;
  // one line names both, which keeps the index a third shorter.
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const merged: ToolEntry[] = []
  for (const t of tools) {
    const twin = merged.find(
      (m) =>
        m.program === t.program && m.purpose === t.purpose && t.purpose !== '',
    )
    const isAlias = twin !== undefined
    if (isAlias) twin.name = `${twin.name}, ${t.name}`
    else merged.push({ ...t })
  }
  tools.length = 0
  tools.push(...merged)
  tools.sort(
    (a, b) =>
      order.indexOf(a.program) - order.indexOf(b.program) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  const sortedPrograms = Object.fromEntries(
    order.filter((k) => k in programs).map((k) => [k, programs[k]]),
  )
  return {
    version: 1,
    source: {
      repo: 'gHashTag/trinity',
      path: 'apps/website/public/tools/spec-tools.json',
      commit,
      contentSha256: String(catalog.contentSha256 ?? ''),
    },
    programs: sortedPrograms,
    tools,
  }
}

function oneLine(text: string): string {
  // Some cards carry `\u2014` as six literal characters; show the character.
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
  const flat = decoded.replace(/\s+/g, ' ').trim()
  const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat
  const long = sentence.length > PURPOSE_MAX_CHARS
  return long
    ? `${sentence.slice(0, PURPOSE_MAX_CHARS - 3).trimEnd()}...`
    : sentence
}

/** Shapes that must never reach a prompt, whatever the catalog says. */
const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

async function generate(args: string[]): Promise<number> {
  const at = args.indexOf('--site')
  const site = at >= 0 ? resolve(args[at + 1] ?? '') : ''
  const reader = join(site, 'scripts', 'agents-from-specs.mjs')
  const noSite = site === '' || !existsSync(reader)
  if (noSite) {
    console.error(
      'usage: bun queen-tools.ts generate --site <gHashTag/trinity checkout>/apps/website',
    )
    return 2
  }
  // The commit that last changed the catalog, so a commit elsewhere in the
  // site does not regenerate an identical index.
  const commit = execFileSync(
    'git',
    ['-C', site, 'log', '-1', '--format=%H', '--', 'public/tools'],
    { encoding: 'utf8' },
  ).trim()
  const previous = loadToolIndex()
  const site_ = (await import(reader)) as {
    readToolCatalog: (root: string) => { contentSha256?: string; tools: Card[] }
  }
  const catalog = site_.readToolCatalog(site)
  const unchanged =
    previous !== null &&
    previous.source.commit === commit &&
    previous.source.contentSha256 === String(catalog.contentSha256 ?? '')
  if (unchanged) {
    console.log(`tool index: up to date at ${commit.slice(0, 12)}`)
    return 0
  }
  const index = indexFromCatalog(catalog, commit)
  const text = `${JSON.stringify(index, null, 1)}\n`
  const leaked = SECRET_SHAPES.some((re) => re.test(text))
  if (leaked) {
    console.error(
      'tool index: REFUSED - a secret-shaped string is in the catalog',
    )
    return 1
  }
  writeFileSync(TOOL_INDEX_PATH, text)
  console.log(
    `tool index: ${index.tools.length} commands from ${commit.slice(0, 12)} -> ${TOOL_INDEX_PATH}`,
  )
  return 0
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2)
  const generating = verb === 'generate'
  const showing = verb === 'show'
  if (generating) process.exit(await generate(rest))
  if (showing) {
    console.log(toolIndexSection(loadToolIndex()).join('\n'))
    process.exit(0)
  }
  console.error('usage: bun queen-tools.ts generate --site DIR | show')
  process.exit(2)
}
