#!/usr/bin/env node
/**
 * T27-02 survey: which of the Queen tick's functions are pure, and can
 * therefore be generated from `.t27`, and which are io or prose and must
 * stay outside the ring.
 *
 * Reads `agent-server/apps/server/src/api/services/queen-tick.ts` (read
 * only - the source is never modified, FR-003) and writes
 * `docs/t27-02-tick-survey.md` next to this tool. Node standard library
 * only (FR-004). Run from the checkout root:
 *
 *   node trios/tools/tick-purity-survey.mjs
 *
 * Paths resolve from this file's own location, so the working directory
 * does not matter.
 *
 * METHOD, so a reader can disagree with a row without re-reading the file:
 *
 * - A "module-level function" is a `function`/`async function` declaration
 *   or a `const NAME = (...) =>` arrow whose declaration starts at column
 *   0. Declarations nested inside another function's body are not
 *   module-level and are excluded (they are listed in the output).
 * - Classification is by NAMED TOKENS found in the function body
 *   (FR-001). The token grammar is the IO_TOKENS table below plus two
 *   rules: a call to another module-level function this survey already
 *   classified io is itself an io token (the callee's clock, store or
 *   network reach is part of the caller's behaviour); and a function with
 *   no io token whose declared return type is `string`/`string[]` and
 *   whose body builds that string with `${...}` interpolation is `prose`
 *   - a sentence a person reads.
 * - A body with no classifying token at all is `pure` (FR-002). That is
 *   the default and the riskiest rule, so the count of rows decided that
 *   way is printed.
 * - Precedence when more than one applies: io, then prose, then pure.
 *
 * Token search is plain text over the body, comments included; the three
 * pure bodies contain none of the tokens even in their comments (checked
 * by hand when the grammar was written).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // <checkout>/trios/tools
const PROJECT = dirname(HERE) // <checkout>/trios
const CHECKOUT = dirname(PROJECT) // <checkout>
const SOURCE = join(
  PROJECT,
  'agent-server/apps/server/src/api/services/queen-tick.ts',
)
const OUTPUT = join(PROJECT, 'docs/t27-02-tick-survey.md')

/**
 * The io token grammar, in precedence order: the first category with a
 * match decides the row and names its token.
 */
const IO_TOKENS = [
  ['postgres', ['pool.query', 'pool.connect', 'new Pool']],
  ['network', ['fetch(']],
  ['child process', ['spawn(']],
  [
    'clock',
    ['Date.now()', 'new Date(', 'setInterval(', 'setTimeout(', 'clearInterval('],
  ],
  ['environment', ['process.env']],
  ['log', ['logger.']],
  [
    'io import',
    [
      'acquireQueenLease(',
      'releaseQueenLease(',
      'logLeaseOutcome(',
      'queenLeaseDatabaseUrl(',
      'dispatchBee(',
      'reapStalledDispatches(',
      'reapDispatchesFromPreviousBoot(',
      'committedFiles(',
      'committedFileCount(',
      'setDurableCloseListener(',
    ],
  ],
]

/**
 * A token as a whitespace-tolerant regular expression, because the source
 * wraps expressions across lines (for instance `pool` on one line and
 * `.query(` on the next). Dots and openers allow surrounding whitespace.
 */
function tokenRegex(token) {
  const pattern = token
    .split('')
    .map((ch) => {
      if (ch === '.') return '\\s*\\.\\s*'
      if (ch === '(') return '\\s*\\('
      if (ch === ' ') return '\\s+'
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(pattern)
}

const IO_COMPILED = IO_TOKENS.map(([category, tokens]) => [
  category,
  tokens.map((token) => ({ token, re: tokenRegex(token) })),
])

const FUNCTION_DECL = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
const ARROW_DECL = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/

/** Every function declared at column 0, with its full text and line. */
function collectModuleFunctions(lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fn = line.match(FUNCTION_DECL)
    if (fn) {
      let end = i
      // The body ends at a closing brace ALONE at column 0 - a line such
      // as `}> {` merely closes a multi-line return type.
      while (end < lines.length && !/^}\s*$/.test(lines[end])) end++
      if (end >= lines.length) throw new Error(`no closing brace for ${fn[1]}`)
      found.push({
        name: fn[1],
        line: i + 1,
        form: 'function',
        text: lines.slice(i, end + 1).join('\n'),
      })
      continue
    }
    const arrow = line.match(ARROW_DECL)
    if (arrow) {
      // An expression-bodied arrow runs to the next blank line.
      let end = i
      while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++
      const text = lines.slice(i, end + 1).join('\n')
      if (!/=>/.test(text)) continue // a const that is not a function
      found.push({ name: arrow[1], line: i + 1, form: 'arrow', text })
    }
  }
  return found
}

