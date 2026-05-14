import Foundation
import SwiftUI

// MARK: - Card Lifecycle Status
enum CardStatus: String, CaseIterable, Codable, Identifiable {
    case owned       = "Owned"
    case listed      = "Listed"
    case sold        = "Sold"
    case grading     = "Sent to Grading"
    case returned    = "Returned from Grading"
    case inTransit   = "In Transit"
    case consigned   = "Consigned"
    case tradePending = "Trade Pending"
    case watchlist   = "Watchlist"
    case archived    = "Archived"
    var id: String { rawValue }

    var color: Color {
        switch self {
        case .owned:       return .blue
        case .listed:      return .orange
        case .sold:        return .green
        case .grading:     return .purple
        case .returned:    return .indigo
        case .inTransit:   return .yellow
        case .consigned:   return .teal
        case .tradePending: return .cyan
        case .watchlist:   return .mint
        case .archived:    return .gray
        }
    }

    var icon: String {
        switch self {
        case .owned:       return "house.fill"
        case .listed:      return "tag.fill"
        case .sold:        return "checkmark.seal.fill"
        case .grading:     return "envelope.fill"
        case .returned:    return "shippingbox.fill"
        case .inTransit:   return "shippingbox"
        case .consigned:   return "person.2.fill"
        case .tradePending: return "arrow.triangle.2.circlepath"
        case .watchlist:   return "eye.fill"
        case .archived:    return "archivebox.fill"
        }
    }
}

// MARK: - Grading Company
enum GradingCompanyOption: String, CaseIterable, Codable {
    case psa   = "PSA"
    case bgs   = "BGS"
    case sgc   = "SGC"
    case cgc   = "CGC"
    case tag   = "TAG"
    case raw   = "Raw"
    case other = "Other"
}

// MARK: - Grading Pipeline Status
enum GradingPipelineStatus: String, CaseIterable, Codable {
    case preparing       = "Preparing"
    case submitted       = "Submitted"
    case receivedByGrader = "Received by Grader"
    case inGrading       = "In Grading"
    case shippedBack     = "Shipped Back"
    case returned        = "Returned"
    case addedToPortfolio = "Added to Portfolio"

    var color: Color {
        switch self {
        case .preparing:        return .gray
        case .submitted:        return .blue
        case .receivedByGrader: return .indigo
        case .inGrading:        return .purple
        case .shippedBack:      return .orange
        case .returned:         return .yellow
        case .addedToPortfolio: return .green
        }
    }

    var stepIndex: Int {
        switch self {
        case .preparing: return 0
        case .submitted: return 1
        case .receivedByGrader: return 2
        case .inGrading: return 3
        case .shippedBack: return 4
        case .returned: return 5
        case .addedToPortfolio: return 6
        }
    }
}

// MARK: - Grading Submission
struct GradingSubmission: Identifiable, Hashable, Codable {
    var id: UUID = UUID()
    var holdingId: UUID
    var playerName: String
    var cardTitle: String
    var gradingCompany: GradingCompanyOption
    var serviceLevel: String          // e.g. "Economy", "Regular", "Express"
    var submissionDate: Date
    var estimatedReturnDate: Date?
    var declaredValue: Double
    var gradingFee: Double
    var shippingCost: Double
    var trackingNumber: String?
    var status: GradingPipelineStatus
    var finalGrade: String?
    var certNumber: String?
    var returnedDate: Date?
    var updatedValueAfterGrade: Double?
    var notes: String?
}

// MARK: - Sale Record
struct SaleRecord: Identifiable, Hashable, Codable {
    var id: UUID = UUID()
    var holdingId: UUID
    var playerName: String
    var cardTitle: String
    var quantitySold: Int
    var salePrice: Double
    var saleDate: Date
    var platform: String             // eBay, PWCC, Whatnot, etc.
    var fees: Double
    var shippingCost: Double
    var taxes: Double
    var costBasisAtSale: Double
    var netProceeds: Double
    var netProfit: Double
    var roi: Double                  // percent
    var buyerNotes: String?

    static var empty: SaleRecord {
        SaleRecord(holdingId: UUID(), playerName: "", cardTitle: "",
                   quantitySold: 1, salePrice: 0, saleDate: Date(),
                   platform: "", fees: 0, shippingCost: 0, taxes: 0,
                   costBasisAtSale: 0, netProceeds: 0, netProfit: 0, roi: 0)
    }
}

