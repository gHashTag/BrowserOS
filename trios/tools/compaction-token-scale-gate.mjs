#!/usr/bin/env node
/**
 * compaction-token-scale-gate.mjs
 *
 * Textual gate for the compaction module's token-scale discipline
 * (issue gHashTag/trios#1373).
 *
 * The compaction module measures one quantity — tokens — on two scales:
 *
 *   raw    : estimateTokens()/slidingWindow() scale, chars/3 per token
 *   budget : estimateTokensForThreshold() scale,
 *            raw * safetyMultiplier + fixedOverhead
 *
 * Budget-scale config fields (triggerThreshold, maxSummarizationInput,
 * minSummarizableTokens) must never be compared against, or handed to,
 * raw-scale helpers without going through toRawTokenBudget(). This gate
 * reads the sources as text and enforces that convention inside
 * compactMessages() so the mismatch cannot silently come back.
 *
 * Checkers (all scoped to the text between the markers
 * `async function compactMessages(` and
 * `export function createCompactionPrepareStep(` in compaction.ts,
 * with comments stripped and runs of whitespace collapsed, except the
 * utils-export checker which scans all of compaction/utils.ts):
 *
 *   bare-divisor         no bare characters-per-token divisor such as
 *                        `.length / 4` or `chars / 3` in compactMessages();
 *                        token counts come from estimateTokens()
 *   sliding-window-limit every `slidingWindow(` call site inside
 *                        compactMessages() receives a limit produced by
 *                        toRawTokenBudget() (inline, or an identifier bound
 *                        to `= toRawTokenBudget(` in the same function);
 *                        call sites are counted from the file, never
 *                        hard-coded
 *   scale-mixed-compare  no comparison operator applied directly against a
 *                        budget-scale config field inside compactMessages();
 *                        convert one side via toRawTokenBudget() first
 *   utils-export         compaction/utils.ts exports
 *                        `toRawTokenBudget(budgetTokens, config)`
 *
 * Usage:
 *   node trios/tools/compaction-token-scale-gate.mjs               # working tree
 *   node trios/tools/compaction-token-scale-gate.mjs --rev <rev>   # git revision
 *   node trios/tools/compaction-token-scale-gate.mjs --selftest    # prove checkers
 *
 * Node built-ins only: the gate deliberately reads the sources as text
 * (never imports them) so it runs in containers without installed
 * dependencies. Exit status: 0 clean, 1 violations or errors.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

// Canonical repository paths (as tracked by git at every revision).
const REL_COMPACTION = 'trios/agent-server/apps/server/src/agent/compaction.ts'
const REL_UTILS =
  'trios/agent-server/apps/server/src/agent/compaction/utils.ts'

// The same files relative to this script (script lives in trios/tools/).
const FS_COMPACTION = resolve(SCRIPT_DIR, '..', 'agent-server/apps/server/src/agent/compaction.ts')
const FS_UTILS = resolve(SCRIPT_DIR, '..', 'agent-server/apps/server/src/agent/compaction/utils.ts')

const REGION_START = 'async function compactMessages('
const REGION_END = 'export function createCompactionPrepareStep('

// Budget-scale ComputedConfig fields that must not meet a raw-scale operand.
const BUDGET_FIELDS =
  'triggerThreshold|maxSummarizationInput|minSummarizableTokens'

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * Replace comment bodies with spaces (newlines preserved) so that comment
 * text can never match a checker and line numbers stay exact. Handles line
 * comments, block comments, single/double-quoted strings and template
 * literals (including ${...} interpolation). Regex literals are not tracked
 * — none appear in the gated region; a false positive would be visible in
 * the gate output and trivially fixable.
 */
