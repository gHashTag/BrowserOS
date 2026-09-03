# Unlanded work inventory

Recorded by the queen-1359 bee for [gHashTag/trios#1359](https://github.com/gHashTag/trios/issues/1359).

`trios/tools/unlanded-work-inventory.mjs` lists every `queen-*` branch in this
repository, compares each against a base ref (default `feat/queen-supervisor`,
printed with every report), checks the remote with `git ls-remote`, and
classifies each branch:

| status | meaning |
|--------|---------|
| `stranded` | commits ahead of the base, absent from the remote - finished work nobody can see on GitHub |
| `landed` | the ref exists on the remote |
| `empty` | zero commits ahead of the base - a running or abandoned bee, not stranded work |
| `unknown` | the `git ls-remote` lookup failed - never reported as `stranded` or `landed` (FR-002) |

The tool is read-only (FR-001): it runs `rev-parse`, `for-each-ref`, `log`,
`diff --numstat`, `ls-remote` and `config --get-regexp`, and nothing else. It
pushes, merges, deletes and modifies nothing. Pushing any of this work is the
operator's decision - the container holds no push credential by design, and
this issue deliberately does not change that.

## How this snapshot was produced

    cd /workspace/BrowserOS/.worktrees/queen-1359
    node trios/tools/unlanded-work-inventory.mjs
    node trios/tools/unlanded-work-inventory.mjs --selftest

Both runs exit 0. The full verbatim outputs follow, including every git
command the tool executed (FR-006), so every number below can be re-derived
by hand.

## Headline numbers

Snapshot taken 2026-09-03T18:12:39Z, base `feat/queen-supervisor` @
`87f4fd324309267fef53af64cbbd488213441490` (the default, printed by the tool):

- **79** `queen-*` branches matched
- **stranded: 64 branches, 121 files changed** - finished bee work that exists
  only in this container
- **landed: 2 branches** - `queen-1293` @ `314ea82` and `queen-1294` @
  `26a6622`, the only two `queen-*` refs on `origin` at the time of the run,
  matching the issue's own `git ls-remote | grep -c` count of 2
- **empty: 13 branches** - including `queen-1359` itself at the time of the
  run (this bee had made no commits yet)
- **unknown: 0 branches** - the `ls-remote` call against `origin` succeeded

A large stranded count is the finding, not a failure of the tool. Sixty-four
branches of accepted work have never reached GitHub, and until now nothing
counted them.

## Reading the report

- Stranded branches are ranked by files changed descending (issue story 2.1),
  and every row carries its commit subjects, so an operator can pick what to
  land without opening each branch. The top of the list:
  `queen-1339` (17 files, +1148), `queen-1356` (7 files, +238),
  `queen-1291` (4 files, +978), `queen-1324` (4 files, +922/-877),
  `queen-1308` (4 files, +453), `queen-1295` (4 files, +539).
- Columns: `BRANCH`, `STATUS`, `ISSUE` (number derived from the branch name),
  `AHEAD` (commits in `base..branch`), `FILES`/`INS`/`DEL` (from
  `git diff --numstat base...branch`), `REMOTE` (`absent`,
  `origin@<short-sha>` when the ref exists there, or `lookup-failed`),
  `ISSUE-STATE` (from `--issues-file` only; `-` when none was supplied),
  `SUBJECTS` (up to five commit subjects, the rest elided with `(+N more)`).

### A note on the issue's "1321 files changed"

The issue's summary measured "1321 files changed across those branches". This
tool reports 121 for the same branches because it measures each branch from
its merge base with the base ref (three-dot, `base...branch`), which counts
only what the branch itself changed. A two-dot diff (`base..branch`) would
additionally count every change the base gained after each branch forked,
which inflates the aggregate with work the bee never touched and ranks
branches by base drift instead of by their own work. The issue's own
per-branch spot checks agree with this tool exactly:

- `queen-1356`: issue says "7 files, 238 insertions" - the tool reports
  FILES 7, INS 238.
- `queen-1353`: issue says "940 insertions" - the tool reports INS 940.
- `queen-1349`: the tool's row carries `feat(ring00): add gate that keeps the
  spec and its Swift twin honest`, the commit the issue names.

## The report, verbatim

```
Unlanded work inventory (gHashTag/trios#1359)
mode: read-only (FR-001) - nothing here pushes, merges, deletes or modifies
run at: 2026-09-03T18:12:39.201Z
repository root: /workspace/BrowserOS/.worktrees/queen-1359
head: queen-1359 @ 87f4fd324309
git: git version 2.47.3
base for comparison: feat/queen-supervisor (default; override with --base <ref>) [FR-003]
base sha: 87f4fd324309267fef53af64cbbd488213441490  (git rev-parse --verify feat/queen-supervisor)
branch pattern: queen-* (default queen-*)
default remote: origin (per-branch branch.<name>.remote overrides when set)
issues file: none supplied - ISSUE-STATE column shows '-' (FR-004: issue state comes from a caller-supplied file, never the network)

branches matched: 79

BRANCH              STATUS     ISSUE  AHEAD   FILES       INS       DEL  REMOTE            ISSUE-STATE  SUBJECTS
queen-1339          stranded    1339      1      17      1148         0  absent                      -  feat(tools): turn blocked/planned tech-tree nodes into brief skeletons
queen-1356          stranded    1356      1       7       238        10  absent                      -  fix(skills): point clade-build invocations at the agent-safe build forms (#1356)
queen-1291          stranded    1291      2       4       978         0  absent                      -  feat(queen): make the English-only task gate a local preflight (#1291) | feat(queen): gate agent-created GitHub tasks on English (#1291)
queen-1295          stranded    1295      1       4       539         8  absent                      -  feat(queen): refill the swarm at once when a bee finishes (#1295)
queen-1308          stranded    1308      1       4       453        21  absent                      -  feat(queen): expose closed worker capacity breakdown (#1308)
queen-1324          stranded    1324      1       4       922       877  absent                      -  test(server): split pg-migrate.test.ts into parse gate, live gate, and helpers
queen-1062          stranded    1062      1       3       398         1  absent                      -  fix(a2a): make agent silence measurable from the server
queen-1296          stranded    1296      2       2       339        20  absent                      -  feat(queen): give the public status one closed swarmState word | test(queen): pin the four closed swarm states on the public status
queen-1090          stranded    1090      1       2       184         0  absent                      -  feat(queen): check a brief's shape before it is delegated
queen-1272          stranded    1272      1       2        28        29  absent                      -  docs(trios): the warning ceiling's record now says zero, in both places
queen-1278          stranded    1278      1       2       492         0  absent                      -  feat(tools): add xctest-triage to count failing tests, not assertions
queen-1279          stranded    1279      1       2       145         0  absent                      -  feat(t27): ring ledger - presence counted from the tree
queen-1302          stranded    1302      1       2       205         1  absent                      -  feat(queen): explain billing mode on public research (#1302)
queen-1303          stranded    1303      1       2       365         5  absent                      -  feat(queen): publish paid worker capacity on /queen/status (#1303)
queen-1304          stranded    1304      1       2       185         7  absent                      -  fix(queen): keep terminal lifecycle events in the public activity feed
queen-1307          stranded    1307      1       2       957         0  absent                      -  feat(queen): read Z.ai Coding Plan health as bounded, secret-free facts (#1307)
queen-1310          stranded    1310      1       2       494         7  absent                      -  feat(queen): explain idle paid slots with a closed queue state (#1310)
queen-1334          stranded    1334      1       2       463         0  absent                      -  feat(tools): queen-epic-ledger - read epic #1334's numbers from the live board
queen-1336          stranded    1336      1       2       485         0  absent                      -  feat(t27): migration ledger generated from the tree, not retyped
queen-1338          stranded    1338      1       2       543         0  absent                      -  feat(trios): the t27 surface census - hand-written twins of .t27 specs counted
queen-1340          stranded    1340      1       2       132         5  absent                      -  fix(bash): race output reads against the timeout so a grandchild cannot outli...
queen-1341          stranded    1341      1       2       614         0  absent                      -  feat(t27): purity survey of the queen tick
queen-1343          stranded    1343      1       2       271         0  absent                      -  feat(tools): ascii-purity survey and gate for L3
queen-1348          stranded    1348      1       2        96         3  absent                      -  Run the CORS guard where the other guards run
queen-1350          stranded    1350      1       2       603         0  absent                      -  feat(trios): t27 migration census - the migration surface, counted and ranked
queen-1352          stranded    1352      1       2       405        73  absent                      -  fix(queen): /queen/status counted why she refused without saying which issue
queen-1354          stranded    1354      1       2       370         3  absent                      -  fix(skill-match): compare boundary paths as written, not lowercased
queen-1357          stranded    1357      1       2      1467         0  absent                      -  feat(tools): re-check the tech tree's evidence against today's tree
queen-1244          stranded    1244      7       1       176        54  absent                      -  chore(trios): sixth verification record for #1244 - clean box, toolchain refe... | chore(trios): fifth verification record for #1244 - harness rebuilt from sour... | chore(trios): fourth verification record for #1244 - fresh dispatch, all chec... | chore(trios): third verification record for #1244 - independent re-run, all c... | chore(trios): the title bar typechecks against the local 999 host too - secon... (+2 more)
queen-1175          stranded    1175      2       1       171       487  absent                      -  docs(trios): record both density replays of the #1175 measurement | fix(trios): narrow only on an exact name match, and say nothing otherwise
queen-1083          stranded    1083      1       1        71         0  absent                      -  docs: add a2a schema inventory for t27 upstream proposal
queen-1089          stranded    1089      1       1        99         0  absent                      -  test(trios): audit the TriOSKitTests exclusion list against disk
queen-1111          stranded    1111      1       1       664         0  absent                      -  feat(trios): the interface-divergence decision, pure and self-proving (#1111)
queen-1176          stranded    1176      1       1       183        81  absent                      -  fix(trios): silence a range that begins nowhere in particular (#1176)
queen-1216          stranded    1216      1       1        63         0  absent                      -  docs: write down how the Queen picks the next subtask
queen-1240          stranded    1240      1       1        79        21  absent                      -  fix: key warm-up waits out the launch gate's whole legitimate lifetime (#1240)
queen-1265          stranded    1265      1       1        45         0  absent                      -  fix(build): name the dead vendored path before any compiler runs
queen-1266          stranded    1266      1       1        50        21  absent                      -  fix(trios): check-selftest's restore trap refuses a victim it no longer holds...
queen-1273          stranded    1273      1       1         8         1  absent                      -  build(trios): the variable the run dies without lives in the recipe now (gHas...
queen-1276          stranded    1276      1       1        64        24  absent                      -  fix(cassette-isolation): follow the recipe into the scripts it calls (#1276)
queen-1289          stranded    1289      1       1        37         0  absent                      -  docs(issue-spec-template): a root file with no extension must be written ./Name
queen-1290          stranded    1290      1       1        93         0  absent                      -  docs: what a bee can verify - named from agent-server/Dockerfile
queen-1297          stranded    1297      1       1       110         0  absent                      -  docs(queen): publish the /queen/status swarm state contract (#1297)
queen-1298          stranded    1298      1       1       336         0  absent                      -  docs: the work-conserving Queen swarm (#1298)
queen-1312          stranded    1312      1       1       250         0  absent                      -  docs: explain the Queen's next-task selection and refusal evidence (#1312)
queen-1321          stranded    1321      1       1       320         0  absent                      -  test(queen): a broken local ref must not block a fresh worktree
queen-1322          stranded    1322      1       1       117         0  absent                      -  docs(trios): write down the priority tiers a Bee reads (#1322)
queen-1323          stranded    1323      1       1       431         0  absent                      -  docs: record the https env probe sweep for dispatch fetch failures (#1323)
queen-1325          stranded    1325      1       1       234         0  absent                      -  docs(trios): record how backlog triage tells landed work from unstarted
queen-1326          stranded    1326      1       1       327         0  absent                      -  docs(queen): write down the bee result contract gap (#1326)
queen-1328          stranded    1328      1       1       248         0  absent                      -  docs(queen): the round report must say when the swarm cannot pay (#1328)
queen-1330          stranded    1330      1       1       198         0  absent                      -  docs(trios): classify what the swarm can reach (#1330)
queen-1331          stranded    1331      1       1       223         0  absent                      -  docs(queen): define when RING-00 becomes the authority (#1331)
queen-1332          stranded    1332      1       1       212         0  absent                      -  docs(queen): distinguish the two kinds of escalation
queen-1333          stranded    1333      1       1       260         0  absent                      -  docs(queen): the queue depth the swarm defends (#1333)
queen-1335          stranded    1335      1       1       283         0  absent                      -  docs(queen): specify the budget's cost-attribution day separately from the bo...
queen-1337          stranded    1337      1       1       107         0  absent                      -  feat(tools): ring00 constant parity gate between the spec and the Rust that runs
queen-1342          stranded    1342      1       1       197         0  absent                      -  docs(ring01): map every a2a.t27 constant and function to the running server
queen-1344          stranded    1344      1       1       199         0  absent                      -  docs: the bee ceiling is a policy number and nothing has measured it
queen-1345          stranded    1345      1       1       210         0  absent                      -  feat(tools): tmp-zero-count gives the unwired tmp-zero gate a number
queen-1346          stranded    1346      1       1       383         0  absent                      -  feat(t27): the tick's pure core as a .t27 spec
queen-1349          stranded    1349      1       1       502         0  absent                      -  feat(ring00): add gate that keeps the spec and its Swift twin honest
queen-1351          stranded    1351      1       1        90         0  absent                      -  docs(t27): survey QueenSalience purity and separate rules from plumbing
queen-1353          stranded    1353      1       1       940         0  absent                      -  feat(tools): provenance gate for generated ring artifacts
queen-1293          landed      1293      1       2        95         6  origin@314ea82              -  fix(queen): deduplicate identical provider keys before reporting capacity
queen-1294          landed      1294      1       2       299         4  origin@26a6622              -  feat(queen): publish aggregate skip summary on public status
queen-1133          empty       1133      0       0         0         0  absent                      -  -
queen-1301          empty       1301      0       0         0         0  absent                      -  -
queen-1306          empty       1306      0       0         0         0  absent                      -  -
queen-1309          empty       1309      0       0         0         0  absent                      -  -
queen-1311          empty       1311      0       0         0         0  absent                      -  -
queen-1316          empty       1316      0       0         0         0  absent                      -  -
queen-1318          empty       1318      0       0         0         0  absent                      -  -
queen-1327          empty       1327      0       0         0         0  absent                      -  -
queen-1329          empty       1329      0       0         0         0  absent                      -  -
queen-1347          empty       1347      0       0         0         0  absent                      -  -
queen-1355          empty       1355      0       0         0         0  absent                      -  -
queen-1359          empty       1359      0       0         0         0  absent                      -  -
queen-1361          empty       1361      0       0         0         0  absent                      -  -

Totals (three separate numbers, per issue story 1.4):
  stranded : 64 branches | 121 files changed (sum of per-branch files-changed)
  landed   : 2 branches
  empty    : 13 branches
  unknown  : 0 branches (remote lookup failed - excluded from stranded and landed per FR-002)

git commands run (153 - every command executed above, FR-006; '# failed' marks a non-zero exit):
  $ git rev-parse --show-toplevel
  $ git --version
  $ git rev-parse --verify feat/queen-supervisor
  $ git rev-parse --abbrev-ref HEAD
  $ git rev-parse HEAD
  $ git for-each-ref --format=%(refname:short) refs/heads/
  $ git config --get-regexp ^branch\..*\.remote$
  $ git log --format=%s feat/queen-supervisor..queen-1062
  $ git diff --numstat feat/queen-supervisor...queen-1062
  $ git log --format=%s feat/queen-supervisor..queen-1083
  $ git diff --numstat feat/queen-supervisor...queen-1083
  $ git log --format=%s feat/queen-supervisor..queen-1089
  $ git diff --numstat feat/queen-supervisor...queen-1089
  $ git log --format=%s feat/queen-supervisor..queen-1090
  $ git diff --numstat feat/queen-supervisor...queen-1090
  $ git log --format=%s feat/queen-supervisor..queen-1111
  $ git diff --numstat feat/queen-supervisor...queen-1111
  $ git log --format=%s feat/queen-supervisor..queen-1133
  $ git log --format=%s feat/queen-supervisor..queen-1175
  $ git diff --numstat feat/queen-supervisor...queen-1175
  $ git log --format=%s feat/queen-supervisor..queen-1176
  $ git diff --numstat feat/queen-supervisor...queen-1176
  $ git log --format=%s feat/queen-supervisor..queen-1216
  $ git diff --numstat feat/queen-supervisor...queen-1216
  $ git log --format=%s feat/queen-supervisor..queen-1240
  $ git diff --numstat feat/queen-supervisor...queen-1240
  $ git log --format=%s feat/queen-supervisor..queen-1244
  $ git diff --numstat feat/queen-supervisor...queen-1244
  $ git log --format=%s feat/queen-supervisor..queen-1265
  $ git diff --numstat feat/queen-supervisor...queen-1265
  $ git log --format=%s feat/queen-supervisor..queen-1266
  $ git diff --numstat feat/queen-supervisor...queen-1266
  $ git log --format=%s feat/queen-supervisor..queen-1272
  $ git diff --numstat feat/queen-supervisor...queen-1272
  $ git log --format=%s feat/queen-supervisor..queen-1273
  $ git diff --numstat feat/queen-supervisor...queen-1273
  $ git log --format=%s feat/queen-supervisor..queen-1276
  $ git diff --numstat feat/queen-supervisor...queen-1276
  $ git log --format=%s feat/queen-supervisor..queen-1278
  $ git diff --numstat feat/queen-supervisor...queen-1278
  $ git log --format=%s feat/queen-supervisor..queen-1279
  $ git diff --numstat feat/queen-supervisor...queen-1279
  $ git log --format=%s feat/queen-supervisor..queen-1289
  $ git diff --numstat feat/queen-supervisor...queen-1289
  $ git log --format=%s feat/queen-supervisor..queen-1290
  $ git diff --numstat feat/queen-supervisor...queen-1290
  $ git log --format=%s feat/queen-supervisor..queen-1291
  $ git diff --numstat feat/queen-supervisor...queen-1291
  $ git log --format=%s feat/queen-supervisor..queen-1293
  $ git diff --numstat feat/queen-supervisor...queen-1293
  $ git log --format=%s feat/queen-supervisor..queen-1294
  $ git diff --numstat feat/queen-supervisor...queen-1294
  $ git log --format=%s feat/queen-supervisor..queen-1295
  $ git diff --numstat feat/queen-supervisor...queen-1295
  $ git log --format=%s feat/queen-supervisor..queen-1296
  $ git diff --numstat feat/queen-supervisor...queen-1296
  $ git log --format=%s feat/queen-supervisor..queen-1297
  $ git diff --numstat feat/queen-supervisor...queen-1297
  $ git log --format=%s feat/queen-supervisor..queen-1298
  $ git diff --numstat feat/queen-supervisor...queen-1298
  $ git log --format=%s feat/queen-supervisor..queen-1301
  $ git log --format=%s feat/queen-supervisor..queen-1302
  $ git diff --numstat feat/queen-supervisor...queen-1302
  $ git log --format=%s feat/queen-supervisor..queen-1303
  $ git diff --numstat feat/queen-supervisor...queen-1303
  $ git log --format=%s feat/queen-supervisor..queen-1304
  $ git diff --numstat feat/queen-supervisor...queen-1304
  $ git log --format=%s feat/queen-supervisor..queen-1306
  $ git log --format=%s feat/queen-supervisor..queen-1307
  $ git diff --numstat feat/queen-supervisor...queen-1307
  $ git log --format=%s feat/queen-supervisor..queen-1308
  $ git diff --numstat feat/queen-supervisor...queen-1308
  $ git log --format=%s feat/queen-supervisor..queen-1309
  $ git log --format=%s feat/queen-supervisor..queen-1310
  $ git diff --numstat feat/queen-supervisor...queen-1310
  $ git log --format=%s feat/queen-supervisor..queen-1311
  $ git log --format=%s feat/queen-supervisor..queen-1312
  $ git diff --numstat feat/queen-supervisor...queen-1312
  $ git log --format=%s feat/queen-supervisor..queen-1316
  $ git log --format=%s feat/queen-supervisor..queen-1318
  $ git log --format=%s feat/queen-supervisor..queen-1321
  $ git diff --numstat feat/queen-supervisor...queen-1321
  $ git log --format=%s feat/queen-supervisor..queen-1322
  $ git diff --numstat feat/queen-supervisor...queen-1322
  $ git log --format=%s feat/queen-supervisor..queen-1323
  $ git diff --numstat feat/queen-supervisor...queen-1323
  $ git log --format=%s feat/queen-supervisor..queen-1324
  $ git diff --numstat feat/queen-supervisor...queen-1324
  $ git log --format=%s feat/queen-supervisor..queen-1325
  $ git diff --numstat feat/queen-supervisor...queen-1325
  $ git log --format=%s feat/queen-supervisor..queen-1326
  $ git diff --numstat feat/queen-supervisor...queen-1326
  $ git log --format=%s feat/queen-supervisor..queen-1327
  $ git log --format=%s feat/queen-supervisor..queen-1328
  $ git diff --numstat feat/queen-supervisor...queen-1328
  $ git log --format=%s feat/queen-supervisor..queen-1329
  $ git log --format=%s feat/queen-supervisor..queen-1330
  $ git diff --numstat feat/queen-supervisor...queen-1330
  $ git log --format=%s feat/queen-supervisor..queen-1331
  $ git diff --numstat feat/queen-supervisor...queen-1331
  $ git log --format=%s feat/queen-supervisor..queen-1332
  $ git diff --numstat feat/queen-supervisor...queen-1332
  $ git log --format=%s feat/queen-supervisor..queen-1333
  $ git diff --numstat feat/queen-supervisor...queen-1333
  $ git log --format=%s feat/queen-supervisor..queen-1334
  $ git diff --numstat feat/queen-supervisor...queen-1334
  $ git log --format=%s feat/queen-supervisor..queen-1335
  $ git diff --numstat feat/queen-supervisor...queen-1335
  $ git log --format=%s feat/queen-supervisor..queen-1336
  $ git diff --numstat feat/queen-supervisor...queen-1336
  $ git log --format=%s feat/queen-supervisor..queen-1337
  $ git diff --numstat feat/queen-supervisor...queen-1337
  $ git log --format=%s feat/queen-supervisor..queen-1338
  $ git diff --numstat feat/queen-supervisor...queen-1338
  $ git log --format=%s feat/queen-supervisor..queen-1339
  $ git diff --numstat feat/queen-supervisor...queen-1339
  $ git log --format=%s feat/queen-supervisor..queen-1340
  $ git diff --numstat feat/queen-supervisor...queen-1340
  $ git log --format=%s feat/queen-supervisor..queen-1341
  $ git diff --numstat feat/queen-supervisor...queen-1341
  $ git log --format=%s feat/queen-supervisor..queen-1342
  $ git diff --numstat feat/queen-supervisor...queen-1342
  $ git log --format=%s feat/queen-supervisor..queen-1343
  $ git diff --numstat feat/queen-supervisor...queen-1343
  $ git log --format=%s feat/queen-supervisor..queen-1344
  $ git diff --numstat feat/queen-supervisor...queen-1344
  $ git log --format=%s feat/queen-supervisor..queen-1345
  $ git diff --numstat feat/queen-supervisor...queen-1345
  $ git log --format=%s feat/queen-supervisor..queen-1346
  $ git diff --numstat feat/queen-supervisor...queen-1346
  $ git log --format=%s feat/queen-supervisor..queen-1347
  $ git log --format=%s feat/queen-supervisor..queen-1348
  $ git diff --numstat feat/queen-supervisor...queen-1348
  $ git log --format=%s feat/queen-supervisor..queen-1349
  $ git diff --numstat feat/queen-supervisor...queen-1349
  $ git log --format=%s feat/queen-supervisor..queen-1350
  $ git diff --numstat feat/queen-supervisor...queen-1350
  $ git log --format=%s feat/queen-supervisor..queen-1351
  $ git diff --numstat feat/queen-supervisor...queen-1351
  $ git log --format=%s feat/queen-supervisor..queen-1352
  $ git diff --numstat feat/queen-supervisor...queen-1352
  $ git log --format=%s feat/queen-supervisor..queen-1353
  $ git diff --numstat feat/queen-supervisor...queen-1353
  $ git log --format=%s feat/queen-supervisor..queen-1354
  $ git diff --numstat feat/queen-supervisor...queen-1354
  $ git log --format=%s feat/queen-supervisor..queen-1355
  $ git log --format=%s feat/queen-supervisor..queen-1356
  $ git diff --numstat feat/queen-supervisor...queen-1356
  $ git log --format=%s feat/queen-supervisor..queen-1357
  $ git diff --numstat feat/queen-supervisor...queen-1357
  $ git log --format=%s feat/queen-supervisor..queen-1359
  $ git log --format=%s feat/queen-supervisor..queen-1361
  $ git ls-remote --heads origin refs/heads/queen-1062 refs/heads/queen-1083 refs/heads/queen-1089 refs/heads/queen-1090 refs/heads/queen-1111 refs/heads/queen-1133 refs/heads/queen-1175 refs/heads/queen-1176 refs/heads/queen-1216 refs/heads/queen-1240 refs/heads/queen-1244 refs/heads/queen-1265 refs/heads/queen-1266 refs/heads/queen-1272 refs/heads/queen-1273 refs/heads/queen-1276 refs/heads/queen-1278 refs/heads/queen-1279 refs/heads/queen-1289 refs/heads/queen-1290 refs/heads/queen-1291 refs/heads/queen-1293 refs/heads/queen-1294 refs/heads/queen-1295 refs/heads/queen-1296 refs/heads/queen-1297 refs/heads/queen-1298 refs/heads/queen-1301 refs/heads/queen-1302 refs/heads/queen-1303 refs/heads/queen-1304 refs/heads/queen-1306 refs/heads/queen-1307 refs/heads/queen-1308 refs/heads/queen-1309 refs/heads/queen-1310 refs/heads/queen-1311 refs/heads/queen-1312 refs/heads/queen-1316 refs/heads/queen-1318 refs/heads/queen-1321 refs/heads/queen-1322 refs/heads/queen-1323 refs/heads/queen-1324 refs/heads/queen-1325 refs/heads/queen-1326 refs/heads/queen-1327 refs/heads/queen-1328 refs/heads/queen-1329 refs/heads/queen-1330 refs/heads/queen-1331 refs/heads/queen-1332 refs/heads/queen-1333 refs/heads/queen-1334 refs/heads/queen-1335 refs/heads/queen-1336 refs/heads/queen-1337 refs/heads/queen-1338 refs/heads/queen-1339 refs/heads/queen-1340 refs/heads/queen-1341 refs/heads/queen-1342 refs/heads/queen-1343 refs/heads/queen-1344 refs/heads/queen-1345 refs/heads/queen-1346 refs/heads/queen-1347 refs/heads/queen-1348 refs/heads/queen-1349 refs/heads/queen-1350 refs/heads/queen-1351 refs/heads/queen-1352 refs/heads/queen-1353 refs/heads/queen-1354 refs/heads/queen-1355 refs/heads/queen-1356 refs/heads/queen-1357 refs/heads/queen-1359 refs/heads/queen-1361
```

## The self-test, verbatim

`--selftest` builds a throwaway repository containing one stranded branch, one
branch matching a fake (local bare) remote, one empty branch, and one branch
whose remote lookup fails, then asserts all four classifications plus the
FR-002 rule. It exits 0 only if every assertion passes. The FR-002 assertion
is stated so that a failed remote lookup classified as `stranded`, `landed`
or `empty` would fail the run.

```
selftest: built /tmp/unlanded-selftest-uSKG50/work (base feat/queen-supervisor @ 048be0a, bare remote /tmp/unlanded-selftest-uSKG50/remote.git, broken remote /tmp/unlanded-selftest-uSKG50/no-such-remote.git)
selftest: assertions -
  PASS  queen-1001: classified 'stranded', expected 'stranded'
  PASS  queen-1002: classified 'landed', expected 'landed'
  PASS  queen-1003: classified 'empty', expected 'empty'
  PASS  queen-1004: classified 'unknown', expected 'unknown'
  PASS  FR-002: classifyBranchLanding({commitsAhead:3, remoteLookup:'failed'}) === 'unknown' (got 'unknown'; 'stranded'/'landed'/'empty' would all fail this)
  PASS  queen-1004: its remote lookup really failed (remoteLookup='failed', remote 'broken')
  PASS  totals: stranded=1 landed=1 empty=1 unknown=1 (got stranded=1 landed=1 empty=1 unknown=1)
selftest OK - all assertions passed
```

## Limits and re-running

- Issue state (open/closed) was not supplied for this run, so `ISSUE-STATE`
  shows `-`. FR-004 keeps it that way on purpose: issue state comes from a
  file the caller supplies, never the network, because this container holds
  no GitHub credential - which is the subject of the issue. To mark closed
  issues, pass e.g.
  `node trios/tools/unlanded-work-inventory.mjs --issues-file issues.json`
  where the file is a JSON array `[{"number":1359,"state":"closed"}]`, a JSON
  map `{"1359":"closed"}`, or lines of `1359 closed`.
- Remote state requires read access to `origin` (`git ls-remote`). Without it
  every branch reads `unknown` and both `stranded` and `landed` drop to 0 -
  by design, so a network failure can never masquerade as a finding.
- The counts drift as the swarm keeps working: bees add branches, the base
  moves, and this document is only the snapshot quoted above. Re-run the tool
  for current numbers.
- The tool works from any directory inside a worktree (it resolves the root
  with `git rev-parse --show-toplevel`); the quoted run was made from the
  `queen-1359` worktree root, not the main checkout.
