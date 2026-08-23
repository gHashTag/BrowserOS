export const meta = {
  name: 'status-board',
  description: 'Measure the real state of trios and the T27 MVP, verify every green claim adversarially, and return the numbers the dashboard renders',
  whenToUse: 'At the start or end of every Queen iteration, and any time someone asks "what is the status". Produces measured numbers, never restated ones.',
  phases: [
    { title: 'Measure', detail: 'one agent per domain, each running commands' },
    { title: 'Challenge', detail: 'adversarial check of every green or done claim' },
    { title: 'Synthesize', detail: 'one status object plus the delta since last time' },
  ],
}

const ROOT = '/Users/playra/BrowserOS/trios'
const T27C = `${ROOT}/.trinity/t27c-build/release/t27c`

const RULES = `
HARD RULES - breaking any invalidates your result:
- READ-ONLY on ${ROOT} and /Users/playra/t27. Several agents work here at once.
- Do NOT run: git add/commit/push/checkout/stash, ./build.sh, or anything that
  launches or kills the trios app.
- Do NOT run 'make check', 'make dev', 'make release' or 'make cassettes'.
  They take 30+ minutes, mutate real source files, and collide with other
  agents. Read the most recent result instead of producing a new one.
  Cheap targets you MAY run: make t27-lowering, make t27-rings, make chain,
  make make-dollars.
- Do NOT run anything that can raise a macOS keychain dialog.
- Scratch under /tmp/status-<your-domain>/ only. English only.

EVIDENCE DISCIPLINE - the whole point of this workflow.
Label every number with how you got it:
  OBSERVED   - you ran a command just now. Quote it and its output.
  STALE      - you read it from a log or file written earlier. Say how old.
  UNKNOWN    - you could not establish it. A respectable answer; use it.
A number you cannot attribute to a command does not go in the report. This
repository's recurring defect is a hand-copied list that nobody re-measured,
so a restated figure is worse than a missing one.
`

const DOMAINS = [
  {
    key: 'gate',
    title: 'Build and gate health',
    brief: `Did the last full gate pass, and how long ago? Find the newest
/tmp/check*.log and read its final REAL_EXIT line and mtime. Then RUN the cheap
gates yourself: make t27-lowering, make t27-rings, make chain. Report each
one's exit status and its [OK]/[FAIL] line. Also count compiler warnings from
the newest log and note the file count it measured.`,
  },
  {
    key: 'queen',
    title: 'Queen board and workers',
    brief: `Read ${ROOT}/.trinity/state/queen_delegation.json. Count tasks by
state. List every task in queued/running/awaitingReview with its issue number,
ownedPaths and sendBacks - those are the boundaries currently held, which is
the number that decides whether new work can start. Check whether any worker
process is alive (pgrep -f 'queen-[0-9]'). Probe the agent server:
curl -s -m 3 http://127.0.0.1:9105/health. Check the menu-bar app is alive
(pgrep -f 'trios.app/Contents/MacOS/trios') - that is an invariant of this
project, so report it explicitly either way.`,
  },
  {
    key: 'specs',
    title: 'T27 specs and lowering',
    brief: `For every .t27 under ${ROOT}/rings, excluding any path containing
.worktrees or .claude: count functions declared in the spec, run
${T27C} gen-rust on it, count 'pub fn' emitted and count 'unimplemented!'.
Report totals and name any spec where declared != emitted or stubs > 0.
A spec that loses functions is losing them SILENTLY - gen-rust exits 0 with
empty stderr - so the count is the only signal. Also report how many specs
there are in total, so a shrinking corpus is visible.`,
  },
  {
    key: 'mvp',
    title: 'MVP definition of done',
    brief: `The plan is /Users/playra/Downloads/Queen_T27_MVP_Architecture.md,
section 23, five sections totalling 29 criteria. The last audit found 0 done,
17 partial, 12 not-started. Do NOT re-audit all 29 - that is a separate,
expensive workflow. Instead check whether anything has MOVED since: look for
newly created files, new make targets, new commands on ${T27C} --help, or new
gates that would flip a specific criterion. Report only criteria whose status
you believe changed, with the evidence, and say explicitly if nothing moved.`,
  },
  {
    key: 'git',
    title: 'Repository and release state',
    brief: `In ${ROOT}: current branch, whether it is ahead/behind origin, and
the last five commit subjects. Count uncommitted files, and say which of them
look like another agent's in-flight work rather than abandoned edits. Do the
same for the submodule at rings/RUST-13/trios-mesh, and report whether the
parent's gitlink matches the submodule's HEAD - a mismatch means a fresh clone
gets different specs from what we are testing. Check for leftover harness
damage: any zero-byte file under rings/, any file containing
checkSelftestKeychainDoor, and whether /tmp/trios_harness.lock is held.`,
  },
]

