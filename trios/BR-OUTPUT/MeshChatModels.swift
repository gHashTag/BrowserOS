// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: untracked mesh-chat models introduced on feat/zai-provider break Codable
//         synthesis (Character does not conform to Encodable). Triage before T27 seal.
// Expires: 2026-12-31
// Follow-up: create separate issue/branch to fix MeshChatModels Codable conformance.
import Foundation
import SwiftUI

// MARK: - Message Kind

enum MeshChatMessageKind: UInt8, Codable, Equatable {
    case text = 0
    case photo = 1
    case video = 2
    case voice = 3
    case status = 4
    case ack = 5

    var iconName: String {
        switch self {
        case .text: return "text.bubble"
        case .photo: return "photo"
        case .video: return "video.fill"
        case .voice: return "waveform"
        case .status: return "info.circle"
        case .ack: return "checkmark.circle"
        }
    }

    var isMedia: Bool {
        self == .photo || self == .video || self == .voice
    }

    var localizedLabel: String {
        switch self {
        case .text: return "Text"
        case .photo: return "Photo"
        case .video: return "Video"
        case .voice: return "Voice"
        case .status: return "Status"
        case .ack: return "Ack"
        }
    }
}

// MARK: - Message

struct MeshChatMessage: Identifiable, Codable, Equatable {
    let id: UInt64
    let peer: UInt32
    let kind: UInt8
    let text: String?
    let payloadBase64: String?
    let sentAt: UInt64
    let acked: Bool
    let channel: String
    let isOutgoing: Bool

    var channelCharacter: Character {
        channel.first ?? "T"
    }

    var messageKind: MeshChatMessageKind {
        MeshChatMessageKind(rawValue: kind) ?? .status
    }

    var displayText: String {
        text ?? ""
    }

    var sentDate: Date {
        Date(timeIntervalSince1970: TimeInterval(sentAt))
    }

    var formattedTime: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: sentDate)
    }

    var formattedDate: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter.string(from: sentDate)
    }

    var isToday: Bool {
        Calendar.current.isDateInToday(sentDate)
    }
}

// MARK: - Conversation

struct MeshConversation: Identifiable, Codable, Equatable {
    let peer: UInt32
    let lastMessageId: UInt64
    let unread: Int
    let updatedAt: UInt64

    var id: UInt32 { peer }

    var updatedDate: Date {
        Date(timeIntervalSince1970: TimeInterval(updatedAt))
    }

    var formattedUpdated: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: updatedDate, relativeTo: Date())
    }
}

// MARK: - Peer

struct MeshPeer: Identifiable, Codable, Equatable {
    let nodeId: UInt32
    var displayName: String?
    var lastSeen: UInt64?
    var signalDbm: Int?

    var id: UInt32 { nodeId }

    var name: String {
        displayName ?? "Node \(nodeId)"
    }
}

// MARK: - Requests

struct MeshChatSendRequest: Codable {
    let dst: UInt32
    let kind: UInt8
    let text: String?
    let payloadBase64: String?
}

struct MeshChatReceiveRequest: Codable {
    let src: UInt32
    let frame: String
}

struct MeshChatAckRequest: Codable {
    let peer: UInt32
}

struct MeshSeedPeerRequest: Codable {
    let peer: UInt32
    let publicKey: String
    let address: String?
}

// MARK: - Responses

struct MeshChatSendResponse: Codable {
    let id: UInt64
    let frame: String
    let queued: Bool
}

struct MeshChatReceiveResponse: Codable {
    let id: UInt64
    let kind: UInt8
    let text: String?
}

struct MeshChatMessagesResponse: Codable {
    let peer: UInt32
    let messages: [MeshChatMessage]
}

struct MeshChatPollResponse: Codable {
    let messages: [MeshChatMessage]
    let conversations: [MeshConversation]
}

// MARK: - Polling Helpers

struct MeshChatSinceQuery: Codable {
    var sinceId: UInt64
}

// MARK: - Date Grouping

extension MeshChatMessage {
    /// Key used to group messages by calendar day in the thread view.
    var dayKey: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: sentDate)
    }
}
