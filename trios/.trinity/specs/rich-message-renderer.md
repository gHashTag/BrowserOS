# Rich Message Renderer Specification

Issue: T27-EPIC-001
Task: RICH-MESSAGE-001
Owner: Chat UI

## Purpose

Render streamed assistant Markdown as stable native SwiftUI blocks without
flattening document structure or overflowing the chat panel.

## Block Contract

The parser must recognize these block types before paragraph fallback:

1. ATX headings.
2. Fenced code blocks with an optional language.
3. GFM pipe tables with a header, delimiter row, column alignment, and body.
4. Thematic breaks made from hyphens, asterisks, or underscores.
5. Consecutive block quote lines.
6. Consecutive unordered or ordered list items.
7. Paragraphs that preserve source line boundaries.

Every parsed block must have a deterministic identifier derived from its source
position and kind. Re-parsing unchanged source must return identical IDs.

## Layout Contract

- Ordinary prose wraps inside the width proposed by the chat panel.
- Tables use a native grid inside a horizontal scroll container.
- Table headers and body cells retain inline Markdown formatting.
- Thematic breaks render as dividers, not literal punctuation.
- Quotes have a leading rule and distinct background.
- Code and tables may scroll horizontally; prose must not overflow horizontally.
- The same renderer is used by the TriOS and BrowserOS chat paths.

## Streaming Contract

- Re-parsing an unchanged completed prefix keeps block identity stable.
- An incomplete trailing construct falls back to readable text until it becomes
  structurally valid.
- Parser output is a pure value and must not depend on SwiftUI render cycles.

## Tests

1. A valid GFM table becomes one table block with parsed alignment and cells.
2. Pipe characters inside inline code or escaped text do not split a cell.
3. A thematic break becomes a thematic-break block.
4. Consecutive quote lines become one quote block.
5. Ordered and unordered lists retain their marker kind.
6. Paragraph source line boundaries are preserved.
7. Identical input produces identical block identifiers.
8. Incomplete table input remains readable paragraph text.

## Invariants

- Source code and first-party documentation remain English and ASCII-only.
- The parser never evaluates HTML, scripts, links, or message content.
- No view uses an unconstrained horizontal fixed size for prose.
- Existing code-block copy behavior remains available.