phase('Measure')

const MEASURE = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'headline', 'metrics', 'problems', 'unmeasured'],
  properties: {
    domain: { type: 'string' },
    headline: { type: 'string', description: 'One sentence a person reads first' },
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value', 'evidence_class', 'command'],
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
          evidence_class: { type: 'string', enum: ['OBSERVED', 'STALE', 'UNKNOWN'] },
          command: { type: 'string', description: 'The exact command, or where the stale number was read from' },
          health: { type: 'string', enum: ['good', 'warn', 'bad', 'neutral'] },
        },
      },
    },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'evidence', 'owner'],
        properties: {
          what: { type: 'string' },
          evidence: { type: 'string' },
          owner: { type: 'string', enum: ['trios', 't27', 'trinity', 'operator', 'unknown'] },
        },
      },
    },
    unmeasured: { type: 'string', description: 'What you could not establish, and why. Be blunt.' },
  },
}

// pipeline, not parallel: each domain's green claims are challenged as soon as
// that domain finishes, rather than every domain waiting for the slowest.
const measured = await pipeline(
  DOMAINS,
  d => agent(
    `Measure one domain of the trios status board by running commands.

${RULES}

YOUR DOMAIN: ${d.title}

${d.brief}

Return metrics with a health colour so the dashboard can render them, every
problem you found with its owner, and an honest list of what you could not
measure. Prefer fewer, well-attributed numbers over many guessed ones.`,
    { label: `measure:${d.key}`, phase: 'Measure', schema: MEASURE }
  ),
  (m, d) => {
    if (!m) return null
    const greens = (m.metrics || []).filter(x => x.health === 'good' && x.evidence_class === 'OBSERVED')
    if (!greens.length) return { domain: d.key, measure: m, challenges: [] }
    return parallel(greens.map(g => () =>
      agent(
        `Try to REFUTE one green status claim. Default to refuted=true when unsure:
a status board that reports green wrongly is worse than one that reports
nothing, because it stops people looking.

${RULES}

CLAIM: ${g.label} = ${g.value} (health: good)
THEIR COMMAND: ${g.command}

Re-run that command yourself and quote what you got. Then ask:
1. Does the command actually establish the claim, or something weaker nearby?
   "The gate exited 0" is not "the gate measured the current tree" if the log
   is hours old and files have changed since.
2. Is it green because it passed, or green because it SKIPPED? A target that
   prints [SKIP] and exits 0 is not passing. This repository has shipped that
   exact defect.
3. Would it still be green if another agent's work landed a minute ago?`,
        {
          label: `challenge:${(g.label || '').slice(0, 28)}`, phase: 'Challenge',
          schema: {
            type: 'object', additionalProperties: false,
            required: ['label', 'refuted', 'corrected_value', 'reason'],
            properties: {
              label: { type: 'string' },
              refuted: { type: 'boolean' },
              corrected_value: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        }
      )
    )).then(cs => ({ domain: d.key, measure: m, challenges: cs.filter(Boolean) }))
  }
)

const domains = measured.filter(Boolean)
for (const d of domains) {
  const bad = d.challenges.filter(c => c.refuted).length
  log(`${d.domain}: ${d.measure.metrics.length} metrics, ${d.measure.problems.length} problems, ${bad} green claims refuted`)
}

phase('Synthesize')

const summary = await agent(
  `Turn measured domains into one status the operator reads in ten seconds.

${RULES}

MEASUREMENTS AND CHALLENGES:
${JSON.stringify(domains, null, 2)}

Previous board, for the delta - read it if it exists:
${ROOT}/.trinity/dashboard/STATUS.md

Produce markdown:
1. **One line** — is the system healthy, and what is the single most important
   thing that is not.
2. **What changed since the previous board** — new, fixed, regressed. If the
   previous board does not exist, say so and skip.
3. **Numbers** — grouped by domain, each with its evidence class. Mark any
   green that was refuted with its corrected value, not the original.
4. **Problems, by owner** — trios (we can fix), t27 (off-limits, report only),
   trinity, operator (needs a decision).
5. **Not measured** — everything, with the reason.

No praise, no hedging, no emoji. A number without a command does not appear.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  domains: domains.map(d => ({
    domain: d.domain,
    headline: d.measure.headline,
    metrics: d.measure.metrics,
    problems: d.measure.problems,
    unmeasured: d.measure.unmeasured,
    refuted: d.challenges.filter(c => c.refuted).map(c => ({ label: c.label, corrected: c.corrected_value, why: c.reason })),
  })),
  summary,
}
