//
//  ListingReviewModels.swift
//  HobbyIQ
//
//  2026-07-20 (backend PR TBD): wire models for the Listing Review
//  & Edit flow. `POST /api/ebay/listings/prepare` returns the
//  pre-filled payload iOS shows the user for review; the same
//  shape is echoed back to `POST /api/ebay/listings/publish`
//  after the user's edits.
//
//  Every field here is optional so a partial backend response
//  (e.g. missing photos, no captured aspects yet) still decodes
//  cleanly — the `validation` block tells us which fields are
//  actually required for publish.
//

import Foundation

// MARK: - Request

struct ListingPrepareRequest: Encodable {
    let holdingId: String
}

// MARK: - Response

struct PreparedListing: Codable, Hashable {
    let success: Bool?
    let holdingId: String?
    var identity: ListingIdentity
    var condition: ListingCondition
    var categoryAspects: ListingCategoryAspects
    var photos: [String]
    var listing: ListingDetails
    let validation: ListingValidation?
}

// MARK: - Identity

struct ListingIdentity: Codable, Hashable {
    var playerName: String?
    var cardYear: Int?
    var setName: String?
    var parallel: String?
    var cardNumber: String?
    var isAuto: Bool
    var isRookie: Bool
    var team: String?
    /// Required by eBay; iOS defaults to "Baseball" if the backend
    /// omits it, so downstream field derivations (league default
    /// mapping) don't hit nil.
    var sport: String
}

// MARK: - Condition

struct ListingCondition: Codable, Hashable {
    var isGraded: Bool
    var gradingCompany: String?  // PSA / BGS / SGC / CGC
    var grade: String?           // "10" / "9.5" / etc.
    var certNumber: String?
    var conditionEstimate: String?  // "Near Mint" / "Excellent" / …
    var conditionNotes: String?
}

/// Raw-card condition tier picker options — matches eBay's
/// "Sports Trading Cards" category condition dropdown.
enum RawConditionEstimate: String, CaseIterable, Identifiable, Codable {
    case nearMint = "Near Mint"
    case excellent = "Excellent"
    case veryGood = "Very Good"
    case good = "Good"
    case fair = "Fair"
    case poor = "Poor"
    var id: String { rawValue }
}

enum GradingCompany: String, CaseIterable, Identifiable, Codable {
    case psa = "PSA"
    case bgs = "BGS"
    case sgc = "SGC"
    case cgc = "CGC"
    var id: String { rawValue }
}

enum ListingSport: String, CaseIterable, Identifiable, Codable {
    case baseball = "Baseball"
    case football = "Football"
    case basketball = "Basketball"
    case hockey = "Hockey"
    case soccer = "Soccer"
    var id: String { rawValue }

    /// Default league mapping used to pre-select the League field
    /// when the backend hasn't populated it. Kept iOS-side because
    /// it's presentation, not truth — the backend still owns final
    /// validation.
    var defaultLeague: String {
        switch self {
        case .baseball: return "MLB"
        case .football: return "NFL"
        case .basketball: return "NBA"
        case .hockey: return "NHL"
        case .soccer: return "MLS"
        }
    }
}

// MARK: - Category aspects (eBay-required)

struct ListingCategoryAspects: Codable, Hashable {
    var league: String?               // MLB / NFL / NBA / NHL / MLS
    var type: String?                 // "Sports Trading Card" default
    var countryOfManufacture: String? // "United States" default
    var yearManufactured: Int?
    var season: Int?
    var language: String?             // "English" default
}

// MARK: - Listing details

struct ListingDetails: Codable, Hashable {
    var quantity: Int
    var priceCents: Int
    var bestOfferEnabled: Bool
    var bestOfferMinPriceCents: Int?
    var description: String
    var titleSuggested: String

    /// Convenience read for the price editor. Backend authoritative
    /// value is always in cents; iOS presents dollars.
    var priceDollars: Double {
        get { Double(priceCents) / 100 }
        set { priceCents = Int((newValue * 100).rounded()) }
    }
}

// MARK: - Validation envelope

struct ListingValidation: Codable, Hashable {
    let requiredMissing: [String]
    let warnings: [String]
    let readyToPublish: Bool
}
