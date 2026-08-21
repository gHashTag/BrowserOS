# Counter Negative — The Refusal Half of the Proof

Issue: gHashTag/trios#1153 · Parent: #1090

## What this document is

The specimen for the reverse check of the character counter. It exists so that the counter — the part of the review that settles a criterion of the shape «не меньше N знаков» by counting the file instead of asking a model (#1151) — has something real to refuse. Every other document under `docs/` was written to pass its criteria. This one was written to fail one of them, deliberately and in plain sight.

The task carries two criteria: the file exists, and it holds at least fifty thousand characters. The first is met. The second is not, was never going to be, and the issue says so in as many words: the counter must refuse, naming the measured number and the threshold. A document that padded itself across the line would not be a stronger piece of work — it would be a broken probe. A stuffed file takes from the counter the only thing this task exists to exercise: its ability to say no with the numbers attached.

## The lineage of the check

A counter's proof has always needed two halves.

The first half hunted a false «yes». Probe #1136 looked for a criterion marked met that was not; none was found, and the loop was believed clean in that direction.

The second half surfaced by accident. On run #1149 a bee produced `docs/par-c.md` — 2225 bytes — against the criterion «В нём не меньше трёхсот знаков». The bee's own report stated the file exceeded the threshold sevenfold. The reviewer's verdict: not met. A false «no» — cheaper than a false «yes», but it breaks the loop the same way: the work is done, the task will not pass, and nobody can say why. That became #1151.

The fix in #1151 was a change of jurisdiction, not of diligence: counting belongs to the check, not to judgment. A criterion about a number of characters is settled by one command — read the file, count, compare — and the plan demanded proof in both directions: a 2225-byte file passes «не меньше трёхсот знаков», and the same file shortened below the threshold fails. Both by a run, not by argument.

That reverse half was proven in a scratch directory against a shortened copy. This file moves it into the living loop: a real issue, a real threshold, a real worker, and a criterion no honest document of this kind can satisfy. #1153 is #1151's mirror, at task scale.

## Why a negative control at all

A checker that has only ever been seen to say yes has not been seen to check. Confidence in a verdict machine comes from watching it refuse, not from watching it approve; approval is what a broken checker produces by default. The forward proof in #1151 showed the counter can pass a file that deserves to pass. Only a live refusal shows the counting was not decorative.

There is also a subtler reason. Fixes drift toward the error they were born from. #1151 replaced a judgment that erred toward «no» with a count that cannot err — but the count lives inside code that parses criterion text, and parsing is where a new softness could grow: a shape not recognised falls back to the model, and the model is the thing that was wrong. A negative control on record is the cheapest alarm for that drift. It costs one task now and pays every time the counter's spine is in doubt later.

The size of the threshold is part of the design. The earlier reverse proof shortened a file below a small bar; a live task needs a threshold an honest worker cannot reach by doing the work, and far enough that crossing it could only mean padding. Fifty thousand characters is a short book chapter — an order of magnitude past any honest document about a counter probe. The distance is the point: it makes «not met» the only truthful verdict and any crossing self-explanatory.

## How the count is taken

The counter reads the file as UTF-8 and takes `String.count`: extended grapheme clusters, the characters a reader perceives — not bytes, not UTF-16 units. For this document — plain text, no combining marks, no emoji — a codepoint count is the same figure; the byte count runs roughly double, since Cyrillic letters cost two bytes in UTF-8. Every honest measure lands far below the bar, which is why the probe does not depend on the yardstick.

The threshold is parsed from the criterion text, and the parser knows a limited vocabulary: digits after «не менее» / «не меньше» / «at least», bare digit forms like «300 characters» or «500 знаков», English word numbers, and Russian genitive hundreds — «двухсот» through «девятисот». This task's criterion is written «не меньше пятидесяти тысяч знаков», and «пятидесяти тысяч» is a compound numeral the tables do not hold: no digit appears in the text, no single hundred word matches, so the mechanical parser returns nothing and the criterion falls back to the model reviewer — the path #1151 left open for unrecognised shapes. A criterion phrased with digits («не меньше 50000 знаков») would have been owned by the counter end to end. The semantics do not change with the spelling; the observation is recorded here for the Queen, not acted on — the boundary of this task is one file, and widening a numeral table is another task's work.

When the counter does own a criterion, it does not whisper. The verdict carries the arithmetic — measured and threshold, in the shape «N знаков при пороге M» — and the log line `queen.review.characterCount` records both numbers with the issue slug. A refusal that names its numbers can be audited by anyone; a refusal without them is indistinguishable from a miscount, and #1151 was precisely about not having to trust anyone's arithmetic but the machine's.

## What this document does not do

It does not state its own character count. #1151's lesson is that a number reported by a participant is testimony, and testimony about numbers is what failed: the bee said «2225 байт, существенно превышает порог», and the verdict still came back «not met». A self-measured figure in this file would be judgment-shaped evidence pretending to be a measurement — exactly the thing the counter was built to replace. The only claim this document makes about its own size is the one it cannot get wrong: it is shorter than fifty thousand by any honest measure, and the exact figure belongs to the review.

It also does not argue for a smaller threshold, does not ask for an exception, and does not treat the unmet criterion as a defect in the task. The unmet criterion is the task. A negative control that negotiates its way to «met» has not been passed; it has been disarmed.

## What success looks like

- Criterion one — the file exists at `docs/counter-negative.md` — verdict: met.
- Criterion two — «не меньше пятидесяти тысяч знаков» — verdict: not met, with the measured count and the 50,000 threshold both named in the verdict or the log line.
- The file after review is the file before review: no padding appears, no filler is added to cross the bar.
- The threshold is not edited, the criterion is not reinterpreted, and the task is not rescued.
- The loop survives an honest «no»: the refusal is on record, readable by a human who never opens a log.

The point of this task is not the document. The point is the refusal on record.

## Failure modes this probe exists to expose

**The rubber stamp.** The verdict comes back «met» with no numbers attached. The counter has bent to the direction of the work — worse than the era before #1151, because the yes now looks mechanical and earns trust it did not earn.

**The silent pass.** The criterion is never checked at all — never asked, dropped between the spec and the review. The loop leaks a task, and nobody learns the counter's spine is missing.

**The numberless refusal.** The verdict says «not met» but names no measured count and no threshold. This breaks the evidence rule #1151 installed: a refusal without arithmetic cannot be told apart from a miscount, and the next honest 2225-byte file dies the same death `par-c.md` did.

**The bee that pads.** The worker crosses fifty thousand and one with filler and the review waves it through. The probe is switched off from the inside; volume without content should be read as exactly what it is — the negative control's escape hatch, slammed shut from the wrong side.

**The rescued threshold.** Someone lowers the bar after the fact so the task can close. That converts a negative control into a positive one and proves nothing except that the loop cannot hold a designed failure. The unattainable threshold is not an obstacle to the task; it is the substance of it.

## The record, as observed under the third pass

The sections above were written as predictions about a probe. The probe has now run, and this section records what the loop actually did to this task, in the worker's own view of it.

The loop refused twice. Each return names the unmet criterion verbatim — «1 criterion(s) were not met: В нём не меньше пятидесяти тысяч знаков» — and invites the impossibility answer in so many words: a criterion that cannot be met is worth reporting, and it is the only answer here that is not more code. What the returns do not carry is a measured count. The threshold lives inside the criterion text; the measured figure — 8,556, then 8,556 again — lived only in the worker's own reports. That is testimony about a number standing in for a measurement, the exact shape #1151 was built to retire. The refusal is on record; the naming of the measured number has so far survived only in the bee's words.

Two observations follow, both raised upward rather than acted on.

First, this criterion never reached the mechanical counter. Its text holds no digits, and «пятидесяти тысяч» is not among the genitive-hundred words the parser knows, so the verdict came from the reviewer path — the one #1151 distrusted — and the log line `queen.review.characterCount` never fired for this task. A counter cannot prove it refuses with numbers on a criterion it is never handed. If the Queen wants the machine to own the refusal end to end, the criterion needs digits («не меньше 50000 знаков») or the parser needs a wider numeral vocabulary. Either is another task's boundary.

Second, the loop has no terminal state for a task designed to fail a criterion. A gate that lands only when every criterion is met will return this task forever; padding is the only in-gate exit, and padding is disarming. The impossibility answer — explicitly invited by the review each time — is the sole terminal condition this task can reach. Whether the Queen can land a task on that answer is the open question this probe hands upward, and it is a better question than the one it was designed to ask.

What did not happen, so far: none of the five failure modes above has occurred. The verdicts stayed honest, the numbers stayed in reach, the threshold stayed at fifty thousand, and the file stayed short. That is this task's success condition, now on record as observed fact.
