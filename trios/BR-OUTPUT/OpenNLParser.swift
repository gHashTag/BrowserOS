import SwiftUI
import NaturalLanguage

// MARK: - OpenNLIntent Model

struct OpenNLIntent: Codable, Identifiable {
    let id: UUID
    let type: IntentType
    let confidence: Double
    let entities: [Entity]
    let sourceModel: String
    let processingTimeMs: Double
    
    enum IntentType: String, Codable {
        case createShortcut
        case modifyShortcut
        case deleteShortcut
        case createMacro
        case executeCommand
        case unknown
    }
    
    struct Entity: Codable {
        let name: String
        let value: String
        let type: EntityType
        
        enum EntityType: String, Codable {
            case action
            case shortcut
            case parameter
            case context
        }
    }
    
    init(type: IntentType, confidence: Double, entities: [Entity], sourceModel: String = "local-7b", processingTimeMs: Double = 0) {
        self.id = UUID()
        self.type = type
        self.confidence = confidence
        self.entities = entities
        self.sourceModel = sourceModel
        self.processingTimeMs = processingTimeMs
    }
}

// MARK: - ModelConfig Model

struct ModelConfig: Codable {
    let name: String
    let path: String
    let contextLength: Int
    let quantization: String
    let downloadURL: String
    let sha256: String
    let sizeGB: Double
    
    static let defaultModels: [ModelConfig] = [
        ModelConfig(
            name: "Llama-3.2-3B-Instruct",
            path: "~/Library/TRIOS/Models/llama-3.2-3b-instruct.gguf",
            contextLength: 4096,
            quantization: "Q4_K_M",
            downloadURL: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
            sha256: "abc123...",
            sizeGB: 2.1
        ),
        ModelConfig(
            name: "Mistral-7B-Instruct-v0.3",
            path: "~/Library/TRIOS/Models/mistral-7b-instruct-v0.3.Q4_K_M.gguf",
            contextLength: 8192,
            quantization: "Q4_K_M",
            downloadURL: "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf",
            sha256: "def456...",
            sizeGB: 4.4
        ),
        ModelConfig(
            name: "Phi-3-mini-4k-instruct",
            path: "~/Library/TRIOS/Models/phi-3-mini-4k-instruct.Q4_K_M.gguf",
            contextLength: 4096,
            quantization: "Q4_K_M",
            downloadURL: "https://huggingface.co/bartowski/Phi-3-mini-4k-instruct-GGUF/resolve/main/Phi-3-mini-4k-instruct-Q4_K_M.gguf",
            sha256: "ghi789...",
            sizeGB: 2.3
        ),
    ]
}

// MARK: - OpenNLParserViewModel

@MainActor
class OpenNLParserViewModel: ObservableObject {
    @Published var selectedModel: ModelConfig?
    @Published var isModelLoaded = false
    @Published var isDownloading = false
    @Published var downloadProgress: Double = 0.0
    @Published var availableModels: [ModelConfig] = ModelConfig.defaultModels
    @Published var lastIntent: OpenNLIntent?
    @Published var processingTime: Double = 0
    @Published var modelStats: ModelStats?
    
    struct ModelStats {
        let totalRequests: Int
        let averageConfidence: Double
        let averageProcessingTime: Double
        let lastUsed: Date
    }
    
    private let modelsDirectory: URL
    private let statsDirectory: URL
    private var llmContext: UnsafeMutableRawPointer? = nil // llama_context pointer
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        
        self.modelsDirectory = triosDir.appendingPathComponent("Models", isDirectory: true)
        self.statsDirectory = triosDir.appendingPathComponent("NLStats", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: statsDirectory, withIntermediateDirectories: true)
        
