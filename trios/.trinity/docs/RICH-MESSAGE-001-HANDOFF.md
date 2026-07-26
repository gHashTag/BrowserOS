# RICH-MESSAGE-001 Agent Handoff

## Objective

Replace the fragile chat Markdown renderer with a deterministic, native SwiftUI
block renderer shared by TriOS and BrowserOS chat.

The visible failure is a GFM table rendered as one wrapped paragraph containing
literal pipe characters and delimiter punctuation. The same renderer also
allocates new block UUIDs during each SwiftUI render, which makes streaming view
identity unstable.

## Current state

- Full access defaults were requested by the user and written to
  `~/.codex/config.toml` as `sandbox_mode = "danger-full-access"` and
  `approval_policy = "never"`. They apply to new tasks or sessions.
- The implementation is complete and the task claim has been released cleanly.
- Behavior SSOT: `trios/.trinity/specs/rich-message-renderer.md`.
- Parser test: `trios/tests/swift/markdown_block_parser_test.swift` passes.
- Renderer: `trios/BR-OUTPUT/RichTextRenderer.swift` now consumes semantic blocks.
- Both message paths already call `RichMessageView` from
  `MessageBubbleView.swift` and `ChatPanelView.swift`.

## Root cause

1. `TextBlock` supports only text, code, headings, and unordered-looking lists.
2. Paragraph parsing joins source lines with a space before table detection.
3. `AttributedString` is configured for inline syntax only.
4. Thematic breaks and quotes have no semantic view.
5. `TextBlock.id` is a new UUID on every parse and render cycle.

## Owned files

The implementation agent may change only these files unless a build error proves
an additional dependency is necessary:

- `trios/.trinity/specs/rich-message-renderer.md`
- `trios/rings/SR-00/MarkdownBlockParser.swift`
- `trios/BR-OUTPUT/RichTextRenderer.swift`
- `trios/tests/swift/markdown_block_parser_test.swift`
- PHI LOOP coordination, checkpoint, seal, and experience artifacts for this task

Do not revert BrowserClaw supervisor, localhost binding, signing, or other user
changes already present in the worktree.

## Implementation contract

1. Create a pure parser with stable source-position IDs.
2. Recognize headings, fenced code, GFM tables, thematic breaks, quotes, ordered
   lists, unordered lists, and paragraphs.
3. Preserve paragraph newlines.
4. Parse escaped table pipes and pipes inside inline code.
5. Render tables with native `Grid` inside horizontal `ScrollView`.
6. Render quotes with a leading rule, and thematic breaks with `Divider`.
7. Keep prose wrapping inside the proposed width.
8. Use inline Markdown only inside already-classified block content.

## Verification

Run from `/Users/playra/BrowserOS/trios`:

```text
swiftc -parse-as-library rings/SR-00/MarkdownBlockParser.swift tests/swift/markdown_block_parser_test.swift -o /private/tmp/markdown_block_parser_test
/private/tmp/markdown_block_parser_test
./build.sh
```

Then restart `trios.app`, open the chat, and verify the supplied Russian status
answer. The table must have aligned columns, `---` must render as a divider, and
the list must remain readable without horizontal prose scrolling.

## Definition of done

- Parser tests pass.
- Full Swift build and code-signature verification pass.
- Live BrowserOS Agent health remains `status=ok` and `cdpConnected=true`.
- UI has no raw table pipes or literal thematic-break markers.
- Source additions pass the ASCII-only policy.
- Checkpoint and experience artifacts are saved.
- Claim is released with a clean result and the queue item moves to done.

## Completion record

- Parser tests: PASS.
- Full Swift build: PASS, 60 source files compiled.
- App signature verification: PASS.
- Live health: `status=ok`, `cdpConnected=true`.
- ASCII audit of all new source, spec, handoff, and agent files: PASS.
- Automated desktop screenshot: unavailable because macOS Screen Recording was
  not granted to the current Codex host. The rebuilt app is running for manual
  visual confirmation.

Use this handoff for regression work or follow-up snapshot testing. Do not repeat
the completed parser migration unless a failing test demonstrates a regression.

