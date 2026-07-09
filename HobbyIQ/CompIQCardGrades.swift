//
//  CompIQCardGrades.swift
//  HobbyIQ
//
//  CF-GRADE-PILL-PANEL (2026-07-04, backend batch): renders the
//  10-canonical-grade pill panel from GET /api/compiq/card-panel/:cardId.
//  Each pill shows the current market value (observed) or estimated
//  projection (with an "est." badge) for that grade. Tapping a pill
//  updates the parent's `selectedGrade`, which triggers a refetch of
//  the priced-card view against the new grade.
//
//  Replaces the earlier `PerGradeBreakdownSection` which called
//  /api/compiq/card-grades. The card-panel endpoint returns the same
//  10-row curve plus identity + reference prices in one round trip.
//

import SwiftUI
import os

// MARK: - Wire Models (GET /api/compiq/card-panel/:cardId)

/// Every field optional AND every decode wrapped in `try?` so one
/// mismatched nested field (e.g. `year` shipped as string, `imageUrl`
/// missing, a single malformed entry in the array) never causes the
/// whole response to throw. Sacrifice strictness for panel resilience.
struct CardPanelResponse: Decodable {
    let success: Bool?
    let cardId: String?
    let identity: CardPanelIdentity?
    let gradeCurve: CardPanelGradeCurve?
    let referencePrices: [CardPanelReferencePrice]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = try? c.decodeIfPresent(Bool.self, forKey: .success)
        cardId = try? c.decodeIfPresent(String.self, forKey: .cardId)
        identity = try? c.decodeIfPresent(CardPanelIdentity.self, forKey: .identity)
        gradeCurve = try? c.decodeIfPresent(CardPanelGradeCurve.self, forKey: .gradeCurve)
        referencePrices = try? c.decodeIfPresent([CardPanelReferencePrice].self, forKey: .referencePrices)
    }

    private enum CodingKeys: String, CodingKey {
        case success, cardId, identity, gradeCurve, referencePrices
    }
}

struct CardPanelIdentity: Decodable, Hashable {
    let cardId: String?
    let player: String?
    let set: String?
    let number: String?
    let variant: String?
    let year: Int?
    let imageUrl: String?
    let description: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cardId = try? c.decodeIfPresent(String.self, forKey: .cardId)
        player = try? c.decodeIfPresent(String.self, forKey: .player)
        set = try? c.decodeIfPresent(String.self, forKey: .set)
        number = try? c.decodeIfPresent(String.self, forKey: .number)
        variant = try? c.decodeIfPresent(String.self, forKey: .variant)
        // Tolerate `year` shipped as either "2011" or 2011.
        if let asInt = try? c.decodeIfPresent(Int.self, forKey: .year) {
            year = asInt
        } else if let asString = try? c.decodeIfPresent(String.self, forKey: .year),
                  let parsed = Int(asString) {
            year = parsed
        } else {
            year = nil
        }
        imageUrl = try? c.decodeIfPresent(String.self, forKey: .imageUrl)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
    }

    private enum CodingKeys: String, CodingKey {
        case cardId, player, set, number, variant, year, imageUrl, description
    }
}

struct CardPanelGradeCurve: Decodable {
    let totalSampleCount: Int?
    let computedAt: String?
    let entries: [CardPanelGradeEntry]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalSampleCount = try? c.decodeIfPresent(Int.self, forKey: .totalSampleCount)
        computedAt = try? c.decodeIfPresent(String.self, forKey: .computedAt)
        entries = try? c.decodeIfPresent([CardPanelGradeEntry].self, forKey: .entries)
    }

    private enum CodingKeys: String, CodingKey {
        case totalSampleCount, computedAt, entries
    }
}

