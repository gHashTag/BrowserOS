import SwiftUI

// MARK: - SearchOverlayView

struct SearchOverlayView: View {
    @Binding var isPresented: Bool
    @Binding var inputText: String
    @State private var query = ""
    @State private var selectedIndex = 0
    @FocusState private var isSearchFocused: Bool
    
    let messageHistory: [String]
    var onSelect: (String) -> Void
    
    private var filteredResults: [String] {
        guard !query.isEmpty else {
            return Array(messageHistory.prefix(20))
        }
        
        let lowercasedQuery = query.lowercased()
        return messageHistory
            .filter { $0.lowercased().contains(lowercasedQuery) }
            .prefix(20)
            .map { $0 }
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Search field
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16))
                    .foregroundColor(.grokDim)
                
                TextField("Search history...", text: $query)
                    .font(.system(size: 16))
                    .textFieldStyle(.plain)
                    .focused($isSearchFocused)
                    .onSubmit {
                        if !filteredResults.isEmpty {
                            selectResult(filteredResults[selectedIndex])
                        }
                    }
                
                if !query.isEmpty {
                    Button(action: { query = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundColor(.grokDim)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
            .background(Color.grokElevated.opacity(0.5))
            .cornerRadius(12)
            .padding(16)
            
            Divider().overlay(Color.grokDivider)
            
            // Results list
            if filteredResults.isEmpty {
                emptyStateView
            } else {
                resultsListView
            }
        }
        .frame(width: 500, height: 400)
        .background(Color.grokBackground)
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.3), radius: 20)
        .onAppear {
            isSearchFocused = true
        }
        .onKeyDown { key in
            handleKeyPress(key)
        }
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 12) {
            Spacer()
            
            Image(systemName: "magnifyingglass")
                .font(.system(size: 48))
                .foregroundColor(.grokDim.opacity(0.5))
            
            Text(query.isEmpty ? "No recent messages" : "No matches found")
                .font(.system(size: 16))
                .foregroundColor(.grokDim)
            
            Text("Type to search through your conversation history")
                .font(.system(size: 12))
                .foregroundColor(.grokDim)
            
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
    
    private var resultsListView: some View {
        ScrollView {
            LazyVStack(spacing: 4) {
                ForEach(Array(filteredResults.enumerated()), id: \.offset) { index, result in
                    SearchResultRow(
                        text: result,
                        isSelected: index == selectedIndex,
                        onClick: { selectResult(result) }
                    )
                }
            }
            .padding(8)
        }
    }
    
    private func selectResult(_ text: String) {
        inputText = text
        isPresented = false
        onSelect(text)
    }
    
    private func handleKeyPress(_ key: Key) -> Bool {
        switch key {
        case .downArrow:
            selectedIndex = min(selectedIndex + 1, filteredResults.count - 1)
            return true
        case .upArrow:
            selectedIndex = max(selectedIndex - 1, 0)
            return true
        case .return:
            if !filteredResults.isEmpty {
                selectResult(filteredResults[selectedIndex])
            }
            return true
        case .escape:
            isPresented = false
            return true
        default:
            return false
        }
    }
}

// MARK: - SearchResultRow

struct SearchResultRow: View {
    let text: String
    let isSelected: Bool
    let onClick: () -> Void
    
    var body: some View {
        Button(action: onClick) {
            HStack {
                Text(truncateText(text, maxLength: 80))
                    .font(.system(size: 14))
                    .foregroundColor(.grokText)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isSelected ? Color.grokElevated : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }
    
    private func truncateText(_ text: String, maxLength: Int) -> String {
        if text.count <= maxLength {
            return text
        }
        return String(text.prefix(maxLength - 3)) + "..."
    }
}

// MARK: - Key Extension

extension View {
    func onKeyDown(handler: @escaping (Key) -> Bool) -> some View {
        self.background(
            KeyEventView(handler: handler)
        )
    }
}

struct KeyEventView: NSViewRepresentable {
    let handler: (Key) -> Bool
    
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        return view
    }
    
    func updateNSView(_ nsView: NSView, context: Context) {
        // Handled via NSEvent monitoring
    }
}

enum Key {
    case upArrow, downArrow, `return`, escape, tab, space
    case character(String)
}

// MARK: - Preview

#if DEBUG
struct SearchOverlayViewPreview: PreviewProvider {
    static var previews: some View {
        SearchOverlayView(
            isPresented: .constant(true),
            inputText: .constant(""),
            messageHistory: [
                "How do I use hotkeys?",
                "Show me the status",
                "Run tests",
                "Clear this conversation",
                "What's the weather?"
            ],
            onSelect: { _ in }
        )
        .frame(width: 500, height: 400)
    }
}
#endif
