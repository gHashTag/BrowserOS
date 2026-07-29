import SwiftUI
import Combine

// MARK: - MacroAction Model

enum MacroAction: Codable {
    case typeText(String)
    case send
    case clear
    case historyUp
    case historyDown
    case navigate(to: String)
    case screenshot
    case wait(seconds: Double)
    
    var description: String {
        switch self {
        case .typeText(let text):
            return "Type: \(text.prefix(30))"
        case .send:
            return "Send"
        case .clear:
            return "Clear"
        case .historyUp:
            return "History Up"
        case .historyDown:
            return "History Down"
        case .navigate(let url):
            return "Navigate: \(url)"
        case .screenshot:
            return "Screenshot"
        case .wait(let seconds):
            return "Wait: \(seconds)s"
        }
    }
}

// MARK: - Macro Model

struct Macro: Codable, Identifiable {
    let id: UUID
    let name: String
    let actions: [MacroAction]
    let createdAt: Date
    let shortcut: String?
    
    init(id: UUID = UUID(), name: String, actions: [MacroAction], shortcut: String? = nil) {
        self.id = id
        self.name = name
        self.actions = actions
        self.shortcut = shortcut
        self.createdAt = Date()
    }
}

// MARK: - MacroRecorderViewModel

@MainActor
class MacroRecorderViewModel: ObservableObject {
    @Published var isRecording = false
    @Published var isPlaying = false
    @Published var recordedActions: [MacroAction] = .init()
    @Published var macros: [Macro] = .init()
    @Published var currentMacroName = ""
    @Published var showSaveDialog = false
    
    private let macrosDirectory: URL
    private var recordingStartTime: Date?
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        let macrosDir = triosDir.appendingPathComponent("Macros", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: macrosDir, withIntermediateDirectories: true)
        self.macrosDirectory = macrosDir
        
        loadMacros()
    }
    
    func startRecording() {
        guard !isRecording else { return }
        
        isRecording = true
        recordedActions = []
        recordingStartTime = Date()
        currentMacroName = "Macro \(Date().formatted())"
        NSLog("[MacroRecorder] Started recording")
    }
    
    func stopRecording() {
        guard isRecording else { return }
        
        isRecording = false
        recordingStartTime = nil
        
        if !recordedActions.isEmpty {
            showSaveDialog = true
        }
        
        NSLog("[MacroRecorder] Stopped recording (\(recordedActions.count) actions)")
    }
    
    func recordAction(_ action: MacroAction) {
        guard isRecording else { return }
        recordedActions.append(action)
        NSLog("[MacroRecorder] Recorded: \(action.description)")
    }
    
    func saveMacro(name: String, shortcut: String? = nil) {
        let macro = Macro(name: name, actions: recordedActions, shortcut: shortcut)
        macros.append(macro)
        
        saveMacroToFile(macro)
        showSaveDialog = false
        recordedActions = []
        
        NSLog("[MacroRecorder] Saved macro '\(name)' with \(macro.actions.count) actions")
    }
    
    func deleteMacro(_ macro: Macro) {
        macros.removeAll { $0.id == macro.id }
        deleteMacroFile(macro)
    }
    
    func playMacro(_ macro: Macro) {
        guard !isPlaying else { return }
        
        isPlaying = true
        NSLog("[MacroRecorder] Playing macro '\(macro.name)'")
        
        Task {
            for action in macro.actions {
                await executeAction(action)
            }
            isPlaying = false
        }
    }
    
    private func executeAction(_ action: MacroAction) async {
        switch action {
        case .typeText(let text):
            // Simulate typing (integration with ChatViewModel needed)
            NSLog("[MacroExecutor] Would type: \(text)")
        case .send:
            NSLog("[MacroExecutor] Would send")
        case .clear:
            NSLog("[MacroExecutor] Would clear")
        case .historyUp:
            NSLog("[MacroExecutor] Would navigate history up")
        case .historyDown:
            NSLog("[MacroExecutor] Would navigate history down")
        case .navigate(let url):
            NSLog("[MacroExecutor] Would navigate to: \(url)")
        case .screenshot:
            NSLog("[MacroExecutor] Would take screenshot")
        case .wait(let seconds):
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    }
    
    private func saveMacroToFile(_ macro: Macro) {
        let fileURL = macrosDirectory.appendingPathComponent("\(macro.id.uuidString).json")
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(macro)
            try data.write(to: fileURL)
        } catch {
            NSLog("[MacroRecorder] Save failed: \(error)")
        }
    }
    
    private func deleteMacroFile(_ macro: Macro) {
        let fileURL = macrosDirectory.appendingPathComponent("\(macro.id.uuidString).json")
        try? FileManager.default.removeItem(at: fileURL)
    }
    
    private func loadMacros() {
        guard FileManager.default.fileExists(atPath: macrosDirectory.path) else {
            return
        }
        
        do {
            let files = try FileManager.default.contentsOfDirectory(at: macrosDirectory, includingPropertiesForKeys: nil)
            
            for file in files where file.pathExtension == "json" {
                let data = try Data(contentsOf: file)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let macro = try decoder.decode(Macro.self, from: data)
                macros.append(macro)
            }
        } catch {
            NSLog("[MacroRecorder] Load failed: \(error)")
        }
    }
}

