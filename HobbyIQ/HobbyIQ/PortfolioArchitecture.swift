//
//  PortfolioArchitecture.swift
//  HobbyIQ
//

import Combine
import Foundation
import SwiftUI

/// CF-IOS-GRADER-STATUS-UI (2026-06-28): backend's persisted grader-status
/// bucket on each holding. Three real states power the dropdown today:
/// `available` (in-hand), `atPsa` (sent in for grading), `pendingRedemption`
/// (graded but waiting for slab pickup). Backend type retains a 4th
/// `in_route` for forward-compat but iOS deliberately omits it — no rows
/// use it and surfacing it would clutter the picker.
enum GraderStatus: String, Codable, Hashable, CaseIterable, Identifiable {
    case available
    case atPsa = "at_psa"
    case pendingRedemption = "pending_redemption"

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .available:          return "Available"
        case .atPsa:              return "At PSA"
        case .pendingRedemption:  return "Pending Redemption"
        }
    }

    var tintColor: Color {
        switch self {
        case .available:          return HobbyIQTheme.Colors.mutedText
        case .atPsa:              return HobbyIQTheme.Colors.electricBlue
        case .pendingRedemption:  return .orange
        }
    }
}

struct CardInput: Identifiable, Hashable {
    let id: UUID
    let playerName: String
    let cardName: String
    let cost: Double

    init(id: UUID = UUID(), playerName: String, cardName: String, cost: Double) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.cost = cost
    }
}

struct CardEstimate: Identifiable, Hashable {
    let id: UUID
    let playerName: String
    let cardName: String
    let estimatedValue: Double
    let confidence: String

    init(
        id: UUID = UUID(),
        playerName: String,
        cardName: String,
        estimatedValue: Double,
        confidence: String
    ) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.estimatedValue = estimatedValue
        self.confidence = confidence
    }
}

/// CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29): per-grade anchor sale the
/// backend ladder fallback uses when computing an estimated FMV. Renders
/// in the detail view as "Anchor: PSA 9 $755, today" or, for raw anchors,
/// "Last sold: $1185 raw, 4 days ago". `confidence` is 0.0–1.0 (engine-
/// internal), not currently surfaced.
struct NearestGradedAnchor: Codable, Hashable {
    let grade: String
    let price: Double
    let daysOld: Int
    let sampleSize: Int
    let confidence: Double
}

/// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383): compact seller card
/// shown on the holding detail sheet when the holding was auto-created
/// from an eBay purchase and the Browse API returned seller info.
struct EbaySeller: Codable, Hashable {
    let username: String
    let feedbackScore: Int?
}

/// CF-PROGRESSIVE-BUCKETS (backend PR #393): server-owned confidence
/// tier that drives the review queue's bucket UX. iOS never bucketizes
/// from the raw `suggestionConfidence` number — backend owns the
/// thresholds so iOS stays semantic.
enum SuggestionConfidenceTier: String, Codable, Hashable {
    case high
    case medium
    case low
}

/// CF-PROGRESSIVE-BUCKETS (backend PR #393): server-computed field-by-
/// field diff between the parsed row and the suggested catalog card.
/// Rendered on the individual-review sheet as "Matched N of M fields
/// (mismatch: parallel, grade)".
struct SuggestionMatchBreakdown: Codable, Hashable {
    let fieldsChecked: Int
    let fieldsMatched: Int
    let mismatchedFields: [String]
}

/// CF-CARDID-SUGGEST (backend PR #389): Cardsight catalog match
/// preview shown next to a pending-review holding so the user can
/// accept the match with one tap. Wire may send `year` as either a
/// number or a string; keep it flexible via a string projection.
struct SuggestionCandidate: Codable, Hashable {
    let title: String?
    let set: String?
    let year: String?
    let number: String?
    let variant: String?
    let image: String?

    private enum CodingKeys: String, CodingKey {
        case title, set, year, number, variant, image
    }

