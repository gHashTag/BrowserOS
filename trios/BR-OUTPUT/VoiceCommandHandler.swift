import SwiftUI
import Speech

// MARK: - VoiceCommand Model

struct VoiceCommand: Codable, Identifiable {
    let id: UUID
    let spokenPhrase: String
    let recognizedIntent: String
    let timestamp: Date
    let success: Bool
    let confidence: Double
    
    init(spokenPhrase: String, recognizedIntent: String, success: Bool = false, confidence: Double = 0.0) {
        self.id = UUID()
        self.spokenPhrase = spokenPhrase
        self.recognizedIntent = recognizedIntent
        self.timestamp = Date()
        self.success = success
        self.confidence = confidence
    }
}

// MARK: - VoiceCommandHandlerViewModel

@MainActor
class VoiceCommandHandlerViewModel: ObservableObject {
    @Published var isListening = false
    @Published var currentTranscript = ""
    @Published var recognizedCommands: [VoiceCommand] = []
    @Published var authorizationStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
    @Published var lastError: String?
    @Published var supportedLanguages: [String] = []
    
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine: AVAudioEngine?
    private let commandHistoryDirectory: URL
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        let voiceDir = triosDir.appendingPathComponent("VoiceCommands", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: voiceDir, withIntermediateDirectories: true)
        self.commandHistoryDirectory = voiceDir
        
        setupSpeechRecognizer()
        checkAuthorization()
    }
    
    private func setupSpeechRecognizer() {
        // Use system's default language or user's preferred
        let preferredLanguage = Locale.preferredLanguages.first ?? "en-US"
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: preferredLanguage))
        
        if let recognizer = speechRecognizer {
            supportedLanguages.append(preferredLanguage)
            NSLog("[VoiceCommand] Speech recognizer initialized for \(preferredLanguage)")
        } else {
            lastError = "Speech recognition not available for this language"
            NSLog("[VoiceCommand] Speech recognizer not available for \(preferredLanguage)")
        }
    }
    
    func checkAuthorization() {
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                self.authorizationStatus = status
                switch status {
                case .authorized:
                    NSLog("[VoiceCommand] Speech recognition authorized")
                case .denied:
                    self.lastError = "Speech recognition access denied. Please enable in System Preferences."
                case .restricted:
                    self.lastError = "Speech recognition restricted on this device"
                case .notDetermined:
                    self.lastError = nil
                @unknown default:
                    self.lastError = "Unknown authorization status"
                }
            }
        }
    }
    
    func startListening() {
        guard authorizationStatus == .authorized else {
            checkAuthorization()
            return
        }
        
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            lastError = "Speech recognizer not available"
            return
        }
        
        isListening = true
        currentTranscript = ""
        lastError = nil
        
        // Create recognition request
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else {
            lastError = "Unable to create recognition request"
            return
        }
        
        recognitionRequest.shouldReportPartialResults = true
        
        // Start recognition task
        recognitionTask = recognizer.recognitionTask(with: recognitionRequest) { result, error in
            Task { @MainActor in
                if let result = result {
                    self.currentTranscript = result.bestTranscription.formattedString
                    
                    // Check for command keywords
                    if self.isCommandComplete(self.currentTranscript) {
                        self.processCommand(self.currentTranscript)
                    }
                }
                
                if error != nil || result?.isFinal == true {
                    self.stopListening()
                }
            }
        }
        
        // Setup audio engine
        setupAudioEngine()
        
        NSLog("[VoiceCommand] Started listening")
    }
    
    func stopListening() {
        isListening = false
        
        recognitionTask?.cancel()
        recognitionTask = nil
        
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        
        audioEngine?.stop()
        audioEngine = nil
        
        NSLog("[VoiceCommand] Stopped listening")
    }
    
    private func setupAudioEngine() {
        audioEngine = AVAudioEngine()
        guard let audioEngine = audioEngine else {
            lastError = "Unable to create audio engine"
            return
        }
        
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, when in
            self.recognitionRequest?.append(buffer)
        }
        
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            lastError = "Audio engine start failed: \(error.localizedDescription)"
        }
    }
    
    private func isCommandComplete(_ transcript: String) -> Bool {
        let lowercased = transcript.lowercased()
        
        // Check for command completion indicators
        let completionPhrases = [
            "send", "go", "execute", "do it", "please",
            "clear", "delete", "remove",
            "search for", "find",
            "help", "what can you do"
        ]
        
        return completionPhrases.contains { lowercased.contains($0) }
    }
    
    private func processCommand(_ transcript: String) {
        let (intent, confidence) = recognizeIntent(from: transcript)
        
        let command = VoiceCommand(
            spokenPhrase: transcript,
            recognizedIntent: intent,
            success: confidence > 0.7,
            confidence: confidence
        )
        
        recognizedCommands.append(command)
        saveCommand(command)
        
        // Execute command
        if confidence > 0.7 {
            executeCommand(intent)
        } else {
            lastError = "Low confidence: '\(transcript)' → \(intent) (\(Int(confidence * 100))%)"
        }
        
        NSLog("[VoiceCommand] Processed: '\(transcript)' → \(intent) (\(Int(confidence * 100))%)")
    }
    
    private func recognizeIntent(from transcript: String) -> (String, Double) {
        let lowercased = transcript.lowercased()
        
        // Rule-based intent recognition (in production, use ML model)
        let intents: [(pattern: [String], intent: String, confidence: Double)] = [
            (["send", "submit"], "send_message", 0.9),
            (["clear", "delete all"], "clear_input", 0.95),
            (["search", "find"], "search_history", 0.85),
            (["help", "what can you do"], "show_help", 0.98),
            (["history", "previous"], "navigate_history", 0.8),
            (["new conversation", "start over"], "new_conversation", 0.9),
            (["take screenshot", "capture"], "take_screenshot", 0.9),
            (["open", "navigate to", "go to"], "navigate_browser", 0.85),
        ]
        
        for (patterns, intent, confidence) in intents {
            if patterns.contains(where: { lowercased.contains($0) }) {
                return (intent, confidence)
            }
        }
        
        return ("unknown", 0.3)
    }
    
    private func executeCommand(_ intent: String) {
        switch intent {
        case "send_message":
            NSLog("[VoiceExecutor] Would send message")
        case "clear_input":
            NSLog("[VoiceExecutor] Would clear input")
        case "search_history":
            NSLog("[VoiceExecutor] Would open search overlay")
        case "show_help":
            NSLog("[VoiceExecutor] Would show help modal")
        case "navigate_history":
            NSLog("[VoiceExecutor] Would navigate history")
        case "new_conversation":
            NSLog("[VoiceExecutor] Would start new conversation")
        case "take_screenshot":
            NSLog("[VoiceExecutor] Would take screenshot")
        case "navigate_browser":
            NSLog("[VoiceExecutor] Would navigate browser")
        default:
            NSLog("[VoiceExecutor] Unknown intent: \(intent)")
        }
    }
    
    private func saveCommand(_ command: VoiceCommand) {
        let fileURL = commandHistoryDirectory.appendingPathComponent("\(command.id.uuidString).json")
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(command)
            try data.write(to: fileURL)
        } catch {
            NSLog("[VoiceCommand] Save failed: \(error)")
        }
    }
    
    func getCommandHistory() -> [VoiceCommand] {
        guard FileManager.default.fileExists(atPath: commandHistoryDirectory.path) else {
            return []
        }
        
        do {
            let files = try FileManager.default.contentsOfDirectory(at: commandHistoryDirectory, includingPropertiesForKeys: nil)
            var commands: [VoiceCommand] = []
            
            for file in files where file.pathExtension == "json" {
                let data = try Data(contentsOf: file)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let command = try decoder.decode(VoiceCommand.self, from: data)
                commands.append(command)
            }
            
            return commands.sorted { $0.timestamp > $1.timestamp }
        } catch {
            NSLog("[VoiceCommand] Load history failed: \(error)")
            return []
        }
    }
}

