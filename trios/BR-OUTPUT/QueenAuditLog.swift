//
//  QueenAuditLog.swift
//  TriOS - Queen Master Chat
//
//  Audit logging for team actions
//

import Foundation

/// QueenAuditLog - Records all Queen actions for compliance
class QueenAuditLog: ObservableObject {
    
    @Published var logs: [AuditLogEntry] = .init()
    @Published var isRecording: Bool = true
    
    private let maxEntries: Int = 1000
    private let storagePath: String
    
    init(storagePath: String = "/tmp/queen_audit.json") {
        self.storagePath = storagePath
        loadLogs()
    }
    
    /// Log an action
    func log(_ action: AuditAction) async {
        guard isRecording else { return }
        
        let entry = AuditLogEntry(
            id: UUID(),
            timestamp: Date(),
            action: action,
            userId: getCurrentUserId(),
            sessionId: getCurrentSessionId()
        )
        
        logs.insert(entry, at: 0)
        
        // Trim old entries
        if logs.count > maxEntries {
            logs = Array(logs.prefix(maxEntries))
        }
        
        // Persist to disk
        await saveLogs()
    }
    
    /// Get logs for session
    func getLogs(forSession sessionId: UUID, limit: Int = 50) -> [AuditLogEntry] {
        return Array(logs
            .filter { $0.sessionId == sessionId }
            .prefix(limit))
    }
    
    /// Get logs for user
    func getLogs(forUser userId: UUID, limit: Int = 50) -> [AuditLogEntry] {
        return Array(logs
            .filter { $0.userId == userId }
            .prefix(limit))
    }
    
    /// Export logs
    func exportLogs(format: ExportFormat) -> String {
        switch format {
        case .json:
            return encodeToJson(logs)
        case .csv:
            return encodeToCsv(logs)
        }
    }
    
    // MARK: - Private Methods
    
    private func loadLogs() {
        // Load from disk
        if let data = FileManager.default.contents(atPath: storagePath),
           let decoded = try? JSONDecoder().decode([AuditLogEntry].self, from: data) {
            logs = decoded
        }
    }
    
    private func saveLogs() async {
        // Save to disk
        if let data = try? JSONEncoder().encode(logs) {
            try? data.write(to: URL(fileURLWithPath: storagePath))
        }
    }
    
    private func getCurrentUserId() -> UUID {
        // Get current user ID from session
        return UUID()
    }
    
    private func getCurrentSessionId() -> UUID? {
        // Get current session ID
        return UUID()
    }
    
    private func encodeToJson(_ logs: [AuditLogEntry]) -> String {
        guard let data = try? JSONEncoder().encode(logs) else { return "[]" }
        return String(data: data, encoding: .utf8) ?? "[]"
    }
    
    private func encodeToCsv(_ logs: [AuditLogEntry]) -> String {
        var csv = "Timestamp,Action,User,Session\n"
        for log in logs {
            csv += "\(log.timestamp),\(log.action.type),\(log.userId),\(log.sessionId ?? UUID())\n"
        }
        return csv
    }
}

// MARK: - Models

struct AuditLogEntry: Identifiable, Codable {
    let id: UUID
    let timestamp: Date
    let action: AuditAction
    let userId: UUID
    let sessionId: UUID?
}

enum AuditAction: Codable {
    case memberAdded(UUID)
    case memberRemoved(UUID)
    case sessionCreated(UUID)
    case sessionJoined(UUID)
    case sessionLeft(UUID)
    case messageBroadcast(UUID, String)
    case taskDelegated(UUID, String)
    case permissionChanged(UUID, String)
    
    var type: String {
        switch self {
        case .memberAdded: return "MEMBER_ADDED"
        case .memberRemoved: return "MEMBER_REMOVED"
        case .sessionCreated: return "SESSION_CREATED"
        case .sessionJoined: return "SESSION_JOINED"
        case .sessionLeft: return "SESSION_LEFT"
        case .messageBroadcast: return "MESSAGE_BROADCAST"
        case .taskDelegated: return "TASK_DELEGATED"
        case .permissionChanged: return "PERMISSION_CHANGED"
        }
    }
}

enum ExportFormat {
    case json
    case csv
}
