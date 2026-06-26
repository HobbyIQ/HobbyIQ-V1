//
//  CompIQSearchModels.swift
//  HobbyIQ
//

import Foundation

// MARK: - Card Search (POST /api/compiq/cardsearch)

struct CompIQVariantSearchRequest: Codable {
    let query: String
}

/// One element of the `parallels[]` array on a Cardsight-source candidate.
/// Backend `CardsightParallel` shape (services/compiq/cardsight.client.ts):
///   { id: string, name: string, numberedTo?: number }
struct CompIQCardsightParallel: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let numberedTo: Int?
}

struct CompIQVariantHit: Codable, Identifiable, Hashable {
    let cardsightCardId: String
    let player: String?
    let set: String?
    let year: Int?
    let number: String?
    let variant: String?
    let title: String?
    let displayLabel: String?
    let imageUrl: String?
    /// CF-PARALLEL-SUBMARKET (2026-06-10): parallel UUID carried through
    /// navigation from a parallel-row tap in the picker. Nil on the wire
    /// (the cardsearch dispatcher's CardIdentity doesn't ship it) and nil
    /// for base-row taps; the picker's `parallelHit(parent:parallel:)`
    /// synth sets it from `parallel.id` so the downstream priceByCardId
    /// can include `parallelId` on the wire request and backend filters
    /// comps to the matched sub-market.
    let parallelId: String?

    // CF-VARIANT-PICKER-RICH (2026-06-07): full CardIdentity disambiguators
    // so the row can surface every signal the candidate carries.
    let brand: String?
    let variation: String?
    let isAuto: Bool
    let serialNumber: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let grade: String?
    let certNumber: String?
    let source: String?
    let attribution: String?
    let confidence: Double?
    let attributes: [String]?
    let parallels: [CompIQCardsightParallel]?

    var id: String { cardsightCardId }

    var resolvedLabel: String {
        if let displayLabel, displayLabel.isEmpty == false { return displayLabel }
        if let title, title.isEmpty == false { return title }
        let parts = [set, player, number, variant].compactMap { $0 }
        return parts.isEmpty ? cardsightCardId : parts.joined(separator: " ")
    }

    /// Bucketed confidence used by the footnote dot. `attribution == "authoritative"`
    /// (cert candidates) force High regardless of the numeric value — those
    /// identities are confirmed by the grader, not relevance-ranked.
    enum ConfidenceLevel { case high, medium, low }

    var confidenceLevel: ConfidenceLevel? {
        if attribution?.lowercased() == "authoritative" { return .high }
        guard let confidence else { return nil }
        if confidence >= 0.8 { return .high }
        if confidence >= 0.5 { return .medium }
        return .low
    }

    /// Friendly source label for the footnote (`"PSA cert"`, `"Cardsight catalog"`).
    var sourceLabel: String? {
        guard let source else { return nil }
        switch source {
        case "psa-cert":          return "PSA cert"
        case "bgs-cert":          return "BGS cert"
        case "sgc-cert":          return "SGC cert"
        case "cgc-cert":          return "CGC cert"
        case "cardsight-catalog": return "Cardsight catalog"
        default:                  return source
        }
    }

    /// Composed display grade label. Prefer the backend's pre-composed `grade`
    /// string; otherwise compose from `{gradeCompany} {gradeValue}`. Returns
    /// nil only when there's nothing to show.
    var gradeDisplay: String? {
        if let grade, grade.isEmpty == false { return grade }
        let company = gradeCompany?.trimmingCharacters(in: .whitespaces)
        let value = gradeValue.map { v -> String in
            // Drop trailing ".0" so "PSA 10" doesn't render as "PSA 10.0".
            v.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", v)
                : String(format: "%.1f", v)
        }
        let parts = [company, value].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Backend (unifiedSearch.dispatcher → CardIdentity) emits `candidateId`
        // as a SOURCE-PREFIXED id, e.g. "cardsight:<uuid>" or "psa:<cert>".
        // /api/compiq/price-by-id expects a bare Cardsight UUID, so strip
        // the "cardsight:" prefix here; preserve other prefixes (cert ids
        // pass through intact).
        let rawCandidateId = try container.decode(String.self, forKey: .cardsightCardId)
        let cardsightPrefix = "cardsight:"
        cardsightCardId = rawCandidateId.hasPrefix(cardsightPrefix)
            ? String(rawCandidateId.dropFirst(cardsightPrefix.count))
            : rawCandidateId
        player = try? container.decodeIfPresent(String.self, forKey: .player)
        set = try? container.decodeIfPresent(String.self, forKey: .set)
        // Wire emits `year` as a STRING on Cardsight catalog rows
        // ("2011") but as an Int on some legacy paths. Accept both so
        // the detail line never silently drops the year segment.
        if let intYear = try? container.decodeIfPresent(Int.self, forKey: .year) {
            year = intYear
        } else if let strYear = try? container.decodeIfPresent(String.self, forKey: .year),
                  let parsed = Int(strYear.trimmingCharacters(in: .whitespaces)) {
            year = parsed
        } else {
            year = nil
        }
        number = try? container.decodeIfPresent(String.self, forKey: .number)
        variant = try? container.decodeIfPresent(String.self, forKey: .variant)
        title = try? container.decodeIfPresent(String.self, forKey: .title)
        displayLabel = try? container.decodeIfPresent(String.self, forKey: .displayLabel)
        imageUrl = try? container.decodeIfPresent(String.self, forKey: .imageUrl)
        brand = try? container.decodeIfPresent(String.self, forKey: .brand)
        variation = try? container.decodeIfPresent(String.self, forKey: .variation)
        // Backend's CardIdentity declares isAuto as required boolean. Default
        // to false on a missing/null value (legacy / lossy rows).
        isAuto = (try? container.decodeIfPresent(Bool.self, forKey: .isAuto)) ?? false
        serialNumber = try? container.decodeIfPresent(String.self, forKey: .serialNumber)
        gradeCompany = try? container.decodeIfPresent(String.self, forKey: .gradeCompany)
        gradeValue = try? container.decodeIfPresent(Double.self, forKey: .gradeValue)
        grade = try? container.decodeIfPresent(String.self, forKey: .grade)
        certNumber = try? container.decodeIfPresent(String.self, forKey: .certNumber)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        attribution = try? container.decodeIfPresent(String.self, forKey: .attribution)
        confidence = try? container.decodeIfPresent(Double.self, forKey: .confidence)
        attributes = try? container.decodeIfPresent([String].self, forKey: .attributes)
        parallels = try? container.decodeIfPresent([CompIQCardsightParallel].self, forKey: .parallels)
        // CF-PARALLEL-SUBMARKET (2026-06-10): wire doesn't carry
        // `parallelId` on cardsearch candidates; nil here is correct.
        // The picker's parallelHit synth populates this for navigation.
        parallelId = nil
    }

