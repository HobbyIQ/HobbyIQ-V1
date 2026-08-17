//
//  PortfolioAnalyticsService.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). The intelligence layer behind
//  Portfolio Breakdown.
//
//  PURE AND SYNCHRONOUS ON PURPOSE. No SwiftUI, no network, no persistence —
//  it takes the holdings the app already has and returns a result. That makes
//  every number here testable, and keeps the view free of arithmetic it would
//  otherwise quietly get wrong on an edge case.
//
//  VALUE-WEIGHTED THROUGHOUT. Shares, concentration and quality are computed on
//  portfolio VALUE. Card counts appear only where the spec asks for them.
//
//  WHAT IT CANNOT SEE, IT SAYS. InventoryCard carries no print-run field and no
//  population data, so print run is parsed out of the parallel / card-name text
//  and is nil when the vendor never wrote it. `unknownScarcityValueShare`
//  reports how much of the portfolio that covers, so a thin-data collection
//  does not render as a confident verdict. Population-based scarcity needs the
//  backend's cardPopulationLookup and is a declared future input, not a guess.
//

import Foundation

final class PortfolioAnalyticsService {

    static let shared = PortfolioAnalyticsService()
    init() {}

    // MARK: - Tunables
    //
    // Named rather than inlined so the thresholds are reviewable in one place
    // and a change shows up in a diff as a decision.

    /// Pre-1980 is treated as vintage: supply is fixed, survivorship is the
    /// only variable, and no modern print-run logic applies.
    private let vintageYearCutoff = 1980
    /// The insert boom. Numbered / insert cards from this window are genuinely
    /// scarce in a way modern numbered cards often are not.
    private let insertEraRange = 1990...1999
    /// "Modern" for supply-risk purposes.
    private let modernYearFloor = 2015

    /// Any single player above this share of value is worth flagging.
    private let playerConcentrationWarning = 0.22
    private let yearConcentrationWarning = 0.35
    private let productConcentrationWarning = 0.40

    /// Consolidation candidates: mid-value cards that are individually
    /// replaceable. Below the floor it is noise; above the ceiling the card is
    /// already a real asset.
    private let upgradeBandFloor: Double = 100
    private let upgradeBandCeiling: Double = 400
    private let upgradeMinimumCards = 4

    /// Seed set for superstar recognition, used ONLY to lift a player from
    /// "unknown" to "established". It is explicitly a stopgap: the right source
    /// is a PlayerIQ tier feed, and this list is deliberately short so nobody
    /// mistakes it for a market ranking. Matching is surname-tolerant because
    /// vendor text writes names every possible way.
    private let establishedSeed: Set<String> = [
        "ohtani", "judge", "witt", "acuna", "acuña", "trout", "betts", "soto",
        "harper", "freeman", "skenes", "guerrero", "tatis", "ramirez", "lindor",
        "alvarez", "devers", "seager", "machado", "arenado", "altuve", "bregman",
    ]

    /// Vendor words that mean "this is a prospect product".
    private let prospectProductTokens = [
        "bowman chrome prospect", "bowman prospect", "1st bowman", "bowman 1st",
        "bowman draft", "prospect auto", "chrome prospect", "bowman sterling",
        "bowman platinum top", "prospects",
    ]

    // MARK: - Entry point

    func analyze(_ cards: [InventoryCard]) -> PortfolioAnalyticsResult {
        // Only holdings the user still owns and that carry a value can be
        // allocated. A sold or zero-valued card would otherwise dilute every
        // share on the screen.
        let owned = cards.filter { isOwned($0) && effectiveValue($0) > 0 }
        guard !owned.isEmpty else { return .empty }

        let totalValue = owned.reduce(0) { $0 + effectiveValue($1) }
        let totalCost = owned.reduce(0) { $0 + ($1.cost * quantity($1)) }
        guard totalValue > 0 else { return .empty }

        let holdings = owned.map { analyzeHolding($0, totalValue: totalValue) }

        let allocations = buildAllocations(holdings, totalValue: totalValue)
        let quality = buildQualityBuckets(holdings, totalValue: totalValue)
        let concentrations = buildConcentrations(owned, holdings, totalValue: totalValue)
        let risk = buildRisk(holdings, concentrations: concentrations, totalValue: totalValue)
        let score = buildScore(holdings, allocations: allocations, risk: risk,
                               concentrations: concentrations, totalValue: totalValue,
                               totalCost: totalCost)
        let upgrades = buildUpgradeOpportunities(holdings)
        let recommendations = buildRecommendations(
            allocations: allocations, concentrations: concentrations,
            quality: quality, holdings: holdings, upgrades: upgrades,
            totalValue: totalValue
        )

        let unknownShare = holdings
            .filter { $0.scarcity == .unknown }
            .reduce(0) { $0 + $1.value } / totalValue

        return PortfolioAnalyticsResult(
            totalValue: totalValue,
            totalCost: totalCost,
            cardCount: owned.count,
            allocations: allocations,
            score: score,
            risk: risk,
            concentrations: concentrations,
            qualityBuckets: quality,
            recommendations: recommendations,
            upgradeOpportunities: upgrades,
            holdings: holdings,
            unknownScarcityValueShare: unknownShare
        )
    }

