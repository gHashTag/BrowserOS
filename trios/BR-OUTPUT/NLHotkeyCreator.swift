import SwiftUI
import NaturalLanguage

// MARK: - NLHotkeyRequest Model

struct NLHotkeyRequest: Codable, Identifiable {
    let id: UUID
    let naturalLanguage: String
    let timestamp: Date
    let parsedIntent: NLIntent
    let suggestedShortcut: String
    let accepted: Bool
    
    init(naturalLanguage: String, parsedIntent: NLIntent, suggestedShortcut: String, accepted: Bool = false) {
        self.id = UUID()
        self.naturalLanguage = naturalLanguage
        self.timestamp = Date()
        self.parsedIntent = parsedIntent
        self.suggestedShortcut = suggestedShortcut
        self.accepted = accepted
    }
}

// MARK: - NLIntent Model

enum NLIntent: Codable {
    case createShortcut(action: String, context: String?)
    case modifyShortcut(action: String, newShortcut: String)
    case deleteShortcut(action: String)
    case createMacro(description: String)
    case unknown
    
    var description: String {
        switch self {
        case .createShortcut(let action, _):
            return "Create shortcut for: \(action)"
        case .modifyShortcut(let action, let shortcut):
            return "Modify \(action) to: \(shortcut)"
        case .deleteShortcut(let action):
            return "Delete shortcut for: \(action)"
        case .createMacro(let desc):
            return "Create macro: \(desc)"
        case .unknown:
            return "Unknown intent"
        }
    }
}

// MARK: - NLHotkeyCreatorViewModel

@MainActor
class NLHotkeyCreatorViewModel: ObservableObject {
    @Published var inputText = ""
    @Published var isProcessing = false
    @Published var parsedIntent: NLIntent?
    @Published var suggestedShortcut: String?
    @Published var confidenceScore: Double = 0.0
    @Published var alternativeShortcuts: [String] = []
    @Published var requestHistory: [NLHotkeyRequest] = []
    @Published var showConfirmation = false
    
    private let tagger = NLTagger(tagSchemes: [.lexicalClass])
    private let requestsDirectory: URL
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        let nlDir = triosDir.appendingPathComponent("NLRequests", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: nlDir, withIntermediateDirectories: true)
        self.requestsDirectory = nlDir
        