    // Backend CardIdentity (cardIdentity.ts) field names:
    //   candidateId, source, attribution, confidence,
    //   player, year, brand, setName, cardNumber, parallel, variation,
    //   isAuto, serialNumber,
    //   grade, gradeCompany, gradeValue, certNumber,
    //   title, imageUrl,
    //   parallels[], attributes[].
    // There is no `displayLabel` on the wire; the computed `resolvedLabel`
    // falls back to title + parts when displayLabel is nil.
    private enum CodingKeys: String, CodingKey {
        case cardsightCardId = "candidateId"
        case player, year, brand
        case set = "setName"
        case number = "cardNumber"
        case variant = "parallel"
        case variation
        case isAuto, serialNumber
        case grade, gradeCompany, gradeValue, certNumber
        case source, attribution, confidence
        case title
        case displayLabel
        case imageUrl
        case attributes, parallels
    }

    init(
        cardsightCardId: String,
        player: String? = nil,
        set: String? = nil,
        year: Int? = nil,
        number: String? = nil,
        variant: String? = nil,
        title: String? = nil,
        displayLabel: String? = nil,
        imageUrl: String? = nil,
        brand: String? = nil,
        variation: String? = nil,
        isAuto: Bool = false,
        serialNumber: String? = nil,
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        grade: String? = nil,
        certNumber: String? = nil,
        source: String? = nil,
        attribution: String? = nil,
        confidence: Double? = nil,
        attributes: [String]? = nil,
        parallels: [CompIQCardsightParallel]? = nil,
        parallelId: String? = nil
    ) {
        self.cardsightCardId = cardsightCardId
        self.player = player
        self.set = set
        self.year = year
        self.number = number
        self.variant = variant
        self.title = title
        self.displayLabel = displayLabel
        self.imageUrl = imageUrl
        self.brand = brand
        self.variation = variation
        self.isAuto = isAuto
        self.serialNumber = serialNumber
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.grade = grade
        self.certNumber = certNumber
        self.source = source
        self.attribution = attribution
        self.confidence = confidence
        self.attributes = attributes
        self.parallels = parallels
        self.parallelId = parallelId
    }

    init(from holding: InventoryCard) {
        self.cardsightCardId = holding.id.uuidString
        self.player = holding.playerName
        self.set = holding.setName.isEmpty ? nil : holding.setName
        self.year = Int(holding.year)
        self.number = nil
        self.variant = holding.parallel.isEmpty ? nil : holding.parallel
        self.title = holding.cardName
        self.displayLabel = holding.cardName
        self.imageUrl = holding.imageFrontUrl
        self.brand = nil
        self.variation = nil
        self.isAuto = holding.isAuto
        self.serialNumber = nil
        self.gradeCompany = holding.gradeCompany
        self.gradeValue = holding.gradeValue
        self.grade = holding.grade.isEmpty ? nil : holding.grade
        self.certNumber = nil
        self.source = nil
        self.attribution = nil
        self.confidence = nil
        self.attributes = nil
        self.parallels = nil
        self.parallelId = nil
    }
}

/// CF-FIND-CARDS-PHASE-B: typeahead suggestion list returned by
/// GET /api/compiq/suggest. Wire shape `{ "query": String, "suggestions":
/// [String] }`. Both fields defensive-optional, matching the project's
/// CompIQVariantListResponse convention — a malformed payload renders as
/// "no suggestions" rather than throwing.
struct CompIQSuggestResponse: Codable {
    let query: String?
    let suggestions: [String]?
}

struct CompIQVariantListResponse: Codable {
    let success: Bool?
    let query: String?
    let count: Int?
    let results: [CompIQVariantHit]?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Dispatcher response shape: { input, candidates, warnings }.
        // No success field is emitted; consumers should tolerate nil
        // and treat the presence of `candidates` as success.
        success = try? container.decodeIfPresent(Bool.self, forKey: .success)
        query = try? container.decodeIfPresent(String.self, forKey: .query)
        count = try? container.decodeIfPresent(Int.self, forKey: .count)
        results = try? container.decodeIfPresent([CompIQVariantHit].self, forKey: .results)
    }

    private enum CodingKeys: String, CodingKey {
        case success
        case query, count
        case results = "candidates"
    }
}

// MARK: - Price By ID (POST /api/compiq/price-by-id)

struct CompIQPriceByIdRequest: Codable {
    let cardsightCardId: String
    let query: String?
    let gradeCompany: String?
    let gradeValue: Double?
    /// CF-PARALLEL-SUBMARKET (2026-06-10): per-parallel comp filter.
    /// Wire keys match `backend/src/routes/compiq.routes.ts:1158` —
    /// `parallelId` (UUID-shape; backend validates) selects the
    /// sub-market, `parallelName` is descriptive (e.g. "Blue Refractor").
    /// Both omitted on base-card requests; cache key includes
    /// `parallelId` so base vs parallel sit at separate entries.
    let parallelId: String?
    let parallelName: String?
}

struct PriceZone: Codable, Hashable {
    let low: Double?
    let high: Double?

    init(low: Double?, high: Double?) {
        self.low = low
        self.high = high
    }

    init(from array: [Double?]?) {
        self.low = array?.first.flatMap { $0 }
        self.high = (array?.count ?? 0) > 1 ? array?[1] : nil
    }
}

struct CompIQPriceMarketTier: Codable, Hashable {
    let value: Double?
    let high: Double?
}

