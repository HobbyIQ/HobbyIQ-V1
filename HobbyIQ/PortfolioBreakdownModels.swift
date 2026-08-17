//
//  PortfolioBreakdownModels.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). The analytics vocabulary behind
//  Portfolio Breakdown: where the money sits, how risky it is, and how it
//  compares to the HobbyIQ target mix.
//
//  EVERYTHING HERE IS VALUE-WEIGHTED, NOT COUNT-WEIGHTED. A collection of 400
//  commons and one grail is not "mostly commons" in any sense the owner cares
//  about. Card counts appear only where the spec asks for them explicitly.
//
//  THE DERIVED SIGNALS ARE HONEST ABOUT WHAT THEY CANNOT SEE. InventoryCard has
//  no print-run field and no population data, so:
//    - print run is PARSED from the parallel / card name text, and is `nil`
//      when the vendor never wrote it — NOT assumed to be unnumbered.
//    - population risk is computed from print run, era and grade as proxies.
//      True pop-based scarcity needs the backend's cardPopulationLookup and is
//      modelled as a future input rather than faked here.
//
//  A card whose scarcity is unknown is reported as unknown. Guessing would put
//  a confident number on the screen that the data cannot support, which is the
//  one thing a portfolio tool must never do.
//

import Foundation

// MARK: - Target allocation

/// The four buckets the HobbyIQ target mix is expressed in.
enum PortfolioCategory: String, CaseIterable, Identifiable, Codable {
    case establishedGreatness
    case trueScarcity
    case eliteProspects
    case speculation

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .establishedGreatness: return "Established Greatness"
        case .trueScarcity: return "True Scarcity"
        case .eliteProspects: return "Elite Prospects"
        case .speculation: return "Speculation / Flips"
        }
    }

    var blurb: String {
        switch self {
        case .establishedGreatness: return "Proven MLB stars, key rookies, important parallels"
        case .trueScarcity: return "Vintage, serial-numbered, low-pop, constrained supply"
        case .eliteProspects: return "Bowman 1st autos and genuinely scarce prospect cards"
        case .speculation: return "Momentum plays and cards bought to resell"
        }
    }

    /// The HobbyIQ Target Portfolio. NOT the user's current allocation.
    var targetShare: Double {
        switch self {
        case .establishedGreatness: return 0.40
        case .trueScarcity: return 0.30
        case .eliteProspects: return 0.20
        case .speculation: return 0.10
        }
    }
}

/// How a current share compares to its target. Bands are deliberately wide —
/// a portfolio three points off target is on target for any decision a
/// collector would actually make, and colouring that red trains people to
/// ignore the indicator.
enum AllocationStatus: String, Codable {
    case onTarget
    case slightlyUnderweight
    case underweight
    case slightlyOverweight
    case overweight

    var label: String {
        switch self {
        case .onTarget: return "ON TARGET"
        case .slightlyUnderweight: return "SLIGHTLY UNDERWEIGHT"
        case .underweight: return "UNDERWEIGHT"
        case .slightlyOverweight: return "SLIGHTLY OVERWEIGHT"
        case .overweight: return "OVERWEIGHT"
        }
    }

    /// Drift is measured in PERCENTAGE POINTS of the whole portfolio, not as a
    /// ratio of the target. Being 5 points off matters the same whether the
    /// target is 10% or 40% — a ratio would scream about the small buckets.
    static func from(current: Double, target: Double) -> AllocationStatus {
        let drift = (current - target) * 100
        switch drift {
        case ..<(-10): return .underweight
        case ..<(-3):  return .slightlyUnderweight
        case ...3:     return .onTarget
        case ...10:    return .slightlyOverweight
        default:       return .overweight
        }
    }
}

struct PortfolioAllocation: Identifiable, Codable {
    let category: PortfolioCategory
    /// Share of total portfolio VALUE, 0...1.
    let currentShare: Double
    let targetShare: Double
    let value: Double
    let cardCount: Int

