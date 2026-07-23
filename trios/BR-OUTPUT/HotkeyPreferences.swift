import SwiftUI
import Combine

// MARK: - HotkeyPreferences Model

struct HotkeyPreferences: Codable {
    var sendShortcut: String = "Return"
    var newLineShortcut: String = "Shift+Return"
    var clearShortcut: String = "Command+K"
    var focusShortcut: String = "Command+L"
    var historyUpShortcut: String = "UpArrow"
    var historyDownShortcut: String = "DownArrow"
    var helpShortcut: String = "Command+/"
    var searchShortcut: String = "Command+K"
    var macroRecordShortcut: String = "Command+Shift+R"
    var macroPlayShortcut: String = "Command+Shift+P"
    
    static let `default` = HotkeyPreferences()
    
    enum CodingKeys: String, CodingKey {
        case sendShortcut, newLineShortcut, clearShortcut, focusShortcut
        case historyUpShortcut, historyDownShortcut, helpShortcut, searchShortcut
        case macroRecordShortcut, macroPlayShortcut
    }
}

// MARK: - HotkeyPreferencesViewModel

@MainActor
class HotkeyPreferencesViewModel: ObservableObject {
    @Published var preferences: HotkeyPreferences = .default
    @Published var isRecording: Bool = false
    @Published var recordingFor: String? = nil
    @Published var conflictMessage: String? = nil
    
    private let prefsFileURL: URL
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        let prefsDir = triosDir.appendingPathComponent("Preferences", isDirectory: true)
        
        // Create directories if needed
        try? FileManager.default.createDirectory(at: prefsDir, withIntermediateDirectories: true)
        
        self.prefsFileURL = prefsDir.appendingPathComponent("hotkeys.json")
        loadPreferences()
    }
    
    func loadPreferences() {
        guard FileManager.default.fileExists(atPath: prefsFileURL.path) else {
            preferences = .default
            return
        }
        
        do {
            let data = try Data(contentsOf: prefsFileURL)
            let decoder = JSONDecoder()
            preferences = try decoder.decode(HotkeyPreferences.self, from: data)
        } catch {
            NSLog("[HotkeyPrefs] Load failed: \(error)")
            preferences = .default
        }
    }
    
    func savePreferences() {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(preferences)
            try data.write(to: prefsFileURL)
            NSLog("[HotkeyPrefs] Saved to \(prefsFileURL.path)")
        } catch {
            NSLog("[HotkeyPrefs] Save failed: \(error)")
        }
    }
    
    func checkConflict(shortcut: String, for action: String) -> Bool {
        let allShortcuts: [(String, String)] = [
            (preferences.sendShortcut, "Send"),
            (preferences.newLineShortcut, "New Line"),
            (preferences.clearShortcut, "Clear"),
            (preferences.focusShortcut, "Focus"),
            (preferences.historyUpShortcut, "History Up"),
            (preferences.historyDownShortcut, "History Down"),
            (preferences.helpShortcut, "Help"),
            (preferences.searchShortcut, "Search"),
            (preferences.macroRecordShortcut, "Macro Record"),
            (preferences.macroPlayShortcut, "Macro Play"),
        ]
        
        for (existing, actionName) in allShortcuts {
            if existing == shortcut && actionName != action {
                conflictMessage = "Conflict: '\(shortcut)' is already assigned to '\(actionName)'"
                return true
            }
        }
        
        conflictMessage = nil
        return false
    }
    
    func startRecording(for action: String) {
        isRecording = true
        recordingFor = action
        conflictMessage = nil
    }
    
    func stopRecording() {
        isRecording = false
        recordingFor = nil
        savePreferences()
    }
    
    func resetToDefaults() {
        preferences = .default
        savePreferences()
    }
}

// MARK: - HotkeyPreferencesView

struct HotkeyPreferencesView: View {
    @StateObject private var viewModel = HotkeyPreferencesViewModel()
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerView
            
            Divider().overlay(Color.grokDivider)
            
