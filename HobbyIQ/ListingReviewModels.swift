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
    /// Mutable so `recomputeValidation()` can refresh it after
    /// every debounced user edit — server-side validation only
    /// runs at prepare-time; iOS keeps it live thereafter.
    var validation: ListingValidation?
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

// MARK: - Publish response (backend PR #645)

/// `/api/ebay/listings/publish` returns this shape — not the
/// full `PreparedListing`. On success we get eBay identifiers so
/// iOS can push the user to the live listing; on failure we get
/// a human-readable error and (when applicable) a `missingPolicy`
/// block that tells the user which seller policy needs setup
/// before publish can succeed.
struct PublishResult: Codable, Hashable {
    let success: Bool
    let offerId: String?
    let listingId: String?
    let listingUrl: String?
    let inventoryItemKey: String?
    let error: String?
    let missingPolicy: MissingPolicy?
}

struct MissingPolicy: Codable, Hashable {
    /// "payment" / "return" / "fulfillment"
    let policyType: String
    let reason: String
}

// MARK: - Client-side validation

extension PreparedListing {
    /// Recomputes `validation` in-place from the current field state.
    /// Runs on every debounced edit so the Publish gate reflects
    /// the user's edits immediately instead of waiting for the next
    /// server round-trip. Mirrors the backend rules — if they drift,
    /// the server's rejection wins at publish time, but the local
    /// gate keeps the user from tapping Publish on a form we know
    /// won't succeed.
    mutating func recomputeValidation() {
        var missing: [String] = []
        if photos.isEmpty { missing.append("photos") }
        if (identity.playerName ?? "").isEmpty { missing.append("identity.playerName") }
        if identity.cardYear == nil { missing.append("identity.cardYear") }
        if (identity.setName ?? "").isEmpty { missing.append("identity.setName") }
        if (categoryAspects.league ?? "").isEmpty { missing.append("categoryAspects.league") }
        if (categoryAspects.type ?? "").isEmpty { missing.append("categoryAspects.type") }
        if (categoryAspects.countryOfManufacture ?? "").isEmpty {
            missing.append("categoryAspects.countryOfManufacture")
        }
        if categoryAspects.yearManufactured == nil {
            missing.append("categoryAspects.yearManufactured")
        }
        if listing.priceCents <= 0 { missing.append("listing.priceCents") }
        if listing.titleSuggested.isEmpty { missing.append("listing.title") }
        if condition.isGraded, (condition.grade ?? "").isEmpty {
            missing.append("condition.grade")
        }

        var warnings: [String] = []
        if listing.titleSuggested.count > 80 {
            warnings.append("Title exceeds eBay's 80-char cap and will be truncated")
        }
        if condition.isGraded == false, (condition.conditionEstimate ?? "").isEmpty {
            warnings.append("Raw condition not set — will default to 'Near Mint'")
        }
        if identity.isAuto == false,
           (identity.parallel?.lowercased() ?? "").contains("auto") {
            warnings.append("Parallel mentions 'auto' but Autograph is off")
        }

        validation = ListingValidation(
            requiredMissing: missing,
            warnings: warnings,
            readyToPublish: missing.isEmpty
        )
    }
}