struct CardPanelGradeEntry: Decodable, Identifiable, Hashable {
    let grade: String                      // "Raw", "PSA 10", "BGS 9.5", ...
    let grader: String                     // "Raw" | "PSA" | "BGS" | "SGC" | "CGC"
    let sampleCount: Int
    let weightedMedianPrice: Double?
    let plainMedianPrice: Double?
    let priceRangeLow: Double?
    let priceRangeHigh: Double?
    let newestSaleDate: String?
    let oldestSaleDate: String?
    let confidenceScore: Double?
    let value: Double?
    let valueSource: ValueSource
    let estimatedMultiplier: Double?
    /// Trend-adjusted value from the panel — the headline the FMV
    /// hero prefers. Nil on fresh-comp / no-trend paths, in which
    /// case callers should fall back to `value`.
    let trendAdjustedValue: Double?
    /// Signed % delta between `value` and `trendAdjustedValue`.
    /// Powers the "trending up / cooling / holding steady" line
    /// beneath the market-value headline.
    let trendAdjustmentPct: Double?
    /// CF-ONE-TRAJECTORY (2026-07-04): the /card-panel wire now
    /// ships a forward projection per grade, sourced from the same
    /// trajectory curve as `trendAdjustedValue` — no separate
    /// /price-by-id call needed.
    ///
    /// CF-PREDICTION-HORIZON-7D (2026-07-06, backend PR #301): horizon
    /// shortened from 30d → 7d. The field `predictedPriceAt30d` keeps
    /// its wire name for back-compat but the value now represents the
    /// horizon defined by `predictedHorizonDays`. Never hard-code
    /// "30" client-side; always render `predictedHorizonDays` so a
    /// future horizon tweak lands without a redeploy.
    let daysSinceNewestSale: Int?
    let predictedPriceAt30d: Double?
    let predictedPricePct: Double?
    let predictedPriceRangeLow: Double?
    let predictedPriceRangeHigh: Double?
    /// CF-PREDICTION-HORIZON-7D (2026-07-06, backend PR #301): actual
    /// horizon (in days) that `predictedPriceAt30d` projects to. `7`
    /// today; may vary per card class later.
    let predictedHorizonDays: Int?
    /// CF-ACTION-BADGES (2026-07-06, backend §1): per-grade
    /// seller-facing verdict + target list price + reasoning prose.
    /// This is the primary product surface for tonight's trajectory
    /// tuning — the badge + reasoning are what a seller reads to
    /// decide whether to hold, sell, or list.
    let recommendation: ActionRecommendation?
    /// CF-REFERENCE-CROSSCHECK (2026-07-06, backend §4): CH model
    /// estimate + divergence check. When `referenceAnomaly == true`
    /// (|divergence| > 25%) iOS surfaces a small ⚠️ next to the pill.
    /// `referenceDivergencePct` is for the anomaly gate only — never
    /// shown numerically.
    let referencePrice: Double?
    let referenceDivergencePct: Double?
    let referenceAnomaly: Bool?
    /// CF-LINEAGE-PASSTHROUGH (2026-07-09, backend PR #331): per-entry
    /// signal-source enum. Values worth surfacing:
    ///   `matched-cohort-cached` / `matched-cohort-live` → "Player momentum"
    ///   `parallel-tier`                                  → "Parallel tier"
    ///   `raw-weekly`                                     → "Raw price trend"
    ///   `release-decay`                                  → "Age-decay curve"
    /// Unknown values render nothing rather than crashing.
    let signalSource: String?
    /// CF-LINEAGE-PASSTHROUGH (2026-07-09, backend PR #331): weekly
    /// trend rate as a signed float (e.g. `0.012` = +1.2%/wk). Surface
    /// only when `abs(ratePerWeek) > 0.005` (0.5%/wk) — smaller values
    /// are inside the noise floor.
    let ratePerWeek: Double?
    /// CF-LINEAGE-PASSTHROUGH (2026-07-09, backend PR #331): per-entry
    /// sibling-fallback lineage. Present when this specific grade's
    /// price was derived from a same-player sibling parallel × premium
    /// × print-run floor. Distinct from the top-level
    /// `CompIQPriceByIdResponse.siblingFallback` (PR #311) which fires
    /// on the search/price endpoints — this one lets per-grade UI
    /// disclose lineage on the panel-driven surfaces.
    let siblingFallback: SiblingFallbackLineage?

    var id: String { grade }

    /// Prefer trend-adjusted value (fresh + momentum-aware), then
    /// canonical `value`, then weighted median, then plain. Shared
    /// with `GradePillPanel.resolvedValue` and the selected-grade
    /// market-value header on `CompIQPricedCardView` so the pill and
    /// the hero always show the same headline.
    var resolvedMarketValue: Double? {
        if let v = trendAdjustedValue, v > 0 { return v }
        if let v = value, v > 0 { return v }
        if let v = weightedMedianPrice, v > 0 { return v }
        if let v = plainMedianPrice, v > 0 { return v }
        return nil
    }

    /// Non-trend-adjusted median for the "LAST SALE" cell — always
    /// the observed comp price, so it never conflates with the
    /// trend-adjusted headline. Falls back to plain median then
    /// `value` if no observed weighted median is present.
    var observedSaleValue: Double? {
        if let v = weightedMedianPrice, v > 0 { return v }
        if let v = plainMedianPrice, v > 0 { return v }
        if let v = value, v > 0 { return v }
        return nil
    }

