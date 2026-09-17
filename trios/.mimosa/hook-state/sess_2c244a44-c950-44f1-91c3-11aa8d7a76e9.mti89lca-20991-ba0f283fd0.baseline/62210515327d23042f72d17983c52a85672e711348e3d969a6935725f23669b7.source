---
name: unmeasured-cause
description: Find and fix the defect where a log line, error message or status summary names a cause nobody measured. Use when debugging a symptom whose message has never changed, when a report reads more reassuring than the system's actual state, before trusting any diagnostic string, and when writing a new warn/error/refusal message. Carries eight instances found in trios, the tell that identifies them, and the repair recipe.
---

# The unmeasured cause

## The defect

A message asserts a cause the code has no way to observe.

The code knows one fact - a value is empty, a fetch returned nothing, a list is
short. The message picks one of several possible reasons for that fact and
states it as though it were measured. It is not lying about the fact. It is
inventing the reason.

This is the single most expensive defect class in this repository. Eight
instances, all found by reading a message against the code that emits it:

| The message said | The code actually knew | Cost |
|---|---|---|
| `API empty` | some error occurred, swallowed by `try?` | the one line that identified it was discarded, every time |
| `the Keychain did not respond` | `resolvedAPIKey` is empty; three sources exist | a whole night spent testing the Keychain, which was fine |
| `All 26 candidates look already done` | 1 of 26 was done; 16 were blocked | "everything is finished" printed over a stuck board |
| `a worker already has it` | the issue is in one of six `spokenFor` states, four of which have no worker | 8 settled tasks read as 8 busy bees |
| `its files are owned by a live task` | which task, in which state, for how long - all in hand, none printed | a block nobody can attribute is a block nobody clears |
| `no entries listed` | the enumeration was refused - launch gate, cooldown, contention, ACL, or genuinely empty | five causes, one word, four of them not "empty" |
| `store: no entries listed (launch gate or cooldown)` + `config file: no TRIOS_ZAI_API_KEY` | the key was present with a zero-length value | a file that looks configured to any reader and supplies nothing |
| `Refused to write over conversation ...` | the bytes were already copied aside and safe | the Queen's own chat unwritable for a month |

## The tell

Any of these, in order of how reliably they fire:

1. **The message never changes.** A real diagnosis varies with the failure. A
   constant string across weeks of different failures is not describing them.
2. **A `try?` or a `catch { }` sits between the failure and the message.** The
   thing that knew got thrown away; the thing that speaks was never told.
3. **The message names a subsystem the function never called.** Grep the
   emitting function for the subsystem it blames. If it isn't there, it is a
   guess.
4. **A boolean stands in for an enum.** `isEmpty` has one shape and five
   causes. Every branch that collapses several states into one word will
   eventually print the wrong one.
5. **The reassuring reading is the frequent one.** "Already done", "nothing to
   do", "all healthy" printed on a loop is how a stuck system looks busy.

## The repair

Do not improve the wording. Change what is measured.

1. **Ask each source and report what each one said.** Not the first answer, not
   a summary - the list.
   ```swift
   // ModelConfigurationStore.credentialDiagnosis
   "store: no entries listed - refused: cooldown armed after an earlier stall; "
   + "config file: TRIOS_ZAI_API_KEY is present but EMPTY - it looks configured "
   + "and supplies nothing; environment: TRIOS_ZAI_API_KEY unset"
   ```
2. **Keep the state, not the boolean.** `Set<Int>` of issue numbers became
   `[Int: [DelegatedTaskState]]` and the false sentence became impossible to
   write. See `QueenDelegationPolicy.spokenForReport`.
3. **Record the outcome where it is observed, read it where it is reported.**
   `KeychainSecrets.lastEnumerationOutcome` exists because the enumeration knows
   why it returned `[]` and the caller does not.
4. **Separate the counts.** A summary that buckets "blocked" with "finished"
   cannot be read. Buckets are the diagnosis; the total is not.