struct CompIQPriceTrendAnalysis: Codable, Hashable {
    let marketDirection: String?
    let changeFromOlderToRecent: String?
    let liquidity: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        marketDirection = try? container.decodeIfPresent(String.self, forKey: .marketDirection)
        // Backend may send as number or string
        if let str = try? container.decodeIfPresent(String.self, forKey: .changeFromOlderToRecent) {
            changeFromOlderToRecent = str
        } else if let num = try? container.decodeIfPresent(Double.self, forKey: .changeFromOlderToRecent) {
            changeFromOlderToRecent = String(format: "%.1f%%", num)
        } else {
            changeFromOlderToRecent = nil
        }
        liquidity = try? container.decodeIfPresent(String.self, forKey: .liquidity)
    }

    private enum CodingKeys: String, CodingKey {
        case marketDirection = "market_direction"
        case changeFromOlderToRecent = "change_from_older_to_recent"
        case liquidity
    }
}

struct CompIQPriceCardIdentity: Codable, Hashable {
    let cardId: String?
    let player: String?
    /// Subset name (e.g. "Base Set", "Chrome Prospect Autographs").
    let set: String?
    /// CF-RELEASE-IDENTITY (2026-06-10): release name (e.g. "Topps Update").
    /// Backend ships both `set` (subset) and `release` (publication line);
    /// the header prefers `release` so the identity reads "2011 Topps
    /// Update · #US175" instead of "2011 Base Set · #US175".
    let release: String?
    let year: Int?
    let number: String?
    let variant: String?

    private enum CodingKeys: String, CodingKey {
        case cardId = "card_id"
        case player, set, release, year, number, variant
    }
}

/// CF-FULL-GRADE-RAIL (2026-06-10): one bucket of the engine's per-grade
/// sale-pool inventory. Backend ships every (grader, grade) for which it
/// has data — the iOS rail renders a selectable chip per numeric-grade
/// bucket with `compCount > 0` (non-numeric grades like "Authentic" are
/// filtered out client-side until the request body grows a `gradeLabel`
/// field). `median` and `recentDirection` are decoded for availability
/// — the rail currently uses only `grader` + `grade` + `compCount`.
struct CompIQGradeBreakdownEntry: Codable, Hashable, Identifiable {
    let grader: String?
    /// Raw wire value as a string — can be numeric ("10", "9.5") or
    /// non-numeric ("Authentic"). The view layer decides whether to
    /// render based on whether `numericGrade` resolves.
    let grade: String?
    let compCount: Int?
    let median: Double?
    let recentDirection: String?
    /// CF-GRADED-RAIL-RENDER (2026-06-12): backend `53ab950+` attaches a
    /// `note` field when an observed grade's median sits below the
    /// observed raw median for the same scope ("Raw trades above PSA 9
    /// here — common for hot prospects."). Display-only — the median
    /// itself is real and unmodified. iOS renders this beneath the
    /// observed value block when the user selects a sub-raw bucket.
    let note: String?

    var id: String { "\(grader ?? "")-\(grade ?? "")" }

    /// Numeric grade parsed from the wire string, or nil for non-numeric
    /// labels like "Authentic". A nil here = chip not selectable in the
    /// current request shape (`gradeValue: Double?`).
    var numericGrade: Double? {
        guard let raw = grade?.trimmingCharacters(in: .whitespaces),
              raw.isEmpty == false else { return nil }
        return Double(raw)
    }
}

/// CF-GRADED-RAIL-RENDER (2026-06-12): one bucket of the engine's per-
/// grade ESTIMATE inventory (separate from gradeBreakdown, which is
/// purely observed). Returned when the /price-by-id request body
/// includes any valid (gradeCompany, gradeValue) pair — the array shape
/// is identical regardless of which pair was sent (PSA 10 / BGS 9.5
/// produce byte-identical arrays per backend handoff). Each entry is
/// the engine's projection for that grade, with a confidence tier and a
/// human-readable basis prose. Values are pre-rounded by the engine to
/// the tier's significant-figure rule — render as-is, no reformatting.
struct CompIQGradedEstimate: Codable, Hashable, Identifiable {
    /// Human-readable grade label as returned by the engine ("PSA 10",
    /// "BGS 9.5", "SGC 10", "PSA 9"). Identifier source.
    let grade: String?
    let estimatedValue: Double?
    let estimateLow: Double?
    let estimateHigh: Double?
    /// One-sentence basis ("Anchor: …. Ratio: …."). The view surfaces it
    /// on the rail's ballpark / no-data faces and beneath the expanded
    /// estimate block.
    let basis: String?
    /// One of: "estimate", "rough", "ballpark", "no-data". The defensive
    /// "insufficient" the backend never emits is mapped to .noData by
    /// `tier` so the view never needs to know about it.
    let confidenceTier: String?

    // MARK: - CF-IOS-HONEST-RANGES (2026-06-16)
    // Comp-sufficiency tiering that drives the iOS state-aware estimate
    // render. Backend is the single source of truth — never recompute
    // sufficiency on-device. All optional + defensive-decoded; a payload
    // without these fields degrades gracefully to the legacy `tier` path.

    /// "sufficient" (≥3 comps → point + "Based on N sales"),
    /// "thin" (1-2 comps → point + range + "Based on N sale(s)"),
    /// "none" (0 comps OR top-tier override → range-only "No recent comps").
    let compSufficiency: String?
    /// Drives the basis prose: "comps", "comps-thin", or "multiplier-range".
    /// Always present alongside compSufficiency.
    let estimateBasis: String?
    /// Observed comp count that anchored the estimate; surfaces as
    /// "Based on N sale(s)" when ≥1.
    let n: Int?
    /// Fitted-multiplier range bounds for the "no recent comps" state's
    /// "≈ Lo–Hi× base" tertiary line. Null on observed-anchor paths.
    let multiplierLow: Double?
    let multiplierHigh: Double?
    /// Dollar range used by the honest-ranges render. Distinct from the
    /// legacy estimateLow/High (which still ships for back-compat); when
    /// honest-ranges is active the renderer reads rangeLow/High.
    let rangeLow: Double?
    let rangeHigh: Double?

    var id: String { grade ?? UUID().uuidString }

    enum Tier: String {
        case estimate
        case rough
        case ballpark
        case noData = "no-data"
    }