// MARK: - Price Forecast
struct PriceForecast: Codable, Hashable {
    var forecast30Day: Double
    var forecast90Day: Double
    var forecast12Month: Double
    var lowEstimate: Double
    var highEstimate: Double
    var modelConfidence: Double      // 0–1
    var reasoningSummary: String
    var volatilityRating: String     // "Low", "Medium", "High"
    var liquidityRating: String      // "Low", "Medium", "High", "Very High"
    var createdAt: Date
}

// MARK: - AI Recommendation
enum AIRecommendationType: String, CaseIterable, Codable {
    case gradeNow        = "Grade This Card"
    case sellNow         = "Sell Now"
    case hold            = "Hold"
    case buyCautiously   = "Buy Cautiously"
    case trendingUp      = "Price Trending Up"
    case trendingDown    = "Price Trending Down"
    case lowLiquidity    = "Low Liquidity Warning"
    case highVolatility  = "High Volatility Warning"
    case underpriced     = "Underpriced Listing Opportunity"
    case overExposure    = "Portfolio Overexposure"
    case staleData       = "Stale Comp Data Warning"

    var icon: String {
        switch self {
        case .gradeNow:      return "star.circle.fill"
        case .sellNow:       return "dollarsign.circle.fill"
        case .hold:          return "hand.raised.fill"
        case .buyCautiously: return "exclamationmark.triangle.fill"
        case .trendingUp:    return "arrow.up.right.circle.fill"
        case .trendingDown:  return "arrow.down.right.circle.fill"
        case .lowLiquidity:  return "drop.fill"
        case .highVolatility: return "waveform.path.ecg"
        case .underpriced:   return "tag.circle.fill"
        case .overExposure:  return "exclamationmark.shield.fill"
        case .staleData:     return "clock.badge.exclamationmark.fill"
        }
    }

    var color: Color {
        switch self {
        case .gradeNow, .trendingUp, .underpriced: return .blue
        case .sellNow:       return .green
        case .hold:          return .gray
        case .buyCautiously, .highVolatility, .overExposure: return .orange
        case .trendingDown, .staleData: return .yellow
        case .lowLiquidity:  return .red
        }
    }

    var priority: Int {
        switch self {
        case .sellNow, .gradeNow:     return 1
        case .trendingDown, .overExposure, .highVolatility: return 2
        case .underpriced, .trendingUp: return 3
        default: return 4
        }
    }
}

struct AIRecommendation: Identifiable, Hashable, Codable {
    var id: UUID = UUID()
    var holdingId: UUID?
    var type: AIRecommendationType
    var explanation: String
    var confidenceScore: Double       // 0–1
    var createdAt: Date
    var dismissedAt: Date?
    var isDismissed: Bool { dismissedAt != nil }
}

// MARK: - Portfolio Holding Model
struct PortfolioHolding: Identifiable, Hashable, Codable {
    let id: UUID
    var playerName: String
    var cardTitle: String
    var cardYear: Int
    var brand: String
    var setName: String
    var product: String
    var sport: String?
    var cardNumber: String?
    var parallel: String?
    var serialNumber: String?
    var printRun: Int?
    var isAuto: Bool
    var isPatch: Bool
    var isRookie: Bool
    var variation: String?
    var bowmanFirst: Bool
    // Graded fields
    var grade: String
    var gradingCompany: String
    var certNumber: String?
    var subgrades: String?           // "C:9.5 / Cor:9 / E:9 / S:9.5"
    var gradingCost: Double?
    var dateGraded: Date?
    // Raw-specific
    var conditionNotes: String?      // centering, corners, surface
    var conditionEstimate: String?   // "NM-MT", "NM", "EX-MT"
    // Inventory
    var quantity: Int
    var purchasePrice: Double
    var totalCostBasis: Double
    var purchaseDate: Date?
    var purchaseSource: String?
    var storageLocation: String?
    var feesPaid: Double
    var taxPaid: Double
    var shippingPaid: Double
    // Status
    var cardStatus: CardStatus
    var listingUrl: String?
    var listingPrice: Double?
    var suggestedListPrice: Double?
    // Valuation
    var currentValue: Double
    var quickSaleValue: Double?
    var fairMarketValue: Double?
    var premiumValue: Double?
    var netEstimatedValue: Double?
    var forecast: PriceForecast?
    // P&L
    var totalProfitLoss: Double
    var totalProfitLossPct: Double
    // AI engine outputs
    var verdict: String
    var recommendation: String
    var trend: PortfolioTrend
    var riskLevel: PortfolioRiskLevel
    var marketSpeed: String
    var marketPressure: String
    var expectedDaysToSell: Int?
    var confidence: Double?
    var compsUsed: Int?
    var parallelDetected: String?
    var explanationBullets: [String]
    // Metadata
    var freshnessStatus: FreshnessStatus
    var lastUpdated: Date
    var statusCategory: StatusCategory
    var tags: [String]
    var notes: String?
    var imageFrontUrl: String?
    var imageBackUrl: String?