    /// Direct construction — used when iOS picks a match from the
    /// catalog-search sheet and needs to render it in the "Suggested
    /// match" card without a round-trip to the backend.
    init(
        title: String? = nil,
        set: String? = nil,
        year: String? = nil,
        number: String? = nil,
        variant: String? = nil,
        image: String? = nil
    ) {
        self.title = title
        self.set = set
        self.year = year
        self.number = number
        self.variant = variant
        self.image = image
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.title = try? c.decodeIfPresent(String.self, forKey: .title)
        self.set = try? c.decodeIfPresent(String.self, forKey: .set)
        // `year` can arrive as `2020` (Int), `2020.0` (Double), or "2020"
        // (String). Normalize to String for display convenience.
        if let s = try? c.decodeIfPresent(String.self, forKey: .year) {
            self.year = s
        } else if let i = try? c.decodeIfPresent(Int.self, forKey: .year) {
            self.year = String(i)
        } else if let d = try? c.decodeIfPresent(Double.self, forKey: .year) {
            self.year = String(Int(d))
        } else {
            self.year = nil
        }
        self.number = try? c.decodeIfPresent(String.self, forKey: .number)
        self.variant = try? c.decodeIfPresent(String.self, forKey: .variant)
        self.image = try? c.decodeIfPresent(String.self, forKey: .image)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(set, forKey: .set)
        try container.encodeIfPresent(year, forKey: .year)
        try container.encodeIfPresent(number, forKey: .number)
        try container.encodeIfPresent(variant, forKey: .variant)
        try container.encodeIfPresent(image, forKey: .image)
    }
}

extension InventoryCard {
    /// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383): priority chain for
    /// the row / grid / detail-sheet primary thumbnail. Order per the
    /// PR contract — eBay Browse photos win over the user's uploaded
    /// photo because they're the source of truth for the auto-imported
    /// row. When the user later uploads their own photo, that flows
    /// into `imageFrontUrl` which sits above `catalogImageUrl` /
    /// `ebayImageUrl` in the local-user preference: user uploads still
    /// dominate downstream. The `photos[]` array is a hint refreshed on
    /// next portfolio load; treat as non-authoritative.
    var preferredThumbnailURL: String? {
        if let first = photos?.first, first.isEmpty == false { return first }
        if let ebay = ebayImageUrl, ebay.isEmpty == false { return ebay }
        if let front = imageFrontUrl, front.isEmpty == false { return front }
        if let catalog = catalogImageUrl, catalog.isEmpty == false { return catalog }
        return nil
    }

    /// True when the row should show the "via eBay" confirmation chip.
    var showsEbayConfirmedChip: Bool { enrichedFromEbay == true }

    /// True when the row should show the "Needs review" pill. Suppressed
    /// when the holding is eBay-confirmed (Browse enrichment) — those
    /// rows are structured data, not a title parse.
    var showsNeedsReviewPill: Bool {
        (needsReview == true) && (enrichedFromEbay != true)
    }

    /// CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388): auto-imported eBay
    /// holdings land in `status = "pending-review"` and MUST stay out
    /// of inventory value / P&L / dashboard totals until the user
    /// confirms them. The backend excludes these from `/api/portfolio`
    /// already; this helper is the client-side belt for anywhere the
    /// list would still leak through.
    var isPendingReview: Bool {
        status.lowercased() == "pending-review"
    }

    /// Backend PR #383/#384 confidence buckets:
    ///   • `enrichedFromEbay == true` → 0.95+, eBay-confirmed
    ///   • parseConfidence 0.70–0.94 → title-parsed only, needs review
    ///   • parseConfidence < 0.70 → not auto-created (never reaches iOS)
    ///
    /// Returns `.high` when eBay confirmed the row via Browse, `.needs`
    /// otherwise. Used to color the row pill in the review queue and
    /// to drive the "Confirm all high-confidence (N)" batch action.
    enum ReviewConfidenceBucket {
        case high      // enrichedFromEbay == true OR parseConfidence >= 0.95
        case needs     // parseConfidence in 0.70..<0.95
    }

    var reviewConfidenceBucket: ReviewConfidenceBucket {
        if enrichedFromEbay == true { return .high }
        if let pc = parseConfidence, pc >= 0.95 { return .high }
        return .needs
    }

    /// CF-EBAY-RELIST (backend PR #388): true when the holding has been
    /// published to eBay and the row should surface the "Listed on
    /// eBay — $X" chip.
    var isListedOnEbay: Bool {
        (ebayOfferId?.isEmpty == false) || (ebayListingId?.isEmpty == false)
    }