        loadHistory()
    }
    
    func processNaturalLanguage(_ text: String) {
        isProcessing = true
        parsedIntent = nil
        suggestedShortcut = nil
        confidenceScore = 0.0
        
        // Step 1: Tokenize and tag
        tagger.string = text
        let tags: [NLTag] = []
        
        // Step 2: Extract intent
        let intent = parseIntent(from: text, tags: tags)
        parsedIntent = intent
        
        // Step 3: Generate shortcut suggestion
        if case .createShortcut(let action, _) = intent {
            let (shortcut, confidence, alternatives) = suggestShortcut(for: action, tags: tags)
            suggestedShortcut = shortcut
            confidenceScore = confidence
            alternativeShortcuts = alternatives
        } else if case .createMacro(let description) = intent {
            // Macro creation handled by AIMacroGenerator
            suggestedShortcut = "⌘Shift+M"
            confidenceScore = 0.7
        }
        
        isProcessing = false
        showConfirmation = true
        
        NSLog("[NLHotkey] Processed: '\(text)' → Intent: \(intent.description), Shortcut: \(suggestedShortcut ?? "N/A"), Confidence: \(confidenceScore)")
    }
    
    func acceptSuggestion() {
        guard let intent = parsedIntent, let shortcut = suggestedShortcut else { return }
        
        let request = NLHotkeyRequest(
            naturalLanguage: inputText,
            parsedIntent: intent,
            suggestedShortcut: shortcut,
            accepted: true
        )
        
        requestHistory.append(request)
        saveRequest(request)
        saveToPreferences(shortcut: shortcut, for: actionName(from: intent))
        
        showConfirmation = false
        inputText = ""
        
        NSLog("[NLHotkey] Accepted: \(shortcut) for \(intent.description)")
    }
    
    func rejectSuggestion() {
        guard let intent = parsedIntent else { return }
        
        let request = NLHotkeyRequest(
            naturalLanguage: inputText,
            parsedIntent: intent,
            suggestedShortcut: suggestedShortcut ?? "N/A",
            accepted: false
        )
        
        requestHistory.append(request)
        saveRequest(request)
        showConfirmation = false
        
        NSLog("[NLHotkey] Rejected: \(intent.description)")
    }
    
    private func parseIntent(from text: String, tags: [NLTag]) -> NLIntent {
        let lowercased = text.lowercased()
        
        // Pattern matching for common intents
        if lowercased.contains("make") || lowercased.contains("create") || lowercased.contains("add") {
            if lowercased.contains("shortcut") || lowercased.contains("hotkey") || lowercased.contains("key") {
                // Extract action
                let action = extractAction(from: text)
                return .createShortcut(action: action, context: nil)
            } else if lowercased.contains("macro") {
                return .createMacro(description: text)
            }
        }
        
        if lowercased.contains("change") || lowercased.contains("modify") || lowercased.contains("update") {
            if let shortcut = extractShortcut(from: text) {
                let action = extractAction(from: text)
                return .modifyShortcut(action: action, newShortcut: shortcut)
            }
        }
        
        if lowercased.contains("delete") || lowercased.contains("remove") {
            let action = extractAction(from: text)
            return .deleteShortcut(action: action)
        }
        
        return .unknown
    }
    
    private func suggestShortcut(for action: String, tags: [NLTag]) -> (String, Double, [String]) {
        // Rule-based suggestion with confidence scoring
        let actionLower = action.lowercased()
        
        // Common action → shortcut mappings
        let mappings: [String: (String, Double, [String])] = [
            "send": ("Return", 0.95, ["Enter", "⌘Enter"]),
            "clear": ("⌘K", 0.9, ["⌘Delete", "Escape"]),
            "search": ("⌘F", 0.95, ["⌘S", "⌘L"]),
            "history": ("⌘H", 0.85, ["⌘Y", "↑↓"]),
            "new": ("⌘N", 0.98, ["⌘Shift+N"]),
            "save": ("⌘S", 0.98, ["⌘Shift+S"]),
            "copy": ("⌘C", 0.99, ["⌘Insert"]),
            "paste": ("⌘V", 0.99, ["⌘Shift+V"]),
            "undo": ("⌘Z", 0.99, ["⌘Shift+Z"]),
            "redo": ("⌘Shift+Z", 0.95, ["⌘Y"]),
            "help": ("⌘/", 0.95, ["F1", "⌘?"]),
            "settings": ("⌘,", 0.98, ["⌘Option+S"]),
            "close": ("⌘W", 0.95, ["⌘Q"]),
            "refresh": ("⌘R", 0.95, ["F5", "⌘Shift+R"]),
        ]
        
        // Find best match
        for (key, value) in mappings {
            if actionLower.contains(key) {
                return value
            }
        }
        
        // Fallback: generate based on first letter
        if let firstChar = actionLower.first, firstChar.isLetter {
            let char = String(firstChar).uppercased()
            return ("⌘\(char)", 0.6, ["⌘Shift+\(char)", "⌘Option+\(char)"])
        }
        
        // Default fallback
        return ("⌘Shift+X", 0.5, ["⌘Option+X", "⌘Control+X"])
    }
    
    private func extractAction(from text: String) -> String {
        // Simple extraction: find the main verb/noun
        let lowercased = text.lowercased()
        
        // Remove common filler words
        let fillerWords = ["make", "create", "add", "a", "an", "the", "for", "to", "shortcut", "hotkey", "key"]
        var words = lowercased.components(separatedBy: .whitespaces)
        words.removeAll { fillerWords.contains($0) }
        
        // Return first meaningful word (capitalized)
        if let first = words.first {
            return first.capitalized
        }
        
        return "Unknown"
    }

    private func actionName(from intent: NLIntent) -> String {
        switch intent {
        case .createShortcut(let action, _),
             .modifyShortcut(let action, _),
             .deleteShortcut(let action):
            return action
        case .createMacro(let description):
            return description
        case .unknown:
            return "Unknown"
        }
    }
    
    private func extractShortcut(from text: String) -> String? {
        // Look for patterns like "Cmd+K", "⌘K", "Control+Shift+X"
        let patterns = [
            #"Cmd\+([A-Z0-9])"#,
            #"⌘([A-Z0-9])"#,
            #"Command\+([A-Z0-9])"#,
            #"Control\+([A-Z0-9])"#,
            #"Ctrl\+([A-Z0-9])"#,
            #"Shift\+([A-Z0-9])"#,
            #"Option\+([A-Z0-9])"#,
            #"Alt\+([A-Z0-9])"#,
        ]
        
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) {
                return String(text[Range(match.range(at: 1), in: text)!])
            }
        }
        
        return nil
    }
    
    private func saveRequest(_ request: NLHotkeyRequest) {
        let fileURL = requestsDirectory.appendingPathComponent("\(request.id.uuidString).json")
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(request)
            try data.write(to: fileURL)
        } catch {
            NSLog("[NLHotkey] Save request failed: \(error)")
        }
    }
    
    private func saveToPreferences(shortcut: String, for action: String) {
        // Integration with HotkeyPreferences needed
        NSLog("[NLHotkey] Would save \(shortcut) for \(action) to preferences")
    }
    
    private func loadHistory() {
        guard FileManager.default.fileExists(atPath: requestsDirectory.path) else {
            return
        }
        
        do {
            let files = try FileManager.default.contentsOfDirectory(at: requestsDirectory, includingPropertiesForKeys: nil)
            
            for file in files where file.pathExtension == "json" {
                let data = try Data(contentsOf: file)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let request = try decoder.decode(NLHotkeyRequest.self, from: data)
                requestHistory.append(request)
            }
        } catch {
            NSLog("[NLHotkey] Load history failed: \(error)")
        }
    }
}

