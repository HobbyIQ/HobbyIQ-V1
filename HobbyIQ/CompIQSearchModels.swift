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
        parallels: [CompIQCardsightParallel]? = nil
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
    }
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
    let set: String?
    let number: String?
    let variant: String?

    private enum CodingKeys: String, CodingKey {
        case cardId = "card_id"
        case player, set, number, variant
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

/// Shared ISO8601 parser for recent + excluded comp date fields. Backend
/// emits either `.withInternetDateTime` or `.withFractionalSeconds` shapes
/// depending on the data source.
enum CompIQCompDateParser {
    static func parse(_ raw: String?) -> Date? {
        guard let raw, raw.isEmpty == false else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: raw)
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
}

struct CompIQPriceExitStrategy: Codable, Hashable {
    let recommendedMethod: String?
    let expectedDaysToSell: Int?
    let timingRecommendation: String?
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
    /// CF-B addition (2026-06-08): canonical card photo for the priced-
    /// card hero slot. Nil → graceful neutral-card placeholder; never
    /// surface a broken-image glyph.
    let cardImageUrl: String?
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
        cardImageUrl = try? container.decodeIfPresent(String.self, forKey: .cardImageUrl)
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
    }

    private enum CodingKeys: String, CodingKey {
        case success, cardsightCardId, summary, marketTier
        case marketValue, predictedPrice, predictedPriceRange, predictedPriceAttribution
        case buyZone, holdZone, sellZone
        case confidence, source, trendAnalysis, recentComps, excludedComps
        case cardImageUrl
        case cardIdentity, gradeUsed, compsUsed, compsAvailable, daysSinceNewestComp
        case verdict, action, quickSaleValue, premiumValue, explanation
        case graderPremium, buyWindow, freshness, broaderTrend
        case exitStrategy, dealScore, variantWarning
        case compQuality, dataSufficiency, trendIQ
        case regime, regimeConfidence, regimeDiagnostics
    }
}
