import SwiftUI
import Combine

// MARK: - HotkeyUsage Model

struct HotkeyUsage: Codable, Identifiable {
    let id: UUID
    let hotkey: String
    let action: String
    let timestamp: Date
    let context: String // chat, browser, code, etc.
    let success: Bool
    let completionTimeMs: Double?
    
    init(hotkey: String, action: String, context: String = "chat", success: Bool = true, completionTimeMs: Double? = nil) {
        self.id = UUID()
        self.hotkey = hotkey
        self.action = action
        self.timestamp = Date()
        self.context = context
        self.success = success
        self.completionTimeMs = completionTimeMs
    }
}

// MARK: - DailyStats Model

struct HotkeyCount: Codable {
    let hotkey: String
    let count: Int
}

struct DailyStats: Codable, Identifiable {
    let date: String // YYYY-MM-DD
    let totalPresses: Int
    let uniqueHotkeys: Set<String>
    let averageCompletionTime: Double
    let errorRate: Double
    let topHotkeys: [HotkeyCount]
    var id: String { date }
    
    init(date: String, totalPresses: Int, uniqueHotkeys: Set<String>, averageCompletionTime: Double, errorRate: Double, topHotkeys: [(String, Int)]) {
        self.date = date
        self.totalPresses = totalPresses
        self.uniqueHotkeys = uniqueHotkeys
        self.averageCompletionTime = averageCompletionTime
        self.errorRate = errorRate
        self.topHotkeys = topHotkeys.map { HotkeyCount(hotkey: $0.0, count: $0.1) }
    }
}

// MARK: - HotkeyAnalyticsViewModel

@MainActor
class HotkeyAnalyticsViewModel: ObservableObject {
    @Published var usageHistory: [HotkeyUsage] = []
    @Published var dailyStats: [DailyStats] = []
    @Published var suggestions: [HotkeySuggestion] = []
    @Published var currentContext: String = "chat"
    
    private let analyticsDirectory: URL
    private var usageBuffer: [HotkeyUsage] = []
    private var contextStartTime: Date?
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let triosDir = docsPath.appendingPathComponent("Trios", isDirectory: true)
        let analyticsDir = triosDir.appendingPathComponent("Analytics", isDirectory: true)
        
        try? FileManager.default.createDirectory(at: analyticsDir, withIntermediateDirectories: true)
        self.analyticsDirectory = analyticsDir
        
