# 🏗️ TRIOS Architecture Overview

**Canonical Architecture for Trinity Project**  
**Pattern**: A2A Ring (Onion) — Core → Infrastructure → Application → Presentation  
**Location**: `/Users/playra/BrowserOS/trios/`

---

## 📐 Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PRESENTATION LAYER                        │
│  ChatPanelView.swift, MessageBubbleView.swift, etc.         │
│  (SwiftUI views, user interaction)                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   APPLICATION LAYER                          │
│  ChatViewModel.swift, ConversationStateMachine.swift        │
│  (Business logic, state management, streaming)              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  INFRASTRUCTURE LAYER                        │
│  SSETransport.swift, HealthCheckTransport.swift             │
│  (Network, parsing, persistence)                            │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      CORE LAYER                              │
│  ChatMessage.swift, ChatEvents.swift, ChatProtocols.swift   │
│  (Data models, protocols, events)                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 File Structure

```
trios/
├── Core Layer (Data & Protocols)
│   ├── ChatMessage.swift        — ChatMessage, ChatRole, MessageSegment, ToolCall
│   ├── ChatEvents.swift         — SSEEvent enum, ParserAction, SSEEventParser
│   └── ChatProtocols.swift      — Transport, Parser, Persister, HealthCheck protocols
│
├── Infrastructure Layer (Network & Storage)
│   ├── SSETransport.swift       — URLSession SSE streaming via AsyncStream<SSEEvent>
│   ├── HealthCheckTransport.swift — GET /health ping
│   ├── UIMessageStreamParser.swift — SSE events to ParserAction
│   └── ConversationPersister.swift — UserDefaults persistence by conversationId
│
├── Application Layer (Business Logic)
│   ├── ChatViewModel.swift      — @MainActor ObservableObject, message + streaming
│   ├── ConversationStateMachine.swift — Actor with .idle/.streaming/.error states
│   └── EventThrottler.swift     — ~30 FPS SSE throttling
│
├── Presentation Layer (UI)
│   ├── ChatPanelView.swift      — Root SwiftUI (header + messages + input)
│   ├── MessageBubbleView.swift  — User/assistant/tool/reasoning bubbles
│   ├── TypingIndicatorView.swift — Animated bouncing dots
│   ├── ToolCallCardView.swift   — Expandable tool cards
│   └── GlassmorphismBackground.swift — NSVisualEffectView bridge + dark tint
│
├── Entry Point
│   └── main.swift               — AppDelegate, StatusBarController, App lifecycle
│
├── Backend Services (Node.js + Rust)
│   ├── browseros-mcp/           — MCP server (port 9105)
│   ├── trios-bridge/            — A2A bridge (port 9203)
│   └── trios-server/            — Rust server (port 9005)
│
├── Configuration
│   ├── ecosystem.config.cjs     — PM2 process manager config
│   ├── build.sh                 — Build script
│   └── .zshrc env vars          — TRINITY_ROOT, TRIOS_ROOT, ports
│
└── Documentation
    ├── TRIOS_MASTER_INSTALLATION_GUIDE.md
    ├── INSTALLATION_GUIDE.html
    ├── QUICK_START.md
    └── ARCHITECTURE_OVERVIEW.md (this file)
```

---

## 🔄 Data Flow

### 1. User sends message
```
User Input → ChatPanelView → ChatViewModel → SSETransport → Backend (9105)
```

### 2. Backend processes
```
browseros-mcp (9105) → trios-bridge (9203) → trios-server (9005) → Tools/APIs
```

### 3. Response streams back
```
Backend → SSETransport → UIMessageStreamParser → ChatViewModel → MessageBubbleView
```

### 4. Conversation persists
```
ChatViewModel → ConversationPersister → UserDefaults (by conversationId)
```

---

