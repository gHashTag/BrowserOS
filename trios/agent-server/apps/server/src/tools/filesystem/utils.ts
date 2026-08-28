import type { Dirent } from 'node:fs'
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { TOOL_LIMITS } from '@browseros/shared/constants/limits'
import { logger } from '../../lib/logger'
import { metrics } from '../../lib/metrics'

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const GREP_MAX_LINE_LENGTH = 500
export const DEFAULT_GREP_LIMIT = 100
export const DEFAULT_FIND_LIMIT = 1000
export const DEFAULT_LS_LIMIT = 500
export const DEFAULT_BASH_TIMEOUT = 120
export const MAX_GREP_FILE_SIZE = 2 * 1024 * 1024
export const MAX_READ_LINES = TOOL_LIMITS.FILESYSTEM_READ_MAX_LINES
export const MAX_READ_CHARS = TOOL_LIMITS.FILESYSTEM_READ_MAX_CHARS

/**
 * Refuses a path that leaves the tree these tools are allowed to touch.
 *
 * The shell tool can be dropped to an unprivileged account; these six cannot.
 * They run inside the server process, so their reach is the server's reach.
 * Measured 2026-08-28 on the deployed container, after the shell had already
 * been confined: `filesystem_read({path: "/proc/self/environ"})` returned the
 * server's environment - DATABASE_URL and TRIOS_API_TOKEN in it - and
 * `/etc/shadow` came back in full. Confining the shell had moved the hole
 * rather than closed it.
 *
 * Symlinks are why the check resolves rather than compares strings: a link
 * created inside the workspace, which an agent may certainly create, otherwise
 * points anywhere and passes a prefix test. For a path that does not exist yet
 * - a file about to be written - the nearest existing ancestor is resolved
 * instead, because that is the directory the write actually lands in.
 *
 * Unset TRIOS_FS_ROOT means no restriction, which is every local install: a
 * developer's agent legitimately reads outside its worktree, and turning this
 * on by default would break work that has nothing to do with a container.
 */
export function pathEscapesRoot(resolved: string): string | null {
  const root = process.env.TRIOS_FS_ROOT
  if (!root) return null

  const realRoot = realOrNearest(resolve(root))
  const realPath = realOrNearest(resolved)
  if (realPath === realRoot || realPath.startsWith(realRoot + sep)) return null

  // The message names the boundary rather than the file, so it reads as a
  // rule rather than as "this particular file is missing".
  return `Refused: ${resolved} is outside ${root}, which is the only tree these tools may touch.`
}

/**
 * The same rule, as a refusal.
 *
 * Throws rather than returning, because `executeWithMetrics` already turns a
 * rejection into `{ isError: true }` AND logs it - so a refused path is
 * visible in the server's log instead of only in the model's transcript, and
 * the call site stays one line with no branch of its own.
 */
export function assertWithinRoot(resolved: string): void {
  const refusal = pathEscapesRoot(resolved)
  if (refusal) throw new Error(refusal)
}

/// Resolves symlinks as far as the path exists, so a not-yet-created file is
/// judged by the directory it would be created in.
function realOrNearest(candidate: string): string {
  let current = candidate
  for (;;) {
    try {
      return realpathSync(current)
    } catch {
      const parent = dirname(current)
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return candidate
      current = parent
    }
  }
}

export interface FilesystemToolResult {
  text: string
  isError?: boolean
  images?: Array<{ data: string; mimeType: string }>
}

export interface TruncationResult {
  content: string
  truncated: boolean
  totalLines: number
  keptLines: number
}

export function truncateHead(
  content: string,
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES,
): TruncationResult {
  const lines = content.split('\n')
  const totalLines = lines.length
  const kept: string[] = []
  let bytes = 0

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1
    if (kept.length >= maxLines || bytes + lineBytes > maxBytes) {
      return {
        content: kept.join('\n'),
        truncated: true,
        totalLines,
        keptLines: kept.length,
      }
    }
    kept.push(line)
    bytes += lineBytes
  }

  return {
    content: kept.join('\n'),
    truncated: false,
    totalLines,
    keptLines: kept.length,
  }
}

