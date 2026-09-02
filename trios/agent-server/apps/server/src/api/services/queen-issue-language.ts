/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The language gate for agent-created GitHub tasks.
 *
 * The Queen product is bilingual on purpose: its dashboard speaks Russian and
 * English, its historical issues are written in both, and none of that is
 * changing. This module does not touch any of it. It exists for exactly one
 * direction of travel - NEW issues being created by agents - and enforces one
 * rule on them: the development queue is English-only.
 *
 * Why a gate at all. A task written in Russian drops into a queue whose
 * workers are instructed, in English, to keep every line they produce in
 * English: source, tests, commit messages, the verdict itself. The task text
 * is the one input that shapes all of that output, so a Cyrillic task either
 * produces English work that answers a question the worker could not fully
 * read, or it drags a second language through the whole pipeline. Refusing it
 * at the door - before a single byte reaches GitHub - is cheaper than either.
 *
 * What this deliberately is NOT:
 *
 *   - It is not a translator. Nothing rewrites or "fixes" the text; the caller
 *     goes back and writes the task in English. Rewriting silently would hide
 *     exactly the decision the author needs to make.
 *   - It is not a general script filter. Ordinary task text carries Markdown,
 *     file paths, shell commands and identifiers, and all of that must pass.
 *     The one thing refused is Cyrillic, and the empty title, because a task
 *     with no title is not a task.
 *   - It is not applied to reading. `gh issue list` and every historical issue
 *     stays exactly as bilingual as it is today; the policy is creation-only.
 *
 * The validator is a pure function of its two arguments: no clock, no
 * environment, no I/O, so the same input always gets the same verdict - which
 * is what lets the pre-commit gate and the wrapper share one answer.
 */

/**
 * Every Cyrillic code point, in every block it lives in.
 *
 * `\p{Script=Cyrillic}` covers all assigned letters, including blocks newer
 * than this file (Extended-C, Extended-D and whatever follows). The explicit
 * ranges are still needed alongside it: a few combining marks inside the
 * Cyrillic blocks are classified with script `Inherited`, so a bare script
 * property would let `a\u0488` slip through as "not Cyrillic". The ranges
 * close that hole.
 */
const CYRILLIC =
  /[\u0400-\u052F\u1C80-\u1C88\u2DE0-\u2DFF\uA640-\uA69F\p{Script=Cyrillic}]|\uFE2E|\uFE2F/u

/** The one rule this module enforces, in the caller-facing error text. */
export const ENGLISH_ONLY_RULE =
  'New GitHub tasks must be written in English only: Cyrillic (Russian) characters are not allowed in the title or the body. Write the task in English and try again.'

/** Which of the two fields a verdict is about. */
export type QueenIssueField = 'title' | 'body'

/** The task passed the gate. There is nothing else to say. */
export interface QueenIssueLanguageOk {
  ok: true
}

/**
 * The task was refused before it reached GitHub.
 *
 * `reason` names the rule; it never quotes the submitted text. A body can
 * contain credentials or anything else sensitive, and the refusal is printed
 * to terminals and logs - so it carries the field name and the rule, and not
 * one character of the input.
 */
export interface QueenIssueLanguageRefusal {
  ok: false
  field: QueenIssueField
  reason: string
}

export type QueenIssueLanguageVerdict =
  | QueenIssueLanguageOk
  | QueenIssueLanguageRefusal

/**
 * True when the text contains any Cyrillic code point.
 *
 * Accepts `unknown` on purpose: the honest failure of a validator is a clear
 * refusal, never a crash on input that came from outside the program.
 */
export function containsCyrillic(text: unknown): boolean {
  return typeof text === 'string' && CYRILLIC.test(text)
}

/**
 * Validate a GitHub issue title and body against the English-only policy.
 *
 * Refused, in this order:
 *   - a title that is not a string, or empty after trimming;
 *   - a title containing Cyrillic;
 *   - a body that is not a string (an empty body is fine - `gh` allows it and
 *     emptiness is not a language question);
 *   - a body containing Cyrillic.
 *
 * Everything else passes: plain English, Markdown, file paths, shell
 * commands, identifiers, other Latin diacritics, emoji. The gate is about one
 * script, not about taste.
 */
export function validateIssueLanguage(
  title: unknown,
  body: unknown,
): QueenIssueLanguageVerdict {
  if (typeof title !== 'string') {
    return {
      ok: false,
      field: 'title',
      reason: 'The issue title must be a string.',
    }
  }
  if (title.trim().length === 0) {
    return {
      ok: false,
      field: 'title',
      reason: 'The issue title must not be empty.',
    }
  }
  if (containsCyrillic(title)) {
    return { ok: false, field: 'title', reason: ENGLISH_ONLY_RULE }
  }
  if (typeof body !== 'string') {
    return {
      ok: false,
      field: 'body',
      reason: 'The issue body must be a string.',
    }
  }
  if (containsCyrillic(body)) {
    return { ok: false, field: 'body', reason: ENGLISH_ONLY_RULE }
  }
  return { ok: true }
}
