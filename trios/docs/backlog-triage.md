# Backlog triage: telling a landed issue from an unstarted one

This file records how the open backlog was triaged on 2026-09-01 and how
to repeat that triage. Before it existed, nothing in trios/docs/
described the procedure: `grep -rl "git log --all --grep" trios/docs/`
returned nothing, and `grep -rl "merge-base" trios/docs/` returned
nothing. The cost was not tidiness. The Queen reads the backlog every
round and could not separate merged work from unstarted work, so she
reported "nothing to choose" while more than half of what she was
looking at had already landed.

Everything below is a measurement procedure, not an opinion. Run the
commands, read the commit messages, write the verdict with the
reference named, and move on.

## The measurement

On 2026-09-01 the triage found:

- 23 open issues carrying no Boundary.
- 13 of them already done: for each, a commit exists whose message says
  `Closes #N` and nobody closed the issue.
- 6 of those 13 were closed on that evidence. Each of the six was
  re-verified in the checkout that performed the triage, and each
  matches exactly one commit containing the literal string `Closes #N`.

The six closed issues and their closing commits:

- #1275 closed by 644161f93, "fix(trios): a stream that never speaks
  is not alive".
- #1271 closed by 1acae2d58, "test(trios): the suite compiles, and the
  ceiling is a requirement now".
- #1269 closed by 7d0335276, "fix(trios): doctor tells the truth, and
  a table whose oracle is the check itself".
- #1268 closed by a117c98b8, "fix(trios): a branch's new files were
  dropped from the combined tree".
- #1267 closed by c500216f5, "fix(trios): a scratch repo nobody
  created, and a launch error nobody read".
- #1263 closed by 0ae95c10f, "fix(trios): wait on a clock, not on a
  count of sleeps".

The counts and branch numbers quoted in this file are the record of
that day in that checkout. Refs move: branches get deleted, remotes
advance, and the same command re-run in a different checkout can print
a different number. A count is a property of the ref set, never a
property of the issue. The verdict never rests on a count. It rests on
the `Closes #N` token in a commit body and on one ancestry exit code
against one named reference.

## Three states, not two

Asking only "is there a commit?" collapses two different situations
into one. A commit that names the issue can be integrated or not
integrated, and those are different verdicts. The triage states are:

- `stale` -- decided by `git merge-base --is-ancestor <sha>
  <reference>` exiting 0. A commit names the issue and that commit is
  an ancestor of the named integration reference. The work has landed
  where it integrates and the open issue is a stale record. Close it.
  Do not delegate a bee to it.

- `landed-unmerged` -- decided by the same command exiting 1:
  `git merge-base --is-ancestor <sha> <reference>` fails, so a commit
  names the issue but is not an ancestor of the named integration
  reference. The work has landed somewhere and has not been integrated
  into the reference. Do not delegate a bee to it either; chase the
  merge instead.

- `starved` -- decided by `git log --all --oneline --grep="Closes #N"`
  printing nothing. No commit names the issue. The work has not
  started. This is the only state that may receive a bee.

One guard sits in front of all three:

- `unknown` -- when a candidate sha reaches you from outside this
  checkout (from an issue body, a note, or a past triage record), run
  `git cat-file -e <sha>^{commit}` first. A non-zero exit means the
  checkout lacks the commit, so no ancestry test can run at all.
  Record the issue as `unknown`, never as `starved`. A worktree that
  does not carry the branch holding the commit produces exactly this
  exit.

## The commands

Run from the git root of the worktree, in this order.

1. Find candidates that name the issue:

       git log --all --oneline --grep="Closes #N"

   The quotes and the word `Closes` matter. See the next section for
   what the looser bare `--grep="#N"` returns instead.

2. Open every candidate and read it:

       git show <sha>
       git show --stat --format= <sha>

   A commit names the issue only when its message body contains the
   literal token `Closes #N`. Reading the subject line is not reading
   the commit. If the subject carries a bare `(#N)` suffix, look at
   the paths the commit touches before you cite it.

3. Guard a sha you did not find yourself:

       git cat-file -e <sha>^{commit}

   Exit 0: the commit is present, continue. Non-zero exit: the
   checkout lacks the commit; record `unknown` and stop.

4. Test ancestry against one named reference:

       git merge-base --is-ancestor <sha> <reference>
       echo $?

   <reference> is the ref the work must be an ancestor of to count as
   integrated: `origin/dev`, or `HEAD` when the working branch is the
   integration point. Exit 0 means `stale` against <reference>. Exit 1
   means `landed-unmerged` against <reference>. Write the reference in
   the same sentence as the verdict: "#1275 is landed-unmerged against
   origin/dev", never "#1275 is landed-unmerged".

