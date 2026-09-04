# T27-04: which of the salience score's decisions are pure, and therefore belong in a spec

Module under survey: `agent-server/queen-core/Sources/QueenPolicy/QueenSalience.swift`
(paths are relative to the `trios/` project directory inside the repository,
which is the prefix the issue writes and this document omits). The file is
131 lines (`wc -l`), read whole. This survey
is read-only: no Swift was modified and no `.t27` was written. Every claim
carries `file:line`; where a claim rests on a definition outside the module,
that definition is quoted at its own lines.

## 1. Function inventory

The module contains 5 function declarations: 4 `func` declarations plus the
computed property `prior` (39), whose getter is a function over `self`. The
command that produced the second number:

```
grep -cE 'func [a-zA-Z]+\(|var prior: Int \{' \
  agent-server/queen-core/Sources/QueenPolicy/QueenSalience.swift
-> 5
```

For comparison, a plain `grep -c 'func ' ...` gives 4, the four `func`
declarations at 57, 75, 94, 113. The table below has 5 rows, one per
declaration; the numbers match.

| Function | Lines | Class | Basis |
| --- | --- | --- | --- |
| `prior` | 39-46 | pure | A switch over `self` returning literals: `.failed` 40_000 (41), `.rejected` 25_000 (42), `.expensive` 20_000 (43), `.committedNothing` 15_000 (44). No clock, environment, network or disk read anywhere in 39-46. |
| `features(of:now:)` | 57-68 | pure | Reads only argument fields: `task.state` (59, 60, 63), `task.committedFiles` (63), and `QueenDelegationPolicy.isExpensive(task)` (66), which is itself `task.totalTokens >= workerTokenWarningThreshold` (QueenDelegation.swift:977-979) over `totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0)` (QueenDelegation.swift:354) and the constant `workerTokenWarningThreshold = 200_000` (QueenDelegation.swift:705). The `now` parameter (57) is never read in the body - a dead parameter, not an impurity. |
| `score(for:now:weightFor:)` | 75-88 | pure | The clock is injected, not read: `now.timeIntervalSince(task.updatedAt)` (83) is arithmetic between two `Date` values already in hand. Weights come from the injected closure, whose default `{ $0.prior }` (78) is pure. Constants `ageCeiling` and `agePerHourWeight` enter at 86. No `Date()`, environment, network or disk access in 75-88. |
| `reviewQueue(_:now:weightFor:)` | 94-107 | pure | The filter predicate `$0.state.needsQueenAttention` (100) is a switch over `self` (QueenDelegation.swift:118-123). The sort key is `score` (102-103) and the tiebreak `lhs.updatedAt < rhs.updatedAt` (105), all from arguments. Output depends only on arguments. The comparator (101-106) is a total order except for tasks sharing both score and `updatedAt`, whose relative order `sorted(by:)` leaves unspecified. |
| `reason(for:now:)` | 113-130 | pure | String assembly over `task.state` (115, 116, 117), `task.committedFiles` (117), `QueenDelegationPolicy.isExpensive(task)` (120), and the injected `now` (123). No clock, environment, network or disk access in 113-130. |

Zero rows are `impure`, so there is no impure line to quote. This is checked,
not assumed: `grep -nE 'Date\(\)|FileManager|ProcessInfo|UserDefaults|print\(|URL\('`
over the file returns nothing; the only Foundation call in the module is
`Date.timeIntervalSince` (83, 123), subtraction between two values in hand.
Zero rows are `plumbing`: every function either computes the ordering
(`prior`, `features`, `score`, `reviewQueue`) or explains it (`reason`); none
merely moves data. Zero rows are `undecided`: the only external definitions
the module touches - `isExpensive`, `needsQueenAttention`, `totalTokens` -
were each read at the lines cited above.

