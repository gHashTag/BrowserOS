/**
 * The repository's modules, for the public Queen field (t27.ai/#/queen).
 *
 * The field's unit of place is a code module (a source directory), and every
 * building's shape and paint is a pure function of the module's signature:
 * language, files, lines, functions, imports, exports, last touched. Until
 * this route existed the website shipped a scan made by the operator's loop
 * as a static file; a snapshot lies the moment a bee merges. This route
 * scans the checkout the server runs beside, caches the result for ten
 * minutes, and stamps it with the commit it read from .git, so the field
 * can say what it shows. It reads files and never runs git or anything else.
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { logger } from '../../lib/logger'

export interface ModuleRow {
  path: string
  depth: number
  language: string
  languages: Record<string, number>
  files: number
  lines: number
  functions: number
  imports: number
  exports: number
  /** the newest file mtime in the module, ISO; the server has no git */
  lastTouched: string | null
  /** filled by the website from the board's cards; the server does not know issues */
  openIssues: number[]
}

export interface ModulesSnapshot {
  repo: string
  commit: string | null
  generatedAt: string
  source: 'server scan'
  root: string
  totalModules: number
  droppedSmallest: number
  modules: ModuleRow[]
}

interface QueenPublicModulesDeps {
  roots?: () => string[]
  now?: () => Date
  ttlMs?: number
  maxModules?: number
}