    var id: String { category.rawValue }
    var status: AllocationStatus { .from(current: currentShare, target: targetShare) }
    /// Signed percentage points away from target.
    var driftPoints: Double { (currentShare - targetShare) * 100 }
}

// MARK: - Card quality

enum PortfolioQualityTier: Int, CaseIterable, Identifiable, Codable {
    case cornerstone = 1
    case strongHold = 2
    case market = 3
    case speculative = 4

    var id: Int { rawValue }

    var displayName: String {
        switch self {
        case .cornerstone: return "Tier 1 — Cornerstone"
        case .strongHold: return "Tier 2 — Strong Holds"
        case .market: return "Tier 3 — Market Cards"
        case .speculative: return "Tier 4 — Speculative"
        }
    }

    var blurb: String {
        switch self {
        case .cornerstone: return "True scarcity, iconic cards, vintage grails, key low-numbered rookies"
        case .strongHold: return "Scarce rookies, Bowman 1sts, established stars, desirable numbered cards"
        case .market: return "Good liquidity, but higher population or replaceable supply"
        case .speculative: return "Prospects, flips, high-pop cards, volatile players"
        }
    }
}

struct PortfolioQualityBucket: Identifiable, Codable {
    let tier: PortfolioQualityTier
    let cardCount: Int
    let value: Double
    /// Share of total portfolio VALUE, 0...1.
    let valueShare: Double
    var id: Int { tier.rawValue }
}

// MARK: - Player classification

/// Where a player sits in their career. Drives category assignment.
///
/// Derived from what the app can actually see — MLB debut date when PlayerIQ
/// has it, otherwise card-side signals (Bowman 1st / prospect products imply a
/// prospect; vintage years imply a legend). `.unknown` is a real answer and is
/// treated as such downstream rather than being bucketed by default.
enum PlayerClassification: String, CaseIterable, Codable {
    case establishedSuperstar
    case establishedStar
    case youngMLBStar
    case mlbRegular
    case eliteProspect
    case prospect
    case speculativeProspect
    case retiredLegend
    case vintageLegend
    case unknown

    var displayName: String {
        switch self {
        case .establishedSuperstar: return "Established Superstar"
        case .establishedStar: return "Established Star"
        case .youngMLBStar: return "Young MLB Star"
        case .mlbRegular: return "MLB Regular"
        case .eliteProspect: return "Elite Prospect"
        case .prospect: return "Prospect"
        case .speculativeProspect: return "Speculative Prospect"
        case .retiredLegend: return "Retired Legend"
        case .vintageLegend: return "Vintage Legend"
        case .unknown: return "Unclassified"
        }
    }

    var isEstablishedMLB: Bool {
        switch self {
        case .establishedSuperstar, .establishedStar, .youngMLBStar, .mlbRegular,
             .retiredLegend, .vintageLegend:
            return true
        default:
            return false
        }
    }

    var isProspect: Bool {
        switch self {
        case .eliteProspect, .prospect, .speculativeProspect: return true
        default: return false
        }
    }
}

// MARK: - Scarcity

/// Print-run bands, in the language collectors actually use.
///
/// `unnumbered` and `unknown` are DIFFERENT. Unnumbered means we read the card
/// text and it carries no serial; unknown means the text never told us. Folding
/// the second into the first would silently mark every under-described card as
/// non-scarce, which is exactly the direction that flatters a portfolio.
enum ScarcityBand: String, CaseIterable, Codable {
    case oneOfOne          // /1
    case ultraScarce       // /2 ... /10   (Black /10, Red /5)
    case veryScarce        // /11 ... /25  (Orange /25)
    case scarce            // /26 ... /99  (True Gold /50)
    case limited           // /100 ... /499
    case highPrintRun      // /500+
    case unnumbered
    case unknown

    var displayName: String {
        switch self {
        case .oneOfOne: return "1-of-1"
        case .ultraScarce: return "/10 or lower"
        case .veryScarce: return "/25 or lower"
        case .scarce: return "/99 or lower"
        case .limited: return "/100–/499"
        case .highPrintRun: return "/500+"
        case .unnumbered: return "Unnumbered"
        case .unknown: return "Unknown print run"
        }
    }