    // Backwards-compat computed for older code paths
    var isRaw: Bool {
        gradingCompany.trimmingCharacters(in: .whitespaces).isEmpty
        || gradingCompany.lowercased() == "raw"
    }

    /// 0–100 sell urgency: combines ROI, trend direction, and days-to-sell.
    var sellUrgency: Int {
        var score = 0
        // ROI contribution: caps at 40 pts
        score += min(40, Int(max(0, totalProfitLossPct) * 0.8))
        // Trend contribution
        switch trend {
        case .falling: score += 30
        case .stable:  score += 5
        case .rising:  score -= 10
        }
        // Days-to-sell urgency
        if let days = expectedDaysToSell {
            if days <= 7       { score += 30 }
            else if days <= 14 { score += 20 }
            else if days <= 30 { score += 10 }
        }
        return max(0, min(100, score))
    }

    var sellUrgencyLabel: String {
        switch sellUrgency {
        case 75...: return "Sell Now"
        case 50...: return "Consider Selling"
        case 25...: return "Watch"
        default:    return "Hold"
        }
    }

    var sellUrgencyColor: Color {
        switch sellUrgency {
        case 75...: return .red
        case 50...: return .orange
        case 25...: return .yellow
        default:    return .green
        }
    }
}

enum PortfolioTrend: String, CaseIterable, Codable {
    case rising, stable, falling
}

enum PortfolioRiskLevel: String, CaseIterable, Codable {
    case low, medium, high
}

enum FreshnessStatus: String, CaseIterable, Codable {
    case live = "Live"
    case updatedToday = "Updated Today"
    case yesterday = "Yesterday"
    case needsRefresh = "Needs Refresh"
}

enum StatusCategory: String, CaseIterable, Codable {
    case strong, hold, sellWatch, risky, needsAttention, winner, loser, normal
}

// MARK: - Filter & Sort

enum PortfolioFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case winners = "Winners"
    case losers = "Losers"
    case sellWatch = "Sell Watch"
    case rising = "Rising"
    case risky = "Risky"
    var id: String { rawValue }
}

enum PortfolioSort: String, CaseIterable, Identifiable {
    case highestValue = "Highest Value"
    case lowestValue = "Lowest Value"
    case biggestGainDollar = "Biggest Gain $"
    case biggestGainPercent = "Biggest Gain %"
    case biggestLossDollar = "Biggest Loss $"
    case biggestLossPercent = "Biggest Loss %"
    case recentlyUpdated = "Recently Updated"
    case oldestUpdate = "Oldest Update"
    case bestSellCandidates = "Best Sell Candidates"
    case highestRisk = "Highest Risk"
    case alphabetical = "Alphabetical"
    case purchaseDateNewest = "Purchase Date (Newest)"
    case purchaseDateOldest = "Purchase Date (Oldest)"
    var id: String { rawValue }
}

// MARK: - Mock Grading Submissions
extension GradingSubmission {
    static let mockSubmissions: [GradingSubmission] = [
        GradingSubmission(
            holdingId: UUID(),
            playerName: "Paul Skenes",
            cardTitle: "2024 Bowman Chrome Blue Auto /150",
            gradingCompany: .psa,
            serviceLevel: "Regular",
            submissionDate: Calendar.current.date(byAdding: .day, value: -30, to: Date())!,
            estimatedReturnDate: Calendar.current.date(byAdding: .day, value: 60, to: Date()),
            declaredValue: 800,
            gradingFee: 35,
            shippingCost: 20,
            trackingNumber: "1Z999AA10123456784",
            status: .inGrading,
            notes: "Solid corners, nice centering"
        ),
        GradingSubmission(
            holdingId: UUID(),
            playerName: "Jackson Holliday",
            cardTitle: "2023 Bowman Chrome Refractor Auto",
            gradingCompany: .bgs,
            serviceLevel: "Economy",
            submissionDate: Calendar.current.date(byAdding: .day, value: -60, to: Date())!,
            estimatedReturnDate: Calendar.current.date(byAdding: .day, value: 30, to: Date()),
            declaredValue: 400,
            gradingFee: 20,
            shippingCost: 15,
            status: .shippedBack,
            notes: nil
        )
    ]
}

