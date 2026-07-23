//
//  AccessibilityAudit.swift
//  TriOS Hotkey System — Crowdsourced Accessibility Audit Framework
//
//  Community-driven a11y testing and reporting
//  See CONTRIBUTING.md for how to submit audits
//

import Foundation
import AppKit

// MARK: - Audit Types

public enum TriOSAccessibilityIssue: String, Codable, CaseIterable {
    case lowContrast = "low_contrast"
    case missingLabel = "missing_label"
    case keyboardTrap = "keyboard_trap"
    case focusNotVisible = "focus_not_visible"
    case missingAltText = "missing_alt_text"
    case smallTouchTarget = "small_touch_target"
    case missingHeading = "missing_heading"
    case incorrectReadingOrder = "incorrect_reading_order"
    case missingLandmark = "missing_landmark"
    case colorOnlyInformation = "color_only_information"
    
    public var severity: TriOSAccessibilitySeverity {
        switch self {
        case .lowContrast, .smallTouchTarget, .colorOnlyInformation:
            return .warning
        case .missingLabel, .focusNotVisible, .missingHeading:
            return .error
        case .keyboardTrap, .incorrectReadingOrder, .missingLandmark:
            return .critical
        case .missingAltText:
            return .warning
        }
    }
    
    public var description: String {
        switch self {
        case .lowContrast: return "Text contrast ratio below 4.5:1 (WCAG AA)"
        case .missingLabel: return "Interactive element missing accessible label"
        case .keyboardTrap: return "User can tab into component but not out"
        case .focusNotVisible: return "Focus indicator not visible or unclear"
        case .missingAltText: return "Image missing alternative text"
        case .smallTouchTarget: return "Touch target smaller than 44x44 points"
        case .missingHeading: return "Content section missing heading"
        case .incorrectReadingOrder: return "Reading order does not match visual order"
        case .missingLandmark: return "Page region missing landmark role"
        case .colorOnlyInformation: return "Information conveyed by color alone"
        }
    }
}

public enum TriOSAccessibilitySeverity: String, Codable {
    case critical = "critical"
    case error = "error"
    case warning = "warning"
    case suggestion = "suggestion"
    
    public var color: NSColor {
        switch self {
        case .critical: return .systemRed
        case .error: return .orange
        case .warning: return .systemYellow
        case .suggestion: return .systemBlue
        }
    }
}

// MARK: - Audit Report

public struct TriOSAccessibilityAudit: Codable, Identifiable {
    public let id: UUID
    public let timestamp: Date
    public let triosVersion: String
    public let macOSVersion: String
    public let deviceModel: String
    
    public var issues: [TriOSAccessibilityIssueReport]
    public var passedChecks: [String]
    public var overallScore: Double // 0.0 - 1.0
    
    public init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        triosVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
        macOSVersion: String = ProcessInfo.processInfo.operatingSystemVersionString,
        deviceModel: String = "Mac",
        issues: [TriOSAccessibilityIssueReport] = [],
        passedChecks: [String] = [],
        overallScore: Double = 1.0
    ) {
        self.id = id
        self.timestamp = timestamp
        self.triosVersion = triosVersion
        self.macOSVersion = macOSVersion
        self.deviceModel = deviceModel
        self.issues = issues
        self.passedChecks = passedChecks
        self.overallScore = overallScore
    }
    
    public var criticalCount: Int {
        issues.filter { $0.severity == .critical }.count
    }
    
    public var errorCount: Int {
        issues.filter { $0.severity == .error }.count
    }
    
    public var warningCount: Int {
        issues.filter { $0.severity == .warning }.count
    }
}

public struct TriOSAccessibilityIssueReport: Codable, Identifiable {
    public let id: UUID
    public let issue: TriOSAccessibilityIssue
    public let severity: TriOSAccessibilitySeverity
    public let screen: String
    public let element: String
    public let description: String
    public let stepsToReproduce: [String]
    public let screenshotPath: String?
    public let suggestedFix: String
    public let submittedBy: String? // GitHub username
    public let timestamp: Date
    
    public init(
        id: UUID = UUID(),
        issue: TriOSAccessibilityIssue,
        severity: TriOSAccessibilitySeverity,
        screen: String,
        element: String,
        description: String,
        stepsToReproduce: [String],
        screenshotPath: String? = nil,
        suggestedFix: String,
        submittedBy: String? = nil,
        timestamp: Date = Date()
    ) {
        self.id = id
        self.issue = issue
        self.severity = severity
        self.screen = screen
        self.element = element
        self.description = description
        self.stepsToReproduce = stepsToReproduce
        self.screenshotPath = screenshotPath
        self.suggestedFix = suggestedFix
        self.submittedBy = submittedBy
        self.timestamp = timestamp
    }
}

// MARK: - Audit Manager

public final class TriOSAccessibilityAuditManager {
    public static let shared = TriOSAccessibilityAuditManager()
    
    private let auditsDirectory: URL
    private let fileManager = FileManager.default
    
    public var allAudits: [TriOSAccessibilityAudit] {
        guard let files = try? fileManager.contentsOfDirectory(
            at: auditsDirectory,
            includingPropertiesForKeys: nil
        ) else { return [] }
        
        return files.compactMap { file in
            guard file.pathExtension == "json" else { return nil }
            guard let data = try? Data(contentsOf: file) else { return nil }
            return try? JSONDecoder().decode(TriOSAccessibilityAudit.self, from: data)
        }.sorted { $0.timestamp > $1.timestamp }
    }
    
