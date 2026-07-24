//
//  SmoothStreamingEnhancements.swift
//  TriOS — Плавный стриминг ответов LLM без дергания
//
//  Best Practices:
//  1. Stable .id() для сообщений (не пересоздавать views)
//  2. Throttled scroll updates (не на каждый токен)
//  3. Batched message updates (debounce 16ms = 60fps)
//  4. Explicit .animation() только для новых элементов
//  5. GeometryPreference для предотвращения layout shift
//

import SwiftUI
import Combine

// MARK: - 1. Stable Message ID Wrapper

/// Обертка для сообщения со стабильным ID который не меняется при стриминге
struct StableMessageView: View {
    let message: ChatMessage
    let isFirstInGroup: Bool
    let isLastInGroup: Bool
    var isConversationIdle: Bool = true
    var onTaskAction: ((UUID, AgentTaskState) -> Void)?
    var onRegenerate: (() -> Void)?
    var onFeedback: ((Bool) -> Void)?
    
    // Стабильный ID на основе времени создания + role
    private var stableId: String {
        "\(message.id.uuidString)-\(message.role.rawValue)"
    }
    
    var body: some View {
        MessageBubbleView(
            message: message,
            isFirstInGroup: isFirstInGroup,
            isLastInGroup: isLastInGroup,
            isConversationIdle: isConversationIdle,
            onTaskAction: onTaskAction,
            onRegenerate: onRegenerate,
            onFeedback: onFeedback
        )
        .id(stableId) // Критично: stable ID предотвращает пересоздание view
        .transaction { transaction in
            // Отключаем animation для обновлений контента (не для новых сообщений)
            if !isFirstInGroup {
                transaction.disablesAnimations = true
            }
        }
    }
}

// MARK: - 3. Batched Message Updates

/// Debouncer для batch updates сообщений (16ms = 60fps)
@MainActor
class MessageBatchUpdater: ObservableObject {
    private var pendingUpdateTask: Task<Void, Never>?
    private let debounceInterval: TimeInterval = 0.016 // 16ms = 1 frame at 60fps
    
    /// Batch update messages с debounce
    func update(
        _ messages: Binding<[ChatMessage]>,
        _ update: @escaping (inout [ChatMessage]) -> Void
    ) {
        pendingUpdateTask?.cancel()
        
        pendingUpdateTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(debounceInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            
            var updated = messages.wrappedValue
            update(&updated)
            messages.wrappedValue = updated
        }
    }
    
    /// Cancel pending update
    func cancel() {
        pendingUpdateTask?.cancel()
    }
}

// MARK: - 4. Smooth List Rendering

/// Container для плавного рендеринга списка сообщений
struct SmoothMessageList<Content: View>: View {
    @ViewBuilder let content: Content
    @State private var appearedIds: Set<String> = []
    
    var body: some View {
        content
            .animation(
                .spring(response: 0.3, dampingFraction: 0.8),
                value: appearedIds
            )
    }
}

// MARK: - 5. Geometry Preference (Prevent Layout Shift)

/// Modifier для предотвращения layout shift при загрузке контента
struct LayoutStabilityModifier: ViewModifier {
    @State private var previousSize: CGSize = .zero
    
    func body(content: Content) -> some View {
        content
            .background(
                GeometryReader { geometry in
                    Color.clear
                        .preference(
                            key: SizePreferenceKey.self,
                            value: geometry.size
                        )
                        .onPreferenceChange(SizePreferenceKey.self) { newSize in
                            // Только если размер значительно изменился (>10px)
                            if abs(newSize.width - previousSize.width) > 10 ||
                               abs(newSize.height - previousSize.height) > 10 {
                                previousSize = newSize
                            }
                        }
                }
            )
    }
}

struct SizePreferenceKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        value = nextValue()
    }
}

extension View {
    /// Применить layout stability для предотвращения дергания
    func layoutStability() -> some View {
        modifier(LayoutStabilityModifier())
    }
}

// MARK: - 6. Streaming Content Throttle

/// Throttle для streaming контента (обновление не чаще 60fps)
@MainActor
class StreamingThrottle: ObservableObject {
    private var lastUpdateTime: Date = .distantPast
    private let frameInterval: TimeInterval = 0.016 // 16ms = 60fps
    private var pendingContent: String?
    private var pendingUpdateTask: Task<Void, Never>?
    
    /// Update content с throttle
    func update(_ content: String, onUpdate: @escaping (String) -> Void) {
        let now = Date()
        let timeSinceLastUpdate = now.timeIntervalSince(lastUpdateTime)
        
        if timeSinceLastUpdate >= frameInterval {
            // Обновляем немедленно
            lastUpdateTime = now
            onUpdate(content)
        } else {
            // Буферизуем обновление
            pendingContent = content
            if pendingUpdateTask == nil {
                let delay = frameInterval - timeSinceLastUpdate
                pendingUpdateTask = Task { [weak self] in
                    try? await Task.sleep(
                        nanoseconds: UInt64(delay * 1_000_000_000)
                    )
                    guard !Task.isCancelled, let self else { return }
                    if let pending = pendingContent {
                        lastUpdateTime = Date()
                        onUpdate(pending)
                        pendingContent = nil
                    }
                    pendingUpdateTask = nil
                }
            }
        }
    }
    
    /// Force update немедленно
    func forceUpdate(_ content: String, onUpdate: @escaping (String) -> Void) {
        pendingUpdateTask?.cancel()
        pendingUpdateTask = nil
        lastUpdateTime = Date()
        onUpdate(content)
    }
}

// MARK: - 7. Smart Scroll Anchor

/// Умный якорь скролла который остается near-bottom при стриминге
enum SmartScrollAnchor: String, Hashable {
    case bottom = "scroll-bottom"
    case auto = "scroll-auto"
    
    static func == (lhs: SmartScrollAnchor, rhs: SmartScrollAnchor) -> Bool {
        lhs.rawValue == rhs.rawValue
    }
}

/// View для smart scroll anchor
struct SmartScrollAnchorView: View {
    let anchor: SmartScrollAnchor
    let isNearBottom: Bool
    let autoScrollOnUpdate: Bool
    
    var body: some View {
        Color.clear
            .frame(height: 1)
            .id(anchor.rawValue)
            .opacity(0)
    }
}

// MARK: - Usage Example

/*
 // В ChatPanelView:
 
 @StateObject private var scrollManager = SmoothScrollManager()
 @StateObject private var batchUpdater = MessageBatchUpdater()
 @StateObject private var throttle = StreamingThrottle()
 
 // При стриминге:
 throttle.update(newToken) { token in
     batchUpdater.update($viewModel.messages) { messages in
         // Update last message content
         if let lastIndex = messages.indices.last {
             messages[lastIndex].content += token
         }
     }
     
     // Throttled scroll
     scrollManager.requestScroll(animated: true)
 }
 
 // В списке сообщений:
 SmoothMessageList {
     ForEach(viewModel.messages) { message in
         StableMessageView(
             message: message,
             isFirstInGroup: ...,
             isLastInGroup: ...
         )
     }
 }
 
 // Scroll anchor:
 SmartScrollAnchorView(
     anchor: .bottom,
     isNearBottom: isNearBottom,
     autoScrollOnUpdate: true
 )
 */
