//
//  QueenPermissions.swift
//  TriOS - Queen Master Chat
//
//  Role-based permissions system
//

import Foundation

/// QueenPermissions - Manages role-based access control
class QueenPermissions {
    
    private var rolePermissions: [QueenRole: Set<Permission>] = [:]
    
    init() {
        setupDefaultPermissions()
    }
    
    /// Get role for member in session
    func getRole(for member: TeamMember, in session: TeamSession) -> QueenRole {
        if member.id == session.owner {
            return .owner
        }
        return member.defaultRole
    }
    
    /// Check if member has permission
    func hasPermission(_ permission: Permission, for member: TeamMember, in session: TeamSession) -> Bool {
        let role = getRole(for: member, in: session)
        return rolePermissions[role]?.contains(permission) ?? false
    }
    
    /// Check if member can perform action
    func can(_ action: Action, for member: TeamMember, in session: TeamSession) -> Bool {
        let requiredPermission = action.requiredPermission
        return hasPermission(requiredPermission, for: member, in: session)
    }
    
    // MARK: - Private Methods
    
    private func setupDefaultPermissions() {
        // Owner permissions
        rolePermissions[.owner] = Set([
            .read, .write, .delete,
            .invite, .remove,
            .configure, .administrate
        ])
        
        // Admin permissions
        rolePermissions[.admin] = Set([
            .read, .write,
            .invite,
            .configure
        ])
        
        // Member permissions
        rolePermissions[.member] = Set([
            .read, .write
        ])
        
        // Viewer permissions
        rolePermissions[.viewer] = Set([
            .read
        ])
    }
}

// MARK: - Models

enum Permission: String, Hashable {
    case read
    case write
    case delete
    case invite
    case remove
    case configure
    case administrate
}

enum Action {
    case viewChat
    case sendMessage
    case deleteMessage
    case inviteMember
    case removeMember
    case configureSession
    case deleteSession
    
    var requiredPermission: Permission {
        switch self {
        case .viewChat: return .read
        case .sendMessage: return .write
        case .deleteMessage: return .delete
        case .inviteMember: return .invite
        case .removeMember: return .remove
        case .configureSession: return .configure
        case .deleteSession: return .delete
        }
    }
}