// MARK: - MacroLibraryView

struct MacroLibraryView: View {
    @StateObject private var viewModel = MacroRecorderViewModel()
    @Binding var isPresented: Bool
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Macro Library")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.grokText)
                    Text("\(viewModel.macros.count) macros saved")
                        .font(.system(size: 12))
                        .foregroundColor(.grokDim)
                }
                
                Spacer()
                
                Button(action: { viewModel.startRecording() }) {
                    HStack {
                        Image(systemName: "record.circle")
                            .foregroundColor(.red)
                        Text("Record New")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.red.opacity(0.1))
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isRecording)
                
                Button(action: { isPresented = false }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.grokDim)
                }
                .buttonStyle(.plain)
            }
            .padding(20)
            
            Divider().overlay(Color.grokDivider)
            
            // Macro list
            if viewModel.macros.isEmpty {
                VStack(spacing: 12) {
                    Spacer()
                    
                    Image(systemName: "film")
                        .font(.system(size: 48))
                        .foregroundColor(.grokDim.opacity(0.5))
                    
                    Text("No macros yet")
                        .font(.system(size: 16))
                        .foregroundColor(.grokDim)
                    
                    Text("Click 'Record New' to create your first macro")
                        .font(.system(size: 12))
                        .foregroundColor(.grokDim)
                    
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(viewModel.macros) { macro in
                            MacroRow(
                                macro: macro,
                                onPlay: { viewModel.playMacro(macro) },
                                onDelete: { viewModel.deleteMacro(macro) }
                            )
                        }
                    }
                    .padding(16)
                }
            }
        }
        .frame(width: 500, height: 500)
        .background(Color.grokBackground)
        .cornerRadius(16)
        .sheet(isPresented: $viewModel.showSaveDialog) {
            SaveMacroSheet(
                viewModel: viewModel,
                onSave: { name, shortcut in
                    viewModel.saveMacro(name: name, shortcut: shortcut)
                }
            )
        }
    }
}

// MARK: - MacroRow

struct MacroRow: View {
    let macro: Macro
    let onPlay: () -> Void
    let onDelete: () -> Void
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(macro.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.grokText)
                
                Text("\(macro.actions.count) actions")
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
            }
            
            Spacer()
            
            if let shortcut = macro.shortcut {
                Text(shortcut)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundColor(.grokDim)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.grokBackground.opacity(0.5))
                    .cornerRadius(4)
            }
            
            Button(action: onPlay) {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(.green)
            }
            .buttonStyle(.plain)
            
            Button(action: onDelete) {
                Image(systemName: "trash.circle.fill")
                    .font(.system(size: 18))
                    .foregroundColor(.red)
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(8)
    }
}

// MARK: - SaveMacroSheet

struct SaveMacroSheet: View {
    @ObservedObject var viewModel: MacroRecorderViewModel
    @State private var name = ""
    @State private var shortcut = ""
    let onSave: (String, String?) -> Void
    
    var body: some View {
        VStack(spacing: 20) {
            Text("Save Macro")
                .font(.system(size: 18, weight: .semibold))
            
            TextField("Macro name", text: $name)
                .textFieldStyle(RoundedBorderTextFieldStyle())
            
            TextField("Shortcut (optional)", text: $shortcut)
                .textFieldStyle(RoundedBorderTextFieldStyle())
            
            HStack(spacing: 12) {
                Button(action: { viewModel.showSaveDialog = false }) {
                    Text("Cancel")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.grokElevated)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                
                Button(action: {
                    onSave(name, shortcut.isEmpty ? nil : shortcut)
                }) {
                    Text("Save")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(name.isEmpty ? Color.gray : Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(name.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 350)
    }
}

// MARK: - Preview

#if DEBUG
struct MacroLibraryViewPreview: PreviewProvider {
    static var previews: some View {
        MacroLibraryView(isPresented: .constant(true))
    }
}
#endif