    /// Tolerant enum — accepts both the current spec strings
    /// (observed/estimated/unavailable) AND the legacy /card-grades
    /// strings (live/projected/no-data). Anything else defaults to
    /// `.unavailable`.
    enum ValueSource: String, Decodable {
        case observed
        case estimated
        case unavailable

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self).lowercased()
            switch raw {
            case "observed", "live":                            self = .observed
            case "estimated", "projected":                      self = .estimated
            case "unavailable", "no-data", "no_data", "none":   self = .unavailable
            default:                                            self = .unavailable
            }
        }
    }

    /// CF-ACTION-BADGES (2026-07-06): per-grade seller verdict shipped
    /// on both /card-panel gradeCurve.entries[i].recommendation and
    /// /portfolio items[i].actionRecommendation. Same shape both places.
    struct ActionRecommendation: Decodable, Hashable {
        enum Verdict: String, Decodable {
            case sellNow = "SELL_NOW"
            case hold = "HOLD"
            case list = "LIST"
            case insufficientData = "INSUFFICIENT_DATA"

            init(from decoder: Decoder) throws {
                let raw = try decoder.singleValueContainer().decode(String.self)
                switch raw.uppercased() {
                case "SELL_NOW", "SELL-NOW", "SELLNOW":            self = .sellNow
                case "HOLD":                                        self = .hold
                case "LIST":                                        self = .list
                default:                                            self = .insufficientData
                }
            }
        }

        enum Urgency: String, Decodable {
            case high, medium, low

            init(from decoder: Decoder) throws {
                let raw = try decoder.singleValueContainer().decode(String.self).lowercased()
                switch raw {
                case "high":    self = .high
                case "medium":  self = .medium
                default:        self = .low
                }
            }
        }

        let verdict: Verdict
        let targetPrice: Double?
        let reasoning: String?
        let urgency: Urgency?
        let expectedDeltaPct: Double?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            verdict = (try? c.decode(Verdict.self, forKey: .verdict)) ?? .insufficientData
            targetPrice = try? c.decodeIfPresent(Double.self, forKey: .targetPrice)
            reasoning = try? c.decodeIfPresent(String.self, forKey: .reasoning)
            urgency = try? c.decodeIfPresent(Urgency.self, forKey: .urgency)
            expectedDeltaPct = try? c.decodeIfPresent(Double.self, forKey: .expectedDeltaPct)
        }

        private enum CodingKeys: String, CodingKey {
            case verdict, targetPrice, reasoning, urgency, expectedDeltaPct
        }
    }

    /// Tolerant memberwise init so `entries.compactMap { try? decode }`
    /// can build placeholders and so the merge in `displayEntries` can
    /// synthesize "unavailable" rows for missing grades.
    init(
        grade: String,
        grader: String,
        sampleCount: Int,
        weightedMedianPrice: Double?,
        plainMedianPrice: Double?,
        priceRangeLow: Double?,
        priceRangeHigh: Double?,
        newestSaleDate: String?,
        oldestSaleDate: String?,
        confidenceScore: Double?,
        value: Double?,
        valueSource: ValueSource,
        estimatedMultiplier: Double?,
        trendAdjustedValue: Double? = nil,
        trendAdjustmentPct: Double? = nil,
        daysSinceNewestSale: Int? = nil,
        predictedPriceAt30d: Double? = nil,
        predictedPricePct: Double? = nil,
        predictedPriceRangeLow: Double? = nil,
        predictedPriceRangeHigh: Double? = nil,
        predictedHorizonDays: Int? = nil,
        recommendation: ActionRecommendation? = nil,
        referencePrice: Double? = nil,
        referenceDivergencePct: Double? = nil,
        referenceAnomaly: Bool? = nil,
        signalSource: String? = nil,
        ratePerWeek: Double? = nil,
        siblingFallback: SiblingFallbackLineage? = nil
    ) {
        self.grade = grade
        self.grader = grader
        self.sampleCount = sampleCount
        self.weightedMedianPrice = weightedMedianPrice
        self.plainMedianPrice = plainMedianPrice
        self.priceRangeLow = priceRangeLow
        self.priceRangeHigh = priceRangeHigh
        self.newestSaleDate = newestSaleDate
        self.oldestSaleDate = oldestSaleDate
        self.confidenceScore = confidenceScore
        self.value = value
        self.valueSource = valueSource
        self.estimatedMultiplier = estimatedMultiplier
        self.trendAdjustedValue = trendAdjustedValue
        self.trendAdjustmentPct = trendAdjustmentPct
        self.daysSinceNewestSale = daysSinceNewestSale
        self.predictedPriceAt30d = predictedPriceAt30d
        self.predictedPricePct = predictedPricePct
        self.predictedPriceRangeLow = predictedPriceRangeLow
        self.predictedPriceRangeHigh = predictedPriceRangeHigh
        self.predictedHorizonDays = predictedHorizonDays
        self.recommendation = recommendation
        self.referencePrice = referencePrice
        self.referenceDivergencePct = referenceDivergencePct
        self.referenceAnomaly = referenceAnomaly
        self.signalSource = signalSource
        self.ratePerWeek = ratePerWeek
        self.siblingFallback = siblingFallback
    }

    /// Custom decode so `grade` / `grader` / `sampleCount` are tolerant
    /// to missing / wrong-typed fields.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        grade = (try? c.decode(String.self, forKey: .grade)) ?? "?"
        grader = (try? c.decode(String.self, forKey: .grader)) ?? "?"
        sampleCount = (try? c.decode(Int.self, forKey: .sampleCount)) ?? 0
        weightedMedianPrice = try? c.decodeIfPresent(Double.self, forKey: .weightedMedianPrice)
        plainMedianPrice = try? c.decodeIfPresent(Double.self, forKey: .plainMedianPrice)
        priceRangeLow = try? c.decodeIfPresent(Double.self, forKey: .priceRangeLow)
        priceRangeHigh = try? c.decodeIfPresent(Double.self, forKey: .priceRangeHigh)
        newestSaleDate = try? c.decodeIfPresent(String.self, forKey: .newestSaleDate)
        oldestSaleDate = try? c.decodeIfPresent(String.self, forKey: .oldestSaleDate)
        confidenceScore = try? c.decodeIfPresent(Double.self, forKey: .confidenceScore)
        value = try? c.decodeIfPresent(Double.self, forKey: .value)
        valueSource = (try? c.decodeIfPresent(ValueSource.self, forKey: .valueSource)) ?? .unavailable
        estimatedMultiplier = try? c.decodeIfPresent(Double.self, forKey: .estimatedMultiplier)
        trendAdjustedValue = try? c.decodeIfPresent(Double.self, forKey: .trendAdjustedValue)
        trendAdjustmentPct = try? c.decodeIfPresent(Double.self, forKey: .trendAdjustmentPct)
        daysSinceNewestSale = try? c.decodeIfPresent(Int.self, forKey: .daysSinceNewestSale)
        predictedPriceAt30d = try? c.decodeIfPresent(Double.self, forKey: .predictedPriceAt30d)
        predictedPricePct = try? c.decodeIfPresent(Double.self, forKey: .predictedPricePct)
        predictedPriceRangeLow = try? c.decodeIfPresent(Double.self, forKey: .predictedPriceRangeLow)
        predictedPriceRangeHigh = try? c.decodeIfPresent(Double.self, forKey: .predictedPriceRangeHigh)
        predictedHorizonDays = try? c.decodeIfPresent(Int.self, forKey: .predictedHorizonDays)
        recommendation = try? c.decodeIfPresent(ActionRecommendation.self, forKey: .recommendation)
        referencePrice = try? c.decodeIfPresent(Double.self, forKey: .referencePrice)
        referenceDivergencePct = try? c.decodeIfPresent(Double.self, forKey: .referenceDivergencePct)
        referenceAnomaly = try? c.decodeIfPresent(Bool.self, forKey: .referenceAnomaly)
        signalSource = try? c.decodeIfPresent(String.self, forKey: .signalSource)
        ratePerWeek = try? c.decodeIfPresent(Double.self, forKey: .ratePerWeek)
        siblingFallback = try? c.decodeIfPresent(SiblingFallbackLineage.self, forKey: .siblingFallback)
    }

    private enum CodingKeys: String, CodingKey {
        case grade, grader, sampleCount
        case weightedMedianPrice, plainMedianPrice
        case priceRangeLow, priceRangeHigh
        case newestSaleDate, oldestSaleDate
        case confidenceScore, value, valueSource, estimatedMultiplier
        case trendAdjustedValue, trendAdjustmentPct
        case daysSinceNewestSale
        case predictedPriceAt30d, predictedPricePct
        case predictedPriceRangeLow, predictedPriceRangeHigh
        case predictedHorizonDays
        case recommendation
        case referencePrice, referenceDivergencePct, referenceAnomaly
        case signalSource, ratePerWeek, siblingFallback
    }
}

