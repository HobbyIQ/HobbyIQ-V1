//
//  CatalogAdditionsModels.swift
//  HobbyIQ
//
//  Wire model for GET /api/catalog/additions?since=YYYY-MM-DD (backend
//  PR #556). Powers the New Drops feed accessible from DailyIQ.
//

import Foundation

struct CatalogAddition: Codable, Identifiable, Hashable {
    let category: String?
    let setName: String?
    let subset: String?
    let addedDate: String?      // YYYY-MM-DD
    let cardCount: Int?
    /// ISO string — never surfaced to the user directly.
    let ingestedAt: String?

    /// Composite id for ForEach/List stability. Combines the fields that
    /// backend uses to group additions.
    var id: String {
        [addedDate ?? "", category ?? "", setName ?? "", subset ?? ""]
            .joined(separator: "|")
    }

    enum CodingKeys: String, CodingKey {
        case category
        case setName    = "set_name"
        case subset
        case addedDate  = "added_date"
        case cardCount  = "card_count"
        case ingestedAt
    }
}

struct CatalogAdditionsResponse: Codable, Hashable {
    let since: String?
    let count: Int?
    let additions: [CatalogAddition]?
}
