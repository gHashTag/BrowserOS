export const meta = {
  name: 'loop-improvement-cycle',
  description: 'One full iteration of the TriOS continuous-improvement loop: measure live, hunt anomalies from six lenses, refute them, group survivors by owned file, repair in parallel, verify adversarially, then record what was learned',
  whenToUse: 'Every iteration of the autonomous improvement loop, or whenever `tri cycle-anom` reports anomalies nobody has acted on. args = { iteration, depth: "shallow"|"deep", skipRepair: bool, quiesced: bool }. Requires the four loop timers to be quiesced first (see PRECONDITION below) if depth is "deep" or skipRepair is false.',
  phases: [
    { title: 'Measure', detail: 'live facts from the swarm, the disk, the board and the ledger' },
    { title: 'Hunt', detail: 'six independent lenses, each blind to the others' },
    { title: 'Refute', detail: 'three adversarial verifiers per finding, majority kills it' },
    { title: 'Repair', detail: 'one agent per owned file, discovered at runtime, never two on one file' },
    { title: 'Prove', detail: 'independent re-check of every repaired file' },
    { title: 'Learn', detail: 'lessons, skill deltas, and the three ways to continue' },
  ],
}

// ---------------------------------------------------------------------------
// PRECONDITION, and why this workflow refuses to be clever about it.
//
// The loop's four launchd timers (ai.t27.trios-{heal,feed,cycle,cycle-heal})
// read the same files this workflow edits. An in-place write that a timer reads
// mid-flight has already corrupted `tri` once - 23 timer fires read a truncated
// dispatcher. So before a repairing run:
//
//   U=$(id -u); for j in ai.t27.trios-heal ai.t27.trios-feed \
//     ai.t27.trios-cycle ai.t27.trios-cycle-heal; do \
//     launchctl bootout gui/$U/$j; done
//
// and afterwards bootstrap them back. This workflow cannot run launchctl - it
// has no shell of its own - so it takes `quiesced` as an ASSERTED FACT from the
// caller and says so loudly in its return value. An asserted fact that is false
// is the caller's defect, not a silent one: the Prove phase checks for a timer
// write landing mid-run and reports it.
// ---------------------------------------------------------------------------

const ctx = args || {}
const DEEP = ctx.depth === 'deep'
const ITER = ctx.iteration ?? null

const ROOT = '/Users/playra/BrowserOS'
const LOOP = ROOT + '/trios/.trinity/loop'

const HOUSE = `
THE SUBJECT: the TriOS continuous-improvement loop - about 40 Node instruments in
${LOOP}, driven by launchd timers, writing a JSONL ledger and ANSI dashboards,
alongside a "Queen" supervisor on Railway that dispatches Claude Code "bees" into git
worktrees against GitHub issues in gHashTag/t27.

HOUSE RULES. Violating any of these is a defect, not a style choice.

1. NUMBERS ARE MEASURED, PROSE IS WRITTEN. A number you cannot measure is null, and
   null renders as "-", NEVER as 0. A fabricated zero is the worst defect class here
   and this repo has shipped it repeatedly.
2. A NON-ZERO EXIT IS OFTEN THE ANSWER, NOT A FAILURE. Instruments exit non-zero to
   report a real condition. Never "fix" a non-zero exit by making it zero.
3. THE RECURRING DEFECT CLASS, hit six times and counting: an instrument that reads
   PROSE, or a TOKEN WITHOUT ITS COMMAND, and treats it as evidence. Before you write
   any regex over source or prose, ask whether it could match a word that is not the
   thing. Narrow it, then pin it with a test that would fail if it widened again.
4. L3 PURITY: source files are ASCII-only. Check with: LC_ALL=C grep -n '[^ -~\t]' FILE
5. L7 UNITY: never create a new *.sh file. Node .mjs only.
6. Do NOT run: git commit, git push, git clean, git checkout, git worktree remove,
   launchctl, or any acting arm of tri (cycle, heal, feed). Reading is always fine.
7. Preserve every behaviour you were not asked to change. This is live machinery and a
   regression here is silent for days.
8. An untested claim is worthless. Run the thing. Paste the real output.

WHAT THE OPERATOR WANTS FROM YOU: self-criticism, not reassurance. If you cannot
reproduce something, say you could not. If the brief you were given is wrong, say it is
wrong. A finding you are unsure of belongs in the unsure field, not dressed up.
`

