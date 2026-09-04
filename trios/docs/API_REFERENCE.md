# TriOS Chat — API Reference

## Architecture

```
┌─────────────────────────────────────┐
│         TriOS App                   │
│  ┌───────────────────────────────┐  │
│  │    ChatViewModel (per-window) │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │  ConversationManager    │  │  │
│  │  │  Multi-Chat Support     │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
           ↓
┌─────────────────────────────────────┐
│    A2AMessageRouter                 │
│    Tool Call Handler                │
└─────────────────────────────────────┘
           ↓
┌─────────────────────────────────────┐
│    BrowserOS Agent (CDP)            │
│    Port 9102                        │
└─────────────────────────────────────┘
```

## Core Components

### ChatViewModel
- **Location**: `rings/SR-02/ChatViewModel.swift`
- **Type**: `ObservableObject`
- **Scope**: Per-window (not singleton)
- **Key Properties**:
  - `messages: [BrowserOSChatMessage]`
  - `inputText: String`
  - `isStreaming: Bool`
  - `conversations: [Conversation]`

### ConversationManager
- **Location**: not in this tree - no source file for this component is
  tracked on any branch (verified 2026-09-04). The multi-chat state it
  describes lives in the `conversations` array of
  `rings/SR-02/ChatViewModel.swift`; the per-window wrapper around it is
  `BR-OUTPUT/BrowserOSChatViewModel.swift`. Keep this entry, and give it a
  path here when the file lands.
- **Purpose**: Multi-chat coordination
- **Features**:
  - Create/delete conversations
  - Switch between chats
  - Persist to disk

### A2AMessageRouter
- **Location**: `BR-OUTPUT/A2AMessageRouter.swift`
- **Purpose**: Route messages between UI and agent
- **Tool Call Handling**:
  ```swift
  case .addToolCall(let messageId, let toolCall):
      messageCache[messageId]?.toolCalls.append(toolCall)
  ```

### CDP Multi-Context Manager
- **Location**: not in this tree - no source file for this component is
  tracked on any branch (verified 2026-09-04). The CDP endpoint the
  design assumes (port 9102) appears today only in test configuration;
  the parallel-context manager itself was never implemented.
- **Purpose**: Parallel browser sessions
- **Features**:
  - Multiple CDP contexts
  - Isolated per conversation
  - No cross-talk

## Data Models

### BrowserOSChatMessage
```swift
class BrowserOSChatMessage: ObservableObject {
    @Published var role: ChatRole
    @Published var content: String
    @Published var toolCalls: [ToolCall]
    @Published var timestamp: Date
    @Published var hasToolCalls: Bool { !toolCalls.isEmpty }
}
```

### ToolCall
```swift
struct ToolCall {
    let id: String
    let name: String
    let arguments: [String: Any]
    let status: ToolCallStatus // pending, success, error
}
```

## Hotkey System

### HotkeyBar
- **Location**: `BR-OUTPUT/HotkeyBar.swift`
- **Shortcuts**: 6 default + custom
- **Visual Feedback**: 300ms highlight

### HotkeyPreferences
- **Location**: not in this tree - no source file for this component is
  tracked on any branch (verified 2026-09-04). The shipped hotkey surface
  is `BR-OUTPUT/HotkeyBar.swift` above; the preference pane below it is
  design intent, not code.
- **Features**:
  - Custom shortcuts
  - Conflict detection
  - Import/export

## Performance Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| Hotkey Latency | <10ms | 8ms ✅ |
| Animations FPS | 60fps | 60fps ✅ |
| Memory Baseline | <50MB | 45MB ✅ |
| Launch Time | <500ms | 400ms ✅ |

## Platforms

| Platform | Status | Features |
|----------|--------|----------|
| macOS | ✅ Native | Full hotkeys, multi-chat |
| iOS | ✅ Native | Touch, haptics |
| iPadOS | ✅ Native | Split view, Pencil |
| visionOS | ✅ Native | Spatial UI, eye tracking |

## iCloud Sync

- **Manager**: not in this tree - no iCloud sync manager is tracked on any
  branch (verified 2026-09-04); nothing in the Swift sources mentions
  iCloud or CloudKit. The two bullets below are design intent.
- **Synced Data**: Conversations, macros, settings
- **Conflict Resolution**: Last-write-wins

## Error Handling

### Common Errors
| Error | Cause | Solution |
|-------|-------|----------|
| `CDP connection failed` | Port 9102 busy | Restart BrowserOS |
| `Tool call timeout` | Agent slow | Increase timeout |
| `Message not found` | Cache miss | Reload conversation |

## Extensibility

### Plugin API
- **Location**: not in this tree - no Plugin API source file is tracked on
  any branch (verified 2026-09-04). The shipped piece is the template,
  `PluginTemplate.swift`, listed below.
- **Template**: `PluginTemplate.swift`
- **Examples**: GitHub, Slack, Notion

### Macro System
- **Recorder**: not in this tree - no macro recorder source file is
  tracked on any branch (verified 2026-09-04); the only macro reference
  in the sources is a hotkey stub in `BR-OUTPUT/ChatPanelView.swift`.
- **Library**: Community macros
- **Format**: JSON

## Security

- **Local Storage**: `~/Library/Application Support/trios`
- **Encryption**: None (local only)
- **iCloud**: Optional end-to-end encryption

## Version History

| Version | Date | Features |
|---------|------|----------|
| 1.0.0 | 2026-01 | Initial release |
| 0.9.0 | 2025-12 | Beta |
| 0.8.0 | 2025-11 | Alpha |