    // MARK: - Card-level facts

    private func isOwned(_ card: InventoryCard) -> Bool {
        let s = card.status.lowercased()
        return !(s.contains("sold") || s.contains("archived") || s.contains("deleted"))
    }

    private func quantity(_ card: InventoryCard) -> Double {
        max(1, card.quantity ?? 1)
    }

    /// Canonical FMV first, then the card's own current value. Quantity-aware:
    /// four copies of a $50 card are $200 of exposure, and treating them as $50
    /// understates concentration in exactly the case that matters.
    private func effectiveValue(_ card: InventoryCard) -> Double {
        let unit = card.fairMarketValueLive ?? card.fairMarketValue ?? card.currentValue
        return max(0, unit) * quantity(card)
    }

    private func yearInt(_ card: InventoryCard) -> Int? {
        // Vendor years arrive as "1995", "1995-96", "'95". Take the first full
        // four-digit run; anything else is not a year we can reason about.
        guard let match = card.year.range(of: #"(19|20)\d{2}"#, options: .regularExpression) else { return nil }
        return Int(card.year[match])
    }

    /// Print run parsed from the card's own text.
    ///
    /// Reads two things: an explicit "/N" serial, and the named parallels whose
    /// print run is a convention rather than printed on the card. Returns nil
    /// when neither is present — see the header on why that is not zero.
    func parsePrintRun(parallel: String, cardName: String) -> Int? {
        let haystack = "\(parallel) \(cardName)".lowercased()

        // Explicit serial: "/25", "/ 25", "1/1", "#/199".
        if let m = haystack.range(of: #"(?<![\d])/\s*(\d{1,5})"#, options: .regularExpression) {
            let digits = haystack[m].filter(\.isNumber)
            if let n = Int(digits), n > 0 { return n }
        }
        if haystack.contains("1/1") || haystack.contains("one of one") || haystack.contains("superfractor") {
            return 1
        }

        // Named parallels with conventional runs. Ordered longest-first so
        // "true gold" is not shadowed by a bare "gold" rule.
        let named: [(String, Int)] = [
            ("true gold", 50), ("gold vinyl", 5), ("red refractor", 5),
            ("black refractor", 10), ("orange refractor", 25),
            ("gold refractor", 50), ("blue refractor", 150),
        ]
        for (token, run) in named where haystack.contains(token) { return run }
        return nil
    }

    private func isProspectCard(_ card: InventoryCard) -> Bool {
        let haystack = "\(card.setName) \(card.cardName) \(card.parallel)".lowercased()
        return prospectProductTokens.contains { haystack.contains($0) }
    }

    private func isGraded(_ card: InventoryCard) -> Bool {
        if let company = card.gradeCompany, !company.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        let g = card.grade.lowercased()
        return !g.isEmpty && !g.contains("raw") && !g.contains("ungraded")
    }

    // MARK: - Classification

    func classify(_ card: InventoryCard) -> PlayerClassification {
        let year = yearInt(card)
        let name = card.playerName.lowercased()
        let isSeedStar = establishedSeed.contains { name.contains($0) }

        if let y = year, y < vintageYearCutoff { return .vintageLegend }

        if isProspectCard(card) {
            let run = parsePrintRun(parallel: card.parallel, cardName: card.cardName)
            switch ScarcityBand.from(printRun: run) {
            case .oneOfOne, .ultraScarce, .veryScarce: return .eliteProspect
            case .scarce, .limited: return .prospect
            default: return .speculativeProspect
            }
        }

        if isSeedStar { return .establishedSuperstar }
        if let y = year, y < 2000 { return .retiredLegend }
        // Everything else is genuinely unclassified. Saying so beats inventing
        // a tier — a PlayerIQ tier feed is what actually resolves this.
        return .unknown
    }

    /// Which target bucket a holding belongs to.
    ///
    /// Precedence is SUPPLY first, then player. A /10 card is constrained
    /// supply whoever is on it, and a prospect card with an ordinary print run
    /// is a speculation whatever the prospect's ranking. Reading the spec the
    /// other way round would let a well-known name launder an unnumbered
    /// high-pop modern card into "Established Greatness".
    func category(for card: InventoryCard) -> PortfolioCategory {
        let year = yearInt(card)
        let run = parsePrintRun(parallel: card.parallel, cardName: card.cardName)
        let band = ScarcityBand.from(printRun: run)
        let classification = classify(card)

        // 1. Vintage supply is fixed.
        if let y = year, y < vintageYearCutoff { return .trueScarcity }

        // 2. Genuinely constrained supply, any player.
        if band == .oneOfOne || band == .ultraScarce || band == .veryScarce { return .trueScarcity }

        // 3. Insert-era numbered cards — the 1990s scarcity the spec calls out.
        if let y = year, insertEraRange.contains(y), run != nil { return .trueScarcity }

        // 4. Prospects split on whether the card is actually scarce.
        if classification.isProspect {
            return (band == .scarce || band == .limited) ? .eliteProspects : .speculation
        }

        // 5. Established names with ordinary supply.
        if classification.isEstablishedMLB { return .establishedGreatness }

        // 6. Unclassified modern with no scarcity signal is, honestly, a flip.
        return band == .scarce ? .trueScarcity : .speculation
    }

    private func qualityTier(band: ScarcityBand, classification: PlayerClassification,
                             isVintage: Bool, isGraded: Bool, value: Double) -> PortfolioQualityTier {
        if isVintage && isGraded { return .cornerstone }
        switch band {
        case .oneOfOne, .ultraScarce: return .cornerstone
        case .veryScarce: return classification.isProspect ? .strongHold : .cornerstone
        case .scarce: return .strongHold
        case .limited: return classification.isEstablishedMLB ? .strongHold : .market
        case .highPrintRun, .unnumbered:
            if classification.isProspect { return .speculative }
            return isGraded ? .market : .speculative
        case .unknown:
            // No scarcity evidence either way — place on the other signals
            // rather than punishing the card for terse vendor text.
            if isVintage { return .strongHold }
            if classification.isEstablishedMLB && isGraded { return .market }
            return classification.isProspect ? .speculative : .market
        }
    }

    private func liquidity(band: ScarcityBand, isGraded: Bool, value: Double,
                           classification: PlayerClassification) -> Double {
        var s = 0.35
        if isGraded { s += 0.30 }                       // slabs trade fastest
        if classification.isEstablishedMLB { s += 0.15 }
        if classification == .unknown { s -= 0.05 }
        // Very thin markets at the extremes: 1-of-1s are rare AND illiquid,
        // and sub-$25 cards cost more to ship than they realise.
        if band == .oneOfOne { s -= 0.10 }
        if value < 25 { s -= 0.15 }
        if value > 5000 { s -= 0.05 }
        return min(1, max(0, s))
    }

    private func supplyRisk(band: ScarcityBand, year: Int?, isGraded: Bool) -> Double {
        guard let y = year, y >= modernYearFloor else { return 0.15 }  // vintage supply is fixed
        switch band {
        case .oneOfOne, .ultraScarce: return 0.05
        case .veryScarce: return 0.15
        case .scarce: return 0.30
        case .limited: return 0.50
        case .highPrintRun: return 0.80
        case .unnumbered: return isGraded ? 0.75 : 0.90
        case .unknown: return 0.60
        }
    }

    private func analyzeHolding(_ card: InventoryCard, totalValue: Double) -> HoldingAnalytics {
        let value = effectiveValue(card)
        let year = yearInt(card)
        let run = parsePrintRun(parallel: card.parallel, cardName: card.cardName)
        let band = ScarcityBand.from(printRun: run)
        let classification = classify(card)
        let vintage = (year ?? 9999) < vintageYearCutoff
        let graded = isGraded(card)

        return HoldingAnalytics(
            cardID: card.id,
            value: value,
            cost: card.cost * quantity(card),
            category: category(for: card),
            qualityTier: qualityTier(band: band, classification: classification,
                                     isVintage: vintage, isGraded: graded, value: value),
            classification: classification,
            scarcity: band,
            printRun: run,
            scarcityScore: band.score,
            liquidityScore: liquidity(band: band, isGraded: graded, value: value,
                                      classification: classification),
            modernSupplyRisk: supplyRisk(band: band, year: year, isGraded: graded),
            portfolioValueWeight: value / totalValue,
            isVintage: vintage,
            isGraded: graded
        )
    }

    // MARK: - Aggregates

    private func buildAllocations(_ holdings: [HoldingAnalytics], totalValue: Double) -> [PortfolioAllocation] {
        PortfolioCategory.allCases.map { category in
            let bucket = holdings.filter { $0.category == category }
            let value = bucket.reduce(0) { $0 + $1.value }
            return PortfolioAllocation(
                category: category,
                currentShare: value / totalValue,
                targetShare: category.targetShare,
                value: value,
                cardCount: bucket.count
            )
        }
    }

    private func buildQualityBuckets(_ holdings: [HoldingAnalytics], totalValue: Double) -> [PortfolioQualityBucket] {
        PortfolioQualityTier.allCases.map { tier in
            let bucket = holdings.filter { $0.qualityTier == tier }
            let value = bucket.reduce(0) { $0 + $1.value }
            return PortfolioQualityBucket(
                tier: tier, cardCount: bucket.count, value: value,
                valueShare: value / totalValue
            )
        }
    }

    private func buildConcentrations(_ cards: [InventoryCard], _ holdings: [HoldingAnalytics],
                                     totalValue: Double) -> [PortfolioConcentration] {
        let byID = Dictionary(uniqueKeysWithValues: holdings.map { ($0.cardID, $0) })
        var out: [PortfolioConcentration] = []

        func top(_ dimension: ConcentrationDimension, threshold: Double,
                 guidance: String, key: (InventoryCard) -> String?) {
            var value: [String: Double] = [:]
            var count: [String: Int] = [:]
            for card in cards {
                guard let k = key(card)?.trimmingCharacters(in: .whitespacesAndNewlines), !k.isEmpty,
                      let h = byID[card.id] else { continue }
                value[k, default: 0] += h.value
                count[k, default: 0] += 1
            }
            guard let (label, v) = value.max(by: { $0.value < $1.value }) else { return }
            let share = v / totalValue
            out.append(PortfolioConcentration(
                dimension: dimension, label: label, share: share, value: v,
                cardCount: count[label] ?? 0,
                isWarning: share > threshold, guidance: guidance
            ))
        }

        top(.player, threshold: playerConcentrationWarning,
            guidance: "Try to keep any single player below roughly 20–25% unless you are intentionally building a PC.") { $0.playerName }
        top(.year, threshold: yearConcentrationWarning,
            guidance: "A single year carrying most of the value ties the portfolio to one release cycle.") { card in
            self.yearInt(card).map(String.init)
        }
        top(.product, threshold: productConcentrationWarning,
            guidance: "One product dominating means one checklist's market moves the whole portfolio.") { $0.setName }
        top(.gradeTier, threshold: 0.55,
            guidance: "Heavy weighting to one grade tier concentrates grading-standard and population risk.") { card in
            guard self.isGraded(card) else { return "Raw / Ungraded" }
            let company = card.gradeCompany ?? "Graded"
            if let v = card.gradeValue { return "\(company) \(v.formatted(.number.precision(.fractionLength(0...1))))" }
            return company
        }

        return out.sorted { $0.share > $1.share }
    }

    private func buildRisk(_ holdings: [HoldingAnalytics],
                           concentrations: [PortfolioConcentration],
                           totalValue: Double) -> PortfolioRiskAnalysis {
        func valueWeighted(_ transform: (HoldingAnalytics) -> Double) -> Double {
            holdings.reduce(0) { $0 + transform($1) * $1.value } / totalValue
        }
        func shareOf(_ predicate: (HoldingAnalytics) -> Bool) -> Double {
            holdings.filter(predicate).reduce(0) { $0 + $1.value } / totalValue
        }

        let established = shareOf { $0.classification.isEstablishedMLB }
        let prospect = shareOf { $0.classification.isProspect }
        let scarcity = valueWeighted { $0.scarcityScore }
        let liquidityScore = valueWeighted { $0.liquidityScore }
        let supply = valueWeighted { $0.modernSupplyRisk }
        let playerShare = concentrations.first { $0.dimension == .player }?.share ?? 0

        // Diversification via Herfindahl on value weights: sum of squared
        // shares. Inverted so a higher score means better spread. This reads
        // real concentration that a plain card count cannot — 50 cards where
        // one is 60% of value is not a diversified portfolio.
        let hhi = holdings.reduce(0) { $0 + pow($1.portfolioValueWeight, 2) }
        let diversification = min(1, max(0, 1 - hhi))

        return PortfolioRiskAnalysis(metrics: [
            PortfolioRiskMetric(
                name: "Established Player Exposure", score: established, polarity: .strengthIsGood,
                detail: "\(pct(established)) of value sits with established or historically significant players."),
            PortfolioRiskMetric(
                name: "Scarcity Quality", score: scarcity, polarity: .strengthIsGood,
                detail: "Value-weighted scarcity across the collection."),
            PortfolioRiskMetric(
                name: "Prospect Exposure", score: prospect, polarity: .riskIsBad,
                detail: "\(pct(prospect)) of value is in prospect cards, whose outcomes are unresolved."),
            PortfolioRiskMetric(
                name: "Modern Supply Risk", score: supply, polarity: .riskIsBad,
                detail: "Exposure to modern cards whose supply is not meaningfully constrained."),
            PortfolioRiskMetric(
                name: "Player Concentration", score: min(1, playerShare / 0.5), polarity: .riskIsBad,
                detail: "Largest single-player weighting is \(pct(playerShare)) of value."),
            PortfolioRiskMetric(
                name: "Liquidity", score: liquidityScore, polarity: .strengthIsGood,
                detail: "How readily the collection could be converted at a fair price."),
            PortfolioRiskMetric(
                name: "Portfolio Diversification", score: diversification, polarity: .strengthIsGood,
                detail: "Spread of value across holdings rather than card count."),
        ])
    }

    private func buildScore(_ holdings: [HoldingAnalytics],
                            allocations: [PortfolioAllocation],
                            risk: PortfolioRiskAnalysis,
                            concentrations: [PortfolioConcentration],
                            totalValue: Double, totalCost: Double) -> PortfolioIQScore {
        func metric(_ name: String) -> Double { risk.metrics.first { $0.name == name }?.score ?? 0 }

        // Allocation fit: total absolute drift from target, where 0 drift is
        // perfect and 100 points of total drift is a total mismatch. Drift is
        // double-counted by construction (an overweight implies an underweight
        // somewhere), hence the /2.
        let totalDrift = allocations.reduce(0) { $0 + abs($1.driftPoints) } / 2
        let allocationFit = min(1, max(0, 1 - totalDrift / 50))

        let unrealised: Double = {
            guard totalCost > 0 else { return 0.5 }
            let r = (totalValue - totalCost) / totalCost
            // Map -50%...+150% onto 0...1 so a sane gain scores well without a
            // moonshot dominating the whole score.
            return min(1, max(0, (r + 0.5) / 2.0))
        }()

        // Risk-adjusted: return, discounted by how speculative the portfolio is.
        let speculativeShare = holdings.filter { $0.category == .speculation }
            .reduce(0) { $0 + $1.value } / totalValue
        let riskAdjusted = min(1, max(0, unrealised * (1 - speculativeShare * 0.5)))

        let components: [PortfolioScoreComponent] = [
            .init(name: "Allocation Fit", score: allocationFit, weight: 0.20),
            .init(name: "Scarcity Quality", score: metric("Scarcity Quality"), weight: 0.18),
            .init(name: "Established Exposure", score: metric("Established Player Exposure"), weight: 0.14),
            .init(name: "Concentration", score: 1 - metric("Player Concentration"), weight: 0.13),
            .init(name: "Liquidity", score: metric("Liquidity"), weight: 0.12),
            .init(name: "Supply Risk", score: 1 - metric("Modern Supply Risk"), weight: 0.10),
            .init(name: "Diversification", score: metric("Portfolio Diversification"), weight: 0.08),
            .init(name: "Risk-Adjusted Return", score: riskAdjusted, weight: 0.05),
        ]

        let raw = components.reduce(0) { $0 + $1.weighted }
        return PortfolioIQScore(value: Int((raw * 100).rounded()), components: components)
    }

    private func buildUpgradeOpportunities(_ holdings: [HoldingAnalytics]) -> [UpgradeOpportunity] {
        // Mid-value, replaceable supply. Cornerstones are excluded — the point
        // is to surface fungible value, not to suggest breaking up good cards.
        let candidates = holdings.filter {
            $0.value >= upgradeBandFloor && $0.value <= upgradeBandCeiling &&
            ($0.qualityTier == .market || $0.qualityTier == .speculative)
        }
        guard candidates.count >= upgradeMinimumCards else { return [] }

        let combined = candidates.reduce(0) { $0 + $1.value }
        let low = candidates.map(\.value).min() ?? 0
        let high = candidates.map(\.value).max() ?? 0
        let targetLow = Int((combined * 0.8) / 100) * 100
        let targetHigh = Int((combined * 1.05) / 100) * 100

        return [UpgradeOpportunity(
            cardCount: candidates.count,
            combinedValue: combined,
            lowValue: low,
            highValue: high,
            insight: "These \(candidates.count) cards hold \(money(combined)) between them in a band where supply is replaceable. That is roughly one \(money(Double(targetLow)))–\(money(Double(targetHigh))) cornerstone card with better scarcity and more durable collector demand."
        )]
    }

    private func buildRecommendations(allocations: [PortfolioAllocation],
                                      concentrations: [PortfolioConcentration],
                                      quality: [PortfolioQualityBucket],
                                      holdings: [HoldingAnalytics],
                                      upgrades: [UpgradeOpportunity],
                                      totalValue: Double) -> [PortfolioRecommendation] {
        var out: [PortfolioRecommendation] = []

        // Allocation drift, worst first. Priority tracks the actual gap so the
        // list re-orders itself as the collection changes.
        for a in allocations where a.status != .onTarget {
            let gap = abs(a.driftPoints)
            let direction = a.driftPoints < 0 ? "Increase" : "Reduce"
            out.append(.init(
                kind: .allocation,
                title: "\(direction) \(a.category.displayName)",
                detail: "\(direction == "Increase" ? "Currently" : "You hold") \(pct(a.currentShare)) of value against a \(pct(a.targetShare)) target — \(String(format: "%.0f", gap)) points \(a.driftPoints < 0 ? "under" : "over").",
                priority: Int(gap) + 40
            ))
        }

        // Concentration warnings.
        for c in concentrations where c.isWarning {
            out.append(.init(
                kind: .concentration,
                title: "\(c.dimension.displayName) Risk",
                detail: "\(pct(c.share)) of portfolio value is tied to \(c.label). \(c.guidance)",
                priority: Int(c.share * 100) + 30
            ))
        }

        // Scarcity, reported either way — a portfolio that is genuinely scarce
        // deserves to be told so, not just scolded for its gaps.
        let scarceShare = holdings.filter { $0.printRun != nil && ($0.printRun ?? 0) <= 100 }
            .reduce(0) { $0 + $1.value } / totalValue
        if scarceShare >= 0.35 {
            out.append(.init(
                kind: .strength,
                title: "Strong scarcity base",
                detail: "\(pct(scarceShare)) of portfolio value is in cards numbered /100 or lower.",
                priority: 25
            ))
        } else if scarceShare < 0.15 {
            out.append(.init(
                kind: .scarcity,
                title: "Thin on genuine scarcity",
                detail: "Only \(pct(scarceShare)) of value is in cards numbered /100 or lower. Serial numbers alone are not scarcity — print run is what matters.",
                priority: 45
            ))
        }

        // Quality mix.
        if let speculative = quality.first(where: { $0.tier == .speculative }), speculative.valueShare > 0.30 {
            out.append(.init(
                kind: .quality,
                title: "Heavy in speculative cards",
                detail: "\(pct(speculative.valueShare)) of value sits in Tier 4 cards across \(speculative.cardCount) holdings.",
                priority: 42
            ))
        }

        if let upgrade = upgrades.first {
            out.append(.init(
                kind: .consolidation,
                title: "Consolidation opportunity",
                detail: upgrade.insight,
                priority: 35
            ))
        }

        return Array(out.sorted { $0.priority > $1.priority }.prefix(5))
    }

    // MARK: - Formatting helpers

    private func pct(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

    private func money(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: v)) ?? "$\(Int(v))"
    }
}
