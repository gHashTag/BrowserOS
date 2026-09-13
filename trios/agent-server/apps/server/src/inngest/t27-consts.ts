/**
 * Read the `pub const` declarations of a `.t27` file with the real compiler.
 *
 * The cards under `trios/agent-server/specs/` say in their header that nothing
 * below is parsed with a regex, and this module keeps that promise: the vendored
 * `t27_compiler.wasm` (same bytes as t27.ai serves, sha256 in `specs/PIN`)
 * lexes, parses and typechecks the file, and the constants are lifted from the
 * AST it returns. The reading is the one `gHashTag/trinity`
 * `apps/website/scripts/agents-from-specs.mjs` does for the site, ported here so
 * the scheduler and the site read a card the same way.
 */

export type ConstValue = string | number | boolean | string[] | number[]

export interface SpecConst {
  type: string
  value: ConstValue
  pub: boolean
}

export interface SpecAnalysis {
  consts: Record<string, SpecConst>
  typecheckOk: boolean
  errors: number
  /** Top-level tokens the parser dropped; a card must have none. */
  discarded: number
}

type WasmExports = {
  memory: WebAssembly.Memory
  t27_alloc: (len: number) => number
  t27_analyze: (ptr: number, len: number) => number
  t27_free: (ptr: number, len: number) => void
}

export type Analyze = (source: string) => SpecAnalysis

/**
 * The wasm hands strings back byte-per-char; a value that is entirely
 * <= 0xff is re-decoded as UTF-8 so a non-ASCII byte pair becomes one char.
 */
export function decodeBytes(text: string): string {
  for (const ch of text) if (ch.charCodeAt(0) > 255) return text
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(text, (c) => c.charCodeAt(0)),
    )
  } catch {
    return text
  }
}

interface AstNode {
  kind: string
  name?: string
  type?: string
  pub?: boolean
  value?: string
  children?: AstNode[]
}

function literalValue(raw: string): ConstValue {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  return JSON.parse(raw) as ConstValue
}

/** Every `const` of the module, from the AST. Throws on a duplicate name. */
export function constsOf(ast: AstNode | undefined): Record<string, SpecConst> {
  const out: Record<string, SpecConst> = {}
  for (const d of ast?.children ?? []) {
    if (d.kind !== 'ConstDecl' || !d.name) continue
    const expr = d.children?.[0]
    if (!expr) continue
    let value: ConstValue
    if (expr.kind === 'ExprLiteral') {
      value = literalValue(decodeBytes(expr.value ?? ''))
    } else if (expr.kind === 'ExprIdentifier') {
      value = JSON.parse(decodeBytes(expr.name ?? '')) as ConstValue
    } else {
      throw new Error(`${d.name}: unsupported expression kind ${expr.kind}`)
    }
    if (d.name in out) throw new Error(`duplicate constant ${d.name}`)
    out[d.name] = { type: d.type ?? '', value, pub: d.pub === true }
  }
  return out
}

/** Instantiate the compiler once; the returned function analyzes one source. */
export async function loadCompiler(wasmBytes: Uint8Array): Promise<Analyze> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {})
  const w = instance.exports as unknown as WasmExports
  return (source: string): SpecAnalysis => {
    const bytes = new TextEncoder().encode(source)
    const inPtr = w.t27_alloc(bytes.length)
    new Uint8Array(w.memory.buffer, inPtr, bytes.length).set(bytes)
    const outPtr = w.t27_analyze(inPtr, bytes.length)
    const len = new DataView(w.memory.buffer).getUint32(outPtr, true)
    const json = new TextDecoder().decode(
      new Uint8Array(w.memory.buffer, outPtr + 4, len),
    )
    w.t27_free(outPtr, 4 + len)
    const a = JSON.parse(json) as {
      ast?: AstNode
      typecheck?: { ok?: boolean; errorCount?: number; errors?: unknown[] }
      discarded?: unknown[]
      lexerDiscarded?: unknown[]
      swallowed?: unknown[]
    }
    return {
      consts: constsOf(a.ast),
      typecheckOk: a.typecheck?.ok === true,
      errors: a.typecheck?.errorCount ?? a.typecheck?.errors?.length ?? 0,
      discarded:
        (a.discarded?.length ?? 0) +
        (a.lexerDiscarded?.length ?? 0) +
        (a.swallowed?.length ?? 0),
    }
  }
}