// MARK: - NLHotkeyCreatorView

struct NLHotkeyCreatorView: View {
    @StateObject private var viewModel = NLHotkeyCreatorViewModel()
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.grokDivider)
            ScrollView {
                VStack(spacing: 20) {
                    inputSection
                    processingIndicator
                    resultSection
                }
                .padding(.bottom, 16)
            }
        }
        .frame(width: 500, height: 550)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }

    private var header: some View {
        HStack {
            Text("Create Shortcut with Natural Language")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.grokText)
            Spacer()
            Button(action: { dismiss() }) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(.grokDim)
            }
            .buttonStyle(.plain)
        }
        .padding(16)
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Describe what you want:")
                .font(.system(size: 13))
                .foregroundColor(.grokDim)
            TextEditor(text: $viewModel.inputText)
                .font(.system(size: 14))
                .frame(minHeight: 60, maxHeight: 100)
                .padding(8)
                .background(Color.grokElevated.opacity(0.3))
                .cornerRadius(8)
            HStack {
                Text("Examples:").font(.system(size: 11)).foregroundColor(.grokDim)
                Spacer()
                Button("Clear") { viewModel.inputText = "" }
                    .font(.system(size: 11))
                    .foregroundColor(.blue)
                    .buttonStyle(.plain)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    exampleChip("Make a shortcut for clearing")
                    exampleChip("Create hotkey for send message")
                    exampleChip("Add a key for search history")
                }
            }
        }
        .padding(16)
    }

    @ViewBuilder
    private var processingIndicator: some View {
        if viewModel.isProcessing {
            HStack {
                ProgressView().scaleEffect(0.8)
                Text("Analyzing your request...")
                    .font(.system(size: 13))
                    .foregroundColor(.grokDim)
            }
            .padding()
            .frame(maxWidth: .infinity)
            .background(Color.blue.opacity(0.1))
            .cornerRadius(8)
        }
    }

    @ViewBuilder
    private var resultSection: some View {
        if let intent = viewModel.parsedIntent {
            VStack(alignment: .leading, spacing: 12) {
                Text("Detected Intent:")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.grokDim)
                Label(intent.description, systemImage: "brain.head.profile")
                    .font(.system(size: 14))
                    .foregroundColor(.grokText)
                    .padding()
                    .background(Color.purple.opacity(0.1))
                    .cornerRadius(8)
                shortcutSuggestion
                alternatives
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var shortcutSuggestion: some View {
        if let shortcut = viewModel.suggestedShortcut {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Suggested Shortcut:")
                        .font(.system(size: 13, weight: .medium))
                    Spacer()
                    Text("\(Int(viewModel.confidenceScore * 100))% confidence")
                        .font(.system(size: 11))
                        .foregroundColor(viewModel.confidenceScore > 0.8 ? .green : .orange)
                }
                HStack {
                    ShortcutBadge(shortcut: shortcut).scaleEffect(1.3)
                    Spacer()
                    Button("Accept") { viewModel.acceptSuggestion() }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                    Button("Reject") { viewModel.rejectSuggestion() }
                        .buttonStyle(.plain)
                        .foregroundColor(.grokDim)
                }
            }
            .padding()
            .background(Color.grokElevated.opacity(0.3))
            .cornerRadius(8)
        }
    }

    @ViewBuilder
    private var alternatives: some View {
        if !viewModel.alternativeShortcuts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Alternatives:").font(.system(size: 12)).foregroundColor(.grokDim)
                HStack(spacing: 8) {
                    ForEach(viewModel.alternativeShortcuts, id: \.self) { alternative in
                        ShortcutBadge(shortcut: alternative).scaleEffect(0.9)
                    }
                }
            }
        }
    }

    private func exampleChip(_ text: String) -> some View {
        ExampleChip(text: text) {
            viewModel.inputText = text
        }
    }
}

// MARK: - Helper Views

struct ExampleChip: View {
    let text: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 11))
                .foregroundColor(.grokText)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.grokElevated.opacity(0.5))
                .cornerRadius(12)
        }
        .buttonStyle(.plain)
    }
}

struct ShortcutBadge: View {
    let shortcut: String
    
    var body: some View {
        Text(shortcut)
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundColor(.grokText)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.blue.opacity(0.2))
            .cornerRadius(6)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color.blue, lineWidth: 1)
            )
    }
}

// MARK: - Preview

#if DEBUG
struct NLHotkeyCreatorViewPreview: PreviewProvider {
    static var previews: some View {
        NLHotkeyCreatorView()
    }
}
#endif