const EXCLUDE = new Set([
  '.worktrees',
  'node_modules',
  'dist',
  'target',
  '_to_delete',
  'BR-OUTPUT',
  '.git',
  'build',
  'DerivedData',
  'Frameworks',
  'Frameworks-dev',
  'Frameworks-test',
  'coverage',
])
const LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.swift': 'swift',
  '.zig': 'zig',
  '.py': 'python',
  '.rs': 'rust',
  '.sh': 'shell',
  '.go': 'go',
}
const FUNC: Record<string, RegExp> = {
  typescript:
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(|^\s*(?:public|private|protected|static|async)?\s*\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm,
  javascript:
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(/gm,
  swift:
    /^\s*(?:public|private|internal|fileprivate|open|static|final|override|\s)*func\s+\w+/gm,
  zig: /^\s*(?:pub\s+)?(?:inline\s+)?fn\s+\w+/gm,
  python: /^\s*(?:async\s+)?def\s+\w+/gm,
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+/gm,
  shell: /^\s*(?:function\s+)?\w+\s*\(\)\s*\{/gm,
  go: /^\s*func\s+/gm,
}
const IMPORT =
  /^\s*(?:import\s|from\s+\S+\s+import|@import\s|#include\s|use\s+\w|const\s+\w+\s*=\s*@import|require\()/gm
const EXPORT = /^\s*(?:export\s|pub\s|public\s|module\.exports)/gm

function count(re: RegExp, text: string): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(text)) n += 1
  return n
}

function candidateRoots(): string[] {
  const workspace = process.env.WORKSPACE_DIR || '/workspace'
  return [
    // the container: the repository is cloned into the workspace volume
    `${workspace}/BrowserOS/trios`,
    // a laptop: the server runs from trios/agent-server, the project root is one up
    path.resolve(process.cwd(), '..'),
    process.cwd(),
  ]
}

async function readCommit(root: string): Promise<string | null> {
  try {
    const head = (
      await readFile(path.join(root, '.git', 'HEAD'), 'utf8')
    ).trim()
    if (!head.startsWith('ref:')) return head.slice(0, 9)
    const ref = head.slice(4).trim()
    try {
      return (await readFile(path.join(root, '.git', ref), 'utf8'))
        .trim()
        .slice(0, 9)
    } catch {
      const packed = await readFile(
        path.join(root, '.git', 'packed-refs'),
        'utf8',
      )
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`))
      return line ? line.slice(0, 9) : null
    }
  } catch {
    // a checkout without .git (a tarball) still scans; it just has no commit
    return null
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (
          EXCLUDE.has(e.name) ||
          e.name.startsWith('.') ||
          e.name.endsWith('.app')
        )
          continue
        stack.push(path.join(dir, e.name))
      } else if (e.isFile() && LANG[path.extname(e.name)]) {
        out.push(path.join(dir, e.name))
      }
    }
  }
  return out
}

/** The module a file belongs to: its directory, capped at depth 5. */
function moduleOf(root: string, file: string): string {
  const rel = path.relative(root, path.dirname(file))
  const segs = rel === '' ? [] : rel.split(path.sep)
  return segs.slice(0, 5).join('/') || '.'
}

/** A directory with fewer than three files merges into its parent. */
function merge(groups: Map<string, string[]>): Map<string, string[]> {
  let changed = true
  while (changed) {
    changed = false
    const keys = [...groups.keys()].sort(
      (a, b) => b.split('/').length - a.split('/').length,
    )
    for (const key of keys) {
      const files = groups.get(key) as string[]
      if (files.length < 3 && key.includes('/')) {
        const parent = key.slice(0, key.lastIndexOf('/'))
        groups.set(parent, [...(groups.get(parent) ?? []), ...files])
        groups.delete(key)
        changed = true
        break
      }
    }
  }
  return groups
}

export async function scanModules(
  root: string,
  maxModules: number,
  now: Date,
): Promise<ModulesSnapshot> {
  const files = await walk(root)
  const groups = new Map<string, string[]>()
  for (const f of files) {
    const key = moduleOf(root, f)
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const modules: ModuleRow[] = []
  for (const [key, list] of merge(groups)) {
    const languages: Record<string, number> = {}
    let lines = 0,
      functions = 0,
      imports = 0,
      exports = 0,
      newest = 0
    for (const f of list) {
      const lang = LANG[path.extname(f)]
      let text: string
      try {
        text = await readFile(f, 'utf8')
        const s = await stat(f)
        newest = Math.max(newest, s.mtimeMs)
      } catch {
        continue
      }
      const n = text.split('\n').length
      lines += n
      languages[lang] = (languages[lang] ?? 0) + n
      functions += count(FUNC[lang], text)
      imports += count(IMPORT, text)
      exports += count(EXPORT, text)
    }
    const language =
      Object.entries(languages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
    modules.push({
      path: key,
      depth: key === '.' ? 0 : key.split('/').length,
      language,
      languages,
      files: list.length,
      lines,
      functions,
      imports,
      exports,
      lastTouched: newest ? new Date(newest).toISOString() : null,
      openIssues: [],
    })
  }
  modules.sort((a, b) => b.lines - a.lines)
  const dropped = Math.max(0, modules.length - maxModules)
  const kept = modules
    .slice(0, maxModules)
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
  return {
    repo: 'gHashTag/trios',
    commit: await readCommit(root),
    generatedAt: now.toISOString(),
    source: 'server scan',
    root,
    totalModules: modules.length,
    droppedSmallest: dropped,
    modules: kept,
  }
}

export function createQueenPublicModulesRoute(
  deps: QueenPublicModulesDeps = {},
) {
  const roots = deps.roots ?? candidateRoots
  const now = deps.now ?? (() => new Date())
  const ttlMs = deps.ttlMs ?? 10 * 60 * 1000
  const maxModules = deps.maxModules ?? 120
  let cache: { at: number; snapshot: ModulesSnapshot } | null = null
  let inflight: Promise<ModulesSnapshot | null> | null = null

  const load = async (): Promise<ModulesSnapshot | null> => {
    for (const root of roots()) {
      try {
        const s = await stat(root)
        if (!s.isDirectory()) continue
      } catch {
        continue
      }
      try {
        const snapshot = await scanModules(root, maxModules, now())
        if (snapshot.modules.length > 0) return snapshot
      } catch (error) {
        logger.warn('Queen public modules scan failed', {
          root,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return null
  }

  return new Hono().get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const t = now().getTime()
    if (cache && t - cache.at < ttlMs) return c.json(cache.snapshot)
    if (!inflight)
      inflight = load().finally(() => {
        inflight = null
      })
    const snapshot = await inflight
    if (!snapshot) {
      if (cache) return c.json(cache.snapshot)
      return c.json({ error: 'No repository checkout to scan' }, 503)
    }
    cache = { at: t, snapshot }
    return c.json(snapshot)
  })
}