function stripCommentsKeepingLayout(src) {
  const out = src.split('')
  let i = 0
  const n = src.length
  let state = 'code' // code | line | block | sq | dq | tpl
  const tplStack = [] // tracks nesting of tpl -> ${ -> tpl ...
  while (i < n) {
    const c = src[i]
    const next = i + 1 < n ? src[i + 1] : ''
    switch (state) {
      case 'code': {
        if (c === '/' && next === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          state = 'line'
        } else if (c === '/' && next === '*') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          state = 'block'
        } else if (c === "'") {
          state = 'sq'
          i++
        } else if (c === '"') {
          state = 'dq'
          i++
        } else if (c === '`') {
          state = 'tpl'
          i++
        } else {
          i++
        }
        break
      }
      case 'line': {
        if (c === '\n') state = 'code'
        else out[i] = ' '
        i++
        break
      }
      case 'block': {
        if (c === '*' && next === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          state = 'code'
        } else {
          if (c !== '\n') out[i] = ' '
          i++
        }
        break
      }
      case 'sq': {
        if (c === '\\') i += 2
        else if (c === "'") {
          state = 'code'
          i++
        } else i++
        break
      }
      case 'dq': {
        if (c === '\\') i += 2
        else if (c === '"') {
          state = 'code'
          i++
        } else i++
        break
      }
      case 'tpl': {
        if (c === '\\') i += 2
        else if (c === '`') {
          state = tplStack.length ? 'tpl-code' : 'code'
          // closing of an interpolated template: return to interpolation
          if (!tplStack.length) i++
          else i++
        } else if (c === '$' && next === '{') {
          tplStack.push('interp')
          state = 'tpl-code'
          i += 2
        } else i++
        break
      }
      case 'tpl-code': {
        // inside ${ ... } — treat like code but remember the way back
        if (c === '}') {
          tplStack.pop()
          state = 'tpl'
          i++
        } else if (c === '/' && next === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          state = 'line-in-tpl'
        } else if (c === '/' && next === '*') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          state = 'block-in-tpl'
        } else if (c === "'") {
          state = 'sq-in-tpl'
          i++
        } else if (c === '"') {
          state = 'dq-in-tpl'
          i++
        } else if (c === '`') {
          tplStack.push('tpl')
          state = 'tpl'
          i++
        } else i++
        break
      }
      case 'line-in-tpl': {
        if (c === '\n') state = 'tpl-code'
        else out[i] = ' '
        i++
        break
      }
      case 'block-in-tpl': {
        if (c === '*' && next === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          state = 'tpl-code'
        } else {
          if (c !== '\n') out[i] = ' '
          i++
        }
        break
      }
      case 'sq-in-tpl':
      case 'dq-in-tpl': {
        const quote = state === 'sq-in-tpl' ? "'" : '"'
        if (c === '\\') i += 2
        else if (c === quote) {
          state = 'tpl-code'
          i++
        } else i++
        break
      }
      default: {
        state = 'code'
        i++
      }
    }
  }
  return out.join('')
}

/**
 * Collapse runs of whitespace to single spaces, returning the collapsed
 * text plus a map from collapsed index -> offset in the input text, so
 * matches can be reported against real line numbers.
 */
function collapseWhitespace(text) {
  let collapsed = ''
  const map = []
  let i = 0
  const n = text.length
  while (i < n) {
    if (/\s/.test(text[i])) {
      let j = i
      while (j < n && /\s/.test(text[j])) j++
      collapsed += ' '
      map.push(i)
      i = j
    } else {
      collapsed += text[i]
      map.push(i)
      i++
    }
  }
  return { collapsed, map }
}

function lineAtOffset(src, offset) {
  let line = 1
  for (let k = 0; k < offset && k < src.length; k++) {
    if (src[k] === '\n') line++
  }
  return line
}

/** Extract a call's argument text (between the parens) from collapsed text. */
function callArgumentText(text, openParenIndex) {
  let depth = 1
  let i = openParenIndex + 1
  const start = i
  while (i < text.length) {
    const c = text[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) break
    }
    i++
  }
  return text.slice(start, i)
}

