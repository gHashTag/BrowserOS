import SwiftUI
import AppKit

// MARK: - AccessibilitySettings Model

struct AccessibilitySettings: Codable {
    var voiceOverEnabled: Bool = false
    var reducedMotion: Bool = false
    var dynamicTypeScale: CGFloat = 1.0
    var highContrastMode: Bool = false
    var switchControlEnabled: Bool = false
    var dwellTime: Double = 1.0 // seconds
    
    static let `default` = AccessibilitySettings()
}

// MARK: - AccessibilityViewModel

@MainActor
class AccessibilityViewModel: ObservableObject {
    @Published var settings: AccessibilitySettings = .default
    @Published var currentFontSize: CGFloat = 14.0
    @Published var contrastLevel: ContrastLevel = .normal
    
    enum ContrastLevel: String, CaseIterable {
        case normal = "Normal"
        case high = "High Contrast"
        case dark = "Dark High Contrast"
        
        var backgroundColor: Color {
            switch self {
            case .normal: return Color.grokBackground
            case .high: return Color.black
            case .dark: return Color.black
            }
        }
        
        var textColor: Color {
            switch self {
            case .normal: return Color.grokText
            case .high: return Color.white
            case .dark: return Color.yellow
            }
        }
        
        var accentColor: Color {
            switch self {
            case .normal: return Color.blue
            case .high: return Color.yellow
            case .dark: return Color.green
            }
        }
    }
    
    init() {
        loadSettings()
        detectSystemPreferences()
    }
    
    func loadSettings() {
        // Load from preferences file (similar to HotkeyPreferences)
        settings = .default
    }
    
    func detectSystemPreferences() {
        // Detect macOS accessibility settings
        let voiceOverEnabled = NSWorkspace.shared.isVoiceOverEnabled
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        
        settings.voiceOverEnabled = voiceOverEnabled
        settings.reducedMotion = reduceMotion
        settings.highContrastMode = increaseContrast
        
        contrastLevel = increaseContrast ? .high : .normal
    }
    
    func setContrastLevel(_ level: ContrastLevel) {
        contrastLevel = level
        settings.highContrastMode = (level != .normal)
    }
    
    func setFontSize(_ size: CGFloat) {
        currentFontSize = size
        settings.dynamicTypeScale = size / 14.0
    }
    
    func announce(_ message: String) {
        // VoiceOver announcement
        NSAccessibility.post(
            element: NSApp.mainWindow ?? NSApp.keyWindow,
            notification: .announcementRequested,
            userInfo: [.announcement: message]
        )
    }
}

// MARK: - AccessibilityModifier

struct AccessibilityModifier: ViewModifier {
    @ObservedObject var viewModel: AccessibilityViewModel
    
    func body(content: Content) -> some View {
        content
            .font(.system(size: viewModel.currentFontSize))
            .animation(viewModel.settings.reducedMotion ? .none : .default, value: viewModel.contrastLevel)
            .background(viewModel.contrastLevel.backgroundColor)
            .foregroundColor(viewModel.contrastLevel.textColor)
            .accessibilityAction {
                // VoiceOver custom actions
            }
    }
}

// MARK: - AccessibilityPanelView

struct AccessibilityPanelView: View {
    @StateObject private var viewModel = AccessibilityViewModel()
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Accessibility")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(viewModel.contrastLevel.textColor)
                
                Spacer()
                
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(viewModel.contrastLevel.textColor.opacity(0.7))
                }
                .buttonStyle(.plain)
            }
            .padding(20)
            
            Divider().overlay(Color.grokDivider)
            
            // Content
            ScrollView {
                VStack(spacing: 24) {
                    // Contrast Themes
                    themeSection
                    
                    // Font Size
                    fontSizeSection
                    
                    // Motion
                    motionSection
                    
                    // VoiceOver
                    voiceOverSection
                    
                    // Switch Control
                    switchControlSection
                }
                .padding(20)
            }
        }
        .frame(width: 500, height: 600)
        .background(viewModel.contrastLevel.backgroundColor)
        .cornerRadius(16)
        .modifier(AccessibilityModifier(viewModel: viewModel))
    }
    
    private var themeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Contrast Theme")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(viewModel.contrastLevel.textColor)
            
            VStack(spacing: 8) {
                ForEach(AccessibilityViewModel.ContrastLevel.allCases, id: \.self) { level in
                    ThemeButton(
                        level: level,
                        isSelected: viewModel.contrastLevel == level,
                        onClick: { viewModel.setContrastLevel(level) }
                    )
                }
            }
        }
    }
    
    private var fontSizeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Font Size")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(viewModel.contrastLevel.textColor)
            
            HStack {
                Text("A")
                    .font(.system(size: 12))
                Slider(value: $viewModel.currentFontSize, in: 10...24, step: 2)
                    .onChange(of: viewModel.currentFontSize) { _, newSize in
                        viewModel.setFontSize(newSize)
                    }
                Text("A")
                    .font(.system(size: 24))
            }
            
            Text("Current: \(Int(viewModel.currentFontSize))pt")
                .font(.system(size: 12))
                .foregroundColor(viewModel.contrastLevel.textColor.opacity(0.7))
        }
    }
    
    private var motionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Motion")
                .font(.system(size: 14, weight: .semibold))
            
            Toggle("Reduce Motion", isOn: $viewModel.settings.reducedMotion)
                .toggleStyle(.switch)
        }
    }
    
    private var voiceOverSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("VoiceOver")
                .font(.system(size: 14, weight: .semibold))
            
            HStack {
                Image(systemName: "waveform")
                    .foregroundColor(viewModel.contrastLevel.textColor.opacity(0.7))
                
                VStack(alignment: .leading, spacing: 4) {
                    Text("VoiceOver Status")
                        .font(.system(size: 13))
                    Text(viewModel.settings.voiceOverEnabled ? "Enabled" : "Disabled")
                        .font(.system(size: 11))
                        .foregroundColor(viewModel.contrastLevel.textColor.opacity(0.7))
                }
                
                Spacer()
                
                Button(action: {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.universalaccess") {
                        NSWorkspace.shared.open(url)
                    }
                    viewModel.detectSystemPreferences()
                }) {
                    Text("Open System Preferences")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
            }
        }
    }
    
    private var switchControlSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Switch Control")
                .font(.system(size: 14, weight: .semibold))
            
            Toggle("Enable Switch Control", isOn: $viewModel.settings.switchControlEnabled)
                .toggleStyle(.switch)
            
            if viewModel.settings.switchControlEnabled {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Dwell Time: \(String(format: "%.1f", viewModel.settings.dwellTime))s")
                        .font(.system(size: 12))
                    
                    Slider(value: $viewModel.settings.dwellTime, in: 0.5...2.0, step: 0.1)
                }
                .padding(.top, 8)
            }
        }
    }
}

// MARK: - ThemeButton

struct ThemeButton: View {
    let level: AccessibilityViewModel.ContrastLevel
    let isSelected: Bool
    let onClick: () -> Void
    
    var body: some View {
        Button(action: onClick) {
            HStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(level.backgroundColor)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(level.accentColor, lineWidth: 2)
                    )
                    .frame(width: 40, height: 30)
                
                Text(level.rawValue)
                    .font(.system(size: 13))
                    .foregroundColor(level.textColor)
                
                Spacer()
                
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(level.accentColor)
                }
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(level.accentColor, lineWidth: isSelected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Preview

#if DEBUG
struct AccessibilityPanelViewPreview: PreviewProvider {
    static var previews: some View {
        AccessibilityPanelView()
    }
}
#endif