    /// CF-PROGRESSIVE-BUCKETS (backend PR #393): bucket for the
    /// progressive review UX. Prefers server-owned tier; falls back
    /// to `.low` when the tier is missing OR there's no suggested
    /// cardId at all (both = manual match required).
    var reviewBucket: ReviewBucket {
        if let tier = suggestionConfidenceTier {
            switch tier {
            case .high: return .high
            case .medium: return .medium
            case .low: return .low
            }
        }
        return suggestedCardId == nil ? .low : .medium
    }

    enum ReviewBucket {
        case high     // auto-matched, safe to bulk-confirm
        case medium   // quick look, verify + accept
        case low      // manual match required
    }
}

struct InventoryCard: Identifiable, Hashable, Codable {
    let id: UUID
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let status: String
    let year: String
    let setName: String
    let parallel: String
    let grade: String
    // CF-AUTOPRICE-GRADE-CONTRACT (2026-05-27): canonical structured grade
    // fields. `gradeCompany` ("PSA", "BGS", "SGC", "CGC") and `gradeValue`
    // (Double — supports decimal BGS/CSG grades like 9.5/8.5 alongside
    // integer PSA grades) replace the joined `grade` label string as
    // the source of truth for grade-aware pricing. The legacy `grade`
    // string remains on the wire for display compatibility.
    //
    // Backend autoPriceHolding reads gradingCompany ?? gradeCompany and
    // gradeValue directly — without these fields, /api/compiq/estimate
    // searches the raw/ungraded comp bucket regardless of the user's
    // actual slab grade. See cardsight.translator.ts:31-99.
    //
    // gradeValue MUST be Double (not Int) — Int? loses the fractional
    // on BGS 9.5 / CSG 8.5 grades AND crashes JSONDecoder when the
    // backend sends a decimal number (Swift's strict decoder rejects
    // "Parsed JSON number 9.5 does not fit in Int"). Backend type
    // contract is `number`; Double matches and the cardsight translator
    // does `String(...).trim()` to coerce for match against Cardsight's
    // `grade_value` string field.
    //
    // Optional with default nil to preserve backward compat for existing
    // call sites that haven't been threaded through yet.
    let gradeCompany: String?
    let gradeValue: Double?
    let purchaseDate: String?
    let purchasePlatform: String?
    let quantity: Double?
    let notes: String?
    let imageFrontUrl: String?
    let imageBackUrl: String?
    /// CF-INVENTORY-CATALOG-IMAGE (2026-07-05): backend-served card
    /// image (same CDN URL the comp-card hero uses). Populated on
    /// holdings the engine has resolved to a Cardsight catalog card.
    /// Rendered as the inventory row/grid thumbnail whenever the
    /// user hasn't uploaded their own `imageFrontUrl` photo. Nil on
    /// legacy or unmatched holdings; view falls through to the
    /// initials/photo-glyph placeholder.
    let catalogImageUrl: String?
    /// CF-ACTION-BADGES (2026-07-06, backend §1): per-holding
    /// seller-facing verdict. Named `actionRecommendation` (NOT
    /// `recommendation`) because a legacy `recommendation: String`
    /// field is already on the wire for backward-compat. iOS must
    /// read this new one; the old one is ignored.
    let actionRecommendation: CardPanelGradeEntry.ActionRecommendation?
    /// CF-HOLDING-REGRADE (2026-07-06, PR #294): PSA/BGS/SGC/CGC cert
    /// number. Always on the wire per backend regression tests; iOS
    /// was silently dropping it. Round-trips through the
    /// `/regrade` endpoint. Nil for raw / legacy holdings.
    let certNumber: String?
    let lowValue: Double?
    let highValue: Double?
    let confidence: Double?
    let method: String?
    let summary: String?
    var isAuto: Bool = false
    /// P0.3 (2026-07-16, backend PR #496): BGS Black Label / Pristine
    /// (BGS 10 with all four subgrades = 10). Prices at ~9× the raw
    /// tier. Nil for every non-BGS-10 holding + regular BGS 10s;
    /// only set true when the grade string literally contains a
    /// Black Label / BL / Pristine token. iOS never sets this for
    /// PSA 10 Pristine (that label belongs to a retired Cardsight
    /// tier — Black Label is BGS-only).
    let isBlackLabel: Bool?
    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): backend-persisted grader bucket.
    /// `available` is the default; missing/null on the wire decodes to it.
    var graderStatus: GraderStatus = .available

    // PR B: photo-storage-sas schema additions
    let photos: [String]?
    let clientId: String?

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): predictedPrice* fields removed
    // from InventoryCard. Backtest established direction is at-chance;
    // every render site of these fields was stripped in this same CF
    // (per-card detail / list / grid chips + Movement modal + portfolio
    // pulse card + CompIQ Market Analysis group). Wire keys silently
    // ignored on decode (Codable init uses `try?` for every field).
    //
    // TODO(CF-INVENTORY-PREDICTED-PRICE, 2026-07-01): backend re-added
    // `predictedPrice` + `fairMarketValueLive` on /api/compiq/search
    // (matched-cohort momentum infrastructure), but the PortfolioHolding
    // wire shape still doesn't emit these fields on GET /api/portfolio.
    // CompIQ page renders Predicted Next Price today
    // (CompIQPricedCardView, CF-IOS-COMPIQ-PREDICTED-PRICE); the
    // inventory row + detail sheet are DEFERRED until the holding wire
    // shape carries `predictedPrice` and `fairMarketValueLive`. Do NOT
    // re-add fields here without a matching backend wire-shape CF.

    // Anchor field (already persisted backend-side)
    let fairMarketValue: Double?

    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): backend valuation bucket.
    // "observed" → row has comp-anchored FMV (fairMarketValue is set).
    // "estimated" → row has a model estimate but no observed comp (fmv=nil,
    //   estimateLow/High would carry the band — not decoded on iOS yet).
    // "pending" → no estimate at all (fmv=nil, no estimate fields).
    // nil → legacy wire row pre-Step-1; treat as pending when fmv is also nil.
    //
    // Used ONLY for the inventory hero's "N estimated · M pending" subtitle
    // count split — Story B's display-only contract holds: every row with
    // fairMarketValue == nil still renders "—" regardless of bucket. The
    // collection-value card is the surface that includes the estimated
    // bucket in its headline.
    let valuationStatus: String?

    /// CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29): backend ladder-fallback
    /// fields populated on holdings the engine couldn't observe directly.
    /// `estimatedValue` is the ladder-derived FMV; `estimateBasis` is the
    /// engine's human-readable provenance prose surfaced in the detail
    /// view's "Why this estimate" disclosure. `nearestGradedAnchor`
    /// carries the anchor sale itself for the row's context caption.
    let estimatedValue: Double?
    let estimateLow: Double?
    let estimateHigh: Double?
    let estimateBasis: String?
    let estimateConfidence: String?
    let nearestGradedAnchor: NearestGradedAnchor?

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): movement* fields removed —
    // direction-class signals every render site of which was stripped
    // in this same CF. Wire keys silently ignored on decode.

    /// Cardsight catalog UUID resolved at identify / cert-resolve time. When
    /// present, the backend can comp the holding without re-matching from
    /// text fields. Optional + backward-compatible: legacy holdings decode
    /// with this as nil and continue to work via text-based matching.
    let cardId: String?

    /// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): LiveMarket headline +
    /// model-line + lean-badge wire fields surfaced on the holdings
    /// list. All three independently optional — render whichever blocks
    /// arrive populated. `lastSaleSurface` uses `date` (not `soldDate`)
    /// per the holding wire contract; the view layer maps it to a
    /// shared display value.
    let lastSaleSurface: LiveMarketLastSaleSurface?
    let modelExpectation: LiveMarketModelExpectation?
    let modelSignal: LiveMarketModelSignal?

    /// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383, 2026-07-12): every
    /// field below is emitted when a holding was auto-created from an
    /// eBay purchase import. All optional/additive; older manual
    /// holdings decode with these as nil and continue to work.
    ///
    /// `source == "ebay-auto"` marks the auto-import provenance.
    /// `enrichedFromEbay == true` means Browse API item specifics were
    /// merged authoritatively over the title parse — treat these as
    /// eBay-confirmed (skip the "review" prompt). `needsReview` is
    /// backend-driven; iOS respects it verbatim, gated on
    /// `enrichedFromEbay != true` per the PR #383 UI contract.
    let source: String?
    let sourcePurchaseId: String?
    let parseConfidence: Double?
    let needsReview: Bool?
    let enrichedFromEbay: Bool?
    let team: String?
    let sport: String?
    let manufacturer: String?
    let ebayImageUrl: String?
    let ebayShortDescription: String?
    let ebayItemAspects: [String: String]?
    let ebayCategoryPath: String?
    let ebaySeller: EbaySeller?

    /// CF-EBAY-RELIST (backend PR #388 handoff): once the user publishes
    /// a holding to eBay via `POST /api/ebay/listings/publish`, backend
    /// stores the offer/listing/list-price on the holding so the row
    /// can render a "Listed on eBay — $X" badge without a per-row
    /// status roundtrip.
    let ebayOfferId: String?
    let ebayListingId: String?
    let listingPrice: Double?

    /// CF-CARDID-SUGGEST (backend PR #389): Cardsight catalog cardId
    /// proposal computed during eBay auto-import. `suggestionConfidence`
    /// is 0.4–0.95; the candidate carries the resolved catalog metadata
    /// so the Review sheet can render a preview before the user
    /// accepts. Nil = no suggestion yet; call
    /// `POST /erp/holdings/generate-suggestions` on queue open to fill.
    let suggestedCardId: String?
    let suggestionConfidence: Double?
    let suggestionCandidate: SuggestionCandidate?
    let suggestionUpdatedAt: String?

    /// CF-PROGRESSIVE-BUCKETS (backend PR #393): confidence tier owned
    /// server-side so iOS bucketing stays semantic. `high` = auto-
    /// matched, safe to bulk-confirm; `medium` = quick verify;
    /// `low` (or `suggestedCardId == nil`) = manual match required.
    let suggestionConfidenceTier: SuggestionConfidenceTier?
    let suggestionMatchBreakdown: SuggestionMatchBreakdown?

    /// CF-UNIVERSAL-MUTATION-ENVELOPE (backend PR #395): every mutation
    /// route now returns the fully-persisted holding — including the
    /// current held-expense array — so iOS can drop the PATCH+refetch
    /// pattern. Decoded straight into `heldExpenses`; the detail sheet
    /// renders from this instead of firing a separate GET /expenses.
    let heldExpenses: [HoldingHeldExpense]?

    /// CF-BACKEND-ID (2026-07-12): backend emits a stable string id
    /// (e.g. `h_abc123`) for every holding. The struct's `id: UUID` is
    /// derived from it via `UUID.deterministic(from:)` for ForEach
    /// stability, but the derived UUID is NOT what the backend
    /// recognizes on write endpoints — /confirm, /reject, /sell all
    /// need the raw wire string. Persist it here so mutations hit
    /// the right holding.
    let backendId: String?

    // The Codable conformance + CodingKeys for InventoryCard live in the
    // extension at CompatibilityShims.swift:1584 — that extension defines
    // its own custom init(from:) which wins over any struct-level synthesized
    // implementation. Adding CodingKeys here would be dead code (the wire-
    // shape aliases are applied inside that extension's init).

    init(
        id: UUID = UUID(),
        playerName: String,
        cardName: String,
        cost: Double,
        currentValue: Double,
        status: String,
        year: String = "",
        setName: String = "",
        parallel: String = "",
        grade: String = "",
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        purchaseDate: String? = nil,
        purchasePlatform: String? = nil,
        quantity: Double? = nil,
        notes: String? = nil,
        imageFrontUrl: String? = nil,
        imageBackUrl: String? = nil,
        catalogImageUrl: String? = nil,
        actionRecommendation: CardPanelGradeEntry.ActionRecommendation? = nil,
        certNumber: String? = nil,
        lowValue: Double? = nil,
        highValue: Double? = nil,
        confidence: Double? = nil,
        method: String? = nil,
        summary: String? = nil,
        isAuto: Bool = false,
        isBlackLabel: Bool? = nil,
        graderStatus: GraderStatus = .available,
        photos: [String]? = nil,
        clientId: String? = nil,
        fairMarketValue: Double? = nil,
        valuationStatus: String? = nil,
        estimatedValue: Double? = nil,
        estimateLow: Double? = nil,
        estimateHigh: Double? = nil,
        estimateBasis: String? = nil,
        estimateConfidence: String? = nil,
        nearestGradedAnchor: NearestGradedAnchor? = nil,
        cardId: String? = nil,
        lastSaleSurface: LiveMarketLastSaleSurface? = nil,
        modelExpectation: LiveMarketModelExpectation? = nil,
        modelSignal: LiveMarketModelSignal? = nil,
        source: String? = nil,
        sourcePurchaseId: String? = nil,
        parseConfidence: Double? = nil,
        needsReview: Bool? = nil,
        enrichedFromEbay: Bool? = nil,
        team: String? = nil,
        sport: String? = nil,
        manufacturer: String? = nil,
        ebayImageUrl: String? = nil,
        ebayShortDescription: String? = nil,
        ebayItemAspects: [String: String]? = nil,
        ebayCategoryPath: String? = nil,
        ebaySeller: EbaySeller? = nil,
        ebayOfferId: String? = nil,
        ebayListingId: String? = nil,
        listingPrice: Double? = nil,
        suggestedCardId: String? = nil,
        suggestionConfidence: Double? = nil,
        suggestionCandidate: SuggestionCandidate? = nil,
        suggestionUpdatedAt: String? = nil,
        suggestionConfidenceTier: SuggestionConfidenceTier? = nil,
        suggestionMatchBreakdown: SuggestionMatchBreakdown? = nil,
        heldExpenses: [HoldingHeldExpense]? = nil,
        backendId: String? = nil
    ) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.cost = cost
        self.currentValue = currentValue
        self.status = status
        self.year = year
        self.setName = setName
        self.parallel = parallel
        self.grade = grade
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.purchaseDate = purchaseDate
        self.purchasePlatform = purchasePlatform
        self.quantity = quantity
        self.notes = notes
        self.imageFrontUrl = imageFrontUrl
        self.imageBackUrl = imageBackUrl
        self.catalogImageUrl = catalogImageUrl
        self.actionRecommendation = actionRecommendation
        self.certNumber = certNumber
        self.lowValue = lowValue
        self.highValue = highValue
        self.confidence = confidence
        self.method = method
        self.summary = summary
        self.isAuto = isAuto
        self.isBlackLabel = isBlackLabel
        self.graderStatus = graderStatus
        self.photos = photos
        self.clientId = clientId
        self.fairMarketValue = fairMarketValue
        self.valuationStatus = valuationStatus
        self.estimatedValue = estimatedValue
        self.estimateLow = estimateLow
        self.estimateHigh = estimateHigh
        self.estimateBasis = estimateBasis
        self.estimateConfidence = estimateConfidence
        self.nearestGradedAnchor = nearestGradedAnchor
        self.cardId = cardId
        self.lastSaleSurface = lastSaleSurface
        self.modelExpectation = modelExpectation
        self.modelSignal = modelSignal
        self.source = source
        self.sourcePurchaseId = sourcePurchaseId
        self.parseConfidence = parseConfidence
        self.needsReview = needsReview
        self.enrichedFromEbay = enrichedFromEbay
        self.team = team
        self.sport = sport
        self.manufacturer = manufacturer
        self.ebayImageUrl = ebayImageUrl
        self.ebayShortDescription = ebayShortDescription
        self.ebayItemAspects = ebayItemAspects
        self.ebayCategoryPath = ebayCategoryPath
        self.ebaySeller = ebaySeller
        self.ebayOfferId = ebayOfferId
        self.ebayListingId = ebayListingId
        self.listingPrice = listingPrice
        self.suggestedCardId = suggestedCardId
        self.suggestionConfidence = suggestionConfidence
        self.suggestionCandidate = suggestionCandidate
        self.suggestionUpdatedAt = suggestionUpdatedAt
        self.suggestionConfidenceTier = suggestionConfidenceTier
        self.suggestionMatchBreakdown = suggestionMatchBreakdown
        self.heldExpenses = heldExpenses
        self.backendId = backendId
    }

    /// P/L is measured against the backend's market value, not the
    /// stored `currentValue` field. `currentValue` is a legacy total
    /// that can drift stale (or be typed as a profit amount in old
    /// versions of the Edit form), which used to invert the sign on
    /// well-priced rows — e.g. Market $307 vs Purchase $205 rendered
    /// P/L −$203 because currentValue held $2. Prefer `fairMarketValue`
    /// (per-unit, ×qty) whenever the pricing engine has priced the
    /// row; fall through to the legacy field only when the backend
    /// hasn't returned FMV yet.
    var profitLoss: Double {
        let qty = max(1.0, quantity ?? 1.0)
        if let fmv = fairMarketValue, fmv > 0 {
            return (fmv * qty) - cost
        }
        return currentValue - cost
    }
}