// MARK: - VoiceCommandButton

struct VoiceCommandButton: View {
    @StateObject private var viewModel = VoiceCommandHandlerViewModel()
    @State private var showHistory = false
    
    var body: some View {
        VStack(spacing: 8) {
            Button(action: {
                if viewModel.isListening {
                    viewModel.stopListening()
                } else {
                    viewModel.startListening()
                }
            }) {
                Circle()
                    .fill(viewModel.isListening ? Color.red : Color.green)
                    .frame(width: 48, height: 48)
                    .overlay(
                        Image(systemName: viewModel.isListening ? "mic.fill" : "mic")
                            .font(.system(size: 20))
                            .foregroundColor(.white)
                    )
                    .overlay(
                        Circle()
                            .stroke(viewModel.isListening ? Color.red.opacity(0.5) : Color.clear, lineWidth: 4)
                            .animation(viewModel.isListening ? .linear(duration: 1.5).repeatForever(autoreverses: false) : .default, value: viewModel.isListening)
                    )
            }
            .buttonStyle(.plain)
            .help(viewModel.isListening ? "Stop listening" : "Start voice command")
            
            if viewModel.isListening {
                Text("Listening...")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
        }
        .sheet(isPresented: $showHistory) {
            VoiceCommandHistoryView(viewModel: viewModel)
        }
    }
}

// MARK: - VoiceCommandHistoryView

struct VoiceCommandHistoryView: View {
    @ObservedObject var viewModel: VoiceCommandHandlerViewModel
    @Environment(\.dismiss) private var dismiss
    
    var commands: [VoiceCommand] {
        viewModel.getCommandHistory()
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Voice Command History")
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
            
            Divider().overlay(Color.grokDivider)
            
            // List
            if commands.isEmpty {
                VStack(spacing: 12) {
                    Spacer()
                    
                    Image(systemName: "mic.slash")
                        .font(.system(size: 48))
                        .foregroundColor(.grokDim.opacity(0.5))
                    
                    Text("No voice commands yet")
                        .font(.system(size: 16))
                        .foregroundColor(.grokDim)
                    
                    Text("Click the mic button to start")
                        .font(.system(size: 12))
                        .foregroundColor(.grokDim)
                    
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(commands) { command in
                            VoiceCommandRow(command: command)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .frame(width: 500, height: 500)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
}

// MARK: - VoiceCommandRow

struct VoiceCommandRow: View {
    let command: VoiceCommand
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("\"\(command.spokenPhrase)\"")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.grokText)
                
                HStack(spacing: 8) {
                    Text(command.recognizedIntent)
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                    
                    Text("\(Int(command.confidence * 100))%")
                        .font(.system(size: 10))
                        .foregroundColor(command.confidence > 0.8 ? .green : .orange)
                }
                
                Text(command.timestamp.formatted())
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
            
            Spacer()
            
            Image(systemName: command.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundColor(command.success ? .green : .red)
        }
        .padding(12)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(8)
    }
}

// MARK: - Preview

#if DEBUG
struct VoiceCommandButtonPreview: PreviewProvider {
    static var previews: some View { VoiceCommandButton() }
}
#endif