// MARK: - Mock Sale Records
extension SaleRecord {
    static let mockSales: [SaleRecord] = [
        SaleRecord(
            holdingId: UUID(),
            playerName: "Julio Rodriguez",
            cardTitle: "2022 Topps Chrome Gold /50 PSA 10",
            quantitySold: 1, salePrice: 1200, saleDate: Calendar.current.date(byAdding: .day, value: -10, to: Date())!,
            platform: "eBay", fees: 120, shippingCost: 12, taxes: 0,
            costBasisAtSale: 700, netProceeds: 1068, netProfit: 368, roi: 52.6
        ),
        SaleRecord(
            holdingId: UUID(),
            playerName: "CJ Abrams",
            cardTitle: "2023 Bowman Chrome Auto Raw",
            quantitySold: 2, salePrice: 220, saleDate: Calendar.current.date(byAdding: .day, value: -25, to: Date())!,
            platform: "Whatnot", fees: 22, shippingCost: 8, taxes: 0,
            costBasisAtSale: 200, netProceeds: 190, netProfit: -10, roi: -5.0
        )
    ]
}

// MARK: - Mock Data
extension PortfolioHolding {
    static let mockHoldings: [PortfolioHolding] = [
        PortfolioHolding(
            id: UUID(),
            playerName: "Elly De La Cruz",
            cardTitle: "2023 Bowman Chrome Orange Auto PSA 10",
            cardYear: 2023,
            brand: "Bowman Chrome",
            setName: "Prospect Auto",
            product: "Orange",
            sport: "Baseball",
            cardNumber: "BCP-101",
            parallel: "Orange",
            serialNumber: "/25",
            printRun: 25,
            isAuto: true,
            isPatch: false,
            isRookie: true,
            variation: nil,
            bowmanFirst: true,
            grade: "10",
            gradingCompany: "PSA",
            certNumber: "12345678",
            subgrades: nil,
            gradingCost: 35,
            dateGraded: Calendar.current.date(byAdding: .day, value: -45, to: Date()),
            conditionNotes: nil,
            conditionEstimate: nil,
            quantity: 1,
            purchasePrice: 900,
            totalCostBasis: 900,
            purchaseDate: Calendar.current.date(byAdding: .day, value: -60, to: Date()),
            purchaseSource: "eBay",
            storageLocation: "Binder A",
            feesPaid: 45,
            taxPaid: 30,
            shippingPaid: 10,
            cardStatus: .owned,
            listingUrl: nil,
            listingPrice: nil,
            currentValue: 1700,
            quickSaleValue: 1600,
            fairMarketValue: 1700,
            premiumValue: 1800,
            netEstimatedValue: 1550,
            forecast: PriceForecast(forecast30Day: 1750, forecast90Day: 1900, forecast12Month: 2400,
                                    lowEstimate: 1500, highEstimate: 2000, modelConfidence: 0.85,
                                    reasoningSummary: "Strong demand, limited pop, rookie premium intact.",
                                    volatilityRating: "Low", liquidityRating: "High", createdAt: Date()),
            totalProfitLoss: 800,
            totalProfitLossPct: 88.9,
            verdict: "Strong hold — value is rising and demand is healthy.",
            recommendation: "Hold",
            trend: .rising,
            riskLevel: .low,
            marketSpeed: "Fast",
            marketPressure: "Low",
            expectedDaysToSell: 2,
            confidence: 0.95,
            compsUsed: 18,
            parallelDetected: nil,
            explanationBullets: ["Value is up 32% from cost.", "Demand is strong.", "Market speed is healthy."],
            freshnessStatus: .live,
            lastUpdated: Date(),
            statusCategory: .strong,
            tags: ["Prospect", "Favorite"],
            notes: "Pulled from pack.",
            imageFrontUrl: nil,
            imageBackUrl: nil
        ),
        PortfolioHolding(
            id: UUID(),
            playerName: "Blake Burke",
            cardTitle: "2023 Bowman Chrome Base Auto Raw",
            cardYear: 2023,
            brand: "Bowman Chrome",
            setName: "Base Auto",
            product: "Base",
            sport: "Baseball",
            cardNumber: "BCP-55",
            parallel: nil,
            serialNumber: nil,
            printRun: nil,
            isAuto: true,
            isPatch: false,
            isRookie: true,
            variation: nil,
            bowmanFirst: true,
            grade: "Raw",
            gradingCompany: "",
            certNumber: nil,
            subgrades: nil,
            gradingCost: nil,
            dateGraded: nil,
            conditionNotes: "Centered well, minor edge wear",
            conditionEstimate: "NM-MT",
            quantity: 2,
            purchasePrice: 120,
            totalCostBasis: 240,
            purchaseDate: Calendar.current.date(byAdding: .day, value: -30, to: Date()),
            purchaseSource: "Card Show",
            storageLocation: "Box 1",
            feesPaid: 0,
            taxPaid: 0,
            shippingPaid: 0,
            cardStatus: .owned,
            listingUrl: nil,
            listingPrice: nil,
            currentValue: 180,
            quickSaleValue: 170,
            fairMarketValue: 180,
            premiumValue: 200,
            netEstimatedValue: 170,
            forecast: PriceForecast(forecast30Day: 185, forecast90Day: 195, forecast12Month: 220,
                                    lowEstimate: 150, highEstimate: 250, modelConfidence: 0.7,
                                    reasoningSummary: "Mid-level prospect, value stable with moderate upside.",
                                    volatilityRating: "Medium", liquidityRating: "Medium", createdAt: Date()),
            totalProfitLoss: 120,
            totalProfitLossPct: 50.0,
            verdict: "Sell watch — profit is strong, but market speed is slowing.",
            recommendation: "Sell Watch",
            trend: .stable,
            riskLevel: .medium,
            marketSpeed: "Slowing",
            marketPressure: "Medium",
            expectedDaysToSell: 7,
            confidence: 0.8,
            compsUsed: 12,
            parallelDetected: nil,
            explanationBullets: ["Profit is strong.", "Market speed is slowing.", "Consider selling soon."],
            freshnessStatus: .updatedToday,
            lastUpdated: Calendar.current.date(byAdding: .hour, value: -3, to: Date())!,
            statusCategory: .sellWatch,
            tags: ["Raw", "Grade Candidate"],
            notes: nil,
            imageFrontUrl: nil,
            imageBackUrl: nil
        ),
        PortfolioHolding(
            id: UUID(),
            playerName: "Max Clark",
            cardTitle: "2023 Bowman Chrome Blue Wave PSA 9",
            cardYear: 2023,
            brand: "Bowman Chrome",
            setName: "Refractor",
            product: "Blue Wave",
            sport: "Baseball",
            cardNumber: "BCP-77",
            parallel: "Blue Wave",
            serialNumber: "/150",
            printRun: 150,
            isAuto: false,
            isPatch: false,
            isRookie: false,
            variation: nil,
            bowmanFirst: false,
            grade: "9",
            gradingCompany: "PSA",
            certNumber: "87654321",
            subgrades: nil,
            gradingCost: 25,
            dateGraded: Calendar.current.date(byAdding: .day, value: -80, to: Date()),
            conditionNotes: nil,
            conditionEstimate: nil,
            quantity: 1,
            purchasePrice: 600,
            totalCostBasis: 600,
            purchaseDate: Calendar.current.date(byAdding: .day, value: -90, to: Date()),
            purchaseSource: "eBay",
            storageLocation: "Safe",
            feesPaid: 30,
            taxPaid: 20,
            shippingPaid: 10,
            cardStatus: .listed,
            listingUrl: "https://ebay.com/itm/123456",
            listingPrice: 575,
            currentValue: 570,
            quickSaleValue: 550,
            fairMarketValue: 570,
            premiumValue: 600,
            netEstimatedValue: 530,
            forecast: PriceForecast(forecast30Day: 555, forecast90Day: 530, forecast12Month: 500,
                                    lowEstimate: 480, highEstimate: 620, modelConfidence: 0.6,
                                    reasoningSummary: "Declining interest, supply increasing in the secondary.",
                                    volatilityRating: "High", liquidityRating: "Low", createdAt: Date()),
            totalProfitLoss: -30,
            totalProfitLossPct: -5.0,
            verdict: "Risk rising — value is slipping and supply is building.",
            recommendation: "Risk",
            trend: .falling,
            riskLevel: .high,
            marketSpeed: "Slow",
            marketPressure: "High",
            expectedDaysToSell: 14,
            confidence: 0.6,
            compsUsed: 7,
            parallelDetected: nil,
            explanationBullets: ["Value is slipping.", "Supply is building.", "Risk is rising."],
            freshnessStatus: .needsRefresh,
            lastUpdated: Calendar.current.date(byAdding: .day, value: -2, to: Date())!,
            statusCategory: .risky,
            tags: ["Listed"],
            notes: nil,
            imageFrontUrl: nil,
            imageBackUrl: nil
        )
    ]
}