        loadAnalytics()
        startContextTracking()
        generateSuggestions()
    }
    
    func recordUsage(hotkey: String, action: String, context: String = "chat", success: Bool = true, completionTimeMs: Double? = nil) {
        let usage = HotkeyUsage(
            hotkey: hotkey,
            action: action,
            context: context,
            success: success,
            completionTimeMs: completionTimeMs
        )
        
        usageHistory.append(usage)
        usageBuffer.append(usage)
        
        // Flush buffer every 10 entries
        if usageBuffer.count >= 10 {
            flushBuffer()
        }
        
        // Generate new suggestions if patterns change
        if usageHistory.count % 50 == 0 {
            generateSuggestions()
        }
        
        NSLog("[Analytics] Recorded: \(hotkey) -> \(action) in \(context)")
    }
    
    func setContext(_ context: String) {
        if currentContext != context {
            currentContext = context
            contextStartTime = Date()
        }
    }
    
    func getSuggestions() -> [HotkeySuggestion] {
        return suggestions
    }
    
    func getDailyStats(days: Int = 7) -> [DailyStats] {
        return Array(dailyStats.prefix(days))
    }
    
    private func startContextTracking() {
        // Track context changes every 5 minutes
        Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.flushBuffer()
                self?.computeDailyStats()
            }
        }
    }
    
    private func flushBuffer() {
        guard !usageBuffer.isEmpty else { return }
        
        let fileURL = analyticsDirectory.appendingPathComponent("usage_\(Date().timeIntervalSince1970).json")
        
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(usageBuffer)
            try data.write(to: fileURL)
            usageBuffer = []
        } catch {
            NSLog("[Analytics] Flush failed: \(error)")
        }
    }
    
    private func loadAnalytics() {
        guard FileManager.default.fileExists(atPath: analyticsDirectory.path) else {
            return
        }
        
        do {
            let files = try FileManager.default.contentsOfDirectory(at: analyticsDirectory, includingPropertiesForKeys: nil)
            
            for file in files where file.pathExtension == "json" {
                let data = try Data(contentsOf: file)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let usage = try decoder.decode([HotkeyUsage].self, from: data)
                usageHistory.append(contentsOf: usage)
            }
            
            computeDailyStats()
        } catch {
            NSLog("[Analytics] Load failed: \(error)")
        }
    }
    
    private func computeDailyStats() {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: usageHistory) { usage in
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.string(from: usage.timestamp)
        }
        
        dailyStats = grouped.map { date, usages in
            let totalPresses = usages.count
            let uniqueHotkeys = Set(usages.map { $0.hotkey })
            let completionTimes = usages.compactMap { $0.completionTimeMs }
            let averageCompletionTime = completionTimes.isEmpty ? 0 : completionTimes.reduce(0, +) / Double(completionTimes.count)
            let errors = usages.filter { !$0.success }.count
            let errorRate = Double(errors) / Double(totalPresses)
            
            // Top hotkeys
            let hotkeyCounts = Dictionary(grouping: usages) { $0.hotkey }
                .map { (hotkey: $0.key, count: $0.value.count) }
                .sorted { $0.count > $1.count }
                .prefix(5)
                .map { ($0.hotkey, $0.count) }
            
            return DailyStats(
                date: date,
                totalPresses: totalPresses,
                uniqueHotkeys: uniqueHotkeys,
                averageCompletionTime: averageCompletionTime,
                errorRate: errorRate,
                topHotkeys: hotkeyCounts
            )
        }.sorted { $0.date > $1.date }
    }
    
    func generateSuggestions() {
        suggestions = []
        
        // Analyze patterns
        let hotkeyFrequency = Dictionary(grouping: usageHistory) { $0.hotkey }
            .map { (hotkey: $0.key, count: $0.value.count) }
            .sorted { $0.count > $1.count }
        
        // Suggestion 1: High-frequency action without hotkey
        let actionFrequency = Dictionary(grouping: usageHistory) { $0.action }
            .map { (action: $0.key, count: $0.value.count) }
            .sorted { $0.count > $1.count }
        
        if let topAction = actionFrequency.first, topAction.count > 20 {
            suggestions.append(HotkeySuggestion(
                action: topAction.action,
                reason: "You use '\(topAction.action)' \(topAction.count) times. Assign a hotkey?",
                priority: .high
            ))
        }
        
        // Suggestion 2: Slow completion time
        let slowHotkeys = usageHistory.filter { ($0.completionTimeMs ?? 0) > 1000 }
        if !slowHotkeys.isEmpty {
            let slowestHotkey = slowHotkeys.max { a, b in
                (a.completionTimeMs ?? 0) < (b.completionTimeMs ?? 0)
            }
            if let slowest = slowestHotkey {
                suggestions.append(HotkeySuggestion(
                    action: slowest.action,
                    reason: "'\(slowest.hotkey)' is slow (\(Int(slowest.completionTimeMs ?? 0))ms). Optimize?",
                    priority: .medium
                ))
            }
        }
        
        // Suggestion 3: Context-aware
        let contextFrequency = Dictionary(grouping: usageHistory.filter { $0.context == currentContext }) { $0.hotkey }
            .map { (hotkey: $0.key, count: $0.value.count) }
            .sorted { $0.count > $1.count }
        
        if contextFrequency.count > 0 {
            suggestions.append(HotkeySuggestion(
                action: "Switch to \(currentContext) mode",
                reason: "In \(currentContext) mode, you use different shortcuts. Auto-switch?",
                priority: .low
            ))
        }
    }
    
    func acceptSuggestion(_ suggestion: HotkeySuggestion) {
        NSLog("[Analytics] Accepted suggestion: \(suggestion.action)")
        // Integration with HotkeyPreferences needed
    }
    
    func dismissSuggestion(_ suggestion: HotkeySuggestion) {
        suggestions.removeAll { $0.id == suggestion.id }
    }
}

