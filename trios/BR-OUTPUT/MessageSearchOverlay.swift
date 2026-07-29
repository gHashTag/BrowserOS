import SwiftUI

// MARK: - Message Search Overlay (⌘F)

struct MessageSearchOverlay: View {
    @Binding var isPresented: Bool
    @Binding var query: String
    let messages: [ChatMessage]
    let onSelectMessage: (ChatMessage) -> Void
    
    @State private var selectedIndex = 0
    @State private var searchResults: [ChatMessage] = []
    
    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.grokDim)
                
                TextField("Search messages...", text: $query)
                    .textFieldStyle(PlainTextFieldStyle())
                    .font(.system(size: 14))
                    .onSubmit {
                        performSearch()
                    }
                
                if !query.isEmpty {
                    Button(action: {
                        query = ""
                        performSearch()
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.grokDim)
                    }
                    .buttonStyle(.plain)
                }
                
                Spacer()
                
                Text("⎋ Close")
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
            }
            .padding(12)
            .background(Color.grokElevated.opacity(0.5))
            
            // Results count
            if !query.isEmpty {
                HStack {
                    Text("\(searchResults.count) result\(searchResults.count == 1 ? "" : "s")")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                    
                    Spacer()
                    
                    if selectedIndex > 0 {
                        Button(action: navigateUp) {
                            Image(systemName: "chevron.up")
                                .font(.system(size: 10))
                                .foregroundColor(.grokText)
                        }
                        .buttonStyle(.plain)
                    }
                    
                    if selectedIndex < searchResults.count - 1 {
                        Button(action: navigateDown) {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10))
                                .foregroundColor(.grokText)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.grokBackground)
            }
            
            // Results list
            if searchResults.isEmpty && !query.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "text.magnifyingglass")
                        .font(.system(size: 32))
                        .foregroundColor(.grokDim)
                    Text("No messages found")
                        .font(.system(size: 14))
                        .foregroundColor(.grokDim)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.grokBackground)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(searchResults.enumerated()), id: \.element.id) { index, message in
                            MessageSearchResultRow(
                                message: message,
                                query: query,
                                isSelected: index == selectedIndex,
                                action: {
                                    onSelectMessage(message)
                                    isPresented = false
                                }
                            )
                            .onTapGesture {
                                onSelectMessage(message)
                                isPresented = false
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }
                .background(Color.grokBackground)
            }
        }
        .frame(maxWidth: 500, maxHeight: 400)
        .background(Color.grokBackground)
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.3), radius: 20)
        .onAppear {
            performSearch()
        }
        .onChange(of: query) { _, _ in
            performSearch()
        }
    }
    
    private func performSearch() {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedQuery.isEmpty {
            searchResults = []
            selectedIndex = 0
            return
        }
        
        searchResults = messages.filter { message in
            message.content.localizedCaseInsensitiveContains(trimmedQuery) ||
            message.segments.contains { segment in
                switch segment {
                case .text(let text):
                    return text.localizedCaseInsensitiveContains(trimmedQuery)
                case .reasoning(let text):
                    return text.localizedCaseInsensitiveContains(trimmedQuery)
                default:
                    return false
                }
            } ||
            message.toolCalls.contains { toolCall in
                toolCall.name.localizedCaseInsensitiveContains(trimmedQuery) ||
                toolCall.arguments.localizedCaseInsensitiveContains(trimmedQuery)
            }
        }
        selectedIndex = 0
    }
    
    private func navigateUp() {
        guard selectedIndex > 0 else { return }
        selectedIndex -= 1
    }
    
    private func navigateDown() {
        guard selectedIndex < searchResults.count - 1 else { return }
        selectedIndex += 1
    }
}

// MARK: - Search Result Row

struct MessageSearchResultRow: View {
    let message: ChatMessage
    let query: String
    let isSelected: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(message.role.rawValue.capitalized)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(message.role == .user ? .blue : .green)
                    
                    Spacer()
                    
                    Text(message.timestamp, style: .relative)
                        .font(.system(size: 9))
                        .foregroundColor(.grokDim)
                }
                
                highlightMatch(in: message.content, query: query)
                    .font(.system(size: 12))
                    .foregroundColor(.grokText)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                
                if !message.toolCalls.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(message.toolCalls.prefix(3), id: \.id) { toolCall in
                            Text(toolCall.name)
                                .font(.system(size: 9))
                                .foregroundColor(.purple)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 2)
                                .background(Color.purple.opacity(0.2))
                                .cornerRadius(3)
                        }
                        if message.toolCalls.count > 3 {
                            Text("+\(message.toolCalls.count - 3)")
                                .font(.system(size: 9))
                                .foregroundColor(.grokDim)
                        }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.blue.opacity(0.2) : Color.clear)
            .overlay(
                Rectangle()
                    .fill(isSelected ? Color.blue.opacity(0.3) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }
    
    private func highlightMatch(in text: String, query: String) -> Text {
        let lowerText = text.lowercased()
        let lowerQuery = query.lowercased()
        
        guard let range = lowerText.range(of: lowerQuery) else {
            return Text(text)
        }
        
        let beforeRange = text.startIndex..<range.lowerBound
        let matchRange = range.lowerBound..<range.upperBound
        let afterRange = range.upperBound..<text.endIndex
        
        return Text(text[beforeRange]) +
        Text(text[matchRange])
            .foregroundColor(.yellow) +
        Text(text[afterRange])
    }
}

// MARK: - Preview

#if DEBUG
struct MessageSearchOverlayPreview: PreviewProvider {
    static var previews: some View {
        MessageSearchOverlay(
            isPresented: .constant(true),
            query: .constant("test"),
            messages: [
                ChatMessage(role: .user, content: "This is a test message"),
                ChatMessage(role: .assistant, content: "Testing the search functionality")
            ],
            onSelectMessage: { _ in }
        )
        .frame(width: 500, height: 400)
        .background(Color.grokBackground)
    }
}
#endif