/**
 * Parameters and return type of one declaration, as written (whitespace
 * collapsed). Handles multi-line signatures, generics such as
 * `Promise<{...}>`, and arrow bodies (`: string =>`).
 */
function signatureOf(text) {
  const open = text.indexOf('(')
  if (open < 0) return { params: '', returnType: '' }
  let depth = 0
  let close = -1
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) return { params: '', returnType: '' }
  const params = collapse(text.slice(open + 1, close))
  // After the parameter list: either `: ReturnType {` (block body) or
  // `: ReturnType =>` (expression body).
  let paren = 0
  let brace = 0
  let angle = 0
  let start = -1
  for (let i = close + 1; i < text.length; i++) {
    const c = text[i]
    if (start < 0) {
      if (c === ':') start = i + 1
      continue
    }
    const flat = paren === 0 && brace === 0 && angle === 0
    if (flat && c === '=' && text[i + 1] === '>') {
      return { params, returnType: collapse(text.slice(start, i)) }
    }
    if (flat && c === '{') {
      return { params, returnType: collapse(text.slice(start, i)) }
    }
    if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === '{') brace++
    else if (c === '}') brace--
    else if (c === '<') angle++
    else if (c === '>') angle--
  }
  return { params, returnType: start < 0 ? '' : collapse(text.slice(start)) }
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').replace(/,\s*$/, '').trim()
}

/** The first template literal that interpolates, e.g. `# ${repo}#${issue}`. */
function templateSample(body) {
  let open = body.indexOf('`')
  while (open >= 0) {
    const close = body.indexOf('`', open + 1)
    if (close < 0) return null
    const segment = body.slice(open, close + 1)
    if (segment.includes('${')) {
      return segment.length > 26 ? segment.slice(0, 25) + '...`' : segment
    }
    open = body.indexOf('`', close + 1)
  }
  return null
}

/**
 * Classify one function body as `pure`, `io` or `prose` by the named
 * tokens it contains. `returnType` is the declared return type as written;
 * `ioCallees` is the set of module-level function names this survey has
 * already classified io by their own tokens (a call to one of them is an
 * io token in this body). Returns the class, the deciding token, and the
 * other tokens found, so a row can be argued with from the table alone.
 */
function classifyBody(body, returnType, ioCallees) {
  const perCategory = []
  for (const [category, tokens] of IO_COMPILED) {
    const matches = tokens
      .map(({ token, re }) => {
        const found = re.exec(body)
        return { token, at: found ? found.index : -1 }
      })
      .filter((m) => m.at >= 0)
      .sort((a, b) => a.at - b.at)
    if (matches.length > 0) perCategory.push({ category, matches })
  }
  if (perCategory.length > 0) {
    const deciding = perCategory[0].matches[0].token
    const also = perCategory
      .flatMap((c) => c.matches.map((m) => m.token))
      .filter((t) => t !== deciding)
    return { kind: 'io', deciding, also }
  }
  const callees = [...ioCallees]
    .map((name) => {
      const at = body.indexOf(`${name}(`)
      return { token: `${name}(`, at }
    })
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)
  if (callees.length > 0) {
    return {
      kind: 'io',
      deciding: callees[0].token,
      also: callees.slice(1).map((c) => c.token),
      via: 'call to a function this survey classifies io',
    }
  }
  if (/^string(\[\])?$/.test(returnType)) {
    const sample = templateSample(body)
    if (sample) {
      return {
        kind: 'prose',
        deciding: `${sample} (string return, sentences for a person)`,
        also: [],
      }
    }
  }
  return { kind: 'pure', deciding: '(no classifying token)', also: [] }
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|')
}