    static func from(printRun: Int?) -> ScarcityBand {
        guard let run = printRun else { return .unknown }
        switch run {
        case 1: return .oneOfOne
        case 2...10: return .ultraScarce
        case 11...25: return .veryScarce
        case 26...99: return .scarce
        case 100...499: return .limited
        default: return .highPrintRun
        }
    }

    /// 0...1. Feeds the scarcity component of the PortfolioIQ Score.
    /// `unknown` scores as mid-low rather than zero: absence of evidence is not
    /// evidence of a huge print run, and zeroing it would punish users whose
    /// vendor text happens to be terse.
    var score: Double {
        switch self {
        case .oneOfOne: return 1.00
        case .ultraScarce: return 0.92
        case .veryScarce: return 0.80
        case .scarce: return 0.65
        case .limited: return 0.45
        case .highPrintRun: return 0.20
        case .unnumbered: return 0.15
        case .unknown: return 0.30
        }
    }
}

// MARK: - Risk

enum RiskLevel: String, Codable {
    case low, moderate, high

    var label: String {
        switch self {
        case .low: return "LOW"
        case .moderate: return "MODERATE"
        case .high: return "HIGH"
        }
    }
}

/// Some rows read better as a strength than a risk ("Liquidity: STRONG" rather
/// than "Liquidity: LOW"), so the metric carries its own polarity.
enum RiskPolarity: String, Codable {
    /// Higher score = more risk. LOW is good.
    case riskIsBad
    /// Higher score = more of a good thing. STRONG is good.
    case strengthIsGood
}

struct PortfolioRiskMetric: Identifiable, Codable {
    let name: String
    /// 0...1, always "more of the named thing".
    let score: Double
    let polarity: RiskPolarity
    let detail: String

    var id: String { name }

    var level: RiskLevel {
        switch score {
        case ..<0.34: return .low
        case ..<0.67: return .moderate
        default: return .high
        }
    }

    /// The word to show. Strength metrics read STRONG / ADEQUATE / THIN.
    var label: String {
        switch polarity {
        case .riskIsBad:
            return level.label
        case .strengthIsGood:
            switch level {
            case .high: return "STRONG"
            case .moderate: return "ADEQUATE"
            case .low: return "THIN"
            }
        }
    }

    /// True when this reading is bad news, whichever direction that is.
    var isConcerning: Bool {
        switch polarity {
        case .riskIsBad: return level == .high
        case .strengthIsGood: return level == .low
        }
    }
}

struct PortfolioRiskAnalysis: Codable {
    let metrics: [PortfolioRiskMetric]
    var concerning: [PortfolioRiskMetric] { metrics.filter(\.isConcerning) }
}

// MARK: - Concentration

enum ConcentrationDimension: String, CaseIterable, Codable {
    case player, year, product, gradeTier, era

    var displayName: String {
        switch self {
        case .player: return "Player Concentration"
        case .year: return "Single-Year Concentration"
        case .product: return "Product Concentration"
        case .gradeTier: return "Grade Concentration"
        case .era: return "Era Concentration"
        }
    }
}

struct PortfolioConcentration: Identifiable, Codable {
    let dimension: ConcentrationDimension
    /// The thing holding the weight — "Shohei Ohtani", "2024", "Bowman Chrome".
    let label: String
    /// Share of total portfolio VALUE, 0...1.
    let share: Double
    let value: Double
    let cardCount: Int
    /// Above the comfort threshold for this dimension.
    let isWarning: Bool
    let guidance: String

    var id: String { "\(dimension.rawValue)-\(label)" }
}

// MARK: - Recommendations

enum RecommendationKind: String, Codable {
    case allocation, concentration, quality, scarcity, consolidation, strength
}

struct PortfolioRecommendation: Identifiable, Codable {
    let kind: RecommendationKind
    let title: String
    let detail: String
    /// Higher sorts first. Derived from how far off the portfolio actually is,
    /// so the list re-orders itself as the collection changes.
    let priority: Int
    var id: String { "\(kind.rawValue)-\(title)" }
}

