import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import {
  assertWithinRoot,
  executeWithMetrics,
  type FilesystemToolResult,
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  MAX_READ_CHARS,
  MAX_READ_LINES,
  toModelOutput,
} from './utils'

const TOOL_NAME = 'filesystem_read'

function createImageResult(
  path: string,
  ext: string,
  buffer: Buffer<ArrayBuffer>,
) {
  const mimeType = IMAGE_MIME_TYPES[ext] || 'application/octet-stream'
  return {
    text: `Image: ${path} (${buffer.byteLength} bytes)`,
    images: [{ data: buffer.toString('base64'), mimeType }],
  }
}

function getStartIndex(offset?: number): number {
  return offset ? Math.max(0, offset - 1) : 0
}

function getSelectedLines(
  allLines: string[],
  startIdx: number,
  limit?: number,
): string[] {
  if (limit !== undefined && limit <= 0) {
    throw new Error('filesystem_read limit must be greater than 0.')
  }

  // Clamp to the maximum so agents do not fail entire turns when a skill or
  // user request touches a large file. The continuation hint in the result
  // tells the caller how to paginate.
  const effectiveLimit =
    limit === undefined ? MAX_READ_LINES : Math.min(limit, MAX_READ_LINES)

  const remaining = allLines.slice(startIdx)
  if (effectiveLimit < remaining.length) {
    return remaining.slice(0, effectiveLimit)
  }
  return remaining
}

/** Room kept for the continuation note, so the answer can always carry one. */
const CONTINUATION_NOTE_BUDGET = 160

function formatReadResult(args: {
  selected: string[]
  startIdx: number
  totalLines: number
  limit?: number
}): FilesystemToolResult {
  const startLineNum = args.startIdx + 1
  const endLineNum = args.startIdx + args.selected.length
  const width = String(endLineNum).length
  const numbered = args.selected
    .map((line, i) => {
      const num = String(args.startIdx + i + 1).padStart(width)
      return `${num} | ${line}`
    })
    .join('\n')

  let text = numbered
  if (endLineNum < args.totalLines) {
    text += `\n\n(${args.totalLines - endLineNum} more lines in file. Use offset=${endLineNum + 1} to continue reading.)`
  } else if (args.startIdx > 0) {
    text += `\n\n(Showing lines ${startLineNum}-${endLineNum} of ${args.totalLines})`
  }

  // A REFUSAL COSTS A PROVIDER CALL, AND THE PROVIDER IS THE CEILING.
  //
  // This used to throw, and the agent's only recovery was to ask again with a
  // smaller range. Measured on the running deployment 2026-09-20: 18 of 19
  // filesystem tool failures in one window were this refusal, on files of 159
  // and 500 lines - ordinary specs. Each one spent a round trip on the same
  // endpoint that was answering `Service temporarily overloaded` 76 times in
  // the same window, and returned no content at all.
  //
  // So it returns what FITS, and says exactly where to continue. The caller
  // gets content on the first call and a correct `offset` for the rest, which
  // is what it would have asked for on the second.
  if (text.length > MAX_READ_CHARS) {
    const kept: string[] = []
    let used = 0
    for (let i = 0; i < args.selected.length; i++) {
      const rendered = `${String(args.startIdx + i + 1).padStart(width)} | ${args.selected[i]}\n`
      // Leave room for the continuation note, which is what makes the answer
      // usable rather than merely shorter.
      if (used + rendered.length > MAX_READ_CHARS - CONTINUATION_NOTE_BUDGET)
        break
      used += rendered.length
      kept.push(args.selected[i])
    }
    if (kept.length === 0) {
      // One line longer than the whole budget. Nothing to hand back, and the
      // caller needs to hear why rather than get an empty answer.
      throw new Error(
        `Line ${startLineNum} alone is ${args.selected[0]?.length ?? 0} characters, above the ${MAX_READ_CHARS}-character limit for filesystem_read. Use filesystem_grep to find what you need in it.`,
      )
    }
    const cutAt = args.startIdx + kept.length
    const shortened = kept
      .map(
        (line, i) =>
          `${String(args.startIdx + i + 1).padStart(width)} | ${line}`,
      )
      .join('\n')
    return {
      text:
        shortened +
        `\n\n(${args.totalLines - cutAt} more lines in file; this answer was ` +
        `cut at the ${MAX_READ_CHARS}-character limit. Use offset=${cutAt + 1} to continue reading.)`,
    }
  }

  return { text }
}

export function createReadTool(cwd: string) {
  return tool({
    description: `Read a file from the filesystem. Returns text content with line numbers, or image data for image files. Text reads are limited to ${MAX_READ_LINES} lines and ${MAX_READ_CHARS} characters per call. Use offset and limit to paginate through large files.`,
    inputSchema: z.object({
      path: z
        .string()
        .describe('File path (relative to working directory or absolute)'),
      offset: z
        .number()
        .optional()
        .describe('Starting line number (1-indexed)'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of lines to read'),
    }),
    execute: (params) =>
      executeWithMetrics(TOOL_NAME, async () => {
        const resolved = resolve(cwd, params.path)
        assertWithinRoot(resolved)
        const ext = extname(resolved).toLowerCase()

        if (IMAGE_EXTENSIONS.has(ext)) {
          const buffer = await readFile(resolved)
          return createImageResult(params.path, ext, buffer)
        }

        const content = await readFile(resolved, 'utf-8')
        const allLines = content.split('\n')
        const totalLines = allLines.length

        const startIdx = getStartIndex(params.offset)
        if (startIdx >= totalLines) {
          return {
            text: `File has ${totalLines} lines. Offset ${params.offset} is beyond end of file.`,
          }
        }

        const selected = getSelectedLines(allLines, startIdx, params.limit)
        return formatReadResult({
          selected,
          startIdx,
          totalLines,
          limit: params.limit,
        })
      }),
    toModelOutput,
  })
}