const FACTS = {
  type: 'object',
  properties: {
    swarm: { type: 'string', description: 'verbatim key lines from /queen/status: dispatch totals, running, swarmState, lastTick refusal, skipSummary shape' },
    delegable: { type: 'string', description: 'how many open issues a bee could take RIGHT NOW, and the command that measured it. If it cannot be measured, say so - do not guess.' },
    disk: { type: 'string', description: 'volume percent used and worktree count' },
    ledger: { type: 'string', description: 'newest begin/end rows in ledger.jsonl with their timestamps, and the age of the newest' },
    boards: { type: 'string', description: 'which GitHub repo each loop instrument reads, and when each of those boards last moved' },
    timers: { type: 'string', description: 'which of the four loop timers are currently loaded, per launchctl list' },
    contradictions: { type: 'string', description: 'any two of the above that disagree with each other. This field is the point of the phase.' },
  },
  required: ['swarm', 'delegable', 'disk', 'ledger', 'boards', 'timers', 'contradictions'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'one sentence naming the defect and its consequence' },
          file: { type: 'string', description: 'repo-relative path of the ONE file that owns this defect, with :line if known. If the defect spans files, name the file that must change.' },
          severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'the exact commands you ran and their exact output. Not a description of evidence - the evidence.' },
          fix: { type: 'string', description: 'the smallest change that closes it, specific enough that another agent could apply it without rediscovering anything' },
          effort: { type: 'string', enum: ['minutes', 'hours', 'days'] },
          measurable: { type: 'string', description: 'the command that will prove the fix worked' },
        },
        required: ['title', 'file', 'severity', 'evidence', 'fix', 'effort', 'measurable'],
      },
    },
    lensNotes: { type: 'string', description: 'what this lens could NOT see, and what it would need to see it' },
  },
  required: ['findings', 'lensNotes'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding does not hold. Default TRUE when you are uncertain.' },
    reason: { type: 'string', description: 'the command you ran and what it showed' },
    corrected: { type: 'string', description: 'if the finding is real but stated wrongly, the corrected statement. Empty string otherwise.' },
  },
  required: ['refuted', 'reason', 'corrected'],
}

const IMPL = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    changed: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' }, description: 'titles of the findings you actually fixed' },
    notFixed: { type: 'array', items: { type: 'string' }, description: 'titles you did NOT fix' },
    whyNot: { type: 'string' },
    syntaxCheck: { type: 'string', description: 'verbatim output of node --check or bash -n, or PASS if it printed nothing' },
    realOutput: { type: 'string', description: 'verbatim output of actually running the thing, truncated to 3000 chars' },
    exitCode: { type: 'string' },
    surprises: { type: 'string', description: 'anything contradicting the brief. Be blunt. Empty string if none.' },
  },
  required: ['file', 'changed', 'fixed', 'notFixed', 'whyNot', 'syntaxCheck', 'realOutput', 'exitCode', 'surprises'],
}

const PROOF = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    syntaxOk: { type: 'boolean' },
    runsOk: { type: 'boolean' },
    asciiOnly: { type: 'boolean' },
    noNewShellScript: { type: 'boolean' },
    survives: { type: 'array', items: { type: 'string' }, description: 'finding titles whose fix you INDEPENDENTLY reproduced working' },
    refuted: { type: 'array', items: { type: 'string' }, description: 'finding titles the implementer claimed fixed but you could not reproduce' },
    regressions: { type: 'string' },
    fabricatedZeros: { type: 'string', description: 'any place the new code renders 0 for an unmeasurable value. Empty string if none.' },
    timerRace: { type: 'string', description: 'evidence that a timer wrote to this file during the run, if any. Empty string if none.' },
    verdict: { type: 'string', enum: ['SOUND', 'PARTIAL', 'BROKEN'] },
    detail: { type: 'string' },
  },
  required: ['file', 'syntaxOk', 'runsOk', 'asciiOnly', 'noNewShellScript', 'survives', 'refuted', 'regressions', 'fabricatedZeros', 'timerRace', 'verdict', 'detail'],
}