    /// Parsed tier; defensive "insufficient" or any unknown string falls
    /// through to .noData so the rail still renders the muted state
    /// instead of crashing.
    var tier: Tier {
        switch confidenceTier {
        case "estimate": return .estimate
        case "rough":    return .rough
        case "ballpark": return .ballpark
        default:         return .noData
        }
    }

    /// CF-IOS-HONEST-RANGES: parsed sufficiency. Unknown / nil → nil so
    /// the renderer can fall through to the legacy path.
    enum CompSufficiency: String {
        case sufficient
        case thin
        case none
    }

    var sufficiency: CompSufficiency? {
        guard let raw = compSufficiency else { return nil }
        return CompSufficiency(rawValue: raw)
    }
}

struct CompIQPriceRecentComp: Codable, Hashable, Identifiable {
    let price: Double?
    let title: String?
    let soldDate: String?
    // CF-B (2026-06-08): wire additions on /price-by-id recentComps[].
    // imageUrl is the eBay 225px thumb (can 404 after ~90d → graceful
    // placeholder fallback in the view). saleType: "Buy It Now"|"Auction"
    // (display as chip; omit if nil). belowMarket flags rows whose price
    // is dimmed and tagged "below market" — calm, never alarming.
    let imageUrl: String?
    let saleType: String?
    let belowMarket: Bool?

    var id: String { "\(title ?? "")-\(price ?? 0)-\(soldDate ?? "")" }

    var parsedDate: Date? { CompIQCompDateParser.parse(soldDate) }

    var relativeDate: String {
        CompIQCompDateParser.relative(soldDate)
    }
}

/// CF-B (2026-06-08): comp rows the engine kept out of value computation.
/// Wire key matches backend's `excludedComps[]` on /price-by-id.
struct CompIQPriceExcludedComp: Codable, Hashable, Identifiable {
    let price: Double?
    let title: String?
    /// Wire key is `date` (NOT `soldDate` like recentComps[]) — preserved
    /// as-is so the dump shape matches the schema doc.
    let date: String?
    let imageUrl: String?
    /// Engine reason code (e.g. `"damaged"`, `"please_read"`, `"lot"`).
    let reason: String?
    /// Short user-facing condition tag (e.g. `"Damaged"`, `"Please read"`).
    let label: String?

    var id: String { "\(title ?? "")-\(price ?? 0)-\(date ?? "")" }

    var parsedDate: Date? { CompIQCompDateParser.parse(date) }
    var relativeDate: String { CompIQCompDateParser.relative(date) }
}

/// CF-VALUE-SPECTRUM (2026-06-10): single last-sale envelope used by the
/// price slot when the engine has no observed value but a recent sale on
/// file. Same date parser as recentComps for consistency.
struct CompIQLastSale: Codable, Hashable {
    let price: Double?
    let soldDate: String?
    let listingType: String?

    var parsedDate: Date? { CompIQCompDateParser.parse(soldDate) }

    /// Whole-day distance from the parsed sold date to "now". Returns nil
    /// when soldDate is missing or unparseable.
    var daysSinceSold: Int? {
        guard let date = parsedDate else { return nil }
        let cal = Calendar.current
        let now = Date()
        return cal.dateComponents([.day], from: date, to: now).day
    }
}

/// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): list-shape last-sale envelope
/// that ships on holding wire (vs `CompIQLastSale` used by the comp page).
/// `date` here is the field on the list; the comp page's `soldDate` field
/// maps to the same display value via the view layer.
struct CardHedgeLastSaleSurface: Codable, Hashable {
    let price: Double?
    let date: String?
    let compCount: Int?
}

/// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): trend-anchor sub-block on
/// `CardHedgeModelExpectation`. Renders the "Base market rising/falling"
/// chip when `direction` resolves to up/down (flat suppressed). View
/// dims the chip opacity by `rSquared` so low-confidence trends fade.
struct CardHedgeTrendAnchor: Codable, Hashable {
    let direction: String?
    let slopePctPerDay: Double?
    let rSquared: Double?
}

/// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): forward-projection range
/// sub-block. View renders "Next likely $L–$H if trend holds" when both
/// range bounds decode cleanly. Read as range[0]/[1] matching the
/// existing model-expectation range pattern.
struct CardHedgeForwardProjection: Codable, Hashable {
    let range: [Double]?

    var low: Double? { range?.first }
    var high: Double? { (range?.count ?? 0) > 1 ? range?[1] : nil }
}

/// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): position-signal sub-block.
/// Backend-computed gain/loss vs the holding's purchase price — view
/// renders a signed dollar line when `gainLoss` is present.
struct CardHedgePositionSignal: Codable, Hashable {
    let gainLoss: Double?
    let gainLossPct: Double?
}

/// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): CardHedge model expectation
/// envelope shared by the comp page (`CompIQPriceByIdResponse`) and the
/// holding wire (`InventoryCard`). All fields optional/nullable per the
/// contract — render only when `value` is present, range pair only when
/// both `range[0]` and `range[1]` decode cleanly.
struct CardHedgeModelExpectation: Codable, Hashable {
    let value: Double?
    let range: [Double]?
    let multiplier: Double?
    let multiplierRange: [Double]?
    let basis: String?
    let n: Int?
    let baseAutoMedian: Double?
    let baseAutoCount: Int?
    /// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): three new optional
    /// sub-blocks. Each renders independently; null AND absent → block
    /// suppressed without affecting the others.
    let trendAnchor: CardHedgeTrendAnchor?
    let forwardProjection: CardHedgeForwardProjection?
    let positionSignal: CardHedgePositionSignal?

    /// Explicit init so existing call sites (previews, mock builders)
    /// that don't pass the new sub-block args keep compiling. Codable
    /// decode path is unaffected — the synthesized decoder reads each
    /// key independently and ignores this initializer.
    init(
        value: Double? = nil,
        range: [Double]? = nil,
        multiplier: Double? = nil,
        multiplierRange: [Double]? = nil,
        basis: String? = nil,
        n: Int? = nil,
        baseAutoMedian: Double? = nil,
        baseAutoCount: Int? = nil,
        trendAnchor: CardHedgeTrendAnchor? = nil,
        forwardProjection: CardHedgeForwardProjection? = nil,
        positionSignal: CardHedgePositionSignal? = nil
    ) {
        self.value = value
        self.range = range
        self.multiplier = multiplier
        self.multiplierRange = multiplierRange
        self.basis = basis
        self.n = n
        self.baseAutoMedian = baseAutoMedian
        self.baseAutoCount = baseAutoCount
        self.trendAnchor = trendAnchor
        self.forwardProjection = forwardProjection
        self.positionSignal = positionSignal
    }