The three-way split therefore collapses for this module: every decision in
it is pure. The impurity the design talks about (the learner "with a file
behind it", 71-74) is kept out by injection, and lives in the caller.

## 2. The three declared weights

| Weight | Declared | What it orders | If doubled | If halved |
| --- | --- | --- | --- | --- |
| `maximumWeight` | 52 | Nothing in this module. A grep of the live tree, `grep -rn "maximumWeight" agent-server --include="*.swift"`, finds only its own declaration (52); no function in the file reads it. Its declared role - ceiling for learned weights (49-51) - is consumed outside the live tree: `rings/SR-01/SalienceLearner.swift:52` divides `smallestPriorGap` by it, and `tests/swift/ChatSSEEndToEndTest.swift:3044` compares a learned weight against `maximumWeight * 8 / 10` (pinned at 8145). | No ordering computed by this file changes. Outside it, the learner's smallest observable weight step halves (SalienceLearner.swift:52) and the pin test at ChatSSEEndToEndTest.swift:8145 fails. | Still no change in this file. Note that nothing clamps `prior` to it: `failed`'s 40_000 (41) would exceed a 20_000 ceiling unremarked, because the one-scale promise (49-51) rests on two constants chosen to match (41, 52), not one derived from the other. |
| `agePerHourWeight` | 53 | The age term of `score` (86): `min(hours, ageCeiling) * agePerHourWeight`. Together with the priors (41-44) it fixes how long a featureless task must wait to outgrow each feature: 16 hours of waiting (16 * 1_000) lifts it above a fresh `committedNothing` (15_000, 44). | The age term's maximum rises from 24_000 to 48_000, past `failed`'s prior of 40_000 (41): a featureless task a day old would outrank a freshly failed one. Today it cannot (24_000 < 40_000). | The age term's maximum falls to 12_000, below every prior (15_000-40_000, 41-44): waiting could never again lift a featureless task above a feature-carrying one. Today 16 hours already does. |
| `ageCeiling` | 54 | The cap on the age term (86): `min(hours, ageCeiling)`. Past 24 hours a task stops gaining score - "older is not more urgent, it is just older" (84-85). | With `agePerHourWeight` unchanged, the age term's maximum becomes 48_000: a 48-hour-old featureless task would outrank every single-feature task, including a fresh failure. The cap currently holds it at 24_000 (86). | Every task older than half a day stops gaining score at 12_000; their mutual order falls entirely to the `updatedAt` tiebreak (105), and no waiting can carry them past `committedNothing` (15_000, 44). |

## 3. What the split surfaced

1. The only impurity this module can ever have arrives through the injected
   `weightFor` (78, 97). Production passes the mutable static `learnedWeight`
   (QueenDelegation.swift:1039, passed at 1042); nothing in the live
   agent-server tree assigns it after the default `{ $0.prior }`, so today's
   ordering runs on priors alone. A spec must state the contract on
   `weightFor`, because the file's purity is conditional on the caller.
2. `maximumWeight` (52) is a declaration without a reader in the module -
   dead as far as this file's ordering goes (Section 2).
3. `features`'s `now` (57) is never read; the signature promises a
   time-dependence the body (58-67) does not have.
4. A fourth, unnamed decision number lives in `reason`: `hours >= 4` (124),
   the threshold at which waiting becomes a stated cause. It is not among
   the three declared weights (52-54) and nothing relates it to them.
5. The two age computations differ: `score` truncates to whole hours (83),
   `reason` compares fractional hours (123). A task 3.9 hours old counts as
   3 hours to its score and stays unexplained to `reason`.
6. `reviewQueue`'s comparator (101-106) is a total order except for tasks
   sharing both score and `updatedAt`; their relative order is unspecified
   because `sorted(by:)` is not guaranteed stable.

## 4. What to specify first

- The subset: `prior` (39-46) and `score` (75-88), plus the two constants
  they run on: `agePerHourWeight` (53) and `ageCeiling` (54).
- Why: production's closure defaults to priors (QueenDelegation.swift:1039),
  so these two functions and two constants are the entire live ordering.
- Why not smaller: they are never used apart (78) - `score` without `prior`
  is arithmetic with no weights; `prior` without `score` is weights only.
- Why not larger: `reviewQueue` (94-107) only filters and sorts by `score`
  with an age tiebreak; `reason` (113-130) adds prose, not decisions.
- `maximumWeight` (52) has no reader here; a spec for it would promise an
  enforcement this file does not contain.
