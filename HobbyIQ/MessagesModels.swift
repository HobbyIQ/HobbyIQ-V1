// CF-MESSAGING iOS (Drew, 2026-08-05).
//
// Codable mirrors of the web /api/messages/* shapes. Keep field names
// 1:1 with apps/web/src/lib/api.ts:Message/ThreadSummary/HoldingRef —
// renames touch all three: backend response, web `Message`, this file.

import Foundation

enum MessageKind: String, Codable {
    case chat, offer, accepted, sold
}

struct HoldingRef: Codable, Hashable {
    let holdingId: String
    let sellerUserId: String
    let cardTitle: String
    let imageUrl: String?
    let askingPriceCents: Int?
}

struct Message: Codable, Identifiable, Hashable {
    let id: String
    let threadId: String
    let fromUserId: String
    let toUserId: String
    let text: String
    let createdAt: String
    let readAt: String?
    let kind: MessageKind
    let priceCents: Int?
    let holdingRef: HoldingRef?
}

struct ThreadSummary: Codable, Hashable, Identifiable {
    var id: String { threadId }
    let threadId: String
    let otherUserId: String
    let otherUsername: String?
    let lastMessage: LastMessage
    let unreadCount: Int

    struct LastMessage: Codable, Hashable {
        let text: String
        let kind: MessageKind
        let fromMe: Bool
        let createdAt: String
        let priceCents: Int?
    }
}

struct UserDisplay: Codable, Hashable {
    let userId: String
    let username: String?
}

struct MessagesThreadsResponse: Codable {
    let success: Bool
    let threads: [ThreadSummary]
}

struct MessagesThreadResponse: Codable {
    let success: Bool
    let messages: [Message]
    let other: UserDisplay
}

struct MessagesSendRequest: Encodable {
    let toUserId: String
    let text: String
    let kind: MessageKind?
    let priceCents: Int?
    let holdingRef: HoldingRef?
}

struct MessagesSendResponse: Codable {
    let success: Bool
    let message: Message?
    let error: String?
}

struct MessagesUnreadCountResponse: Codable {
    let success: Bool
    let unread: Int
}