// ---------------------------------------------------------------------------

phase('Measure')

const facts = await agent(
  HOUSE +
  `\n\nMEASURE THE LOOP AS IT IS RIGHT NOW. Do not read documentation about what it should
be - run the instruments and read the live surfaces. Specifically:

  curl -s --max-time 20 https://trios-agent-server-production.up.railway.app/queen/status
  cd ${LOOP} && node backlog.mjs           (how many issues a bee could take right now)
  cd ${LOOP} && node board.mjs             (which board each instrument reads; may not exist yet)
  cd ${LOOP} && node reap-local.mjs        (worktrees, and how many are actually reapable)
  df -h /  and  git worktree list | wc -l
  tail -3 ${LOOP}/ledger.jsonl
  launchctl list | grep -i 'trios-heal\\|trios-feed\\|trios-cycle'
  grep -oE "REPO = [^\\n]*" ${LOOP}/*.mjs | sort -u

The LAST field is the one that matters. Two of these surfaces will disagree with each
other - they always do. Find the disagreement and name it precisely. A contradiction
between two measurements is worth more than either measurement alone.`,
  { label: 'measure:live', phase: 'Measure', schema: FACTS }
)

const FACTSHEET = facts
  ? '\n\nLIVE FACTS measured at the start of this run:\n' + JSON.stringify(facts, null, 2).slice(0, 6000)
  : '\n\nLIVE FACTS: the measuring agent returned nothing. Measure what you need yourself, and SAY that the factsheet was missing.'

// ---------------------------------------------------------------------------
// Six lenses. Each is deliberately blind to the others: a lens that has already
// been told what another found stops looking and starts confirming.
// ---------------------------------------------------------------------------

phase('Hunt')

const LENSES = [
  {
    key: 'fabricated-numbers',
    q: `LENS: FABRICATED NUMBERS. Read every renderer in ${LOOP} (loop.mjs, dash.mjs,
dash2.mjs, snapshot.mjs, and anything else that prints a value a human reads). For each
value on screen, trace it back to the thing that measured it. Hunt for: a 0 printed
where the value is absent; a value rendered with no age when its source is a file that
could be days old; a delta computed across an unknown span; a ratio printed without its
denominator; a constant hardcoded in the renderer that pretends to be a reading. For
every finding, show the line that prints it and the line that should have measured it.`,
  },
  {
    key: 'blind-gates',
    q: `LENS: GATES THAT CANNOT FAIL. This loop has many checks. Find the ones that are
structurally incapable of reporting a problem: a check whose regex cannot match the
thing it guards; a gate wired into no timer, no CI job and no make target; a report
dressed as a gate that always exits 0; a sentinel threshold set so low it could never
fire; a check that guards two copies of a rule and only reads one. For each, PROVE the
blindness - construct the input it should catch and show that it does not.`,
  },
  {
    key: 'silent-failure',
    q: `LENS: WORK THAT REPORTS SUCCESS AND PRODUCES NOTHING. Read the ledger
(${LOOP}/ledger.jsonl) with python3 and look for long runs of a step reporting ok while
its output count is zero. Read the summarisers in heal.mjs and feed.mjs and find which
child lines they swallow. Read the timer logs. The question this lens answers: which
step has been reporting success for the longest while achieving nothing, and how would
an operator ever have found out?`,
  },
  {
    key: 'stale-surface',
    q: `LENS: THINGS THAT ARE OLD AND DO NOT SAY SO. Every rendered artefact, every cached
file, every anchor, every skill document, every runbook in .claude/. For each: when was
it last written, what does it claim, and is that claim still true today? Name anything
that presents a stale value as a current one. Include documents that reference a branch,
a PR, a checkout or a schedule that no longer exists.`,
  },
  {
    key: 'the-last-mile',
    q: `LENS: WORK THAT DOES NOT LAND. The swarm has finished many dispatches and produced
few or no remote commits. Trace the whole path: a bee finishes, and then what? Where does
the branch go, who pushes it, what opens the PR, what merges it, and at which step does
the chain break? Use git for-each-ref on remotes, git ls-remote, the dispatch records,
and push-work.mjs. Be specific about which step is broken; "pushes are failing" is not a
finding, "push-work.mjs reads local refs in this checkout and never sees the bees'
worktrees" is.`,
  },
  {
    key: 'self-contradiction',
    q: `LENS: THE LOOP CONTRADICTING ITSELF. Two files answering one question differently.
A constant in one place and a live reading in another. A rule written down three times
with the copies drifted apart. A comment claiming a guard the code does not implement.
A document in the mandatory read order that does not exist. Grep for duplicated logic
and diff the copies. Every finding must show BOTH sides of the contradiction.`,
  },
]