/// A cluster of mid-value cards that together equal one better card.
///
/// Deliberately does NOT name cards to sell. It states what is true — this much
/// value is spread across this many replaceable cards — and leaves the decision
/// to the owner. That keeps it analysis rather than financial advice.
struct UpgradeOpportunity: Identifiable, Codable {
    let cardCount: Int
    let combinedValue: Double
    let lowValue: Double
    let highValue: Double
    let insight: String
    var id: String { "upgrade-\(cardCount)-\(Int(combinedValue))" }
}

// MARK: - Score

enum PortfolioScoreTier: String, Codable {
    case elite, strong, good, moderateRisk, highRisk, speculative

    var displayName: String {
        switch self {
        case .elite: return "Elite"
        case .strong: return "Strong Portfolio"
        case .good: return "Good Portfolio"
        case .moderateRisk: return "Moderate Risk"
        case .highRisk: return "High Risk"
        case .speculative: return "Speculative"
        }
    }

    static func from(score: Int) -> PortfolioScoreTier {
        switch score {
        case 90...: return .elite
        case 80..<90: return .strong
        case 70..<80: return .good
        case 60..<70: return .moderateRisk
        case 50..<60: return .highRisk
        default: return .speculative
        }
    }
}

/// The named inputs behind the score, kept so the UI can show WHY rather than
/// just a number. A score a user cannot interrogate is a horoscope.
struct PortfolioScoreComponent: Identifiable, Codable {
    let name: String
    /// 0...1 before weighting.
    let score: Double
    /// Contribution weight, summing to 1 across all components.
    let weight: Double
    var id: String { name }
    var weighted: Double { score * weight }
}

struct PortfolioIQScore: Codable {
    let value: Int              // 0...100
    let components: [PortfolioScoreComponent]
    var tier: PortfolioScoreTier { .from(score: value) }
}

// MARK: - Per-card derived analytics

/// What the service worked out about one holding. Derived on the fly — none of
/// this is persisted, so it cannot drift from the card it describes.
struct HoldingAnalytics: Identifiable {
    let cardID: UUID
    let value: Double
    let cost: Double
    let category: PortfolioCategory
    let qualityTier: PortfolioQualityTier
    let classification: PlayerClassification
    let scarcity: ScarcityBand
    let printRun: Int?
    /// 0...1
    let scarcityScore: Double
    let liquidityScore: Double
    let modernSupplyRisk: Double
    /// Share of the whole portfolio's value, 0...1.
    let portfolioValueWeight: Double
    let isVintage: Bool
    let isGraded: Bool

    var id: UUID { cardID }
    var unrealizedReturn: Double { cost > 0 ? (value - cost) / cost : 0 }
}

// MARK: - Result

struct PortfolioAnalyticsResult {
    let totalValue: Double
    let totalCost: Double
    let cardCount: Int

    let allocations: [PortfolioAllocation]
    let score: PortfolioIQScore
    let risk: PortfolioRiskAnalysis
    let concentrations: [PortfolioConcentration]
    let qualityBuckets: [PortfolioQualityBucket]
    let recommendations: [PortfolioRecommendation]
    let upgradeOpportunities: [UpgradeOpportunity]
    let holdings: [HoldingAnalytics]

    /// Share of value whose print run we could not read. Surfaced in the UI so
    /// a thin-data portfolio does not read as a confident verdict.
    let unknownScarcityValueShare: Double

    var totalProfitLoss: Double { totalValue - totalCost }
    var roi: Double { totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0 }

    static let empty = PortfolioAnalyticsResult(
        totalValue: 0, totalCost: 0, cardCount: 0,
        allocations: [], score: PortfolioIQScore(value: 0, components: []),
        risk: PortfolioRiskAnalysis(metrics: []), concentrations: [],
        qualityBuckets: [], recommendations: [], upgradeOpportunities: [],
        holdings: [], unknownScarcityValueShare: 0
    )
}