/** Split argument text on top-level commas (string-aware). */
function splitTopLevelArgs(args) {
  const parts = []
  let cur = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (quote) {
      cur += c
      if (c === '\\') {
        if (i + 1 < args.length) cur += args[i + 1]
        i++
      } else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      cur += c
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
      cur += c
    } else if (c === ')' || c === ']' || c === '}') {
      depth--
      cur += c
    } else if (c === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

/**
 * All compaction.ts checkers. Input: full source text of compaction.ts.
 * Output: { violations: [{ line, message }], slidingWindowSites: number }.
 */
function checkCompactionRegion(src) {
  const violations = []
  const stripped = stripCommentsKeepingLayout(src)
  const { collapsed: full, map: fullMap } = collapseWhitespace(stripped)

  const start = full.indexOf(REGION_START)
  const end = start === -1 ? -1 : full.indexOf(REGION_END, start)
  if (start === -1 || end === -1) {
    violations.push({
      line: 1,
      message: `region markers not found — expected '${REGION_START}' followed by '${REGION_END}' in ${REL_COMPACTION}`,
    })
    return { violations, slidingWindowSites: 0 }
  }
  const region = full.slice(start, end)

  // Checker 1: bare characters-per-token divisors (`.length / 4`, `chars / 3`).
  const divisorRe = /(?:\.length|\bchars\b|\blength\b)\s*\/\s*\d/g
  let m
  while ((m = divisorRe.exec(region)) !== null) {
    const absIdx = fullMap[start + m.index]
    violations.push({
      line: lineAtOffset(src, absIdx),
      message: `bare characters-per-token divisor '${m[0].replace(/\s+/g, ' ')}' inside compactMessages() — token counts must come from estimateTokens(), not a length division`,
    })
  }

  // Checker 2: every slidingWindow( call site receives a toRawTokenBudget limit.
  let slidingWindowSites = 0
  const bindingReCache = new Map()
  let idx = region.indexOf('slidingWindow(')
  while (idx !== -1) {
    const prev = idx > 0 ? region[idx - 1] : ''
    if (/[A-Za-z0-9_$]/.test(prev)) {
      idx = region.indexOf('slidingWindow(', idx + 1)
      continue // part of a longer identifier, not a call
    }
    slidingWindowSites++
    const argText = callArgumentText(region, idx + 'slidingWindow('.length - 1)
    const args = splitTopLevelArgs(argText)
    const callLine = lineAtOffset(src, fullMap[start + idx])
    if (args.length < 2) {
      violations.push({
        line: callLine,
        message: `slidingWindow( call site #${slidingWindowSites} has no token limit argument`,
      })
    } else {
      const limit = args[1]
      let converted = limit.includes('toRawTokenBudget(')
      if (!converted && IDENT_RE.test(limit)) {
        let bindingRe = bindingReCache.get(limit)
        if (!bindingRe) {
          bindingRe = new RegExp(
            `\\b${escapeRegExp(limit)}\\s*=\\s*toRawTokenBudget\\(`,
          )
          bindingReCache.set(limit, bindingRe)
        }
        converted = bindingRe.test(region)
      }
      if (!converted) {
        violations.push({
          line: callLine,
          message: `slidingWindow( call site #${slidingWindowSites} receives '${limit}' — a raw-scale helper must be given a raw-token limit produced by toRawTokenBudget()`,
        })
      }
    }
    idx = region.indexOf('slidingWindow(', idx + 1)
  }

  // Checker 3: comparison operators applied directly to budget-scale fields.
  const mixedRe = new RegExp(`[<>]=?\\s*config\\.(${BUDGET_FIELDS})\\b`, 'g')
  while ((m = mixedRe.exec(region)) !== null) {
    const absIdx = fullMap[start + m.index]
    violations.push({
      line: lineAtOffset(src, absIdx),
      message: `scale-mixed comparison '${m[0].replace(/\s+/g, ' ')}' inside compactMessages() — config.${m[1]} is budget-scale; convert via toRawTokenBudget() before comparing against a raw estimateTokens() result`,
    })
  }

  return { violations, slidingWindowSites }
}

/**
 * Utils checker: toRawTokenBudget must be exported from compaction/utils.ts.
 * Input: full source text. Output: violation or null.
 */
function checkUtilsExport(src) {
  const exportRe = /export\s+function\s+toRawTokenBudget\s*\(/
  const m = exportRe.exec(src)
  if (m) return null
  const lines = src.split('\n')
  let line = 1
  for (let i = 0; i < lines.length; i++) {
    if (/function\s+toRawTokenBudget/.test(lines[i])) {
      line = i + 1
      break
    }
  }
  return {
    line,
    message:
      "toRawTokenBudget is missing from compaction/utils.ts — add 'export function toRawTokenBudget(budgetTokens, config)', the algebraic inverse of estimateTokensForThreshold",
  }
}

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

function gitRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: SCRIPT_DIR,
    encoding: 'utf8',
  }).trim()
}

