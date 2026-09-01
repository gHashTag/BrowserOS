# GitHub Issue Language Policy

Tracking issue: `gHashTag/trios#1291`.

## Observable contract

The product UI may present the Queen dashboard in Russian or English. New
GitHub tasks are different: every issue title and body created by Queen must be
English before any network request is made.

## Acceptance criteria

1. An English title and English body are accepted.
2. A title or body containing a non-ASCII letter is refused before the GitHub
   POST and the refusal names the offending field.
3. Empty titles and bodies are refused rather than creating content-free work.
4. Language-neutral punctuation, Markdown, paths, URLs, and emoji remain
   allowed.
5. Existing historical issues remain readable and delegable; the contract
   governs new issue creation only.
6. Lefthook runs the deterministic policy suite and refuses the commit when it
   fails.

## Non-regression

- Russian and English website locales keep the same Queen copy keys.
- Runtime localization never grants permission to create a non-English GitHub
  task.
- The server-side QueenCore mirror remains byte-for-byte identical to the app
  policy source.
