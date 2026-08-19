# Counter, Negative Check

This file is a fixture, not a manual. It exists so the Queen's character counter (#1151) can be driven through its refusal path under controlled conditions: the acceptance criterion attached to this document names a threshold of fifty thousand characters, the document deliberately cannot reach it, and the correct outcome of the run is a loud, numbered refusal. A counter that has only ever said yes has never been tested; this file is how it gets tested on the other side.

## Why a negative fixture exists at all

The counter was born from a false negative. In the run behind #1149 a criterion read «не меньше трёхсот знаков», the file `docs/par-c.md` weighed in at 2225 bytes — seven times the floor — and the reviewer still declared the criterion unmet. The work was done, the verdict said otherwise, and nobody could say why. That failure mode (#1151) is one of two directions a verifier can be wrong:

- **False yes** — unmet work accepted as done. It is the expensive direction: the error travels downstream into a merge, and the cost of undoing it grows with every step it survives. But it is also the direction the project had already probed and found absent (#1136): under the conditions tested, the counter did not hand out a pass it should have withheld.
- **False no** — done work rejected as undone. Cheaper, because nothing lands that should not have; the loop stalls instead of corrupting. But a false no is not free. The worker did the work, the report says the work failed, and the person holding the map has to arbitrate between the two with no evidence in hand. #1151 showed that when counting is left to judgement, the judgement can be wrong in either direction, silently.

The counter exists to remove judgement from the arithmetic. A criterion of the shape «не меньше N знаков» is decided by reading the file and counting, not by asking a model how big the file feels. That removes the false directions only if the counter itself is verified in both directions. #1149's fixtures verified the yes path at a small scale; the positive runs proved the counter could accept a file above its floor. They proved nothing about the no path, because every fixture passed.

A refusal path that has never fired is a refusal path nobody trusts. The first real failure it meets is also the first evidence of whether it works. This document exists so that first firing happens on purpose, in a run whose entire purpose is observation, rather than by accident in a run whose purpose is shipping.

## What this fixture asks for

Two criteria, from #1153:

1. The file `docs/counter-negative.md` exists.
2. It contains not fewer than fifty thousand characters.

The first criterion is trivially satisfiable: create the file, write a real document. The second is designed to fail, and the issue says so plainly: «Второй критерий выполнен не будет. Счётчик обязан отказать, назвав измеренное число и порог.» The threshold is set so far above what a single honest document in this repository contains — the largest of its sibling documents weighs about fifteen thousand characters — that no reasonable writing effort reaches it. That is the point. The fixture does not ask the worker to fail; it asks the worker to work honestly inside a boundary that cannot be crossed, so the counter's behaviour at the boundary is the only thing left to observe.

An unreachable threshold is a cleaner instrument than an artificially short document would be. A short document — a file deliberately kept to forty-nine characters — tests the counter near zero, where any counter refuses. It proves the counter is not broken, nothing more. An unreachable threshold tests the counter at a realistic size: the measured number is in the thousands, it is a plausible document size, and a sloppy verifier might wave it through on plausibility. The counter must do the arithmetic anyway and return the arithmetic's answer, not the plausibility's.

## What the counter must do with it

The counter, as implemented in `rings/SR-02/ChatViewModel.swift`, resolves a character criterion in four movements:

1. **Parse the threshold** out of the criterion text. Digits are recognised directly («300 знаков»), English word numbers to the hundreds («three hundred characters»), Russian genitive hundreds («трёхсот знаков»).
2. **Locate the file.** A criterion that names a path is checked against that path; one that names none is checked against the task's owned paths.
3. **Measure.** The file is read as UTF-8 and its characters counted — characters, not bytes, so a Cyrillic letter is one character however many bytes it occupies.
4. **Compare and report.** Measured against threshold, verdict met or unmet, and both numbers carried in the result so the verdict can be shown, not merely asserted.

For this fixture the correct verdict on the second criterion is unmet, with the measured number — whatever this document turns out to weigh — and the threshold of fifty thousand both stated. A verdict of unmet without the numbers is a shrug; the numbers are what turn a refusal from an obstacle into information. The worker reads them, sees the gap is by construction, and the Queen reads them and knows the counter did its job rather than merely having an opinion.

The refusal must also be *distinguishable from silence*. A counter that cannot classify a criterion has a third behaviour — skip it, leave it unchecked, hand it to the model — and that behaviour is correct for shapes it genuinely cannot parse. But skipping and refusing must not look alike from the outside. «Unmet, measured 15,842 against 50,000» ends the question; «unchecked» reopens it, and the difference between the two is the difference between a counter and a suggestion box.

## A gap this fixture walks into

The threshold in this criterion is written with words, not digits: «пятидесяти тысяч знаков» — fifty thousand. The parser recognises Russian word numbers in the hundreds only. Thousands are not in its vocabulary. Unless the shape has been extended since, the parser returns nil for this criterion, and a nil threshold means no mechanical verdict at all: the criterion falls back to the model, to be decided the way #1151 decided it should not be decided — by judgement, without counting.

That is a finding, not a flaw in the fixture. A negative fixture is supposed to walk the refusal path and report exactly what it met on the way. If what it met is a parse gap, the honest report is «the counter could not refuse because it could not read the number», and that is a sharper result than a clean refusal: it says the counting still has shapes it cannot see, and the safety it provides is not yet total. The follow-up work belongs to whoever owns the parser — the boundary of this task is this document and nothing else, and out-of-scope work is raised here rather than done quietly.

## What a passing run of this fixture looks like

Not a merge. Not a green checkmark. The fixture passes when the loop behaves correctly around a verdict of unmet:

- The file exists, and the first criterion is reported met.
- The second criterion is reported unmet, with the measured number and the threshold both named.
- Nothing pads the document to cross the threshold. Reaching fifty thousand characters by filler would not satisfy the criterion so much as destroy the instrument — the counter would accept, the refusal path would stay untested, and the run would prove nothing while appearing to prove everything.
- The worker stops and answers each criterion in turn — met, not met, or could not check — because an unmet criterion honestly reported is a working loop, and an unmet criterion quietly massaged into a met one is #1151 wearing different clothes.

The refusal, once delivered and recorded, becomes the artefact. The Queen has a numbered refusal from the counter under load, the reverse direction of the false negative that started this, and the counter's two-way behaviour — measured acceptance above a floor, measured refusal below one — is no longer an assumption but a run.

## Reading the two verdicts together

The first criterion tests existence: a file is there or it is not, and no counting is needed. The second tests arithmetic under the hardest condition — a number a real document plausibly reaches, judged against a floor it cannot. Together they exercise the whole small grammar of mechanical acceptance: presence, measurement, comparison, refusal. The run of #1149 exercised presence and measurement on the accepting side; this one exercises them on the refusing side; between the two, every verdict the counter can emit has now been emitted for a reason.

That completeness is what a verifier needs before anyone trusts it with a merge. A counter whose every output has been observed under controlled conditions can be believed when it emits that output unobserved. A counter with an untaken branch — refusal, or acceptance, or skip — can only ever be *hoped* to be right, and hope is what #1151 removed from the process in the first place.

## Boundaries of this task

One file: this one. No code, no tests, no branches, no commits — the checkout is shared with the user, the build, and every sibling worker, and attribution to `queen/1153` is the Queen's work after the turn ends. The document belongs to the issue that asked for it: #1153, part of #1090, the negative half of the counter's proof, sibling to #1149's positive runs and #1151's false negative. Work that seems obviously needed beyond this file — extending the parser to word thousands, say — is raised in the report, not done under the table; unstated scope is where reviews turn into arguments, and this fixture exists to keep reviews short.