function readFromRevision(root, rev, relPath) {
  return execFileSync('git', ['-C', root, 'show', `${rev}:${relPath}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
}

function loadSources(rev) {
  if (!rev) {
    return {
      compaction: readFileSync(FS_COMPACTION, 'utf8'),
      utils: readFileSync(FS_UTILS, 'utf8'),
    }
  }
  const root = gitRoot()
  return {
    compaction: readFromRevision(root, rev, REL_COMPACTION),
    utils: readFromRevision(root, rev, REL_UTILS),
  }
}

// ---------------------------------------------------------------------------
// Selftest — prove each checker fires on a defective fixture and stays quiet
// on a correct one, so a passing gate cannot be mistaken for a dead gate.
// ---------------------------------------------------------------------------

function selftest() {
  const defective = [
    "import { estimateTokens, slidingWindow } from './compaction/utils'",
    '',
    'async function compactMessages(',
    '  model,',
    '  messages,',
    '  config,',
    ') {',
    '  const summaryTokens = Math.ceil(summary.length / 4)',
    '  const summarizeTokens = estimateTokens(toSummarize)',
    '  if (summarizeTokens > config.maxSummarizationInput) {',
    '    toSummarize = slidingWindow(toSummarize, config.maxSummarizationInput)',
    '  }',
    '  return slidingWindow(',
    '    messages,',
    '    config.triggerThreshold,',
    '  )',
    '}',
    '',
    'export function createCompactionPrepareStep(',
  ].join('\n')

  const correct = [
    "import { estimateTokens, slidingWindow, toRawTokenBudget } from './compaction/utils'",
    '',
    'async function compactMessages(',
    '  model,',
    '  messages,',
    '  config,',
    ') {',
    '  const rawLimit = toRawTokenBudget(config.triggerThreshold, config)',
    '  const summaryTokens = estimateTokens([{ role: "user", content: summary }])',
    '  if (summaryTokens >= originalTokens) {',
    '    return slidingWindow(messages,',
    '      rawLimit)',
    '  }',
    '  // a comment mentioning slidingWindow( and .length / 4 must not count',
    '  return slidingWindow(messages, toRawTokenBudget(config.triggerThreshold, config))',
    '}',
    '',
    'export function createCompactionPrepareStep(',
  ].join('\n')

  const utilsDefective = [
    'export function estimateTokensForThreshold(messages, config) {',
    '  return 0',
    '}',
    'function toRawTokenBudget(budgetTokens, config) {',
    '  return 0',
    '}',
  ].join('\n')

  const utilsCorrect = [
    'export function toRawTokenBudget(budgetTokens, config) {',
    '  return Math.max(0, (budgetTokens - config.fixedOverhead) / config.safetyMultiplier)',
    '}',
  ].join('\n')

  const bad = checkCompactionRegion(defective)
  const good = checkCompactionRegion(correct)

  const pick = (name) =>
    bad.violations.filter((v) => v.message.startsWith(name))
  const results = [
    {
      name: 'bare-divisor',
      fired: pick('bare characters-per-token divisor'),
      quiet: checkCompactionRegion(correct).violations.filter((v) =>
        v.message.startsWith('bare characters-per-token divisor'),
      ).length === 0,
      expectLines: [8],
    },
    {
      name: 'sliding-window-limit',
      fired: pick('slidingWindow( call site'),
      quiet:
        checkCompactionRegion(correct).violations.filter((v) =>
          v.message.startsWith('slidingWindow( call site'),
        ).length === 0,
      expectLines: [11, 13],
    },
    {
      name: 'scale-mixed-compare',
      fired: pick('scale-mixed comparison'),
      quiet:
        checkCompactionRegion(correct).violations.filter((v) =>
          v.message.startsWith('scale-mixed comparison'),
        ).length === 0,
      expectLines: [10],
    },
  ]

  let ok = true
  for (const r of results) {
    const lines = r.fired.map((v) => v.line)
    const firedOk = r.fired.length > 0
    const linesOk =
      r.expectLines.length === lines.length &&
      r.expectLines.every((l, i) => l === lines[i])
    const pass = firedOk && linesOk && r.quiet
    if (!pass) ok = false
    const detail = pass
      ? `fired on defective fixture at line(s) ${lines.join(',')} and stayed quiet on the correct fixture`
      : `FAIL — fired=${JSON.stringify(lines)} quiet=${r.quiet} (expected lines ${r.expectLines.join(',')})`
    console.log(`selftest ${r.name.padEnd(20)}: ${detail}`)
  }

  const utilsBad = checkUtilsExport(utilsDefective)
  const utilsGood = checkUtilsExport(utilsCorrect)
  const utilsPass = utilsBad !== null && utilsGood === null
  if (!utilsPass) ok = false
  console.log(
    `selftest ${'utils-export'.padEnd(20)}: ${
      utilsPass
        ? `fired on defective fixture (line ${utilsBad.line}) and stayed quiet on the correct fixture`
        : 'FAIL — checker did not behave on fixtures'
    }`,
  )

  // Also prove the site counter counts from the text rather than a constant.
  const siteCountOk = bad.slidingWindowSites === 2 && good.slidingWindowSites === 2
  if (!siteCountOk) ok = false
  console.log(
    `selftest ${'site-count'.padEnd(20)}: ${
      siteCountOk
        ? 'counted 2 slidingWindow( call sites in each fixture from the text itself'
        : `FAIL — counted ${bad.slidingWindowSites}/${good.slidingWindowSites}, expected 2/2`
    }`,
  )

  console.log(
    `compaction-token-scale-gate: selftest ${ok ? 'OK' : 'FAILED'}`,
  )
  process.exit(ok ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    selftest()
    return
  }
  const revFlag = argv.indexOf('--rev')
  const rev = revFlag !== -1 ? argv[revFlag + 1] : null
  if (revFlag !== -1 && !rev) {
    console.error('compaction-token-scale-gate: --rev requires a revision argument')
    process.exit(1)
  }

  let sources
  try {
    sources = loadSources(rev)
  } catch (err) {
    console.error(
      `compaction-token-scale-gate: FAILED to read sources${rev ? ` at revision ${rev}` : ' from the working tree'}: ${err.message}`,
    )
    process.exit(1)
  }

  const where = rev ? `revision ${rev}` : 'working tree'
  const region = checkCompactionRegion(sources.compaction)
  const utilsViolation = checkUtilsExport(sources.utils)

  const violations = [
    ...region.violations.map((v) => ({ path: REL_COMPACTION, ...v })),
    ...(utilsViolation
      ? [{ path: REL_UTILS, ...utilsViolation }]
      : []),
  ]

  for (const v of violations) {
    console.log(`${v.path}:${v.line}: ${v.message}`)
  }

  if (violations.length > 0) {
    console.log(
      `compaction-token-scale-gate: FAILED — ${violations.length} violation(s) in ${where} (slidingWindow call sites checked: ${region.slidingWindowSites})`,
    )
    process.exit(1)
  }

  console.log(
    `compaction-token-scale-gate: OK — ${where} is clean; slidingWindow( call sites checked: ${region.slidingWindowSites} (all receive a toRawTokenBudget limit)`,
  )
  process.exit(0)
}

main()
