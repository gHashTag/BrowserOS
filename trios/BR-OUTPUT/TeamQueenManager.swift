//
//  TeamQueenManager.swift
//  TriOS - Queen Master Chat
//
//  Multi-user team collaboration support
//

import Foundation
import SwiftUI

/// TeamQueenManager - Manages multi-user Queen sessions
@MainActor
class TeamQueenManager: ObservableObject {
    
    @Published var teamMembers: [TeamMember] = []
    @Published var activeSessions: [TeamSession] = []
    @Published var currentRole: QueenRole = .member
    
    private let permissionsManager: QueenPermissions
    private let auditLogger: QueenAuditLog
    
    init(permissionsManager: QueenPermissions = QueenPermissions(),
         auditLogger: QueenAuditLog = QueenAuditLog()) {
        self.permissionsManager = permissionsManager
        self.auditLogger = auditLogger
    }
    
    /// Add team member to Queen session
    func addMember(_ member: TeamMember) async {
        teamMembers.append(member)
        await auditLogger.log(.memberAdded(member.id))
    }
    
    /// Remove team member
    func removeMember(_ memberId: UUID) async {
        teamMembers.removeAll { $0.id == memberId }
        await auditLogger.log(.memberRemoved(memberId))
    }
    
    /// Create shared session
    func createSession(name: String, members: [UUID]) async -> TeamSession {
        let session = TeamSession(
            id: UUID(),
            name: name,
            members: members,
            createdAt: Date(),
            owner: UUID() // Current user
        )
        
        activeSessions.append(session)
        await auditLogger.log(.sessionCreated(session.id))
        
        return session
    }
    
    /// Join session
    func joinSession(_ sessionId: UUID, as member: TeamMember) async {
        if let index = activeSessions.firstIndex(where: { $0.id == sessionId }) {
            if !activeSessions[index].members.contains(member.id) {
                activeSessions[index].members.append(member.id)
            }
            currentRole = permissionsManager.getRole(for: member, in: activeSessions[index])
        }
    }
    
    /// Leave session
    func leaveSession(_ sessionId: UUID) async {
        activeSessions.removeAll { $0.id == sessionId }
    }
    
    /// Broadcast message to all session members
    func broadcast(_ message: String, in sessionId: UUID) async {
        guard let session = activeSessions.first(where: { $0.id == sessionId }) else { return }
        
        for memberId in session.members {
            await sendMessage(message, to: memberId)
        }
        
        await auditLogger.log(.messageBroadcast(sessionId, message))
    }
    
    // MARK: - Private Methods
    
    private func sendMessage(_ message: String, to memberId: UUID) async {
        // Send message to team member
    }
}

// MARK: - Models

struct TeamMember: Identifiable, Codable {
    let id: UUID
    let name: String
    let email: String
    let avatar: String?
    let defaultRole: QueenRole
    let joinedAt: Date
}

struct TeamSession: Identifiable, Codable {
    let id: UUID
    var name: String
    var members: [UUID]
    let createdAt: Date
    let owner: UUID
    var isActive: Bool = true
}

enum QueenRole: String, Codable {
    case owner
    case admin
    case member
    case viewer
    
    var canEdit: Bool {
        [.owner, .admin].contains(self)
    }
    
    var canDelete: Bool {
        self == .owner
    }
    
    var canInvite: Bool {
        [.owner, .admin].contains(self)
    }
}
