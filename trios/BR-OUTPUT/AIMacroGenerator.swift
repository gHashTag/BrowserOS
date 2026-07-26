import SwiftUI

// MARK: - AIMacroStep Model

struct AIMacroStep: Codable, Identifiable {
    let id: UUID
    let action: String
    let parameters: [String: String]
    let naturalLanguage: String
    let confidence: Double
    
    init(action: String, parameters: [String: String] = [:], naturalLanguage: String = "", confidence: Double = 1.0) {
        self.id = UUID()
        self.action = action
        self.parameters = parameters
        self.naturalLanguage = naturalLanguage
        self.confidence = confidence
    }
}

// MARK: - AIMacroDefinition Model

struct AIMacroDefinition: Codable, Identifiable {
    let id: UUID
    let name: String
    let description: String
    let steps: [AIMacroStep]
    let estimatedDuration: Double // seconds
    let complexity: Int // 1-5 scale
    let tags: [String]
    
    init(name: String, description: String, steps: [AIMacroStep], estimatedDuration: Double = 0, complexity: Int = 1, tags: [String] = []) {
        self.id = UUID()
        self.name = name
        self.description = description
        self.steps = steps
        self.estimatedDuration = estimatedDuration
        self.complexity = complexity
        self.tags = tags
    }
}

// MARK: - AIMacroGeneratorViewModel

@MainActor
class AIMacroGeneratorViewModel: ObservableObject {
    @Published var naturalLanguageInput = ""
    @Published var isGenerating = false
    @Published var generatedMacro: AIMacroDefinition?
    @Published var generationSteps: [String] = .init()
    @Published var currentStep = 0
    @Published var showPreview = false
    