5. **Distinguish empty from absent, everywhere.** This project has now hit the
   same distinction four times: `nil` vs `0` file count, a nonexistent branch
   vs a branch with no commits, an empty config value vs a missing key, and an
   unreadable conversation vs an empty one. It will hit it again.

## Do not confuse the guard with its purpose

Two of the eight were guards that outlived their reason:

- The conversation write-refusal existed to protect the **bytes**. Once `load`
  copied them aside under a quarantine key, refusing the write protected
  nothing and bricked the slot for the life of the install - including
  `ChatConversation.trinityQueenId`, so the Queen dropped every line of her own
  transcript for a month while every tick reported success.
- The Keychain cooldown existed to stop callers **piling up**, not to latch.
  One stalled read at launch left the flag raised for the life of the process.

When you find a guard producing a bad outcome, ask what it is protecting and
whether that thing is already safe by other means. Gate on **the condition it
cares about**, measured now - not on a flag that records that the condition was
once true.

## Later instances (2026-08-21, second sweep)

Four more, found by reading each hot signal against its emitter. The tells
were the same ones listed above:

| The message said | The code actually knew | Tell |
|---|---|---|
| cassette FAIL: "trios-test ran but the marker never appeared" | the marker had not appeared IN 120s; the process was alive and the log still growing when the harness killed it | a fixed deadline standing in for a measurement of progress; fixed by resetting an idle clock on log growth (Makefile `cassettes`) |
| "Timed out: the background read is still in flight" (TriOSEncryption) | the read had COMPLETED in under a millisecond with a deliberate launch-gate refusal; the 60s stall cooldown was armed anyway and kept encryption refused for 55s after the gate lifted | a `try?` discarded the thrown reason; the timeout branch could not tell "hung" from "answered no" |
| "every keychain read is refused for 60s" / "did not answer in 2s" | the cooldown had been per-item for a day, and the callers passed `deadline: 8.0` | the message never changed while the code did; constants in a message that the code takes as parameters |
| "the work exists and nobody is looking at it" (reconcile) | only THIS record's state; a sibling record on the same branch sat in the review queue, and one branch's commits were in HEAD patch-for-patch under other SHAs | the emitting function never asked the registry about siblings or git about patch-ids - it named a conclusion two measurements away |

The second one repeats the guard lesson exactly: the cooldown exists to stop
callers piling up behind a HUNG securityd, and a fast refusal is not that
condition. Gate on what was measured now.

## Writing a new message

Before you commit any `warn`, `error` or refusal string, answer in one line:
**which statement in this function established that?** If the answer is "it is
usually that", write what you actually measured instead, and add the
measurement if it is missing. A wrong diagnosis is worse than none: it sends
the reader somewhere real and wrong, and it survives because it is plausible.

## Third sweep (2026-08-22, the first day tokens were real)

| The message said | The code actually knew | Cost |
|---|---|---|
| chat-probe: `key: MISSING` | the probe never read the env var at all (only a JSON key of the same name in config files); the running app held the key in its cache | release probing was impossible on the reference machine |
| "orphaned keychain calls never return" (my own report) | no settlement was ever measured; once keychain.read.settled existed, every orphan settled with OSStatus 0 in 9.8-215.6s | a night of "securityd is broken" when it is merely slow |
| the $10/day budget "gate" | it gated only NEW dispatches; the review sweep's send-back restarted workers past it | $7.60 of the first real-money day burned through an ungated path |
| "Cannot move ... from cancelled to failed" x4 | the finish handler asked for a transition the state table has never allowed, on every worker that outlived its cancel | steady refusal noise beside every operator cancel |

The repeated shape: a guard, gate or probe that exists SOMEWHERE is quoted
as if it covered every path. The gate is real; the coverage is the claim
nobody measured. When citing a protection, name the exact call sites it
stands on - and grep for the paths it does not.