// ---- run ----

const source = readFileSync(SOURCE, 'utf8')
const lines = source.split('\n')
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
const functions = collectModuleFunctions(lines)
if (functions.length === 0) {
  console.error(`no module-level functions found in ${SOURCE}`)
  process.exit(1)
}

const withSignatures = functions.map((fn) => ({
  ...fn,
  ...signatureOf(fn.text),
}))

// Pass 1: direct tokens only. Pass 2: calls to functions pass 1 marked io.
const pass1 = withSignatures.map((fn) => ({
  fn,
  result: classifyBody(fn.text, fn.returnType, new Set()),
}))
const ioNames = new Set(
  pass1.filter((p) => p.result.kind === 'io').map((p) => p.fn.name),
)
const rows = pass1.map(({ fn, result }) => ({
  fn,
  result:
    result.kind === 'pure'
      ? classifyBody(fn.text, fn.returnType, ioNames)
      : result,
}))

const totals = { pure: 0, io: 0, prose: 0 }
for (const { result } of rows) totals[result.kind]++
const rowCount = rows.length
const sum = totals.pure + totals.io + totals.prose
if (sum !== rowCount) {
  console.error(`totals do not add up: ${sum} vs ${rowCount} rows`)
  process.exit(1)
}
const pureByAbsence = rows.filter(
  ({ result }) =>
    result.kind === 'pure' && result.deciding === '(no classifying token)',
)
const sha = createHash('sha256').update(source).digest('hex').slice(0, 12)
const sourceRel = relative(CHECKOUT, SOURCE)
const outputRel = relative(CHECKOUT, OUTPUT)

const table = rows
  .map(({ fn, result }) => {
    let token = cell(result.deciding)
    const extras = []
    if (result.via) extras.push(result.via)
    if (result.also && result.also.length > 0) {
      extras.push(`also: ${result.also.map(cell).join(', ')}`)
    }
    if (extras.length > 0) token += ` (${extras.join('; ')})`
    return `| ${fn.name} | ${fn.line} | ${result.kind} | ${token} |`
  })
  .join('\n')

const signatureRows = rows
  .filter(({ result }) => result.kind === 'pure')
  .map(({ fn }) => `| ${fn.name} | ${cell(fn.params)} | ${cell(fn.returnType)} |`)
  .join('\n')
const pureNames = rows
  .filter(({ result }) => result.kind === 'pure')
  .map(({ fn }) => fn.name)

const grammarRows = IO_TOKENS.map(
  ([category, tokens]) =>
    `| ${category} | ${tokens.map((t) => '`' + t + '`').join(', ')} |`,
).join('\n')