struct CardPanelReferencePrice: Decodable, Hashable {
    let grade: String?
    let grader: String?
    let referencePrice: Double?
    let displayOrder: Int?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        grade = try? c.decodeIfPresent(String.self, forKey: .grade)
        grader = try? c.decodeIfPresent(String.self, forKey: .grader)
        referencePrice = try? c.decodeIfPresent(Double.self, forKey: .referencePrice)
        displayOrder = try? c.decodeIfPresent(Int.self, forKey: .displayOrder)
    }

    private enum CodingKeys: String, CodingKey {
        case grade, grader, referencePrice, displayOrder
    }
}

// MARK: - Bulk Grade Curves (POST /api/compiq/observed-grade-curves-bulk)

/// CF-BULK-GRADE-CURVES (2026-07-04, backend batch §4): compute-heavy
/// endpoint gated behind the `predictions` entitlement. Server dedups
/// cardIds, caches 12h, and bounds concurrency at 8-in-flight. Max
/// 500 cardIds per HTTP request; the iOS wrapper chunks larger sets
/// transparently.
struct BulkGradeCurvesRequest: Encodable {
    let cardIds: [String]
}

struct BulkGradeCurvesResponse: Decodable {
    let success: Bool?
    let count: Int?
    let curves: [BulkGradeCurve]?
}

