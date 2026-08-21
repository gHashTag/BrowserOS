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

## Writing a new message

Before you commit any `warn`, `error` or refusal string, answer in one line:
**which statement in this function established that?** If the answer is "it is
usually that", write what you actually measured instead, and add the
measurement if it is missing. A wrong diagnosis is worse than none: it sends
the reader somewhere real and wrong, and it survives because it is plausible.