struct Sale: Identifiable, Hashable, Codable {
    let id: UUID
    let cardId: UUID
    let playerName: String
    let cardName: String
    let cost: Double
    let salePrice: Double
    let fees: Double
    let profit: Double
    let date: Date

    init(
        id: UUID = UUID(),
        cardId: UUID,
        playerName: String,
        cardName: String,
        cost: Double,
        salePrice: Double,
        fees: Double,
        profit: Double,
        date: Date
    ) {
        self.id = id
        self.cardId = cardId
        self.playerName = playerName
        self.cardName = cardName
        self.cost = cost
        self.salePrice = salePrice
        self.fees = fees
        self.profit = profit
        self.date = date
    }

    var margin: Double {
        salePrice > 0 ? profit / salePrice : 0
    }
}

protocol CompIQProvider {
    func bulkEstimate(cards: [CardInput]) async throws -> [CardEstimate]
}

protocol PortfolioProvider {
    func getInventory() async -> [InventoryCard]
    func saveInventory(_ cards: [InventoryCard]) async
    func getSales() async -> [Sale]
    func saveSale(_ sale: Sale) async
}

final class LocalCompIQProvider: CompIQProvider {
    func bulkEstimate(cards: [CardInput]) async throws -> [CardEstimate] {
        cards.map { card in
            let multiplier = stableMultiplier(for: card)
            return CardEstimate(
                playerName: card.playerName,
                cardName: card.cardName,
                estimatedValue: card.cost * multiplier,
                confidence: confidenceLabel(for: multiplier)
            )
        }
    }