/// Same shape as `CardPanelGradeCurve` with the addition of `cardId`
/// so bulk callers can match each curve back to its holding.
struct BulkGradeCurve: Decodable, Identifiable, Hashable {
    let cardId: String?
    let totalSampleCount: Int?
    let computedAt: String?
    let entries: [CardPanelGradeEntry]?

    var id: String { cardId ?? UUID().uuidString }
}

private let gradePanelLogger = Logger(subsystem: "com.hobbyiq.app", category: "GradePillPanel")

// MARK: - Grade Pill Panel

/// GradePillPanel — horizontal scroll of the 10 canonical grade pills
/// (Raw, PSA 10, PSA 9, BGS 10, BGS 9.5, BGS 9, SGC 10, SGC 9, CGC 10,
/// CGC 9). Tapping a pill updates the parent view's `selectedGrade`,
/// which triggers a comp/price refetch via CompIQPricedCardView's
/// existing onChange handler.
struct GradePillPanel: View {
    let cardId: String
    @Binding var selectedGrade: CompIQPricedCardView.GradeOption
    /// CF-PANEL-VALUE-TO-HEADER (2026-07-04): fires whenever a fresh
    /// /card-panel payload lands so the parent view can surface the
    /// selected-grade market value in the FMV hero header even when
    /// /price-by-id would route to a hedged/last-sale slot for that
    /// grade. Guarantees the "market value" number is consistent
    /// between the pill and the selected-grade card.
    var onEntriesLoaded: (([CardPanelGradeEntry]) -> Void)? = nil

    @State private var payload: CardPanelResponse?
    @State private var isLoading = false
    @State private var errorText: String?

    /// CF-CANONICAL-10-GRADES (2026-07-04): always render these 10 pills
    /// in this order, even when the server returns fewer entries. Missing
    /// grades fall back to an "unavailable" placeholder so the panel
    /// never looks half-populated.
    private static let canonicalGrades: [(grade: String, grader: String)] = [
        ("Raw",     "Raw"),
        ("PSA 10",  "PSA"),
        ("PSA 9",   "PSA"),
        ("BGS 10",  "BGS"),
        ("BGS 9.5", "BGS"),
        ("BGS 9",   "BGS"),
        ("SGC 10",  "SGC"),
        ("SGC 9",   "SGC"),
        ("CGC 10",  "CGC"),
        ("CGC 9",   "CGC")
    ]

    private var displayEntries: [CardPanelGradeEntry] {
        let serverEntries = payload?.gradeCurve?.entries ?? []
        // CF-GRADE-MATCH-TOLERANT (2026-07-04): match server entries to
        // canonical rows by normalized (grader, numeric-value) pair
        // instead of raw label string. Handles server label drift like
        // "PSA10" vs "PSA 10" vs "psa 10".
        var byKey: [String: CardPanelGradeEntry] = [:]
        for entry in serverEntries {
            let key = normalizedGradeKey(grade: entry.grade, grader: entry.grader)
            if byKey[key] == nil {
                byKey[key] = entry
            }
        }
        return Self.canonicalGrades.map { canonical in
            let key = normalizedGradeKey(grade: canonical.grade, grader: canonical.grader)
            if let server = byKey[key] {
                return server
            }
            return CardPanelGradeEntry(
                grade: canonical.grade,
                grader: canonical.grader,
                sampleCount: 0,
                weightedMedianPrice: nil,
                plainMedianPrice: nil,
                priceRangeLow: nil,
                priceRangeHigh: nil,
                newestSaleDate: nil,
                oldestSaleDate: nil,
                confidenceScore: nil,
                value: nil,
                valueSource: .unavailable,
                estimatedMultiplier: nil
            )
        }
    }

    /// CF-PANEL-RENDER-DIAG (2026-07-04): per-pill render log so we can
    /// compare against the [panel-decode] block and see whether the
    /// tolerant matcher key is what we expect or whether display value
    /// resolution is dropping data.
    private func logRenderEntries(_ entries: [CardPanelGradeEntry]) {
        for entry in entries {
            let key = normalizedGradeKey(grade: entry.grade, grader: entry.grader)
            let resolved = resolvedValue(entry)
            let matched = resolved != nil
            let display = matched ? displayValue(entry) : "nil"
            print("[panel-render] grade=\(entry.grade) key=\(key) matched=\(matched) displayValue=\(display)")
        }
    }

