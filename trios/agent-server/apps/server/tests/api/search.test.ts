import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FilesystemToolResult } from '../../src/tools/filesystem/utils'
import { createMemorySearchTool } from '../../src/tools/memory/search'

/**
 * Pins the contract of the memory search module exactly as it stands today.
 * Nothing here redesigns the subject; every assertion observes behaviour that
 * is already there, so the next change to the file has something to fail
 * against.
 *
 * createMemorySearchTool is the sole export of the module and the sole symbol
 * this suite covers; it is named in every test title below so a reader can
 * map assertions to exports. The tool it returns reads markdown files from
 * the memory directory under BROWSEROS_DIR, so each test points that variable
 * at a throwaway directory on local disk and restores the previous value
 * afterwards. The suite therefore needs no network, no database and no
 * container, and no export is left unexercised by a blocked dependency.
 */

const ORIGINAL_BROWSEROS_DIR = process.env.BROWSEROS_DIR

let memoryRoot: string
let exec: (keywords: string[]) => Promise<FilesystemToolResult>
let searchTool: ReturnType<typeof createMemorySearchTool>

/** The memory directory the tool will read: <BROWSEROS_DIR>/memory. */
function memoryDir(): string {
  return join(memoryRoot, 'memory')
}

/** Counts result blocks by their "(relevance: N.NN)" headers. */
function blockCount(text: string): number {
  return (text.match(/\(relevance: \d+\.\d{2}\)/g) ?? []).length
}

beforeEach(async () => {
  memoryRoot = join(
    tmpdir(),
    `memory-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  process.env.BROWSEROS_DIR = memoryRoot
  searchTool = createMemorySearchTool()
  // biome-ignore lint/suspicious/noExplicitAny: test helper reaching execute
  exec = (keywords: string[]) => (searchTool as any).execute({ keywords })
})

afterEach(async () => {
  if (ORIGINAL_BROWSEROS_DIR === undefined) {
    delete process.env.BROWSEROS_DIR
  } else {
    process.env.BROWSEROS_DIR = ORIGINAL_BROWSEROS_DIR
  }
  await rm(memoryRoot, { recursive: true, force: true })
})

describe('searchContract', () => {
  it('createMemorySearchTool: reports no memories when the memory directory does not exist', async () => {
    const result = await exec(['anything'])

    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('No memories found.')
  })

  it('createMemorySearchTool: reports no memories when the directory holds no markdown files', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(join(memoryDir(), 'notes.txt'), 'a plain text note')

    const result = await exec(['plain'])

    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('No memories found.')
  })

  it('createMemorySearchTool: echoes the keywords when nothing matches', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(join(memoryDir(), 'diary.md'), '## Tuesday\nwalked the dog')

    const result = await exec(['kangaroo', 'platypus'])

    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('No memories matching [kangaroo, platypus] found.')
  })

  it('createMemorySearchTool: formats hits as [file] (relevance: N.NN) blocks and repeats a bare line before its section', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(
      join(memoryDir(), 'sections.md'),
      '## Groceries\nmilk and eggs\n\n## Hardware\nscrewdriver and wrench',
    )

    const result = await exec(['screwdriver'])

    expect(result.isError).toBeUndefined()
    expect(result.text).not.toContain('No memories')
    // Two hits for one keyword: the bare line, then the section carrying it.
    expect(blockCount(result.text)).toBe(2)
    expect(result.text).toContain('\n\n---\n\n')
    // Each block names its source file and a two-decimal relevance score.
    expect(result.text).toMatch(
      /\[sections\.md\] \(relevance: \d+\.\d{2}\)\nscrewdriver and wrench/,
    )
    expect(result.text).toMatch(
      /\[sections\.md\] \(relevance: \d+\.\d{2}\)\n## Hardware\nscrewdriver and wrench/,
    )
    // The bare line outranks the section, and the unmatched section is absent.
    expect(result.text.indexOf('screwdriver and wrench')).toBeLessThan(
      result.text.indexOf('## Hardware'),
    )
    expect(result.text).not.toContain('milk and eggs')
  })

  it('createMemorySearchTool: merges hits from every keyword', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(join(memoryDir(), 'a.md'), 'the kangaroo jumps high')
    await writeFile(join(memoryDir(), 'b.md'), 'the platypus swims fast')

    const result = await exec(['kangaroo', 'platypus'])

    expect(result.text).toContain('[a.md]')
    expect(result.text).toContain('kangaroo')
    expect(result.text).toContain('[b.md]')
    expect(result.text).toContain('platypus')
  })

  it('createMemorySearchTool: searches only markdown files', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(join(memoryDir(), 'only.md'), '## Facts\nthe sky is blue')
    await writeFile(join(memoryDir(), 'extra.txt'), 'zebra facts live here')

    const result = await exec(['zebra'])

    expect(result.text).toBe('No memories matching [zebra] found.')
  })

  it('createMemorySearchTool: caps the result list at ten entries', async () => {
    await mkdir(memoryDir(), { recursive: true })
    for (let i = 1; i <= 12; i++) {
      const nn = String(i).padStart(2, '0')
      await writeFile(
        join(memoryDir(), `f${nn}.md`),
        `note xylophone-${nn} unique-${nn}`,
      )
    }

    const result = await exec(['xylophone'])

    expect(result.isError).toBeUndefined()
    expect(blockCount(result.text)).toBe(10)
  })

  it('createMemorySearchTool: returns one section block rather than repeating a line the section already carries', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(
      join(memoryDir(), 'dedup.md'),
      '## pangolin\na fairly long line of prose where the word pangolin sits far away from the beginning',
    )

    const result = await exec(['pangolin'])

    expect(result.isError).toBeUndefined()
    expect(blockCount(result.text)).toBe(1)
    expect(result.text).not.toContain('\n\n---\n\n')
    expect(result.text).toContain(
      '## pangolin\na fairly long line of prose where the word pangolin',
    )
  })

  it('createMemorySearchTool: rejects an empty keyword list and accepts a non-empty one', () => {
    // The schema on the returned tool is what the model's calls are validated
    // against: a call with no keywords never reaches execute.
    // biome-ignore lint/suspicious/noExplicitAny: reading the tool's schema
    const schema = (searchTool as any).inputSchema

    expect(schema.safeParse({ keywords: [] }).success).toBe(false)
    expect(schema.safeParse({ keywords: ['anything'] }).success).toBe(true)
  })

  it('createMemorySearchTool: renders a successful search to the model as text', async () => {
    await mkdir(memoryDir(), { recursive: true })
    await writeFile(join(memoryDir(), 'only.md'), 'the emu runs fast')

    const result = await exec(['emu'])
    // biome-ignore lint/suspicious/noExplicitAny: calling the tool's model rendering
    const rendered = (searchTool as any).toModelOutput({
      output: result,
      toolCallId: 'call_1',
      input: { keywords: ['emu'] },
    })

    expect(rendered).toEqual({ type: 'text', value: result.text })
  })
})