export function truncateTail(
  content: string,
  maxLines = MAX_LINES,
  maxBytes = MAX_BYTES,
): TruncationResult {
  const lines = content.split('\n')
  const totalLines = lines.length
  const kept: string[] = []
  let bytes = 0

  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1
    if (kept.length >= maxLines || bytes + lineBytes > maxBytes) {
      return {
        content: kept.reverse().join('\n'),
        truncated: true,
        totalLines,
        keptLines: kept.length,
      }
    }
    kept.push(lines[i])
    bytes += lineBytes
  }

  return {
    content: kept.reverse().join('\n'),
    truncated: false,
    totalLines,
    keptLines: kept.length,
  }
}

export function truncateLine(
  line: string,
  maxChars = GREP_MAX_LINE_LENGTH,
): string {
  if (line.length <= maxChars) return line
  return `${line.slice(0, maxChars)} [truncated]`
}

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '.cache',
  '.turbo',
  '.output',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  '.angular',
  '.expo',
  '.yarn',
  '.pnp',
])

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.rar',
  '.7z',
  '.xz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
  '.flac',
  '.ogg',
  '.sqlite',
  '.db',
  '.wasm',
  '.class',
  '.pyc',
])

export function isBinaryPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return false
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
}

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
])

export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export async function* walkFiles(
  dir: string,
  baseDir: string,
): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name as string)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name as string)) continue
      yield* walkFiles(fullPath, baseDir)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield relative(baseDir, fullPath)
    }
  }
}

export function toModelOutput({
  output,
}: {
  output: unknown
  toolCallId: string
  input: unknown
}) {
  const result = output as FilesystemToolResult
  if (result.isError) {
    return { type: 'error-text' as const, value: result.text }
  }
  if (result.images?.length) {
    return {
      type: 'content' as const,
      value: [
        { type: 'text' as const, text: result.text },
        ...result.images.map((img) => ({
          type: 'media' as const,
          data: img.data,
          mediaType: img.mimeType,
        })),
      ],
    }
  }
  return { type: 'text' as const, value: result.text || 'Success' }
}

export function executeWithMetrics(
  toolName: string,
  fn: () => Promise<FilesystemToolResult>,
): Promise<FilesystemToolResult> {
  const startTime = performance.now()
  return fn().then(
    (result) => {
      metrics.log('tool_executed', {
        tool_name: toolName,
        duration_ms: Math.round(performance.now() - startTime),
        success: !result.isError,
        source: 'chat',
      })
      return result
    },
    (error) => {
      const errorText = error instanceof Error ? error.message : String(error)
      logger.error('Filesystem tool execution failed', {
        tool: toolName,
        error: errorText,
      })
      metrics.log('tool_executed', {
        tool_name: toolName,
        duration_ms: Math.round(performance.now() - startTime),
        success: false,
        error_message: errorText,
        source: 'chat',
      })
      return { text: errorText, isError: true }
    },
  )
}

export function stripBom(content: string): {
  content: string
  hasBom: boolean
} {
  if (content.charCodeAt(0) === 0xfeff) {
    return { content: content.slice(1), hasBom: true }
  }
  return { content, hasBom: false }
}

export function detectLineEnding(content: string): '\r\n' | '\r' | '\n' {
  const crlfIdx = content.indexOf('\r\n')
  if (crlfIdx !== -1) return '\r\n'
  const crIdx = content.indexOf('\r')
  if (crIdx !== -1) return '\r'
  return '\n'
}

export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function restoreLineEndings(
  content: string,
  lineEnding: string,
): string {
  if (lineEnding === '\n') return content
  return content.replace(/\n/g, lineEnding)
}