    /// Build a stable key from a grade+grader pair regardless of the
    /// backend's exact label formatting. `"PSA 10"` / `"PSA10"` /
    /// `"psa 10"` all collapse to `"psa|10"`; Raw collapses to `"raw"`.
    static func normalizedKey(grade: String, grader: String) -> String {
        let grader = grader.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if grader == "raw" { return "raw" }
        let digits = grade.unicodeScalars.reduce(into: "") { acc, scalar in
            if CharacterSet.decimalDigits.contains(scalar) || scalar == "." {
                acc.append(Character(scalar))
            } else if acc.isEmpty == false, scalar != "." {
            }
        }
        let trimmed = digits.hasSuffix(".0") ? String(digits.dropLast(2)) : digits
        return "\(grader)|\(trimmed)"
    }

    private func normalizedGradeKey(grade: String, grader: String) -> String {
        Self.normalizedKey(grade: grade, grader: grader)
    }

    var body: some View {
        // CF-GRADE-PILL-PANEL-ALWAYS-10 (2026-07-04): always render 10
        // canonical pills. Server data fills what it has; the rest fall
        // back to muted "unavailable" tiles. Chromeless when embedded
        // in the header tile.
        // CF-PILL-SKELETON (2026-07-04): show grey skeleton pills while
        // /card-panel is loading — no blank placeholders, no flicker
        // between empty and populated states.
        let renderEntries = displayEntries
        // CF-PANEL-RENDER-DIAG (2026-07-04): per-pill render log so we
        // can compare the decoded server rows (from [panel-decode])
        // against what actually reaches the pill view.
        let _ = logRenderEntries(renderEntries)
        return VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if isLoading && payload == nil {
                        ForEach(0..<10, id: \.self) { _ in
                            skeletonPill
                        }
                    } else {
                        ForEach(renderEntries) { entry in
                            pill(for: entry)
                        }
                    }
                }
                // CF-PILL-STROKE-INSET (2026-07-04): 4pt inset on each
                // end so the gradient stroke on the leading/trailing
                // pill never brushes the header card's border.
                .padding(.horizontal, 4)
            }

            // CF-PILL-DEBUG-STATE (2026-07-04): on-screen diagnostic so
            // an empty pill panel tells us WHY at a glance instead of
            // requiring Console.app. Auto-hides on healthy state.
            if let hint = diagnosticHint {
                Text(hint)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: cardId) {
            await fetch()
        }
    }

    /// Text shown just below the pills whenever they're empty for a
    /// non-obvious reason. Returns nil in the healthy state so nothing
    /// renders. Reports the exact state (decoded count, observed
    /// count, estimated count) so a card with thin data reads
    /// differently from a card whose panel decode broke.
    private var diagnosticHint: String? {
        if isLoading && payload == nil { return nil }
        if let msg = errorText {
            return "Couldn't load grade prices: \(msg)"
        }
        let entries = payload?.gradeCurve?.entries ?? []
        let observedCount = entries.filter { $0.valueSource == .observed && resolvedValue($0) != nil }.count
        let estimatedCount = entries.filter { $0.valueSource == .estimated && resolvedValue($0) != nil }.count
        let anyValues = observedCount + estimatedCount
        if entries.isEmpty {
            return "Panel returned 0 grade rungs for this card — backend hasn't computed a curve yet."
        }
        if anyValues == 0 {
            return "Panel returned \(entries.count) rungs but 0 have a computed price yet."
        }
        if anyValues < entries.count {
            return "\(observedCount) observed · \(estimatedCount) estimated · \(entries.count - anyValues) unavailable"
        }
        return nil
    }

    /// Grey placeholder pill shown while `/card-panel` is loading —
    /// same footprint as the real pill so the layout doesn't shift
    /// when the response lands.
    private var skeletonPill: some View {
        VStack(spacing: 3) {
            RoundedRectangle(cornerRadius: 3)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                .frame(width: 36, height: 8)
            RoundedRectangle(cornerRadius: 3)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
                .frame(width: 64, height: 12)
        }
        .frame(minWidth: 62, minHeight: 44)
        .padding(.horizontal, 6)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.15))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.3), lineWidth: 1)
        )
    }

    /// A pill is "active" if we can render a real dollar value for it —
    /// resolved from `value`, `weightedMedianPrice`, or `plainMedianPrice`.
    /// The `valueSource` enum alone can mislead if the backend drifts,
    /// so this is the canonical driver for styling.
    private func isActive(_ entry: CardPanelGradeEntry) -> Bool {
        resolvedValue(entry) != nil
    }

    @ViewBuilder
    private func pill(for entry: CardPanelGradeEntry) -> some View {
        let isSelected = matches(entry, selectedGrade)
        let active = isActive(entry)
        // CF-GRADE-TILE-ALIGN (2026-07-06): dropped the "EST." pill row
        // (only appeared on estimated tiles, which pushed the Raw
        // tile's rows out of vertical alignment with the graded tiles).
        // Price text now renders in warning-orange when the value is
        // estimated — same signal, no layout drift.
        let isEstimated = active && entry.valueSource == .estimated
        let priceTint: Color = {
            if !active { return HobbyIQTheme.Colors.mutedText }
            if isEstimated { return HobbyIQTheme.Colors.warning }
            return HobbyIQTheme.Colors.pureWhite
        }()
        Button {
            selectedGrade = gradeOption(for: entry)
        } label: {
            VStack(spacing: 3) {
                Text(entry.grade)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(active
                                     ? HobbyIQTheme.Colors.pureWhite
                                     : HobbyIQTheme.Colors.mutedText)
                Text(displayValue(entry))
                    .font(.system(size: 14, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(priceTint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(minWidth: 62, minHeight: 44)
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(pillBackground(active: active, isSelected: isSelected))
            )
            .overlay(
                // CF-GRADED-PILL-BLUEGREEN (2026-07-04): graded pills
                // (Raw excluded) get a light electricBlue → hobbyGreen
                // gradient stroke so they read as a coherent themed
                // set. Raw stays with the flat steel-gray outline —
                // pill color signals "this is a graded rung".
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(
                        pillStrokeStyle(entry: entry, active: active, isSelected: isSelected),
                        lineWidth: isSelected ? 1.5 : 1
                    )
            )
        }
        .buttonStyle(.plain)
        // CF-PILL-TAP-ALWAYS (2026-07-04): unavailable pills still
        // route the tap through — the /price-by-id refetch that
        // fires as a side effect surfaces a proper empty-state comps
        // section for that grade (e.g. "No PSA 9 comps yet"), which
        // is more useful than a dead tap.
        .accessibilityLabel("\(entry.grade) \(accessibilityValue(entry))")
    }

    private func pillBackground(active: Bool, isSelected: Bool) -> Color {
        if !active {
            return HobbyIQTheme.Colors.steelGray.opacity(0.15)
        }
        if isSelected {
            return HobbyIQTheme.Colors.electricBlue.opacity(0.22)
        }
        return HobbyIQTheme.Colors.cardNavy.opacity(0.6)
    }

    /// Stroke style for a pill. Selected → solid electricBlue.
    /// Graded (non-Raw, non-selected) → light electricBlue → hobbyGreen
    /// gradient (60% opacity). Raw or inactive → flat steel-gray.
    private func pillStrokeStyle(
        entry: CardPanelGradeEntry,
        active: Bool,
        isSelected: Bool
    ) -> AnyShapeStyle {
        if isSelected {
            return AnyShapeStyle(HobbyIQTheme.Colors.electricBlue)
        }
        let isGraded = entry.grader.uppercased() != "RAW"
        if isGraded && active {
            return AnyShapeStyle(
                LinearGradient(
                    colors: [
                        HobbyIQTheme.Colors.electricBlue.opacity(0.7),
                        HobbyIQTheme.Colors.hobbyGreen.opacity(0.7)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        }
        if isGraded {
            // Inactive graded pill — same gradient at reduced opacity
            // so the theming is preserved but the pill still reads
            // as unavailable.
            return AnyShapeStyle(
                LinearGradient(
                    colors: [
                        HobbyIQTheme.Colors.electricBlue.opacity(0.25),
                        HobbyIQTheme.Colors.hobbyGreen.opacity(0.25)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        }
        // Raw pill — flat steel-gray outline.
        if !active {
            return AnyShapeStyle(HobbyIQTheme.Colors.steelGray.opacity(0.35))
        }
        return AnyShapeStyle(HobbyIQTheme.Colors.steelGray.opacity(0.5))
    }

    private func pillBorder(active: Bool, isSelected: Bool) -> Color {
        if isSelected {
            return HobbyIQTheme.Colors.electricBlue
        }
        if !active {
            return HobbyIQTheme.Colors.steelGray.opacity(0.35)
        }
        return HobbyIQTheme.Colors.steelGray.opacity(0.5)
    }

    /// CF-PILL-HEADLINE-ALIGN (2026-07-07): mirror
    /// `unifiedMarketValue()` on `CompIQPricedCardView` — pill and
    /// MARKET VALUE headline must resolve from the same fallback
    /// chain so a Raw pill of $450 doesn't sit next to a headline of
    /// $573. Order: `trendAdjustedValue` (stale-sale forward-adjusted)
    /// → `value` (fresh weighted median) → `weightedMedianPrice` →
    /// `plainMedianPrice`. Matches the doc comment on
    /// `CardPanelGradeEntry.resolvedMarketValue`.
    private func resolvedValue(_ entry: CardPanelGradeEntry) -> Double? {
        if let v = entry.trendAdjustedValue, v > 0 { return v }
        if let v = entry.value, v > 0 { return v }
        if let v = entry.weightedMedianPrice, v > 0 { return v }
        if let v = entry.plainMedianPrice, v > 0 { return v }
        return nil
    }

    /// Pill dollar rendering — always full dollars with no cents.
    /// CF-PILL-HEADLINE-ALIGN (2026-07-07): rounds to the NEAREST
    /// whole dollar (matching `.currency.precision(.fractionLength(0))`
    /// used everywhere else in the app). Previously used `ceil()`
    /// which surfaced $574 while the MARKET VALUE headline showed
    /// $573 for the same underlying $573.43. `≥$10,000` collapses to
    /// "10k" / "10.1k" so the pill footprint stays uniform.
    private func displayValue(_ entry: CardPanelGradeEntry) -> String {
        guard let value = resolvedValue(entry) else { return "—" }
        if value >= 10_000 {
            let thousands = value / 1_000
            if thousands >= 100 {
                return String(format: "$%.0fk", thousands)
            }
            return String(format: "$%.1fk", thousands)
        }
        return wholeUSDString(value)
    }

    private func accessibilityValue(_ entry: CardPanelGradeEntry) -> String {
        guard isActive(entry) else { return "unavailable" }
        if entry.valueSource == .estimated {
            return "estimated value \(displayValue(entry))"
        }
        return "market value \(displayValue(entry))"
    }

    private func matches(_ entry: CardPanelGradeEntry, _ option: CompIQPricedCardView.GradeOption) -> Bool {
        // Raw → grader == "Raw"
        if entry.grader.uppercased() == "RAW" {
            return option.gradeCompany == nil
        }
        // Graded → match company + numeric value from the label
        guard let (company, value) = parseGraderAndValue(from: entry) else { return false }
        return option.gradeCompany?.uppercased() == company.uppercased()
            && option.gradeValue == value
    }

    /// Turn "PSA 10" / "BGS 9.5" into ("PSA", 10) / ("BGS", 9.5). Raw
    /// returns nil (handled by the caller).
    private func parseGraderAndValue(from entry: CardPanelGradeEntry) -> (String, Double)? {
        let raw = entry.grade.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = raw.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, let value = Double(parts[1]) else { return nil }
        return (String(parts[0]), value)
    }

    private func gradeOption(for entry: CardPanelGradeEntry) -> CompIQPricedCardView.GradeOption {
        if entry.grader.uppercased() == "RAW" {
            return .raw
        }
        guard let (company, value) = parseGraderAndValue(from: entry) else {
            return .raw
        }
        return CompIQPricedCardView.GradeOption(
            label: CompIQPricedCardView.GradeOption.composeLabel(company: company, value: value),
            gradeCompany: company,
            gradeValue: value
        )
    }

    private func fetch() async {
        guard cardId.isEmpty == false else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchCardPanel(cardId: cardId)
            let entries = response.gradeCurve?.entries ?? []
            let sampleLabels = entries.prefix(3).map { "\($0.grade)|\($0.grader)|val=\($0.value ?? -1)|src=\($0.valueSource)" }.joined(separator: " · ")
            gradePanelLogger.notice("[card-panel] cardId=\(cardId, privacy: .public) success=\(response.success ?? false) entries=\(entries.count) sample=\(sampleLabels, privacy: .public)")

            // CF-PANEL-DECODE-DIAG (2026-07-04): per-entry decode log —
            // per Drew's spec so we can see if the entries decoded but
            // one of the price fields didn't map into Swift.
            for entry in entries {
                print("[panel-decode] grade=\(entry.grade) grader=\(entry.grader) sampleCount=\(entry.sampleCount) value=\(String(describing: entry.value)) weightedMedian=\(String(describing: entry.weightedMedianPrice)) valueSource=\(entry.valueSource) estMult=\(String(describing: entry.estimatedMultiplier))")
            }

            payload = response
            onEntriesLoaded?(entries)
        } catch {
            gradePanelLogger.error("[card-panel] cardId=\(cardId, privacy: .public) fetch failed: \(String(describing: error), privacy: .public)")
            print("[panel-decode] fetch failed: \(error)")
            errorText = error.localizedDescription
            payload = nil
        }
    }
}

/// Card chrome matching the other grouped sections on the priced-card
/// view. Kept local since the priced-card modifier is file-private.
private struct GradePanelGroupCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.6)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.15), radius: 6, x: 0, y: 3)
    }
}