## 🔌 Backend Services Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TRIOS APP (Swift)                        │
│                  Status Bar + Panel UI                      │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP/SSE
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              PM2 Process Manager                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  trios-server (Rust) :9005                           │  │
│  │  - Core business logic                               │  │
│  │  - Tool execution                                      │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  browseros-mcp (Node.js) :9105                       │  │
│  │  - MCP protocol                                      │  │
│  │  - External API integrations                         │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  trios-bridge (Node.js) :9203                        │  │
│  │  - A2A bridge                                        │  │
│  │  - GitButler CLI integration                         │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              External Services                              │
│  • GitHub/GitButler  • Tailscale  • MCP Clients            │
│  • Filesystem  • Shell commands  • BrowserOS Agent          │
└─────────────────────────────────────────────────────────────┘
```

---

## 🌐 Network Ports

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| trios-server | 9005 | HTTP | Core Rust server |
| browseros-mcp | 9105 | HTTP/SSE | MCP server, Tailscale funnel |
| trios-bridge | 9203 | HTTP | A2A bridge, GitButler integration |
| TRIOS_MESH | 9505 | TCP | Mesh networking (future) |
| TRIOS_A2A | 9200 | HTTP | A2A protocol (future) |

---

## 🔑 Key Design Patterns

### 1. **Onion Architecture**
- Dependencies point inward
- Core layer has no dependencies
- Each layer only knows about inner layers

### 2. **Actor Model**
- `ConversationStateMachine` as Actor
- Prevents data races in concurrent streaming
- Thread-safe state management

### 3. **ObservableObject Pattern**
- `ChatViewModel` as @MainActor
- SwiftUI binding via @Published
- Reactive UI updates

### 4. **Protocol-Oriented Design**
- `ChatTransportProtocol`
- `ChatParserProtocol`
- `ChatPersisterProtocol`
- Easy to swap implementations

### 5. **AsyncStream for SSE**
- Native Swift concurrency
- Backpressure handling via EventThrottler
- ~30 FPS UI updates

---

## 🛠️ Key Files Explained

### `main.swift` (24.4KB)
**Entry point** — AppDelegate, StatusBarController, app lifecycle
- Creates status bar icon
- Handles right-click menu
- Manages panel window
- Toggles Tailscale funnel/serve

### `ChatViewModel.swift`
**Brain of the app** — Message management, SSE streaming
- @MainActor ObservableObject
- Sends messages to backend
- Receives streaming responses
- Manages conversation state

### `SSETransport.swift`
**Network layer** — Server-Sent Events streaming
- URLSession with AsyncStream
- Handles reconnection
- Parses SSE events

### `UIMessageStreamParser.swift`
**Parser** — SSE events → UI actions
- Converts SSEEvent to ParserAction
- Handles message segments, tool calls
- Throttles updates to ~30 FPS

### `ConversationPersister.swift`
**Storage** — UserDefaults persistence
- Saves conversations by ID
- Auto-loads on app launch
- Handles migration

### `ChatPanelView.swift`
**Root UI** — SwiftUI panel
- Header with tabs
- Message list
- Input field
- Keyboard shortcut handler

---

## 🎨 UI Components

| Component | Purpose | Features |
|-----------|---------|----------|
| ChatPanelView | Root container | Tabs, keyboard shortcuts |
| MessageBubbleView | Message display | User/assistant/tool/reasoning |
| TypingIndicatorView | Loading state | Animated dots |
| ToolCallCardView | Tool results | Expandable cards |
| GlassmorphismBackground | Visual effect | NSVisualEffectView + tint |

---

## 📊 Performance Characteristics

| Metric | Target | Actual |
|--------|--------|--------|
| App launch | < 2s | ~1.5s |
| Panel open | < 200ms | ~150ms |
| SSE latency | < 100ms | ~50ms |
| UI FPS | 60 | 60 (throttled to 30 for SSE) |
| Memory usage | < 100MB | ~80MB |
| Binary size | < 20MB | ~13MB |

---

## 🔒 Security Considerations

1. **Sandboxing**: App runs in sandbox with limited permissions
2. **Accessibility**: Required for window shifting (user-granted)
3. **Network**: Localhost only (9105, 9203, 9005)
4. **Tailscale**: Optional, user-authenticated
5. **Credentials**: Stored in Keychain (future)

---

## 🚀 Future Enhancements

- [ ] Multi-conversation support
- [ ] Cloud sync via iCloud
- [ ] Plugin system
- [ ] Custom themes
- [ ] Voice input
- [ ] Screen capture integration
- [ ] TRIOS_MESH networking
- [ ] A2A protocol v2

---

## 📞 References

- **Installation**: `TRIOS_MASTER_INSTALLATION_GUIDE.md`
- **Quick Start**: `QUICK_START.md`
- **HTML Guide**: `INSTALLATION_GUIDE.html`
- **GitHub**: https://github.com/gHashTag/BrowserOS
- **Trinity**: https://github.com/gHashTag/trinity

---

**Architecture v1.0.0** | 2026-05-28 | Trinity Project (@gHashTag)