    var rangeLow: Double? { range?.first }
    var rangeHigh: Double? { (range?.count ?? 0) > 1 ? range?[1] : nil }
    var multiplierLow: Double? { multiplierRange?.first }
    var multiplierHigh: Double? { (multiplierRange?.count ?? 0) > 1 ? multiplierRange?[1] : nil }
}

/// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): CardHedge "lean" badge driver.
/// `lean` is a CLOSED 3-value enum on the wire (`"buy" | "hold" | "sell"`);
/// unknown literals decode as nil and suppress the badge — the view must
/// never render the raw string. `deltaPct` carries a signed percent where
/// positive = above model, negative = below.
struct CardHedgeModelSignal: Codable, Hashable {
    let lean: String?
    let deltaPct: Double?
    let expectation: Double?
    let effectiveMultiplier: Double?
}

/// CLOSED enum mirroring the `lean` literals — `init?(rawValue:)` returns
/// nil for any unknown string, which the view treats as "no badge."
enum CardHedgeLean: String, Codable {
    case buy
    case hold
    case sell
}

/// CF-PRICEHISTORY-60D (2026-06-10): 60-day chart series point on
/// `/api/compiq/price-by-id` for the comp-page price-history chart.
/// Wire shape per backend SHA 9441dcc:
///   { soldDate: ISO8601 string, price: Double, listingType: "fixed" | "auction" | null }
/// ≤150 points, sorted ASCENDING by soldDate (plot as-is, no client sort).
/// `listingType` carries the raw Cardsight wire value — `"fixed"` renders
/// as a BIN circle, `"auction"` as an auction triangle, nil falls through
/// to a neutral default.
struct PriceHistoryPoint: Codable, Hashable, Identifiable {
    let soldDate: String?
    let price: Double?
    let listingType: String?

    var id: String { "\(soldDate ?? "")-\(price ?? 0)" }

    var parsedDate: Date? { CompIQCompDateParser.parse(soldDate) }

    /// Normalized BIN/auction classifier. Anything other than the two
    /// canonical wire values collapses to `.unknown` so the chart still
    /// plots the point (neutral color/shape) rather than dropping data.
    enum Kind { case bin, auction, unknown }

    var kind: Kind {
        switch listingType?.lowercased() {
        case "fixed": return .bin
        case "auction": return .auction
        default: return .unknown
        }
    }
}

/// Shared ISO8601 parser for recent + excluded comp date fields. Backend
/// emits either `.withInternetDateTime` or `.withFractionalSeconds` shapes
/// depending on the data source.
///
/// CF-PRICEHISTORY-60D (2026-06-10) addition: backend's priceHistory[]
/// soldDate carries 6-digit microsecond precision (e.g.
/// `2026-06-09T10:20:50.208067Z`) which `.withFractionalSeconds` is
/// documented to handle only up to 3 digits. The third arm truncates
/// any sub-millisecond tail and retries — pure additive fallback, never
/// kicks in when the existing two-arm chain already returns a date.
enum CompIQCompDateParser {
    static func parse(_ raw: String?) -> Date? {
        guard let raw, raw.isEmpty == false else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        if let date = standard.date(from: raw) { return date }
        // Sub-millisecond precision fallback (CF-PRICEHISTORY-60D 2026-06-10).
        let normalized = raw.replacingOccurrences(
            of: #"(\.\d{3})\d+(Z|[+\-]\d{2}:?\d{2})$"#,
            with: "$1$2",
            options: .regularExpression
        )
        if normalized != raw, let date = fractional.date(from: normalized) { return date }
        return nil
    }