const hunted = await parallel(LENSES.map(l => () =>
  agent(HOUSE + FACTSHEET + '\n\n' + l.q +
    `\n\nReturn 4-10 findings. No filler - a finding with weak evidence costs more than a
missing one, because someone will act on it. If this lens finds nothing real, return an
empty array and say so in lensNotes. That is a legitimate answer.`,
    { label: 'hunt:' + l.key, phase: 'Hunt', schema: FINDINGS, effort: 'high' })
))

const rawFindings = hunted.filter(Boolean).flatMap(h => h.findings || [])
const lensesReturned = hunted.filter(Boolean).length
if (lensesReturned < LENSES.length) {
  log('WARNING: ' + (LENSES.length - lensesReturned) + ' of ' + LENSES.length + ' lenses returned nothing. Coverage is incomplete and the counts below understate the real defect set.')
}
log(lensesReturned + '/' + LENSES.length + ' lenses reported; ' + rawFindings.length + ' raw findings')

// ---------------------------------------------------------------------------
// Refute. Three verifiers per finding, each told to default to refuted when
// uncertain. A finding survives on a majority. This is a barrier on purpose:
// the grouping that follows needs the whole surviving set at once, because two
// findings on one file must never become two agents.
// ---------------------------------------------------------------------------

phase('Refute')

const judged = await parallel(rawFindings.map((f, i) => () =>
  parallel([0, 1, 2].map(k => () =>
    agent(HOUSE +
      '\n\nREFUTE THIS FINDING. Your default answer is refuted=true; only set it false if\n' +
      'you personally reproduced the defect by running something.\n\n' +
      'CLAIM: ' + f.title + '\n' +
      'FILE: ' + f.file + '\n' +
      'CLAIMED EVIDENCE: ' + String(f.evidence).slice(0, 2000) + '\n\n' +
      (k === 0
        ? 'YOUR ANGLE: reproduce the evidence exactly as stated. Do the commands give that output today?'
        : k === 1
          ? 'YOUR ANGLE: assume the evidence is real but the CONCLUSION is wrong. Is there an innocent explanation - a deliberate design, a second code path, a value that is legitimately absent?'
          : 'YOUR ANGLE: assume the finding is real but STATED WRONGLY - wrong file, wrong line, wrong magnitude, wrong consequence. If so, correct it in the corrected field rather than refuting it.') +
      '\n\nDo not edit any file.',
      { label: 'refute:' + i + ':' + k, phase: 'Refute', schema: VERDICT })
  )).then(vs => {
    const v = vs.filter(Boolean)
    if (v.length === 0) return null
    const kills = v.filter(x => x.refuted).length
    const correction = (v.find(x => x.corrected) || {}).corrected || ''
    return { finding: correction ? Object.assign({}, f, { title: correction }) : f, survives: kills < 2, votes: v.length, kills }
  })
))

const survivors = judged.filter(Boolean).filter(j => j.survives).map(j => j.finding)
const killed = judged.filter(Boolean).filter(j => !j.survives).length
const unjudged = judged.filter(x => !x).length
log(survivors.length + ' survived, ' + killed + ' refuted' + (unjudged ? ', ' + unjudged + ' UNJUDGED (verifiers returned nothing - these are dropped, not accepted)' : ''))