// MARK: - HotkeySuggestion Model

struct HotkeySuggestion: Identifiable, Equatable {
    let id: UUID
    let action: String
    let reason: String
    let priority: Priority
    
    enum Priority: String {
        case low = "Low"
        case medium = "Medium"
        case high = "High"
        
        var color: Color {
            switch self {
            case .low: return .blue
            case .medium: return .orange
            case .high: return .red
            }
        }
    }
    
    init(id: UUID = UUID(), action: String, reason: String, priority: Priority) {
        self.id = id
        self.action = action
        self.reason = reason
        self.priority = priority
    }
}

// MARK: - AnalyticsDashboardView

struct AnalyticsDashboardView: View {
    @StateObject private var viewModel = HotkeyAnalyticsViewModel()
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Hotkey Analytics")
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
                VStack(spacing: 24) {
                    // Stats overview
                    statsOverview
                    
                    // Suggestions
                    if !viewModel.suggestions.isEmpty {
                        suggestionsSection
                    }
                    
                    // Daily chart
                    dailyChartSection
                }
                .padding(20)
            }
        }
        .frame(width: 600, height: 600)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
    
    private var statsOverview: some View {
        HStack(spacing: 16) {
            StatCard(
                title: "Total Presses",
                value: "\(viewModel.usageHistory.count)",
                icon: "keyboard"
            )
            
            StatCard(
                title: "Unique Hotkeys",
                value: "\(Set(viewModel.usageHistory.map { $0.hotkey }).count)",
                icon: "command"
            )
            
            StatCard(
                title: "Avg Time",
                value: String(format: "%.0fms", viewModel.dailyStats.first?.averageCompletionTime ?? 0),
                icon: "clock"
            )
            
            StatCard(
                title: "Error Rate",
                value: String(format: "%.1f%%", (viewModel.dailyStats.first?.errorRate ?? 0) * 100),
                icon: "exclamationmark.triangle"
            )
        }
    }
    
    private var suggestionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("AI Suggestions")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokDim)
            
            ForEach(viewModel.suggestions) { suggestion in
                SuggestionCard(suggestion: suggestion)
            }
        }
    }
    
    private var dailyChartSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Last 7 Days")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokDim)
            
            // Simple bar chart
            HStack(alignment: .bottom, spacing: 8) {
                ForEach(viewModel.getDailyStats(days: 7)) { stat in
                    VStack {
                        Rectangle()
                            .fill(Color.blue.opacity(0.7))
                            .frame(height: CGFloat(min(stat.totalPresses, 50)) * 2)
                        
                        Text(String(stat.date.suffix(2)))
                            .font(.system(size: 10))
                            .foregroundColor(.grokDim)
                    }
                }
            }
            .frame(height: 120)
        }
    }
}

// MARK: - StatCard

struct StatCard: View {
    let title: String
    let value: String
    let icon: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundColor(.blue)
                Spacer()
            }
            
            Text(value)
                .font(.system(size: 24, weight: .bold))
                .foregroundColor(.grokText)
            
            Text(title)
                .font(.system(size: 12))
                .foregroundColor(.grokDim)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(8)
    }
}

// MARK: - SuggestionCard

struct SuggestionCard: View {
    let suggestion: HotkeySuggestion
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(suggestion.action)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.grokText)
                Text(suggestion.reason)
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
            }
            
            Spacer()
            
            HStack(spacing: 8) {
                Text(suggestion.priority.rawValue)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(suggestion.priority.color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(suggestion.priority.color.opacity(0.1))
                    .cornerRadius(4)
                
                Button(action: {}) {
                    Text("Accept")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                
                Button(action: {}) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Color.grokElevated.opacity(0.3))
        .cornerRadius(8)
    }
}

// MARK: - Preview

#if DEBUG
struct AnalyticsDashboardViewPreview: PreviewProvider {
    static var previews: some View {
        AnalyticsDashboardView()
    }
}
#endif