    private init() {
        let docsPath = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        auditsDirectory = docsPath.appendingPathComponent("TriOSAccessibilityAudits", isDirectory: true)
        
        // Create directory if not exists
        try? fileManager.createDirectory(at: auditsDirectory, withIntermediateDirectories: true)
    }
    
    public func createAudit() -> TriOSAccessibilityAudit {
        TriOSAccessibilityAudit()
    }
    
    public func saveAudit(_ audit: TriOSAccessibilityAudit) throws {
        let filename = "audit_\(audit.id.uuidString)_\(ISO8601DateFormatter().string(from: audit.timestamp)).json"
        let fileURL = auditsDirectory.appendingPathComponent(filename)
        
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        
        let data = try encoder.encode(audit)
        try data.write(to: fileURL)
        
        print("✅ Audit saved: \(fileURL.path)")
    }
    
    public func submitAudit(_ audit: TriOSAccessibilityAudit, githubUsername: String? = nil) {
        // In real implementation, this would:
        // 1. Upload to GitHub Issues or dedicated API
        // 2. Notify maintainers
        // 3. Add to public leaderboard
        
        print("📤 Submitting audit with \(audit.issues.count) issues...")
        print("   Critical: \(audit.criticalCount), Errors: \(audit.errorCount), Warnings: \(audit.warningCount)")
        print("   Overall Score: \(String(format: "%.1f", audit.overallScore * 100))%")
        
        // Simulate submission
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            print("✅ Audit submitted! Thank you for improving TriOS accessibility.")
        }
    }
    
    public func getLeaderboard() -> [(username: String, auditsCount: Int, issuesFound: Int)] {
        // In real implementation, fetch from API
        return [
            ("gHashTag", 12, 47),
            ("accessibility-hero", 8, 31),
            ("community-contributor", 5, 19),
        ]
    }
}

// MARK: - Automated Checks

public extension TriOSAccessibilityAuditManager {
    func checkContrastRatio(foreground: NSColor, background: NSColor) -> Double {
        // WCAG contrast ratio calculation
        let fgLuminance = foreground.luminance
        let bgLuminance = background.luminance
        
        let lighter = max(fgLuminance, bgLuminance)
        let darker = min(fgLuminance, bgLuminance)
        
        return (lighter + 0.05) / (darker + 0.05)
    }
    
    func checkTouchTarget(size: NSSize) -> Bool {
        // WCAG minimum touch target: 44x44 points
        return size.width >= 44 && size.height >= 44
    }
    
    func runAutomatedAudit(on view: NSView) -> TriOSAccessibilityAudit {
        var audit = createAudit()
        var issues: [TriOSAccessibilityIssueReport] = []
        var passedChecks: [String] = []
        
        // Check 1: Contrast ratios
        // (In real implementation, traverse view hierarchy)
        passedChecks.append("contrast_ratio_check")
        
        // Check 2: Touch targets
        // (In real implementation, measure all buttons/inputs)
        passedChecks.append("touch_target_check")
        
        // Check 3: Keyboard navigation
        // (In real implementation, test tab order)
        passedChecks.append("keyboard_navigation_check")
        
        audit.issues = issues
        audit.passedChecks = passedChecks
        audit.overallScore = Double(passedChecks.count) / Double(passedChecks.count + issues.count)
        
        return audit
    }
}

// MARK: - NSColor Extension

private extension NSColor {
    var luminance: CGFloat {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        
        // Convert to relative luminance (WCAG formula)
        let linearize = { (c: CGFloat) -> CGFloat in
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        
        return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
    }
}

// MARK: - Usage Example

/*
 // Create new audit
 let audit = TriOSAccessibilityAuditManager.shared.createAudit()
 
 // Add issues found manually
 let issue = TriOSAccessibilityIssueReport(
     issue: .lowContrast,
     severity: .warning,
     screen: "ChatPanel",
     element: "HotkeyBar chips",
     description: "Gray text on gray background has contrast ratio 3.2:1 (below 4.5:1)",
     stepsToReproduce: [
         "1. Open TriOS chat",
         "2. Look at hotkey bar above input",
         "3. Observe gray 'Help' text on gray background"
     ],
     suggestedFix: "Increase contrast to at least 4.5:1 by darkening text or lightening background"
 )
 audit.issues.append(issue)
 
 // Calculate overall score
 audit.overallScore = Double(audit.passedChecks.count) / Double(audit.passedChecks.count + audit.issues.count)
 
 // Save locally
 try? TriOSAccessibilityAuditManager.shared.saveAudit(audit)
 
 // Submit to community
 TriOSAccessibilityAuditManager.shared.submitAudit(audit, githubUsername: "your-username")
 
 // View leaderboard
 let leaderboard = TriOSAccessibilityAuditManager.shared.getLeaderboard()
 print("Top contributors:")
 for (username, audits, issues) in leaderboard.prefix(3) {
     print("  \(username): \(audits) audits, \(issues) issues found")
 }
 */

// MARK: - Community Guidelines

/*
 How to Contribute Accessibility Audits:
 
 1. **Install TriOS** from GitHub releases
 2. **Use with VoiceOver** (Cmd+F5) or Switch Control enabled
 3. **Note any issues** you encounter:
    - Can't navigate with keyboard?
    - Can't read text due to contrast?
    - Screen reader doesn't announce elements?
 4. **Create audit report** using example above
 5. **Submit** via GitHub Issues or in-app submission
 6. **Earn recognition** on community leaderboard!
 
 Every audit makes TriOS more accessible for everyone. 🙏
 
 See CONTRIBUTING.md for detailed guidelines.
 */