const doc = `# T27-02: the tick's purity survey

Every function declared at module level in
\`${sourceRel}\` (${lines.length} lines, sha256 ${sha}),
classified \`pure\`, \`io\` or \`prose\` so the ring migration can be mechanical:
\`pure\` means arguments in, value out - no I/O, no clock, no string
formatting for a person - and only those can be generated from \`.t27\`.
\`io\` touches the pool, the network or the file system. \`prose\` returns a
sentence a person reads.

Produced by \`trios/tools/tick-purity-survey.mjs\` (Node standard library
only). The script reads the source read-only and writes only this file.

## Method

- Module level means the declaration starts at column 0:
  \`function\`, \`async function\`, their \`export\` forms, and
  \`const NAME = (...) =>\` arrows. ${rowCount} functions were found.
- Classification is by NAMED TOKENS in the function body (FR-001). The io
  tokens, in precedence order (the first category with a match decides the
  row and names its token):

| category | tokens |
| --- | --- |
${grammarRows}

- Two further rules:
  1. A call to another module-level function this survey classifies io is
     itself an io token - the callee's clock, store or network reach is
     part of the caller's behaviour.
  2. A function with no io token whose declared return type is
     \`string\`/\`string[]\` and whose body builds that string with
     \`\${...}\` interpolation is \`prose\`.
- A body containing no classifying token is \`pure\` (FR-002). That default
  is the rule most likely to be wrong, so its count is stated below.
- Precedence: io > prose > pure.
- Token search is plain text over the body, comments included; the three
  pure bodies contain none of the tokens even in their comments.

## The table

| function | line | class | deciding token |
| --- | --- | --- | --- |
${table}

## Totals

- pure: ${totals.pure}
- io: ${totals.io}
- prose: ${totals.prose}
- rows: ${rowCount} (${totals.pure} + ${totals.io} + ${totals.prose} = ${sum})
- decided \`pure\` by the absence of any classifying token: ${pureByAbsence.length}
  (${pureNames.join(', ')}) - the set most likely to be wrong.

## The pure set, signatures as written

These are the \`.t27\` candidates: the argument and return shapes below are
what a \`.t27\` signature has to say. Whitespace is collapsed; types are
otherwise exactly as written in the source.

| function | parameters | return |
| --- | --- | --- |
${signatureRows}

\`stateOfDispatch\` and \`parseVerdictBlock\` are the two the issue names as
pure by inspection; \`boundaryPathsOf\` is the third this survey finds. It
is a deliberate re-implementation of the Swift boundary rule so the board
can be drawn without spawning \`queend\` - a parser of its argument and
nothing else.

## Excluded by rule, and why

- Function declarations NESTED inside another function's body are not
  module-level and are not rows: \`stop\` (line 620, inside
  \`startLeaseHeartbeat\`), \`settle\` (1582) and \`turn\` (1589, both inside
  \`createRoundGate\`), \`round\` (1701) and \`handover\` (1724, both inside
  \`startQueenTick\`), plus the object methods of the \`RoundGate\` return
  value. The ring question applies to them through their enclosing rows.
- Interfaces are types, not functions: \`SpecVerdict\`, \`QueendChoice\`,
  \`LeaseWatch\`, \`ReviewRound\`, \`RoundGate\`.
- Module-level consts that are not functions: \`LEASE_NAME\`,
  \`ZERO_UUID\`, \`LEASE_TTL_SECONDS\`, \`HEARTBEAT_SECONDS\`,
  \`ISSUE_PAGE_SIZE\`, \`ISSUE_PAGE_CAP\`, \`heartbeats\` (a Set), \`timer\`.

## Rows a reader may want to argue with

- \`boardTask\` (io) - the only row decided by the callee rule. Its body's
  single non-pure act is calling \`isoSeconds(\`, which is io by
  \`new Date(\`. Pass the formatted timestamps in as arguments and
  \`boardTask\` becomes pure: it is otherwise a shape builder over its
  arguments, and an obvious \`.t27\` candidate once the clock is removed.
- \`isoSeconds\` (io) - \`new Date(value)\` parses its argument rather than
  reading the clock, but \`new Date(\` is one of the issue's own deciding
  tokens, and a \`.t27\` signature cannot assume JS date semantics either,
  so it stays io.
- \`report\` (io) - its body is prose assembly, but it ends in
  \`pool.query\`; the store outranks the sentences. The sentences are the
  prose half of a function the ring cannot own.
- \`createRoundGate\` (io) - no pool, no network, no clock of its own; the
  deciding token is \`logger.\` alone. It is a scheduler's queue, not a
  decision, so it does not belong in the ring either way.
- \`refillOnBeeCompletion\` (io) - a pure-shaped body whose one act
  registers a durable listener (\`setDurableCloseListener(\`).
- \`boundaryStrays\` (io) - cited on \`logger.\`, its only direct io token,
  but the load-bearing reason is one step down: it calls \`askQueend(\`,
  which spawns the policy binary. The callee rule found that for
  \`boardTask\`; here it is masked by the weaker direct token.
- \`startLeaseHeartbeat\` (io) - cited on \`setInterval(\`; the same body
  also renews the lease through \`acquireQueenLease(\` and logs through
  \`logger.\`.
`

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, doc, 'utf8')

console.log(`source: ${sourceRel} (${lines.length} lines, sha256 ${sha})`)
console.log(`module-level functions found: ${rowCount}`)
console.log(
  `totals: pure ${totals.pure}, io ${totals.io}, prose ${totals.prose}` +
    ` (sum ${sum} = rows ${rowCount})`,
)
console.log(
  `pure by absence of a classifying token: ${pureByAbsence.length}` +
    ` (${pureNames.join(', ')})`,
)
console.log(`wrote: ${outputRel}`)