    static func relative(_ raw: String?) -> String {
        guard let date = parse(raw) else { return raw ?? "Unknown" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

struct CompIQPriceBuyWindow: Codable, Hashable {
    let score: Double?
    let label: String?
    let reasons: [String]?
}

struct CompIQPriceFreshness: Codable, Hashable {
    let status: String?
    let lastUpdated: String?
    let daysSinceNewestComp: Int?
}

struct CompIQPriceBroaderTrend: Codable, Hashable {
    let direction: String?
    let label: String?
    let note: String?
    /// CF-THIN-CARD-FULL-DETAIL-PARITY Phase 2 (2026-06-11): backend
    /// engine `01ac241+` ships an `impliedTrendPct` alongside
    /// `direction`/`label` so the iOS "Overall Trend" + value-block
    /// follower can fall back to a broader-trend pct when
    /// `trendIQ.impliedPct` is absent (thin-pool / no-recent-comps).
    let impliedTrendPct: Double?
}

struct CompIQPriceExitStrategy: Codable, Hashable {
    let recommendedMethod: String?
    let expectedDaysToSell: Int?
    let timingRecommendation: String?
}

/// CF-MARKET-READ (2026-06-08): advisor-voice strategy block on the
/// pricing response. Replaces the now-deprecated `exitStrategy` +
/// `freshness` pair on engine `e541463+`. `marketRead` is full prose;
/// `marketReadFactPack` is the structured backing data the prose was
/// generated from. The fact pack is decoded for availability but not
/// rendered — the view treats `marketRead` as the canonical surface.
struct CompIQMarketReadFactPack: Codable, Hashable {
    let cardId: String?
    let grade: String?
    let sampleUsed: Int?
    let sampleAvailable: Int?
    let windowDays: Int?
    let priceMin: Double?
    let priceMax: Double?
    let binMedian: Double?
    let binCount: Int?
    let binPriceMin: Double?
    let binPriceMax: Double?
    let auctionMedian: Double?
    let auctionCount: Int?
    let trendDirection: String?
    let trendPct: Double?
    let excludedCount: Int?
    let excludedPriceMin: Double?
    let excludedPriceMax: Double?
    let topExclusionReasons: [CompIQMarketReadExclusionReason]?
    let fmv: Double?
}

struct CompIQMarketReadExclusionReason: Codable, Hashable {
    let reason: String?
    let count: Int?
    let label: String?
}

// MARK: - TrendIQ

struct TrendIQResponse: Codable {
    let composite: Double?
    let direction: String?
    let impliedPct: Double?
    let lastUpdated: String?
    let coverage: String?
    let components: TrendIQComponents?
    let weights: TrendIQWeights?
}

struct TrendIQComponents: Codable {
    let playerMomentum: TrendIQPlayerMomentum?
    let cardTrajectory: TrendIQCardTrajectory?
    let segmentTrajectory: TrendIQSegmentTrajectory?
}

struct TrendIQPlayerMomentum: Codable {
    let multiplier: Double?
    let flags: [String]?
    let componentSignals: [String: Double]?
    let lastUpdated: String?
    let sourceUrl: String?
}

struct TrendIQCardTrajectory: Codable {
    let multiplier: Double?
    let pctChange: Double?
    let recentMedian: Double?
    let olderMedian: Double?
    let recentCount: Int?
    let olderCount: Int?
    let windowRecentDays: Int?
    let windowOlderDays: Int?
}

struct TrendIQSegmentTrajectory: Codable {
    let multiplier: Double?
    let pctChange: Double?
    let siblingPoolSize: Int?
    let outcome: String?
}

struct TrendIQWeights: Codable {
    let playerMomentum: Double?
    let cardTrajectory: Double?
    let segmentTrajectory: Double?
}

/// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25): one point in the
/// CardHedge prices-by-card daily series. Wire shape per the backend
/// momentum-surface contract: `{ date: ISO8601 string, price: Double }`.
/// Series is sorted ascending by date when backend ships it; iOS does
/// not re-sort defensively — the trend computation reads `first` and
/// `last` in order.
struct CardHedgePricePoint: Codable, Hashable {
    let date: String?
    let price: Double?
}

/// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25): compact momentum
/// envelope the backend MAY emit as an alternative to (or alongside)
/// `pricesByCard`. iOS prefers `momentum` when both are present so a
/// pre-computed backend value wins over client-side recomputation;
/// falls back to deriving from `pricesByCard` when only the series
/// shipped. `direction` carries the canonical "up" | "down" | "flat"
/// vocabulary the cardhedge slot uses to pick the arrow glyph.
struct CardHedgeMomentum: Codable, Hashable {
    let pctChange: Double?
    let direction: String?
    let window: String?
}

/// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25): provenance object
/// the backend MAY ship to describe the CardHedge surface that drove
/// the estimate. Optional; surfaces in the attribution pill when
/// `window` is present (e.g. "CardHedge · 30d").
struct CardHedgeProvenance: Codable, Hashable {
    let window: String?
    let asOf: String?
    let source: String?
}

struct CompIQPriceByIdResponse: Codable {
    let success: Bool?
    let cardsightCardId: String?
    let summary: String?
    let marketTier: CompIQPriceMarketTier?
    /// Phase 3: renamed from `fmv`. The canonical market value from the engine.
    let marketValue: Double?
    /// Phase 3: predicted price from multiplier-anchored mechanism (nullable).
    let predictedPrice: Double?
    /// Phase 3: predicted price range (nullable AND may be absent from JSON — both decode as nil).
    let predictedPriceRange: CompIQPriceRange?
    /// Phase 3: attribution metadata for predictedPrice (shape varies by engine path).
    let predictedPriceAttribution: CompIQPredictedPriceAttribution?
    let buyZone: PriceZone?
    let holdZone: PriceZone?
    let sellZone: PriceZone?
    let confidence: Double?
    let source: String?
    let trendAnalysis: CompIQPriceTrendAnalysis?
    let recentComps: [CompIQPriceRecentComp]?
    /// CF-B (2026-06-08): rows the engine dropped from value calc
    /// (condition/lot/damage). Nil or empty → skip the "Excluded from
    /// value" section entirely.
    let excludedComps: [CompIQPriceExcludedComp]?
    /// CF-PRICEHISTORY-60D (2026-06-10): 60-day chart series for the
    /// comp-page price-history section. Display-only — never enters the
    /// training corpus. Sorted ASCENDING by soldDate; ≤150 points.
    /// Suppressed (or rendered empty) when the success branch couldn't
    /// build one (variant-mismatch / thin-data); the view layer ignores
    /// counts <2 to keep the chart from drawing a broken axis.
    let priceHistory: [PriceHistoryPoint]?
    /// CF-B addition (2026-06-08): canonical card photo for the priced-
    /// card hero slot. Nil → graceful neutral-card placeholder; never
    /// surface a broken-image glyph.
    let cardImageUrl: String?
    /// CF-CARD-IMAGE-FALLBACK (2026-06-11): eBay listing thumb (~225px)
    /// shipped alongside `cardImageUrl` so the hero can fall back when
    /// the proxy 404s (Cardsight coverage gap on the proxy route).
    /// Softer than a proxy scan but reliably available on cards with a
    /// recent comp, including parallels the proxy doesn't cover.
    let cardImageThumbUrl: String?
    let cardIdentity: CompIQPriceCardIdentity?
    let gradeUsed: String?
    let compsUsed: Int?
    // CF-COMP-DETAIL-EXPAND (2026-06-07): pre-quality-filter Cardsight
    // count. Lets the iOS comp page render "N of M available" so the
    // user sees the condition-filter delta (e.g. "20 of 26 — 6 dropped
    // for damage / read description / lot").
    let compsAvailable: Int?
    let daysSinceNewestComp: Int?
    // CF-COMP-DETAIL-EXPAND (2026-06-07): regime classifier outputs.
    // regime = "stable" / "volatile" / "trending" / "insufficient_data".
    // regimeConfidence = "high" / "low".
    let regime: String?
    let regimeConfidence: String?
    let regimeDiagnostics: CompIQRegimeDiagnostics?
    let verdict: String?
    let action: String?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let explanation: [String]?
    let graderPremium: Double?
    let buyWindow: CompIQPriceBuyWindow?
    let freshness: CompIQPriceFreshness?
    let broaderTrend: CompIQPriceBroaderTrend?
    let exitStrategy: CompIQPriceExitStrategy?
    let dealScore: Double?
    let variantWarning: String?
    let compQuality: String?
    let dataSufficiency: String?
    let trendIQ: TrendIQResponse?

    /// CF-MARKET-READ (2026-06-08): advisor-voice prose for the Strategy
    /// group. Replaces `exitStrategy` + `freshness` on engine `e541463+`.
    /// Nil/empty → hide the Strategy group entirely.
    let marketRead: String?
    /// Optional disclaimer footnote shown beneath `marketRead`. The view
    /// substitutes a default ("Market guidance, not investment advice.")
    /// when the wire field is nil so the legal footnote always appears.
    let marketReadDisclaimer: String?
    /// Structured backing data for `marketRead`. Decoded for availability
    /// but not rendered.
    let marketReadFactPack: CompIQMarketReadFactPack?

    /// CF-VALUE-SPECTRUM (2026-06-10): discriminator for the price-slot
    /// rendering. Wire values: `"observed"`, `"trend-extrapolated"`,
    /// `"last-sale"`, or nil (no sales / unknown). The view branches
    /// directly on this — legacy responses (estimateSource missing but
    /// `marketTier?.value` present) fall back to the observed treatment.
    let estimateSource: String?
    /// Engine's central estimate for the "trend-extrapolated" branch.
    /// Distinct from `marketValue` (which only fills on observed).
    let estimatedValue: Double?
    /// Hedged range that accompanies the extrapolated estimate.
    let estimateRange: CompIQPriceRange?
    /// One-line basis prose explaining how the extrapolated estimate was
    /// derived (e.g. "From the last sale ($A, N days ago), adjusted for
    /// the set's recent trend.").
    let estimateBasis: String?
    /// Last sale envelope for the "last-sale" branch and the basis line
    /// on extrapolated branches.
    let lastSale: CompIQLastSale?
    /// CF-FULL-GRADE-RAIL (2026-06-10): per-(grader,grade) sale-pool
    /// inventory the rail renders selectable chips from. Optional — older
    /// engine builds may omit.
    let gradeBreakdown: [CompIQGradeBreakdownEntry]?
    /// CF-GRADED-RAIL-RENDER (2026-06-12): engine's per-grade ESTIMATES
    /// for grades the observed pool doesn't cover. Returned whenever the
    /// request body included any valid (gradeCompany, gradeValue) pair.
    /// The rail intermixes these with `gradeBreakdown` in grade order
    /// with per-tier confidence styling.
    let gradedEstimates: [CompIQGradedEstimate]?

    /// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25): CardHedge
    /// prices-by-card daily series. Present on `estimateSource ==
    /// "cardhedge"` responses once the backend momentum-surface CF
    /// deploys; nil on Cardsight-source responses. iOS derives the
    /// momentum half of the cardhedge slot from first/last when
    /// `momentum` is absent.
    let pricesByCard: [CardHedgePricePoint]?
    /// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25): pre-computed
    /// compact momentum. iOS prefers this over deriving from
    /// `pricesByCard` so a backend-authoritative number wins.
    let momentum: CardHedgeMomentum?
    /// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25): CardHedge
    /// provenance object. When `window` is present, the cardhedge
    /// attribution pill upgrades from "CardHedge" to "CardHedge · 30d".
    let chProvenance: CardHedgeProvenance?

    /// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): CardHedge model
    /// expectation envelope. Renders the "Model expects $X (range
    /// $L–$H)" line beneath the last-sale headline on the comp page.
    let modelExpectation: CardHedgeModelExpectation?
    /// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): CardHedge lean badge
    /// driver. `lean` is closed-enum (`buy`/`hold`/`sell`); deltaPct is
    /// signed (+ above, − below model).
    let modelSignal: CardHedgeModelSignal?
    /// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): comp-page-side comp
    /// count for the CardHedge last-sale headline ("via N comps"). The
    /// holdings-list wire emits the same number on
    /// `lastSaleSurface.compCount` instead.
    let chCompCount: Int?

    var hasInsufficientComps: Bool {
        source == "no-recent-comps" || marketTier?.value == nil
    }

    var verdictText: String {
        if let verdict, verdict.isEmpty == false { return verdict }
        guard let summary, summary.isEmpty == false else { return "No verdict" }
        let first = summary.components(separatedBy: CharacterSet(charactersIn: "—-–")).first ?? summary
        return first.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var trendPercent: Double? {
        guard let raw = trendAnalysis?.changeFromOlderToRecent else { return nil }
        let pattern = #"[-+]?\d+(?:\.\d+)?"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
              let range = Range(match.range, in: raw),
              let value = Double(raw[range]) else { return nil }
        return value
    }

    /// Formatted FMV that returns "—" when nil instead of "$0.00"
    var formattedFMV: String {
        guard let value = marketTier?.value else { return "—" }
        return value.formatted(.currency(code: "USD"))
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = try? container.decodeIfPresent(Bool.self, forKey: .success)
        cardsightCardId = try? container.decodeIfPresent(String.self, forKey: .cardsightCardId)
        summary = try? container.decodeIfPresent(String.self, forKey: .summary)
        marketTier = try? container.decodeIfPresent(CompIQPriceMarketTier.self, forKey: .marketTier)
        marketValue = try? container.decodeIfPresent(Double.self, forKey: .marketValue)
        predictedPrice = try? container.decodeIfPresent(Double.self, forKey: .predictedPrice)
        predictedPriceRange = try? container.decodeIfPresent(CompIQPriceRange.self, forKey: .predictedPriceRange)
        predictedPriceAttribution = try? container.decodeIfPresent(CompIQPredictedPriceAttribution.self, forKey: .predictedPriceAttribution)

        // Zones come as [Double?] arrays — decode to PriceZone
        if let arr = try? container.decodeIfPresent([Double?].self, forKey: .buyZone) {
            buyZone = PriceZone(from: arr)
        } else {
            buyZone = nil
        }
        if let arr = try? container.decodeIfPresent([Double?].self, forKey: .holdZone) {
            holdZone = PriceZone(from: arr)
        } else {
            holdZone = nil
        }
        if let arr = try? container.decodeIfPresent([Double?].self, forKey: .sellZone) {
            sellZone = PriceZone(from: arr)
        } else {
            sellZone = nil
        }

        confidence = try? container.decodeIfPresent(Double.self, forKey: .confidence)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        trendAnalysis = try? container.decodeIfPresent(CompIQPriceTrendAnalysis.self, forKey: .trendAnalysis)
        recentComps = try? container.decodeIfPresent([CompIQPriceRecentComp].self, forKey: .recentComps)
        excludedComps = try? container.decodeIfPresent([CompIQPriceExcludedComp].self, forKey: .excludedComps)
        priceHistory = try? container.decodeIfPresent([PriceHistoryPoint].self, forKey: .priceHistory)
        cardImageUrl = try? container.decodeIfPresent(String.self, forKey: .cardImageUrl)
        cardImageThumbUrl = try? container.decodeIfPresent(String.self, forKey: .cardImageThumbUrl)
        cardIdentity = try? container.decodeIfPresent(CompIQPriceCardIdentity.self, forKey: .cardIdentity)
        gradeUsed = try? container.decodeIfPresent(String.self, forKey: .gradeUsed)
        compsUsed = try? container.decodeIfPresent(Int.self, forKey: .compsUsed)
        compsAvailable = try? container.decodeIfPresent(Int.self, forKey: .compsAvailable)
        daysSinceNewestComp = try? container.decodeIfPresent(Int.self, forKey: .daysSinceNewestComp)
        regime = try? container.decodeIfPresent(String.self, forKey: .regime)
        regimeConfidence = try? container.decodeIfPresent(String.self, forKey: .regimeConfidence)
        regimeDiagnostics = try? container.decodeIfPresent(CompIQRegimeDiagnostics.self, forKey: .regimeDiagnostics)
        verdict = try? container.decodeIfPresent(String.self, forKey: .verdict)
        action = try? container.decodeIfPresent(String.self, forKey: .action)
        quickSaleValue = try? container.decodeIfPresent(Double.self, forKey: .quickSaleValue)
        premiumValue = try? container.decodeIfPresent(Double.self, forKey: .premiumValue)
        // explanation can be [String] or a single String
        if let arr = try? container.decodeIfPresent([String].self, forKey: .explanation) {
            explanation = arr
        } else if let single = try? container.decodeIfPresent(String.self, forKey: .explanation) {
            explanation = [single]
        } else {
            explanation = nil
        }
        graderPremium = try? container.decodeIfPresent(Double.self, forKey: .graderPremium)
        buyWindow = try? container.decodeIfPresent(CompIQPriceBuyWindow.self, forKey: .buyWindow)
        freshness = try? container.decodeIfPresent(CompIQPriceFreshness.self, forKey: .freshness)
        broaderTrend = try? container.decodeIfPresent(CompIQPriceBroaderTrend.self, forKey: .broaderTrend)
        exitStrategy = try? container.decodeIfPresent(CompIQPriceExitStrategy.self, forKey: .exitStrategy)
        dealScore = try? container.decodeIfPresent(Double.self, forKey: .dealScore)
        variantWarning = try? container.decodeIfPresent(String.self, forKey: .variantWarning)
        compQuality = try? container.decodeIfPresent(String.self, forKey: .compQuality)
        dataSufficiency = try? container.decodeIfPresent(String.self, forKey: .dataSufficiency)
        trendIQ = try? container.decodeIfPresent(TrendIQResponse.self, forKey: .trendIQ)
        marketRead = try? container.decodeIfPresent(String.self, forKey: .marketRead)
        marketReadDisclaimer = try? container.decodeIfPresent(String.self, forKey: .marketReadDisclaimer)
        marketReadFactPack = try? container.decodeIfPresent(CompIQMarketReadFactPack.self, forKey: .marketReadFactPack)
        estimateSource = try? container.decodeIfPresent(String.self, forKey: .estimateSource)
        estimatedValue = try? container.decodeIfPresent(Double.self, forKey: .estimatedValue)
        estimateRange = try? container.decodeIfPresent(CompIQPriceRange.self, forKey: .estimateRange)
        estimateBasis = try? container.decodeIfPresent(String.self, forKey: .estimateBasis)
        lastSale = try? container.decodeIfPresent(CompIQLastSale.self, forKey: .lastSale)
        gradeBreakdown = try? container.decodeIfPresent([CompIQGradeBreakdownEntry].self, forKey: .gradeBreakdown)
        gradedEstimates = try? container.decodeIfPresent([CompIQGradedEstimate].self, forKey: .gradedEstimates)
        pricesByCard = try? container.decodeIfPresent([CardHedgePricePoint].self, forKey: .pricesByCard)
        momentum = try? container.decodeIfPresent(CardHedgeMomentum.self, forKey: .momentum)
        chProvenance = try? container.decodeIfPresent(CardHedgeProvenance.self, forKey: .chProvenance)
        modelExpectation = try? container.decodeIfPresent(CardHedgeModelExpectation.self, forKey: .modelExpectation)
        modelSignal = try? container.decodeIfPresent(CardHedgeModelSignal.self, forKey: .modelSignal)
        chCompCount = try? container.decodeIfPresent(Int.self, forKey: .chCompCount)
    }

    private enum CodingKeys: String, CodingKey {
        case success, cardsightCardId, summary, marketTier
        case marketValue, predictedPrice, predictedPriceRange, predictedPriceAttribution
        case buyZone, holdZone, sellZone
        case confidence, source, trendAnalysis, recentComps, excludedComps, priceHistory
        case cardImageUrl, cardImageThumbUrl
        case cardIdentity, gradeUsed, compsUsed, compsAvailable, daysSinceNewestComp
        case verdict, action, quickSaleValue, premiumValue, explanation
        case graderPremium, buyWindow, freshness, broaderTrend
        case exitStrategy, dealScore, variantWarning
        case compQuality, dataSufficiency, trendIQ
        case regime, regimeConfidence, regimeDiagnostics
        case marketRead, marketReadDisclaimer, marketReadFactPack
        case estimateSource, estimatedValue, estimateRange, estimateBasis, lastSale
        case gradeBreakdown, gradedEstimates
        case pricesByCard, momentum, chProvenance
        case modelExpectation, modelSignal, chCompCount
    }
}