    private func stableMultiplier(for card: CardInput) -> Double {
        let source = "\(card.playerName)|\(card.cardName)".unicodeScalars.map(\.value).reduce(0, +)
        let normalized = Double(source % 100) / 100
        return 1.2 + normalized
    }

    private func confidenceLabel(for multiplier: Double) -> String {
        switch multiplier {
        case ..<1.5:
            return "medium"
        case ..<1.9:
            return "good"
        default:
            return "high"
        }
    }
}

@MainActor
final class LocalPortfolioProvider: ObservableObject, PortfolioProvider {
    static let shared = LocalPortfolioProvider()

    private static let inventoryKey = "hiq.local.inventory"
    private static let salesKey = "hiq.local.sales"

    @Published private var inventory: [InventoryCard]
    @Published private var sales: [Sale]

    init(
        inventory: [InventoryCard]? = nil,
        sales: [Sale]? = nil
    ) {
        if let inventory {
            self.inventory = inventory
        } else {
            self.inventory = Self.loadFromDisk(key: Self.inventoryKey) ?? []
        }
        if let sales {
            self.sales = sales
        } else {
            self.sales = Self.loadFromDisk(key: Self.salesKey) ?? []
        }
    }

    func getInventory() async -> [InventoryCard] {
        inventory
    }

