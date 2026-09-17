import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createQueenPublicModulesRoute } from '../../src/api/routes/queen-public-modules'

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'queen-modules-'))
  const put = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  await put(
    'server/src/lib/a.ts',
    'import x from "y"\nexport function one() {}\nexport const two = () => 1\n',
  )
  await put('server/src/lib/b.ts', 'import z from "w"\nfunction three() {}\n')
  await put('server/src/lib/c.ts', 'export const four = 4\n')
  await put('tools/only.py', 'def five():\n    pass\n')
  await put('node_modules/dep/index.js', 'module.exports = 1\n')
  await put('.git/HEAD', 'ref: refs/heads/main\n')
  await put('.git/refs/heads/main', 'abcdef1234567890\n')
  return root
}

describe('GET /queen/public-modules', () => {
  it('scans the checkout into modules with the signature the field draws from', async () => {
    const root = await fixture()
    const now = new Date('2026-09-04T16:00:00Z')
    const response = await createQueenPublicModulesRoute({
      roots: () => [root],
      now: () => now,
    }).request('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.source).toBe('server scan')
    expect(body.commit).toBe('abcdef123')
    expect(body.generatedAt).toBe('2026-09-04T16:00:00.000Z')
    const paths = body.modules.map((m: { path: string }) => m.path)
    expect(paths).toContain('server/src/lib')
    expect(paths.some((p: string) => p.includes('node_modules'))).toBe(false)
    const lib = body.modules.find(
      (m: { path: string }) => m.path === 'server/src/lib',
    )
    expect(lib.language).toBe('typescript')
    expect(lib.files).toBe(3)
    // lines = newline count + 1 per file (a trailing newline counts), the same rule as the loop scanner
    expect(lib.lines).toBe(9)
    expect(lib.functions).toBe(3)
    expect(lib.imports).toBe(2)
    expect(lib.exports).toBe(3)
    expect(lib.openIssues).toEqual([])
    expect(typeof lib.lastTouched).toBe('string')
    // a directory with fewer than three files merges into its parent
    expect(paths).toContain('tools')
  })

  it('answers 503 with no checkout and serves the cache within the ttl', async () => {
    const none = await createQueenPublicModulesRoute({
      roots: () => ['/nonexistent/queen'],
    }).request('/')
    expect(none.status).toBe(503)
    const root = await fixture()
    let t = Date.parse('2026-09-04T16:00:00Z')
    const route = createQueenPublicModulesRoute({
      roots: () => [root],
      now: () => new Date(t),
      ttlMs: 60_000,
    })
    const first = await (await route.request('/')).json()
    t += 30_000
    const second = await (await route.request('/')).json()
    expect(second.generatedAt).toBe(first.generatedAt)
  })
})
