---
name: chat-logic
domain: Language
agent: L
priority: P0
status: active
claim_id: CHATLOGIC-001
task_id: CHATLOGIC-001
issue: "#T27-EPIC-001"
---

# Spec: ChatLogic - Pure Chat Parsing and Intent Router

## Purpose

Provide framework-free, unit-testable helpers for parsing chat input and routing it to BrowserOS MCP tools. The logic must never fall through to raw shell execution; unrecognized input returns `nil`.

## Invariants

### INV-1: No Raw Shell Fallthrough
`parseIntent(_:pageId:)` returns either a structured tool call or `nil`. It must never silently execute arbitrary shell text.

### INV-2: Strict Command Recognition
Only messages matching an explicit prefix list (`shell `, `run `, `exec `, `navigate `, etc.), an exact command word (`click`, `screenshot`, `extract`, `pwd`), or a slash path (`/`, `./`) are considered commands.

### INV-3: Recursive Self-Launch Block
Any shell command matching the recursive-launch patterns must be rewritten to a safe `echo` via the `filesystem_bash` tool, never executed as written.

### INV-4: Page ID Threading
When a `pageId` is provided, `parseIntent` threads it into tool arguments for `navigate_page`, `click`, `take_screenshot`, and `get_page_content`.

### INV-5: URL Extraction
`extractURL(from:)` returns the first `http://` or `https://` URL from free text, or `nil`.

### INV-6: First Page ID Parsing
`firstPageId(in:)` parses the leading numeric id from `list_pages` text output (format: `"<id>. Title (tab N)\n   url"`).

## Interface

```swift
enum ChatLogic {
    static func firstPageId(in text: String) -> Int?
    static func isLikelyCommand(_ text: String) -> Bool
    static func parseIntent(_ text: String, pageId: Int?) -> (String, [String: Any])?
    static func extractURL(from text: String) -> String?
}
```

## Tool Mapping

| Input pattern | Tool | Arguments |
|---|---|---|
| `navigate ` / `go to ` / `open ` / `browse ` | `navigate_page` | `url` (extracted or default `https://google.com`), optional `page` |
| `click` / `click ` / `press` / `press ` | `click` | optional `page`, default `element: "1"` |
| `screenshot` / `screenshot ` / `capture` / `capture ` | `take_screenshot` | optional `page` |
| `extract` / `extract ` / `get data ` / `content ` | `get_page_content` | optional `page` |
| `shell ` / `run ` / `exec ` | `filesystem_bash` | `command`, `description`; blocked if matches recursive-launch patterns |

## Recursive-Launch Patterns

Commands matching any of the following regexes (case-insensitive) are blocked:
- `trios_app`
- `open trios\b`
- `open trios\.app`
- `swiftc.*trios`
- `launchd.*trios`
- `clade-promote.*boot`

Blocked output:
```swift
("filesystem_bash", [
    "command": "echo 'Blocked: command may cause recursive self-launch: \(cmd)'",
    "description": "Blocked self-launch"
])
```

## Tests

### T-1: Unit Test Suite
Run `swiftc tests/swift/chat_logic_test.swift BR-OUTPUT/ChatLogic.swift -o /tmp/chat_logic_test && /tmp/chat_logic_test`.

Covered behaviors:
- `firstPageId` parses ids 0, 3, indented values, and returns nil for empty listings.
- `isLikelyCommand` accepts explicit prefixes, exact commands, slash paths.
- `isLikelyCommand` rejects fuzzy matches like `running`, `clicking`.
- `extractURL` returns the first http(s) URL.
- `parseIntent` maps recognized inputs to the correct tool.
- `parseIntent` threads `pageId` and extracts URLs.
- Recursive-launch patterns are blocked and rewritten to safe echo.
- Ordinary shell commands are passed through verbatim.
- Innocuous `trios` substrings are not blocked.

### T-2: Build Pass
`./build.sh` must compile all Swift sources without errors.

### T-3: Rust Verification
`cargo test --workspace` and `cargo clippy --all-targets --all-features` must pass.

## Constraints

- Foundation only in `ChatLogic.swift`; no SwiftUI/Combine.
- ASCII-only source; English identifiers and comments.
- No hardcoded absolute paths.
- No new shell scripts (L7 UNITY).

## Change Flow

Any change to this spec or `BR-OUTPUT/ChatLogic.swift` must pass:

1. Spec update (this file).
2. t27-creator implementation.
3. t27-verifier L1-L7 verdict.
4. `/t27-tri-pipeline seal`.
5. Land with `Closes #T27-EPIC-001`.
6. `/t27-experience-save`.