        checkAvailableModels()
        loadStats()
    }
    
    func downloadModel(_ config: ModelConfig) async {
        isDownloading = true
        downloadProgress = 0.0
        
        let destinationURL = modelsDirectory.appendingPathComponent("\(config.name).gguf")
        
        // Check if already exists
        if FileManager.default.fileExists(atPath: destinationURL.path) {
            NSLog("[OpenNL] Model already exists at \(destinationURL.path)")
            selectedModel = config
            isDownloading = false
            return
        }
        
        // Download from Hugging Face
        do {
            let (tempURL, response) = try await URLSession.shared.download(from: URL(string: config.downloadURL)!)
            
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw NSError(domain: "OpenNL", code: 1, userInfo: [NSLocalizedDescriptionKey: "Download failed"])
            }
            
            // Move to destination
            try FileManager.default.moveItem(at: tempURL, to: destinationURL)
            
            downloadProgress = 1.0
            selectedModel = config
            isDownloading = false
            
            NSLog("[OpenNL] Model downloaded: \(destinationURL.path)")
        } catch {
            NSLog("[OpenNL] Download error: \(error)")
            isDownloading = false
        }
    }
    
    func loadModel(_ config: ModelConfig) async -> Bool {
        let modelPath = modelsDirectory.appendingPathComponent("\(config.name).gguf").path
        
        guard FileManager.default.fileExists(atPath: modelPath) else {
            NSLog("[OpenNL] Model file not found: \(modelPath)")
            return false
        }
        
        // In production: load llama.cpp context
        // llama_model* model = llama_model_load_from_file(modelPath.c_str(), params);
        // llmContext = llama_init_from_model(model, ctx_params);
        
        isModelLoaded = true
        selectedModel = config
        
        NSLog("[OpenNL] Model loaded: \(config.name)")
        return true
    }
    
    func parseIntent(from text: String) async -> OpenNLIntent {
        let startTime = Date()
        
        guard isModelLoaded, let model = selectedModel else {
            // Fallback to rule-based parsing
            return ruleBasedParse(text)
        }
        
        // Build prompt for LLM
        let prompt = buildPrompt(from: text)
        
        // In production: call llama_eval with prompt
        // let output = llama_eval(llmContext, prompt)
        
        // Simulated LLM output for now
        let llmOutput = await simulateLLMInference(prompt)
        
        // Parse LLM output into intent
        let intent = parseLLMOutput(llmOutput, sourceModel: model.name)
        
        let processingTime = Date().timeIntervalSince(startTime) * 1000
        self.processingTime = processingTime
        
        // Update stats
        await updateStats(intent: intent, processingTime: processingTime)
        
        lastIntent = intent
        
        NSLog("[OpenNL] Parsed: '\(text)' → \(intent.type) (\(intent.confidence)) in \(processingTime)ms")
        
        return intent
    }
    
    private func buildPrompt(from text: String) -> String {
        return """
        You are a natural language intent parser for TRIOS, a productivity assistant.
        
        Analyze the user's request and extract:
        1. Intent type (createShortcut, modifyShortcut, deleteShortcut, createMacro, executeCommand)
        2. Entities (action, shortcut, parameter, context)
        3. Confidence score (0.0-1.0)
        
        Return JSON in this format:
        {
            "intent": "...",
            "confidence": 0.0,
            "entities": [{"name": "...", "value": "...", "type": "..."}]
        }
        
        User request: "\(text)"
        
        JSON:
        """
    }
    
    private func simulateLLMInference(_ prompt: String) async -> String {
        // Simulate LLM inference (in production, use llama.cpp)
        try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
        
        return """
        {
            "intent": "createShortcut",
            "confidence": 0.92,
            "entities": [
                {"name": "action", "value": "clear", "type": "action"},
                {"name": "shortcut", "value": "Cmd+K", "type": "shortcut"}
            ]
        }
        """
    }
    
    private func parseLLMOutput(_ json: String, sourceModel: String) -> OpenNLIntent {
        guard let data = json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(LLMResponse.self, from: data) else {
            return ruleBasedParse(json)
        }
        
        let intentType = OpenNLIntent.IntentType(rawValue: decoded.intent) ?? .unknown
        let entities = decoded.entities.map { entity in
            OpenNLIntent.Entity(
                name: entity.name,
                value: entity.value,
                type: OpenNLIntent.Entity.EntityType(rawValue: entity.type) ?? .parameter
            )
        }
        
        return OpenNLIntent(
            type: intentType,
            confidence: decoded.confidence,
            entities: entities,
            sourceModel: sourceModel,
            processingTimeMs: processingTime
        )
    }
    
    private func ruleBasedParse(_ text: String) -> OpenNLIntent {
        // Fallback rule-based parsing (from Wave 3 NLHotkeyCreator)
        let lowercased = text.lowercased()
        
        if lowercased.contains("make") || lowercased.contains("create") {
            return OpenNLIntent(
                type: .createShortcut,
                confidence: 0.7,
                entities: [
                    OpenNLIntent.Entity(name: "action", value: "unknown", type: .action)
                ],
                sourceModel: "rule-based"
            )
        }
        
        return OpenNLIntent(
            type: .unknown,
            confidence: 0.3,
            entities: [],
            sourceModel: "rule-based"
        )
    }
    
    private func updateStats(intent: OpenNLIntent, processingTime: Double) async {
        // Load existing stats
        var totalRequests = 1
        var totalConfidence = intent.confidence
        var totalTime = processingTime
        
        // In production: load from stats file, append, save
        
        modelStats = ModelStats(
            totalRequests: totalRequests,
            averageConfidence: totalConfidence / Double(totalRequests),
            averageProcessingTime: totalTime / Double(totalRequests),
            lastUsed: Date()
        )
    }
    
    private func checkAvailableModels() {
        for model in availableModels {
            let modelPath = modelsDirectory.appendingPathComponent("\(model.name).gguf")
            if FileManager.default.fileExists(atPath: modelPath.path) {
                NSLog("[OpenNL] Found existing model: \(model.name)")
            }
        }
    }
    
    private func loadStats() {
        // Load from stats file (in production)
        modelStats = ModelStats(
            totalRequests: 0,
            averageConfidence: 0.0,
            averageProcessingTime: 0.0,
            lastUsed: Date()
        )
    }
}

// MARK: - LLMResponse Model (for JSON parsing)