    func saveInventory(_ cards: [InventoryCard]) async {
        inventory = cards
        Self.saveToDisk(cards, key: Self.inventoryKey)
    }

    func getSales() async -> [Sale] {
        sales
    }

    func saveSale(_ sale: Sale) async {
        sales.append(sale)
        Self.saveToDisk(sales, key: Self.salesKey)
    }

    // MARK: - Disk Persistence

    private static func saveToDisk<T: Encodable>(_ value: T, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    private static func loadFromDisk<T: Decodable>(key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

final class CompIQService {
    let provider: CompIQProvider

    init(provider: CompIQProvider) {
        self.provider = provider
    }

    func bulkEstimate(cards: [CardInput]) async throws -> [CardEstimate] {
        try await provider.bulkEstimate(cards: cards)
    }
}

struct PortfolioPerformanceSnapshot {
    let totalSold: Double
    let totalProfit: Double
    let margin: Double

    static let empty = PortfolioPerformanceSnapshot(totalSold: 0, totalProfit: 0, margin: 0)
}

final class PortfolioService {
    let provider: PortfolioProvider

    init(provider: PortfolioProvider) {
        self.provider = provider
    }

    func getInventory() async -> [InventoryCard] {
        await provider.getInventory()
    }

    func saveInventory(_ cards: [InventoryCard]) async {
        await provider.saveInventory(cards)
    }

    func getSales() async -> [Sale] {
        await provider.getSales()
    }

    func addSale(card: InventoryCard, salePrice: Double, fees: Double) async {
        let profit = salePrice - card.cost - fees

        let sale = Sale(
            cardId: card.id,
            playerName: card.playerName,
            cardName: card.cardName,
            cost: card.cost,
            salePrice: salePrice,
            fees: fees,
            profit: profit,
            date: Date()
        )

        await provider.saveSale(sale)
    }

    func markCardAsSold(
        card: InventoryCard,
        salePrice: Double,
        fees: Double,
        date: Date
    ) async {
        let profit = salePrice - card.cost - fees

        let sale = Sale(
            cardId: card.id,
            playerName: card.playerName,
            cardName: card.cardName,
            cost: card.cost,
            salePrice: salePrice,
            fees: fees,
            profit: profit,
            date: date
        )

        let inventory = await provider.getInventory()
        let remaining = inventory.filter { $0.id != card.id }
        await provider.saveInventory(remaining)
        await provider.saveSale(sale)
    }

    func appendEstimatedCards(_ cards: [InventoryCard]) async {
        let existing = await provider.getInventory()
        await provider.saveInventory(existing + cards)
    }

    func calculateSummary(sales: [Sale]) -> (month: Double, year: Double) {
        let calendar = Calendar.current
        let now = Date()

        let monthly = sales.filter {
            calendar.isDate($0.date, equalTo: now, toGranularity: .month) &&
            calendar.isDate($0.date, equalTo: now, toGranularity: .year)
        }

        let yearly = sales.filter {
            calendar.isDate($0.date, equalTo: now, toGranularity: .year)
        }

        let monthlyProfit = monthly.reduce(0) { $0 + $1.profit }
        let yearlyProfit = yearly.reduce(0) { $0 + $1.profit }

        return (monthlyProfit, yearlyProfit)
    }

    func performanceSnapshot(for sales: [Sale], in period: PortfolioPeriod) -> PortfolioPerformanceSnapshot {
        let calendar = Calendar.current
        let now = Date()

        let filteredSales = sales.filter { sale in
            switch period {
            case .month:
                return calendar.isDate(sale.date, equalTo: now, toGranularity: .month) &&
                    calendar.isDate(sale.date, equalTo: now, toGranularity: .year)
            case .year:
                return calendar.isDate(sale.date, equalTo: now, toGranularity: .year)
            }
        }

        let totalSold = filteredSales.reduce(0) { $0 + $1.salePrice }
        let totalProfit = filteredSales.reduce(0) { $0 + $1.profit }
        let margin = totalSold > 0 ? (totalProfit / totalSold) * 100 : 0

        return PortfolioPerformanceSnapshot(
            totalSold: totalSold,
            totalProfit: totalProfit,
            margin: margin
        )
    }

    func exportInventoryCSV(cards: [InventoryCard]) throws -> URL {
        var csv = "Player Name,Year,Set,Card Name,Parallel,Grade,Cost,Current Value,Status\n"

        for card in cards {
            let row = [
                card.playerName.csvEscaped,
                card.year.csvEscaped,
                card.setName.csvEscaped,
                card.cardName.csvEscaped,
                card.parallel.csvEscaped,
                card.grade.csvEscaped,
                String(format: "%.2f", card.cost),
                String(format: "%.2f", card.currentValue),
                card.status.csvEscaped
            ].joined(separator: ",")

            csv.append(row)
            csv.append("\n")
        }

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("hobbyiq_inventory.csv")

        try csv.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL
    }
}

enum PortfolioPeriod {
    case month
    case year
}

private extension String {
    var csvEscaped: String {
        let escaped = replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}