if (!survivors.length) {
  return {
    iteration: ITER,
    quiescedAsserted: !!ctx.quiesced,
    facts,
    raw: rawFindings.length,
    survivors: [],
    note: 'No finding survived refutation. That is a result, not a failure: either the loop is sound on these six lenses today, or the lenses are blind. lensNotes from each lens says which.',
    lensNotes: hunted.filter(Boolean).map((h, i) => ({ lens: LENSES[i] && LENSES[i].key, note: h.lensNotes })),
  }
}

if (ctx.skipRepair) {
  return { iteration: ITER, facts, survivors, killed, note: 'skipRepair was set; findings returned unrepaired' }
}

// ---------------------------------------------------------------------------
// THE DYNAMIC PART. File ownership is not declared in this script - it is
// derived from what the hunt actually found. One agent per file, every finding
// for that file in one brief. Two agents on one file is a lost edit, so the
// grouping is the safety property, not a convenience.
// ---------------------------------------------------------------------------

phase('Repair')

const byFile = new Map()
for (const f of survivors) {
  const file = String(f.file || 'unknown').split(':')[0].trim() || 'unknown'
  if (!byFile.has(file)) byFile.set(file, [])
  byFile.get(file).push(f)
}

const order = { blocker: 0, high: 1, medium: 2, low: 3 }
const groups = Array.from(byFile.entries())
  .map(([file, fs]) => ({
    file,
    findings: fs,
    worst: Math.min.apply(null, fs.map(f => order[f.severity] ?? 3)),
  }))
  .filter(g => g.file !== 'unknown')
  .sort((a, b) => a.worst - b.worst || b.findings.length - a.findings.length)

const dropped = byFile.has('unknown') ? byFile.get('unknown').length : 0
if (dropped) log('DROPPED ' + dropped + ' finding(s) that named no owning file - they are NOT repaired and NOT counted as done.')
log('repairing ' + groups.length + ' file(s): ' + groups.map(g => g.file.split('/').pop()).join(', '))

const results = await pipeline(
  groups,
  (g) => agent(
    HOUSE + FACTSHEET +
    '\n\nYOU OWN EXACTLY ONE FILE: ' + g.file + '\n' +
    'You may read anything. You may WRITE only that file. Another agent is editing a\n' +
    'different file at this moment; if you touch theirs, one of the two edits is lost.\n' +
    (ctx.quiesced
      ? 'The four loop timers are quiesced, so no timer will read your file mid-write.\n'
      : 'WARNING: the caller did NOT assert that the timers are quiesced. Write via a\n' +
        'mktemp copy and an atomic mv, never in place, and say in surprises that you had to.\n') +
    '\nCONFIRMED DEFECTS IN YOUR FILE (each survived three independent attempts to refute it):\n\n' +
    g.findings.map((f, i) =>
      (i + 1) + '. [' + f.severity + '] ' + f.title +
      '\n   EVIDENCE: ' + String(f.evidence).slice(0, 1200) +
      '\n   FIX: ' + String(f.fix).slice(0, 1200) +
      '\n   PROVE IT WITH: ' + f.measurable
    ).join('\n\n') +
    '\n\nFix what you can prove you fixed. A defect you leave alone and DECLARE is worth\n' +
    'more than one you paper over: put it in notFixed with a reason. Then run the thing\n' +
    'and paste its real output and exit code.',
    { label: 'repair:' + g.file.split('/').pop(), phase: 'Repair', schema: IMPL }
  ),
  (impl, g) => {
    if (!impl || !impl.changed) return impl ? { skipped: g.file, reason: 'implementer reported no change' } : null
    return agent(
      HOUSE +
      '\n\nYOU ARE AN ADVERSARIAL VERIFIER. Another agent just edited ' + g.file + '.\n\n' +
      'ITS SELF-REPORT (do not trust it):\n' + JSON.stringify(impl, null, 2).slice(0, 4000) + '\n\n' +
      'THE DEFECTS IT WAS GIVEN:\n' +
      g.findings.map(f => '- ' + f.title + '\n  prove with: ' + f.measurable).join('\n') + '\n\n' +
      'REFUTE IT. Read the file yourself. Then:\n' +
      '  - syntax check it (node --check, or bash -n for a shell dispatcher)\n' +
      '  - RUN it and read the real output\n' +
      '  - L3: LC_ALL=C grep -n \'[^ -~\\t]\' on the file must print nothing\n' +
      '  - L7: git status --porcelain | grep \'\\.sh$\' must print nothing new\n' +
      '  - for EACH defect, reproduce the BEFORE condition from its evidence and confirm\n' +
      '    the AFTER state actually differs. A fix you cannot demonstrate goes in refuted.\n' +
      '  - hunt house-rule-1 violations specifically: a 0 rendered where the value is\n' +
      '    unmeasurable. This repo fabricates zeros. Assume it did again and go looking.\n' +
      '  - if the implementer wrote any regex, try to make it FALSE-POSITIVE on a scratch\n' +
      '    copy under /tmp. Never experiment on the real file.\n' +
      '  - check whether a timer wrote to this file during the run: compare its mtime\n' +
      '    against what the implementer reported.\n' +
      'Do not edit anything.',
      { label: 'prove:' + g.file.split('/').pop(), phase: 'Prove', schema: PROOF, effort: 'high' }
    )
  }
)