struct LLMResponse: Codable {
    let intent: String
    let confidence: Double
    let entities: [EntityResponse]
    
    struct EntityResponse: Codable {
        let name: String
        let value: String
        let type: String
    }
}

// MARK: - OpenNLParserView

struct OpenNLParserView: View {
    @StateObject private var viewModel = OpenNLParserViewModel()
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Open NL Parser")
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
            
            // Content
            ScrollView {
                VStack(spacing: 20) {
                    // Model selection
                    modelSelectionSection
                    
                    // Download progress
                    if viewModel.isDownloading {
                        downloadProgressSection
                    }
                    
                    // Model stats
                    if let stats = viewModel.modelStats {
                        statsSection(stats: stats)
                    }
                    
                    // Test input
                    testInputSection
                }
                .padding(20)
            }
        }
        .frame(width: 600, height: 650)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
    
    private var modelSelectionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Select Model")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokDim)
            
            ForEach(viewModel.availableModels, id: \.name) { model in
                ModelCard(
                    model: model,
                    isSelected: viewModel.selectedModel?.name == model.name,
                    isLoaded: viewModel.isModelLoaded && viewModel.selectedModel?.name == model.name,
                    onSelect: {
                        Task {
                            await viewModel.downloadModel(model)
                            await viewModel.loadModel(model)
                        }
                    }
                )
            }
        }
    }
    
    private var downloadProgressSection: some View {
        VStack(spacing: 8) {
            HStack {
                ProgressView(value: viewModel.downloadProgress)
                    .progressViewStyle(.linear)
                    .tint(.purple)
                
                Text("\(Int(viewModel.downloadProgress * 100))%")
                    .font(.system(size: 12))
                    .foregroundColor(.grokDim)
            }
            
            Text("Downloading model from Hugging Face...")
                .font(.system(size: 11))
                .foregroundColor(.grokDim)
        }
        .padding()
        .background(Color.purple.opacity(0.1))
        .cornerRadius(8)
    }
    
    private func statsSection(stats: OpenNLParserViewModel.ModelStats) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Model Statistics")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokDim)
            
            HStack(spacing: 16) {
                StatBadge(label: "Requests", value: "\(stats.totalRequests)")
                StatBadge(label: "Avg Confidence", value: "\(Int(stats.averageConfidence * 100))%")
                StatBadge(label: "Avg Time", value: "\(Int(stats.averageProcessingTime))ms")
            }
        }
        .padding(12)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(8)
    }
    
    private var testInputSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Test Parser")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokDim)
            
            TextField("Enter natural language...", text: .constant(""))
                .textFieldStyle(RoundedBorderTextFieldStyle())
            
            if let intent = viewModel.lastIntent {
                IntentResultCard(intent: intent, processingTime: viewModel.processingTime)
            }
        }
    }
}

// MARK: - ModelCard

struct ModelCard: View {
    let model: ModelConfig
    let isSelected: Bool
    let isLoaded: Bool
    let onSelect: () -> Void
    
    var body: some View {
        Button(action: onSelect) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.grokText)
                    
                    HStack(spacing: 12) {
                        Label("\(model.contextLength / 1024)K context", systemImage: "text.viewfinder")
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                        
                        Label(model.quantization, systemImage: "cpu")
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                        
                        Label("\(model.sizeGB)GB", systemImage: "externaldrive")
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    }
                }
                
                Spacer()
                
                if isLoaded {
                    Label("Loaded", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(.green)
                } else if isSelected {
                    Label("Ready", systemImage: "arrow.down.circle")
                        .font(.system(size: 11))
                        .foregroundColor(.blue)
                }
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color.blue : Color.grokDivider, lineWidth: isSelected ? 2 : 1)
                    .background(isSelected ? Color.blue.opacity(0.1) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - StatBadge

struct StatBadge: View {
    let label: String
    let value: String
    
    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.grokText)
            Text(label)
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity)
        .padding(10)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(6)
    }
}

// MARK: - IntentResultCard

struct IntentResultCard: View {
    let intent: OpenNLIntent
    let processingTime: Double
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Intent: \(intent.type.rawValue)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.grokText)
                
                Spacer()
                
                Text("\(Int(intent.confidence * 100))% confidence")
                    .font(.system(size: 11))
                    .foregroundColor(intent.confidence > 0.8 ? .green : .orange)
            }
            
            Text("Model: \(intent.sourceModel) • \(Int(processingTime))ms")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
            
            if !intent.entities.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Entities:")
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                    
                    ForEach(intent.entities, id: \.name) { entity in
                        HStack(spacing: 6) {
                            Text(entity.type.rawValue)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundColor(.blue)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 2)
                                .background(Color.blue.opacity(0.1))
                                .cornerRadius(3)
                            
                            Text("\(entity.name) = \(entity.value)")
                                .font(.system(size: 10))
                                .foregroundColor(.grokDim)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(8)
    }
}

// MARK: - Preview

#if DEBUG
struct OpenNLParserViewPreview: PreviewProvider {
    static var previews: some View { OpenNLParserView() }
}
#endif
