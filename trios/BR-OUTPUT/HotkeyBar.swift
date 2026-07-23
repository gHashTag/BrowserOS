import SwiftUI

// MARK: - HotkeyBar Component

struct HotkeyBar: View {
    @State private var activeHotkey: String?
    @State private var showHelpOverlay = false
    
    var body: some View {
        HStack(spacing: 14) {
            HotkeyChip(
                icon: "arrow.up.circle.fill",
                label: "History",
                keys: ["↑", "↓"],
                color: .blue,
                isActive: activeHotkey == "history"
            )
            
            HotkeyChip(
                icon: "return",
                label: "Send",
                keys: ["⏎"],
                color: .green,
                isActive: activeHotkey == "send"
            )
            
            HotkeyChip(
                icon: "return.left",
                label: "New line",
                keys: ["⇧", "⏎"],
                color: .gray,
                isActive: activeHotkey == "newline"
            )
            
            HotkeyChip(
                icon: "trash.fill",
                label: "Clear",
                keys: ["⌘", "K"],
                color: .orange,
                isActive: activeHotkey == "clear"
            )
            
            HotkeyChip(
                icon: "text.cursor",
                label: "Focus",
                keys: ["⌘", "L"],
                color: .purple,
                isActive: activeHotkey == "focus"
            )
            
            HotkeyChip(
                icon: "command",
                label: "All shortcuts",
                keys: ["⌘", "/"],
                color: .pink,
                isActive: showHelpOverlay,
                action: { showHelpOverlay.toggle() }
            )
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.grokElevated.opacity(0.4))
        .cornerRadius(12)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.grokDivider.opacity(0.5), lineWidth: 1)
        )
        .sheet(isPresented: $showHelpOverlay) {
            HotkeyHelpOverlay(isPresented: $showHelpOverlay)
        }
    }
}

// MARK: - HotkeyChip Component

struct HotkeyChip: View {
    let icon: String
    let label: String
    let keys: [String]
    let color: Color
    let isActive: Bool
    var action: (() -> Void)? = nil
    
    var body: some View {
        Button(action: {
            action?()
        }) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(color)
                
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.grokText)
                
                HStack(spacing: 2) {
                    ForEach(keys, id: \.self) { key in
                        Text(key)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundColor(.grokDim)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 2)
                            .background(Color.grokBackground.opacity(0.6))
                            .cornerRadius(4)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isActive ? color.opacity(0.2) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isActive ? color : Color.grokDivider.opacity(0.3), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help("\(label): \(keys.joined(separator: " + "))")
    }
}

// MARK: - HotkeyHelpOverlay

struct HotkeyHelpOverlay: View {
    @Binding var isPresented: Bool
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Keyboard Shortcuts")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.grokText)
                
                Spacer()
                
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.grokDim)
                }
                .buttonStyle(.plain)
            }
            .padding(20)
            .background(Color.grokBackground)
            .overlay(
                Rectangle()
                    .frame(height: 1)
                    .foregroundColor(.grokDivider),
                alignment: .bottom
            )
            
            // Shortcuts list
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ShortcutCategory(
                        title: "Navigation",
                        shortcuts: [
                            ("Move to previous message", ["↑"]),
                            ("Move to next message", ["↓"]),
                            ("Focus input field", ["⌘", "L"]),
                        ]
                    )
                    
                    ShortcutCategory(
                        title: "Editing",
                        shortcuts: [
                            ("Send message", ["⏎"]),
                            ("New line", ["⇧", "⏎"]),
                            ("Clear input", ["⌘", "K"]),
                            ("Select all", ["⌘", "A"]),
                            ("Copy", ["⌘", "C"]),
                            ("Paste", ["⌘", "V"]),
                            ("Cut", ["⌘", "X"]),
                            ("Undo", ["⌘", "Z"]),
                        ]
                    )
                    
                    ShortcutCategory(
                        title: "Application",
                        shortcuts: [
                            ("Close/Blur input", ["⎋"]),
                            ("Show this help", ["⌘", "/"]),
                            ("Quit application", ["⌘", "Q"]),
                        ]
                    )
                    
                    // Pro tips
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: "lightbulb.fill")
                                .foregroundColor(.yellow)
                            Text("Pro Tips")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(.grokText)
                        }
                        
                        Text("• Use arrow keys to quickly recall previous messages")
                            .font(.system(size: 12))
                            .foregroundColor(.grokDim)
                        Text("• Shift+Enter to format multi-line messages")
                            .font(.system(size: 12))
                            .foregroundColor(.grokDim)
                        Text("• Command+K to quickly clear and start fresh")
                            .font(.system(size: 12))
                            .foregroundColor(.grokDim)
                    }
                    .padding(12)
                    .background(Color.grokElevated.opacity(0.3))
                    .cornerRadius(8)
                }
                .padding(20)
            }
        }
        .frame(width: 450, height: 550)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
}

// MARK: - ShortcutCategory

struct ShortcutCategory: View {
    let title: String
    let shortcuts: [(description: String, keys: [String])]
    
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokDim)
                .textCase(.uppercase)
            
            VStack(alignment: .leading, spacing: 8) {
                ForEach(shortcuts, id: \.description) { shortcut in
                    HStack {
                        Text(shortcut.description)
                            .font(.system(size: 13))
                            .foregroundColor(.grokText)
                        
                        Spacer()
                        
                        HStack(spacing: 3) {
                            ForEach(shortcut.keys, id: \.self) { key in
                                Text(key)
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                                    .foregroundColor(.grokDim)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .background(Color.grokBackground.opacity(0.5))
                                    .cornerRadius(5)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 5)
                                            .stroke(Color.grokDivider.opacity(0.4), lineWidth: 1)
                                    )
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Preview

struct HotkeyBarPreview: PreviewProvider {
    static var previews: some View {
        HotkeyBar()
            .frame(maxWidth: .infinity)
            .background(Color.grokBackground)
    }
}