const proofs = results.filter(r => r && r.verdict)
const broken = proofs.filter(p => p.verdict === 'BROKEN')
const partial = proofs.filter(p => p.verdict === 'PARTIAL')
const zeros = proofs.filter(p => p.fabricatedZeros && p.fabricatedZeros.trim())
const races = proofs.filter(p => p.timerRace && p.timerRace.trim())

// ---------------------------------------------------------------------------

phase('Learn')

const learned = await agent(
  HOUSE +
  '\n\nYOU ARE THE RECORDER for iteration ' + (ITER === null ? '(unnumbered)' : ITER) + '.\n\n' +
  'MEASURED AT THE START:\n' + JSON.stringify(facts, null, 2).slice(0, 5000) + '\n\n' +
  'FINDINGS: ' + rawFindings.length + ' raised, ' + survivors.length + ' survived refutation, ' +
  killed + ' refuted' + (unjudged ? ', ' + unjudged + ' unjudged and dropped' : '') + '.\n\n' +
  'REPAIRS AND THEIR INDEPENDENT VERDICTS:\n' + JSON.stringify(proofs, null, 2).slice(0, 20000) + '\n\n' +
  `YOUR JOB, in four parts:

1. THE LESSON. What did this iteration teach that a future one would otherwise have to
   rediscover? Not a summary of what was done - a lesson is a thing that changes a
   future decision. If a finding was REFUTED, the refutation is often the better lesson:
   "we believed X, measured it, and X was false" is worth more than a repair. Write at
   most three lessons. One good one beats three padded ones.

2. THE SKILL DELTA. For each lesson, name the file under ${ROOT}/trios/.claude/skills/
   that should carry it, and write the exact paragraph to add or replace. If no existing
   skill fits, say which new one is needed and why. Do NOT write the files - propose the
   text. A lesson that lives only in a ledger is a lesson nobody will read.

3. THE HONEST SCORE. How much of this iteration actually worked? Count BROKEN and
   PARTIAL verdicts, findings the verifiers refuted after repair, and anything the
   implementers put in notFixed. State the failure rate plainly. Do not round it toward
   success.

4. THREE WAYS TO CONTINUE. Exactly three, each one a real fork in the road, not three
   flavours of the same thing. For each: what the operator would do, what the loop would
   do unattended, what it costs, and what it would prove. Rank them and say which one you
   would pick if nobody answered, and why.

Write direct prose. No bullet-point soup. No congratulation.`,
  { label: 'learn', phase: 'Learn', effort: 'high' }
)

return {
  iteration: ITER,
  depth: DEEP ? 'deep' : 'shallow',
  quiescedAsserted: !!ctx.quiesced,
  facts,
  lenses: { requested: LENSES.length, returned: lensesReturned },
  findings: { raw: rawFindings.length, survived: survivors.length, refuted: killed, unjudged, droppedNoFile: dropped },
  repaired: groups.map(g => g.file),
  proofs,
  broken: broken.map(p => p.file),
  partial: partial.map(p => p.file),
  fabricatedZeros: zeros.map(p => ({ file: p.file, where: p.fabricatedZeros })),
  timerRaces: races.map(p => ({ file: p.file, evidence: p.timerRace })),
  learned,
}