            // Content
            ScrollView {
                VStack(spacing: 24) {
                    // Basic Shortcuts
                    shortcutSection(
                        title: "Basic Shortcuts",
                        shortcuts: [
                            ("Send Message", viewModel.preferences.sendShortcut, "sendShortcut"),
                            ("New Line", viewModel.preferences.newLineShortcut, "newLineShortcut"),
                            ("Clear Input", viewModel.preferences.clearShortcut, "clearShortcut"),
                            ("Focus Input", viewModel.preferences.focusShortcut, "focusShortcut"),
                        ]
                    )
                    
                    // Navigation Shortcuts
                    shortcutSection(
                        title: "Navigation",
                        shortcuts: [
                            ("History Up", viewModel.preferences.historyUpShortcut, "historyUpShortcut"),
                            ("History Down", viewModel.preferences.historyDownShortcut, "historyDownShortcut"),
                            ("Show Help", viewModel.preferences.helpShortcut, "helpShortcut"),
                            ("Search History", viewModel.preferences.searchShortcut, "searchShortcut"),
                        ]
                    )
                    
                    // Macro Shortcuts
                    shortcutSection(
                        title: "Macros",
                        shortcuts: [
                            ("Start Recording", viewModel.preferences.macroRecordShortcut, "macroRecordShortcut"),
                            ("Play Macro", viewModel.preferences.macroPlayShortcut, "macroPlayShortcut"),
                        ]
                    )
                    
                    // Conflict warning
                    if let conflict = viewModel.conflictMessage {
                        HStack {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.yellow)
                            Text(conflict)
                                .font(.system(size: 13))
                                .foregroundColor(.yellow)
                        }
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.yellow.opacity(0.1))
                        .cornerRadius(8)
                    }
                    
                    // Reset button
                    Button(action: {
                        viewModel.resetToDefaults()
                    }) {
                        HStack {
                            Image(systemName: "arrow.counterclockwise")
                            Text("Reset to Defaults")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.grokElevated)
                        .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
                .padding(20)
            }
        }
        .frame(width: 500, height: 600)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
    
    private var headerView: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Keyboard Shortcuts")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.grokText)
                Text("Click on a shortcut to reassign it")
                    .font(.system(size: 12))
                    .foregroundColor(.grokDim)
            }
            
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
    }
    
    private func shortcutSection(title: String, shortcuts: [(String, String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokDim)
                .textCase(.uppercase)
            
            VStack(spacing: 8) {
                ForEach(shortcuts, id: \.0) { label, shortcut, key in
                    ShortcutRow(
                        label: label,
                        shortcut: shortcut,
                        key: key,
                        isRecording: viewModel.recordingFor == key,
                        onRecord: { viewModel.startRecording(for: key) }
                    )
                }
            }
        }
    }
}

// MARK: - ShortcutRow

struct ShortcutRow: View {
    let label: String
    let shortcut: String
    let key: String
    let isRecording: Bool
    let onRecord: () -> Void
    
    @State private var isHovering = false
    
    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 14))
                .foregroundColor(.grokText)
            
            Spacer()
            
            Button(action: onRecord) {
                HStack(spacing: 6) {
                    if isRecording {
                        Image(systemName: "record.circle")
                            .foregroundColor(.red)
                        Text("Press keys...")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundColor(.red)
                    } else {
                        Text(shortcut)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundColor(.grokDim)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.grokBackground.opacity(0.5))
                            .cornerRadius(5)
                            .overlay(
                                RoundedRectangle(cornerRadius: 5)
                                    .stroke(Color.grokDivider.opacity(0.4), lineWidth: 1)
                            )
                        
                        Image(systemName: "pencil")
                            .font(.system(size: 11))
                            .foregroundColor(.grokDim)
                            .opacity(isHovering ? 1 : 0)
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 8)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isRecording ? Color.red.opacity(0.1) : Color.clear)
                )
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isHovering ? Color.grokElevated.opacity(0.3) : Color.clear)
        )
        .cornerRadius(8)
        .onHover { hovering in
            isHovering = hovering
        }
    }
}

// MARK: - Preview

#if DEBUG
struct HotkeyPreferencesViewPreview: PreviewProvider {
    static var previews: some View {
        HotkeyPreferencesView()
            .frame(width: 500, height: 600)
    }
}
#endif