Why the reference must be named, in numbers from the 2026-09-01
checkout: `origin/dev` stood 940 commits behind the working branch.
All six closing commits above returned exit 1 from
`git merge-base --is-ancestor <sha> origin/dev` and exit 0 from
`git merge-base --is-ancestor <sha> HEAD`. The same issue is therefore
`landed-unmerged` under one reference and `stale` under the other, and
only the sentence that names its reference says which. Re-measure the
gap in your own checkout; it moves as both refs advance. Branch
containment is no substitute: 126 branches contained 644161f93 on that
day, so the answer to "does some branch have it" was yes for anything
worth asking about and carried no information at all. One named
reference, one exit code, one verdict.

## What counts as a link

A commit names an issue only when its message body contains the
literal token `Closes #N`. A commit a reader merely believes is
related is not evidence. Open the candidate commit and read its
message before citing it; a subject that mentions a number is not a
body that closes an issue.

Three separate traps, all measured on 2026-09-01:

1. A bare number grep is not a link. In the triage checkout,
   `git log --all --oneline --grep="#1263"` returned 4 commits where
   `--grep="Closes #1263"` returned 1. The extras come from a
   different numbering namespace: upstream BrowserOS pull requests are
   suffixed `(#N)` in subjects, and those pull-request numbers collide
   with TriOS issue numbers. The triage record cites two of the
   collisions, both touching paths outside `trios/` and neither
   carrying a `Closes` line:

   - efb6cb7d9, subject "fix: store side panel scope in extension
     storage (#1263)", touching only paths under
     `apps/agent/lib/browseros/`.
   - 09f3d19e8, the same collision for #1268 through the suffix
     `(#1268)`, touching paths outside `trios/` as well.

   Open such a commit, find no `Closes` line and no `trios/` path,
   and discard it: it is evidence about an upstream pull request, not
   about a TriOS issue. Both of these commits were absent from the
   worktree in which this document was written (`git cat-file -e`
   exits non-zero for each there); they are cited from the triage
   record because that checkout held them.

2. A `Closes #N` grep counts commits, not landings. `Closes #1081`
   appeared in 11 distinct commits across branches. In total, 149
   commits carried a `Closes #` marker. Counting matches says nothing
   about where any of that work integrated; only the ancestry test in
   step 4 answers that, which is why a count is never the verdict.

3. A single match is still not a landing. #1269 has exactly one
   commit matching `Closes #1269`, and its verdict still depends on
   the reference chosen in step 4.

## Worked examples

Counts below are the 2026-09-01 record of the triage checkout.
Re-derive them in your own checkout before citing one; the verdict
procedure, not the counts, is what transfers.

For each issue: the closing commit, the count the `Closes #N` grep
returned, and the count the looser bare `#N` grep returned. Every
`Closes #N` count is 1; the bare counts are the noise that trap 1
describes.

- #1275, closing commit 644161f93: the `Closes #1275` grep returned
  1, the bare `#1275` grep returned 2.
- #1271, closing commit 1acae2d58: the `Closes #1271` grep returned
  1, the bare `#1271` grep returned 3.
- #1269, closing commit 7d0335276: the `Closes #1269` grep returned
  1, the bare `#1269` grep returned 1.
- #1268, closing commit a117c98b8: the `Closes #1268` grep returned
  1, the bare `#1268` grep returned 2.
- #1267, closing commit c500216f5: the `Closes #1267` grep returned
  1, the bare `#1267` grep returned 1.
- #1263, closing commit 0ae95c10f: the `Closes #1263` grep returned
  1, the bare `#1263` grep returned 4.

The four situations the procedure exists for:

- #1269, choosing work. The Queen runs
  `git log --all --oneline --grep="Closes #1269"` and gets the single
  line `7d0335276 fix(trios): doctor tells the truth, and a table
  whose oracle is the check itself`. She opens it, finds
  `Closes #1269` in the body, and `git merge-base --is-ancestor
  7d0335276 HEAD` exits 0. Verdict, reference named: #1269 is `stale`
  against `HEAD`. No bee is delegated to it.

- #1263, the loose grep. A reader runs
  `git log --all --oneline --grep="#1263"` and gets 4 lines, one of
  them `efb6cb7d9 fix: store side panel scope in extension storage
  (#1263)`. They open that commit and find it touches only paths
  under `apps/agent/lib/browseros/` and carries no `Closes` line.
  They discard it as an upstream pull-request number in a different
  numbering namespace and treat it as no evidence about TriOS issue
  #1263. The line that matters is 0ae95c10.

- #1275, the reference decides. The closing commit 644161f93 returns
  exit 1 from `git merge-base --is-ancestor 644161f93 origin/dev` and
  exit 0 from `git merge-base --is-ancestor 644161f93 HEAD`. Applying
  the procedure, #1275 is `landed-unmerged` against `origin/dev` (and
  `stale` against `HEAD`), and the integration reference is written
  next to the verdict in the same sentence, because the sentence
  without the reference states nothing.

- The missing commit. A worktree that does not carry the branch
  holding a candidate commit gets a non-zero exit from
  `git cat-file -e <sha>^{commit}`. The issue is recorded as
  `unknown` and is not classified `starved`, because "no commit names
  it here" and "no commit names it anywhere" are different claims,
  and only the second one starves an issue.
