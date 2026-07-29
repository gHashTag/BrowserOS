//
//  QueenIntegrationsHub.swift
//  TriOS - Queen Master Chat
//
//  Central hub for external integrations (Slack, Email, Calendar)
//

import Foundation

/// QueenIntegrationsHub - Manages all external integrations
@MainActor
class QueenIntegrationsHub: ObservableObject {
    
    @Published var connectedServices: [ConnectedService] = []
    @Published var isSyncing: Bool = false
    
    let slackIntegration: SlackIntegration
    let emailIntegration: EmailIntegration
    let calendarIntegration: CalendarIntegration
    
    init() {
        self.slackIntegration = SlackIntegration()
        self.emailIntegration = EmailIntegration()
        self.calendarIntegration = CalendarIntegration()
    }
    
    /// Connect a service
    func connect(_ service: ServiceType, credentials: String) async -> Bool {
        let success: Bool
        
        switch service {
        case .slack:
            success = await slackIntegration.connect(credentials: credentials)
        case .email:
            success = await emailIntegration.connect(credentials: credentials)
        case .calendar:
            success = await calendarIntegration.connect(credentials: credentials)
        }
        
        if success {
            connectedServices.append(ConnectedService(
                type: service,
                connectedAt: Date(),
                isActive: true
            ))
        }
        
        return success
    }
    
    /// Disconnect a service
    func disconnect(_ service: ServiceType) async {
        switch service {
        case .slack:
            await slackIntegration.disconnect()
        case .email:
            await emailIntegration.disconnect()
        case .calendar:
            await calendarIntegration.disconnect()
        }
        
        connectedServices.removeAll { $0.type == service }
    }
    
    /// Sync data from all connected services
    func syncAll() async {
        isSyncing = true
        
        await withTaskGroup(of: Void.self) { group in
            if connectedServices.contains(where: { $0.type == .slack }) {
                group.addTask { await self.slackIntegration.sync() }
            }
            if connectedServices.contains(where: { $0.type == .email }) {
                group.addTask { await self.emailIntegration.sync() }
            }
            if connectedServices.contains(where: { $0.type == .calendar }) {
                group.addTask { await self.calendarIntegration.sync() }
            }
        }
        
        isSyncing = false
    }
    
    /// Send message via integration
    func send(_ message: String, via service: ServiceType, to recipient: String) async -> Bool {
        switch service {
        case .slack:
            return await slackIntegration.send(message, to: recipient)
        case .email:
            return await emailIntegration.send(message, to: recipient)
        case .calendar:
            return false // Calendar doesn't support messaging
        }
    }
}

// MARK: - Models

struct ConnectedService: Identifiable {
    let id = UUID()
    let type: ServiceType
    let connectedAt: Date
    var isActive: Bool
}

enum ServiceType: String, Identifiable, CaseIterable {
    case slack
    case email
    case calendar
    
    var id: String { rawValue }
    
    var displayName: String {
        switch self {
        case .slack: return "Slack"
        case .email: return "Email"
        case .calendar: return "Calendar"
        }
    }
    
    var icon: String {
        switch self {
        case .slack: return "message.fill"
        case .email: return "envelope.fill"
        case .calendar: return "calendar"
        }
    }
}