    private let generationHistoryDirectory: URL
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        let macrosDir = triosDir.appendingPathComponent("AIMacros", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: macrosDir, withIntermediateDirectories: true)
        self.generationHistoryDirectory = macrosDir
    }
    
    func generateMacro(from description: String) async {
        isGenerating = true
        generatedMacro = nil
        generationSteps = []
        currentStep = 0
        
        // Simulate AI generation pipeline (in production, this would call an LLM)
        await step("Parsing natural language description...")
        let parsedActions = parseActions(from: description)
        
        await step("Identifying action sequence...")
        let steps = convertToSteps(parsedActions)
        
        await step("Estimating duration and complexity...")
        let duration = estimateDuration(steps)
        let complexity = calculateComplexity(steps)
        
        await step("Generating macro definition...")
        let macro = AIMacroDefinition(
            name: extractName(from: description),
            description: description,
            steps: steps,
            estimatedDuration: duration,
            complexity: complexity,
            tags: extractTags(from: description)
        )
        
        generatedMacro = macro
        showPreview = true
        isGenerating = false
        
        NSLog("[AIMacro] Generated macro '\(macro.name)' with \(macro.steps.count) steps, complexity \(complexity)/5")
    }
    
    func executeMacro() {
        guard let macro = generatedMacro else { return }
        
        Task {
            for (index, step) in macro.steps.enumerated() {
                NSLog("[AIMacro] Executing step \(index + 1)/\(macro.steps.count): \(step.action)")
                await executeStep(step)
            }
            NSLog("[AIMacro] Macro execution complete")
        }
    }
    
    func saveMacro() {
        guard let macro = generatedMacro else { return }
        
        let fileURL = generationHistoryDirectory.appendingPathComponent("\(macro.id.uuidString).json")
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(macro)
            try data.write(to: fileURL)
            NSLog("[AIMacro] Saved macro to \(fileURL.path)")
        } catch {
            NSLog("[AIMacro] Save failed: \(error)")
        }
    }
    
    private func step(_ description: String) async {
        generationSteps.append(description)
        currentStep = generationSteps.count - 1
        try? await Task.sleep(nanoseconds: 500_000_000) // 500ms per step
    }
    
    private func parseActions(from text: String) -> [String] {
        // Simple rule-based parsing (in production, use LLM)
        let lowercased = text.lowercased()
        var actions: [String] = []
        
        if lowercased.contains("clear") { actions.append("clear") }
        if lowercased.contains("type") || lowercased.contains("write") { actions.append("type") }
        if lowercased.contains("send") { actions.append("send") }
        if lowercased.contains("wait") || lowercased.contains("delay") { actions.append("wait") }
        if lowercased.contains("history") { actions.append("history") }
        if lowercased.contains("search") { actions.append("search") }
        if lowercased.contains("screenshot") { actions.append("screenshot") }
        if lowercased.contains("navigate") || lowercased.contains("open") { actions.append("navigate") }
        
        return actions.isEmpty ? ["type"] : actions
    }
    
    private func convertToSteps(_ actions: [String]) -> [AIMacroStep] {
        return actions.map { action in
            switch action {
            case "clear":
                return AIMacroStep(action: "clear", naturalLanguage: "Clear the input field")
            case "type":
                return AIMacroStep(action: "type", parameters: ["text": "Hello"], naturalLanguage: "Type text")
            case "send":
                return AIMacroStep(action: "send", naturalLanguage: "Send the message")
            case "wait":
                return AIMacroStep(action: "wait", parameters: ["seconds": "1"], naturalLanguage: "Wait 1 second")
            case "history":
                return AIMacroStep(action: "history_up", naturalLanguage: "Navigate to previous message")
            case "search":
                return AIMacroStep(action: "search", parameters: ["query": ""], naturalLanguage: "Search history")
            case "screenshot":
                return AIMacroStep(action: "screenshot", naturalLanguage: "Take a screenshot")
            case "navigate":
                return AIMacroStep(action: "navigate", parameters: ["url": ""], naturalLanguage: "Navigate to URL")
            default:
                return AIMacroStep(action: "unknown", naturalLanguage: "Unknown action")
            }
        }
    }
    
    private func estimateDuration(_ steps: [AIMacroStep]) -> Double {
        let baseTime: Double = 0.5 // seconds per step
        let waitSteps = steps.filter { $0.action == "wait" }
        let waitTime = waitSteps.reduce(0.0) { sum, step in
            sum + (Double(step.parameters["seconds"] ?? "1") ?? 1.0)
        }
        return Double(steps.count - waitSteps.count) * baseTime + waitTime
    }
    
    private func calculateComplexity(_ steps: [AIMacroStep]) -> Int {
        let base = steps.count
        let uniqueActions = Set(steps.map { $0.action }).count
        
        if base <= 2 { return 1 }
        if base <= 4 { return 2 }
        if base <= 6 { return 3 }
        if base <= 8 { return 4 }
        return 5
    }
    
    private func extractName(from text: String) -> String {
        // Generate a descriptive name
        let words = text.components(separatedBy: .whitespaces).filter { $0.count > 3 }
        if words.count >= 2 {
            return "Auto: \(words.prefix(3).joined(separator: " "))"
        }
        return "Auto Macro"
    }
    
    private func extractTags(from text: String) -> [String] {
        var tags: [String] = []
        let lowercased = text.lowercased()
        
        if lowercased.contains("clear") { tags.append("clear") }
        if lowercased.contains("send") { tags.append("messaging") }
        if lowercased.contains("search") { tags.append("search") }
        if lowercased.contains("history") { tags.append("navigation") }
        if lowercased.contains("screenshot") { tags.append("capture") }
        
        return tags.isEmpty ? ["general"] : tags
    }
    
    private func executeStep(_ step: AIMacroStep) async {
        // Simulate step execution (in production, integrate with actual actions)
        try? await Task.sleep(nanoseconds: 300_000_000) // 300ms per step
        NSLog("[AIMacroExecutor] Would execute: \(step.action) with params: \(step.parameters)")
    }
}

// MARK: - AIMacroGeneratorView

