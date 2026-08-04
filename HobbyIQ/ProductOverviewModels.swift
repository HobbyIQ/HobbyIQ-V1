// CF-CATALOG-FIRST product-structure models (Drew, 2026-08-04).
//
// Codable mirrors of the backend/src/routes/productStructure.routes.ts
// response shape. Field names MUST stay 1:1 with the TypeScript types
// in apps/web/src/lib/api.ts:ProductStructure — every rename touches
// three places (backend response, web `ProductStructure`, this file).

import Foundation

struct ProductParallel: Codable, Hashable, Identifiable {
    let section: String
    let name: String
    let printRun: Int?
    // Compose section + name so SwiftUI's ForEach has a stable id
    // without polluting the wire shape.
    var id: String { "\(section):\(name)" }
}

struct ProductSubset: Codable, Hashable, Identifiable {
    let name: String
    let cardPrefix: String?
    let parallelCount: Int
    var id: String { name }
}

struct ProductRelic: Codable, Hashable, Identifiable {
    let name: String
    let cardPrefix: String?
    var id: String { name }
}

struct ProductStructure: Codable, Hashable {
    let productKey: String
    let productName: String
    let sourcePage: String
    let year: Int
    let sport: String
    let brand: String
    let setKey: String
    let parentSetKey: String?
    let setName: String
    let parallels: [ProductParallel]
    let inserts: [ProductSubset]
    let autos: [ProductSubset]
    let gameUsed: [ProductRelic]
    let gimmicks: [ProductRelic]
    let parallelCount: Int
    let insertCount: Int
    let autoCount: Int
    let gameUsedCount: Int
    let gimmickCount: Int
    let fetchedAt: String
    let lastImportedAt: String
}

struct ProductStructureResponse: Codable {
    let success: Bool
    let product: ProductStructure
}

struct ProductListItem: Codable, Hashable, Identifiable {
    let productKey: String
    let productName: String
    let year: Int
    let brand: String
    let setKey: String
    let parentSetKey: String?
    let setName: String
    let parallelCount: Int
    let insertCount: Int
    let autoCount: Int
    let gameUsedCount: Int
    let gimmickCount: Int
    var id: String { productKey }
}

struct ProductListResponse: Codable {
    let success: Bool
    let count: Int
    let products: [ProductListItem]
}