struct AIMacroGeneratorView: View {
    @StateObject private var viewModel = AIMacroGeneratorViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.grokDivider)
            ScrollView {
                VStack(spacing: 20) {
                    inputSection
                    generationProgress
                    macroPreview
                    examplePrompts
                }
                .padding(.bottom, 16)
            }
        }
        .frame(width: 550, height: 650)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }

    private var header: some View {
        HStack {
            Text("AI Macro Generator")
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
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Describe the macro you want to create:")
                .font(.system(size: 13))
                .foregroundColor(.grokDim)
            TextEditor(text: $viewModel.naturalLanguageInput)
                .font(.system(size: 14))
                .frame(minHeight: 80, maxHeight: 120)
                .padding(8)
                .background(Color.grokElevated.opacity(0.3))
                .cornerRadius(8)
            HStack {
                Button(action: {
                    Task { await viewModel.generateMacro(from: viewModel.naturalLanguageInput) }
                }) {
                    Label("Generate Macro", systemImage: "wand.and.stars")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(viewModel.naturalLanguageInput.isEmpty ? Color.gray : Color.purple)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.naturalLanguageInput.isEmpty || viewModel.isGenerating)
                Button("Clear") { viewModel.naturalLanguageInput = "" }
                    .font(.system(size: 12))
                    .foregroundColor(.grokDim)
                    .buttonStyle(.plain)
            }
        }
        .padding(16)
    }

    @ViewBuilder
    private var generationProgress: some View {
        if viewModel.isGenerating {
            VStack(spacing: 12) {
                ProgressView(
                    value: Double(viewModel.currentStep + 1),
                    total: Double(viewModel.generationSteps.count + 2)
                )
                .progressViewStyle(.linear)
                .tint(.purple)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(viewModel.generationSteps.enumerated()), id: \.offset) { index, step in
                        Label {
                            Text(step)
                                .foregroundColor(index == viewModel.currentStep ? .purple : .grokDim)
                        } icon: {
                            Image(systemName: index < viewModel.currentStep ? "checkmark.circle.fill" : "circle")
                                .foregroundColor(index < viewModel.currentStep ? .green : .gray)
                        }
                        .font(.system(size: 12))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
            .background(Color.purple.opacity(0.1))
            .cornerRadius(8)
        }
    }

    @ViewBuilder
    private var macroPreview: some View {
        if let macro = viewModel.generatedMacro {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(macro.name).font(.system(size: 16, weight: .semibold))
                        Text(macro.description).font(.system(size: 12)).foregroundColor(.grokDim)
                    }
                    Spacer()
                    Text("\(String(format: "%.1f", macro.estimatedDuration))s  |  \(macro.complexity)/5")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Steps:").font(.system(size: 13, weight: .medium)).foregroundColor(.grokDim)
                    ForEach(Array(macro.steps.enumerated()), id: \.offset) { index, step in
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.white)
                                .frame(width: 24, height: 24)
                                .background(Circle().fill(Color.blue))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(step.action.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.system(size: 13, weight: .medium))
                                if !step.naturalLanguage.isEmpty {
                                    Text(step.naturalLanguage).font(.system(size: 11)).foregroundColor(.grokDim)
                                }
                            }
                            Spacer()
                        }
                        .padding(8)
                        .background(Color.grokElevated.opacity(0.3))
                        .cornerRadius(6)
                    }
                }
                if !macro.tags.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(macro.tags, id: \.self) { tag in
                            Text("#\(tag)")
                                .font(.system(size: 10))
                                .foregroundColor(.blue)
                        }
                    }
                }
                HStack(spacing: 12) {
                    macroActionButton("Execute", icon: "play.fill", color: .green) {
                        viewModel.executeMacro()
                    }
                    macroActionButton("Save", icon: "tray.and.arrow.down.fill", color: .blue) {
                        viewModel.saveMacro()
                    }
                }
            }
            .padding(16)
            .background(Color.grokElevated.opacity(0.3))
            .cornerRadius(12)
        }
    }

    @ViewBuilder
    private var examplePrompts: some View {
        if viewModel.generatedMacro == nil && !viewModel.isGenerating {
            VStack(alignment: .leading, spacing: 8) {
                Text("Try these examples:")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.grokDim)
                ExamplePrompt(text: "Clear the input and type 'Hello, World!' then send") {
                    viewModel.naturalLanguageInput = "Clear the input and type 'Hello, World!' then send"
                }
                ExamplePrompt(text: "Wait 2 seconds, search for 'status', navigate to first result") {
                    viewModel.naturalLanguageInput = "Wait 2 seconds, search for 'status', navigate to first result"
                }
                ExamplePrompt(text: "Take a screenshot, clear input, type '/status', send") {
                    viewModel.naturalLanguageInput = "Take a screenshot, clear input, type '/status', send"
                }
            }
            .padding(16)
        }
    }

    private func macroActionButton(
        _ title: String,
        icon: String,
        color: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(color)
                .foregroundColor(.white)
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - ExamplePrompt

struct ExamplePrompt: View {
    let text: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            HStack {
                Image(systemName: "lightbulb")
                    .font(.system(size: 11))
                    .foregroundColor(.yellow)
                Text(text)
                    .font(.system(size: 12))
                    .foregroundColor(.grokText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color.grokElevated.opacity(0.3))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Preview

#if DEBUG
struct AIMacroGeneratorViewPreview: PreviewProvider {
    static var previews: some View {
        AIMacroGeneratorView()
    }
}
#endif
