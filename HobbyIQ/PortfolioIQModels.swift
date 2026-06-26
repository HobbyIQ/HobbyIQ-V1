//
//  PortfolioIQModels.swift
//  HobbyIQ
//

import Foundation
import SwiftUI

typealias PortfolioPeriodStats = SummaryPeriod

struct PortfolioAccountSnapshot: Codable, Hashable {
    let userId: String
    let totalCards: Int
    let totalValue: Double
    let totalCost: Double
    let totalProfitLoss: Double
    let roi: Double
    let generatedAt: String

    var generatedAtFormatted: String {
        portfolioDisplayDate(from: generatedAt)
    }
}

struct PortfolioCardDetail: Codable, Identifiable, Hashable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let purchasePlatform: String?
    let notes: String?
    let lastPricedAt: String?
    let signal: String?
    let format: String?
    let sellReason: String?

    var signalColor: Color {
        portfolioSignalColor(signal, fallback: .gray)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(currentValue)
    }
}

struct PortfolioBestSellCard: Codable, Identifiable, Hashable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: String?
    let format: String?
    let recommendation: String

    var signalColor: Color {
        portfolioSignalColor(signal, fallback: .blue)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }
}

struct PortfolioHeroSummary: Hashable {
    let totalCards: Int
    let totalValue: Double
    let costBasis: Double
    let unrealizedPnL: Double
    let roi: Double
    let lastRefreshText: String
}

// Display-only hero aggregate computed from the holdings array at render
// time. Excludes unpriced holdings (`fairMarketValue == nil`) from the
// displayed dollar figures and reports them as a separate count. Used by
// the InventoryIQ header subtitle and the PortfolioIQ hero VStack so the
// "$X · +Y · Z% ROI" line stays arithmetically honest — the top number,
// the P/L, and the cost-basis subtitle are all reaggregated against the
// priced subset so they reconcile.
//
// Does NOT replace `PortfolioHeroSummary.totalValue`/`unrealizedPnL`/`roi`,
// which keep their cost-proxy-inclusive sums for non-hero consumers
// (DailyIQ rollups, account snapshot, exports, etc.). The seven producer
// sums at PortfolioIQViewModel:681/:755-756, DashboardService:56,
// AppSupport:547, APIService:644, CompatibilityShims:2699/:3027 are
// unchanged so P/L logic and the −100%-loss guard hold.
struct InventoryDisplayAggregate {
    let displayValue: Double
    let displayCost: Double
    let displayPL: Double
    let displayROI: Double
    let totalCards: Int
    let pricedCount: Int
    let unpricedCount: Int
    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): split the unpriced bucket
    // so the hero subtitle can read "N estimated · M pending" instead of
    // the generic "N unpriced". `displayValue` is unchanged — still
    // observed-only — so Story B's display-only invariant holds. The
    // collection-value card is the surface that includes the estimated
    // bucket in its headline; this split makes the hero's exclusion
    // transparent rather than reframing the aggregate.
    let estimatedCount: Int
    let pendingCount: Int

    init(holdings: [InventoryCard]) {
        var value = 0.0
        var cost = 0.0
        var priced = 0
        var estimated = 0
        var pending = 0
        for card in holdings {
            if let fmv = card.fairMarketValue {
                let qty = max(1.0, card.quantity ?? 1.0)
                value += fmv * qty
                cost += card.cost
                priced += 1
            } else if card.valuationStatus == "estimated" {
                estimated += 1
            } else {
                // "pending", "observed" with nil fmv (backend reclassifies
                // these as pending in computeSnapshotFromHoldings), or a
                // legacy/null wire row that pre-dates Step 1 — all bucket
                // as pending so the four-bucket arithmetic stays clean:
                // priced + estimated + pending = totalCards.
                pending += 1
            }
        }
        self.displayValue = value
        self.displayCost = cost
        self.displayPL = value - cost
        self.displayROI = cost > 0 ? ((value - cost) / cost) * 100 : 0
        self.totalCards = holdings.count
        self.pricedCount = priced
        self.estimatedCount = estimated
        self.pendingCount = pending
        self.unpricedCount = estimated + pending
    }

    /// Subtitle suffix used by the InventoryIQ + PortfolioIQ heroes. Splits
    /// when both buckets are present so the user sees the why behind the
    /// excluded count. Empty when nothing is unpriced.
    var unpricedSubtitleSuffix: String {
        switch (estimatedCount, pendingCount) {
        case (0, 0):
            return ""
        case (let e, 0):
            return " · \(e) estimated"
        case (0, let p):
            return " · \(p) pending"
        case (let e, let p):
            return " · \(e) estimated · \(p) pending"
        }
    }
}

enum PortfolioPriorityActionKind: String, Hashable {
    case sellWatch
    case highRisk
    case stalePricing
}

struct PortfolioPriorityAction: Identifiable, Hashable {
    let id: String
    let kind: PortfolioPriorityActionKind
    let title: String
    let subtitle: String
    let detail: String
    let cardCount: Int
}

struct PortfolioMover: Identifiable, Hashable {
    // CF-IOS-DIRECTION-SWEEP (2026-06-18): PortfolioMover stripped to
    // P/L-only. The prior shape carried movementDirection / impliedPct /
    // composite / dollarImpact / coverage to feed the now-removed
    // movement-branch sort + render. profitLoss + trendLabel /
    // trendDetail are sufficient under the P/L-always ranking.
    let id: String
    let playerName: String
    let cardName: String
    let currentValue: Double
    let profitLoss: Double
    let trendLabel: String
    let trendDetail: String

    init(
        id: String,
        playerName: String,
        cardName: String,
        currentValue: Double,
        profitLoss: Double,
        trendLabel: String,
        trendDetail: String
    ) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.currentValue = currentValue
        self.profitLoss = profitLoss
        self.trendLabel = trendLabel
        self.trendDetail = trendDetail
    }
}



// MARK: - Ledger Response Envelope

struct PortfolioLedgerResponse: Codable {
    let userId: String?
    let count: Int?
    let totals: PortfolioLedgerTotals?
    let entries: [PortfolioLedgerEntry]?
}

struct PortfolioLedgerTotals: Codable, Hashable {
    let realizedProfitLoss: Double?
    let grossProceeds: Double?
    let netProceeds: Double?
    let costBasisSold: Double?
}

// MARK: - Ledger Entry

struct PortfolioLedgerEntry: Identifiable, Hashable, Codable {
    let id: String
    let playerName: String
    let cardTitle: String?
    let quantitySold: Int?
    let unitSalePrice: Double?
    let grossProceeds: Double?
    let fees: Double?
    let tax: Double?
    let shipping: Double?
    let netProceeds: Double?
    let costBasisSold: Double?
    let realizedProfitLoss: Double?
    let realizedProfitLossPct: Double?
    let soldAt: String?
    let notes: String?

    let source: String?
    let ebayOrderId: String?
    let needsReconciliation: Bool?

    let finalValueFee: Double?
    let paymentProcessingFee: Double?
    let promotedListingFee: Double?
    let adFee: Double?
    let otherFees: Double?
    let netPayout: Double?
    let actualShippingCost: Double?
    let suppliesCost: Double?
    let gradingCost: Double?
    let dismissedAt: String?
    let dismissedReason: String?

    private let _dateTextOverride: String?

    var cardName: String { cardTitle ?? "" }
    var salePrice: Double { unitSalePrice ?? grossProceeds ?? 0 }
    var profit: Double { realizedProfitLoss ?? 0 }
    var isEbaySource: Bool { source == "ebay" }

    var dateText: String {
        if let override = _dateTextOverride { return override }
        guard let soldAt, !soldAt.isEmpty else { return "" }
        let fmtFrac = ISO8601DateFormatter()
        fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtStd = ISO8601DateFormatter()
        fmtStd.formatOptions = [.withInternetDateTime]
        guard let date = fmtFrac.date(from: soldAt) ?? fmtStd.date(from: soldAt) else {
            return soldAt
        }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    var totalGranularFees: Double? {
        let known: [Double] = [finalValueFee, paymentProcessingFee, promotedListingFee, adFee, otherFees, actualShippingCost].compactMap { $0 }
        return known.isEmpty ? nil : known.reduce(0, +)
    }

    var hasAnyNullFee: Bool {
        guard isEbaySource else { return false }
        return finalValueFee == nil || paymentProcessingFee == nil
    }

    init(fromSale sale: Sale, index: Int) {
        self.id = "ledger-\(index)-\(sale.id.uuidString)"
        self.playerName = sale.playerName
        self.cardTitle = sale.cardName
        self.unitSalePrice = sale.salePrice
        self.grossProceeds = sale.salePrice
        self.fees = sale.fees
        self.realizedProfitLoss = sale.profit
        self._dateTextOverride = sale.saleDateFormatted
        self.quantitySold = nil
        self.tax = nil
        self.shipping = nil
        self.netProceeds = nil
        self.costBasisSold = nil
        self.realizedProfitLossPct = nil
        self.soldAt = nil
        self.notes = nil
        self.source = nil
        self.ebayOrderId = nil
        self.needsReconciliation = nil
        self.finalValueFee = nil
        self.paymentProcessingFee = nil
        self.promotedListingFee = nil
        self.adFee = nil
        self.otherFees = nil
        self.netPayout = nil
        self.actualShippingCost = nil
        self.suppliesCost = nil
        self.gradingCost = nil
        self.dismissedAt = nil
        self.dismissedReason = nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, playerName, cardTitle, quantitySold, unitSalePrice
        case grossProceeds, fees, tax, shipping, netProceeds
        case costBasisSold, realizedProfitLoss, realizedProfitLossPct
        case soldAt, notes, source, ebayOrderId, needsReconciliation
        case finalValueFee, paymentProcessingFee, promotedListingFee
        case adFee, otherFees, netPayout, actualShippingCost
        case suppliesCost, gradingCost
        case dismissedAt, dismissedReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        playerName = (try? c.decodeIfPresent(String.self, forKey: .playerName)) ?? ""
        cardTitle = try? c.decodeIfPresent(String.self, forKey: .cardTitle)
        quantitySold = try? c.decodeIfPresent(Int.self, forKey: .quantitySold)
        unitSalePrice = try? c.decodeIfPresent(Double.self, forKey: .unitSalePrice)
        grossProceeds = try? c.decodeIfPresent(Double.self, forKey: .grossProceeds)
        fees = try? c.decodeIfPresent(Double.self, forKey: .fees)
        tax = try? c.decodeIfPresent(Double.self, forKey: .tax)
        shipping = try? c.decodeIfPresent(Double.self, forKey: .shipping)
        netProceeds = try? c.decodeIfPresent(Double.self, forKey: .netProceeds)
        costBasisSold = try? c.decodeIfPresent(Double.self, forKey: .costBasisSold)
        realizedProfitLoss = try? c.decodeIfPresent(Double.self, forKey: .realizedProfitLoss)
        realizedProfitLossPct = try? c.decodeIfPresent(Double.self, forKey: .realizedProfitLossPct)
        soldAt = try? c.decodeIfPresent(String.self, forKey: .soldAt)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        ebayOrderId = try? c.decodeIfPresent(String.self, forKey: .ebayOrderId)
        needsReconciliation = try? c.decodeIfPresent(Bool.self, forKey: .needsReconciliation)
        finalValueFee = try? c.decodeIfPresent(Double.self, forKey: .finalValueFee)
        paymentProcessingFee = try? c.decodeIfPresent(Double.self, forKey: .paymentProcessingFee)
        promotedListingFee = try? c.decodeIfPresent(Double.self, forKey: .promotedListingFee)
        adFee = try? c.decodeIfPresent(Double.self, forKey: .adFee)
        otherFees = try? c.decodeIfPresent(Double.self, forKey: .otherFees)
        netPayout = try? c.decodeIfPresent(Double.self, forKey: .netPayout)
        actualShippingCost = try? c.decodeIfPresent(Double.self, forKey: .actualShippingCost)
        suppliesCost = try? c.decodeIfPresent(Double.self, forKey: .suppliesCost)
        gradingCost = try? c.decodeIfPresent(Double.self, forKey: .gradingCost)
        dismissedAt = try? c.decodeIfPresent(String.self, forKey: .dismissedAt)
        dismissedReason = try? c.decodeIfPresent(String.self, forKey: .dismissedReason)
        _dateTextOverride = nil
    }
}

// MARK: - Ledger PATCH

struct LedgerPatchBody: Encodable {
    var gradingCost: Double??
    var suppliesCost: Double??
    var dismissedAt: String??
    var dismissedReason: String??

    private enum CodingKeys: String, CodingKey {
        case gradingCost, suppliesCost, dismissedAt, dismissedReason
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let v = gradingCost { try container.encode(v, forKey: .gradingCost) }
        if let v = suppliesCost { try container.encode(v, forKey: .suppliesCost) }
        if let v = dismissedAt { try container.encode(v, forKey: .dismissedAt) }
        if let v = dismissedReason { try container.encode(v, forKey: .dismissedReason) }
    }
}

struct LedgerPatchResponse: Decodable {
    let message: String
    let entry: PortfolioLedgerEntry
}

extension InventoryCard {
    var costFormatted: String {
        portfolioCurrencyString(cost)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(currentValue)
    }

    // Display-only value text matching `currentValue`'s TOTAL magnitude
    // (FMV × quantity). Returns "—" when `fairMarketValue` is nil so the row
    // does not render a cost-proxy dollar number for unpriced holdings.
    // `currentValue` and every P/L derivation are untouched so the
    // −100%-loss guard inside `currentValue`'s cost-proxy fallback still
    // holds. `fairMarketValue == 0` is a genuine price and renders as "$0".
    var displayValueText: String {
        guard let fmv = fairMarketValue else { return "—" }
        let qty = max(1.0, quantity ?? 1.0)
        return inventoryWholeDollarString(fmv * qty)
    }

    var displayValueFormatted: String {
        guard let fmv = fairMarketValue else { return "—" }
        let qty = max(1.0, quantity ?? 1.0)
        return portfolioCurrencyString(fmv * qty)
    }

    var isUnpriced: Bool { fairMarketValue == nil }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(cost > 0 ? (profitLoss / cost) * 100 : 0)
    }

    var purchaseDateFormatted: String {
        portfolioDisplayDate(from: purchaseDate ?? "")
    }

    var purchasePlatformText: String {
        guard let purchasePlatform else { return "—" }
        let trimmed = purchasePlatform.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "—" : trimmed
    }

    var statusChipText: String {
        let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Active"
        }
        return trimmed
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    var gradeChipText: String {
        let trimmed = grade.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Raw" : trimmed
    }

    var trendChipText: String {
        switch profitLoss {
        case ..<0:
            return "Down"
        case 0:
            return "Flat"
        default:
            return "Up"
        }
    }

    var freshnessChipText: String {
        if let confidence {
            switch confidence {
            case 0.8...:
                return "Fresh"
            case 0.6..<0.8:
                return "Review"
            default:
                return Labels.stale
            }
        }

        if method?.isEmpty == false || summary?.isEmpty == false {
            return "Synced"
        }

        return Labels.stale
    }

    var dailyTrendBadgeText: String? {
        switch profitLoss {
        case ..<0:
            return "DailyIQ Watch"
        case 0:
            return nil
        default:
            return "DailyIQ Trend"
        }
    }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): movementIsStale,
    // movementIsExpired, shouldShowMovementChip, movementChipText,
    // movementChipColor, dollarImpact, predictedPriceFormatted,
    // movementCoverageLabel all removed — every consumer was a
    // direction render site stripped in this same CF.

    var fairMarketValueFormatted: String? {
        fairMarketValue.map { portfolioCurrencyString($0) }
    }

    var costBasisImpactFormatted: String {
        portfolioCurrencyString(cost)
    }

    var profitPercentFormatted: String {
        portfolioSignedPercentString(cost > 0 ? (profitLoss / cost) * 100 : 0)
    }

    var expectedDaysToSellText: String {
        switch status.lowercased() {
        case "sell_now", "sell now", "sell":
            return "1-7 days"
        case "watch":
            return "7-14 days"
        case "hold":
            return "14-30 days"
        default:
            if profitLoss < 0 {
                return "7-14 days"
            }
            return "14-21 days"
        }
    }

    var actionabilityBullets: [String] {
        var bullets: [String] = []

        if let summary, summary.isEmpty == false {
            bullets.append(summary)
        }

        if let method, method.isEmpty == false {
            bullets.append("Method: \(method)")
        }

        if let notes, notes.isEmpty == false {
            bullets.append(notes)
        }

        if bullets.isEmpty {
            bullets.append("No extra explanation provided yet.")
        }

        return bullets
    }
}

extension PortfolioInventorySummary {
    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(totalProfitLoss)
    }

    var totalValueFormatted: String {
        portfolioCurrencyString(totalCurrentValue)
    }

    var totalCostFormatted: String {
        portfolioCurrencyString(totalCost)
    }
}

extension SummaryPeriod {
    var netProfitFormatted: String {
        portfolioSignedCurrencyString(netProfit ?? totalProfit)
    }

    var marginFormatted: String {
        Labels.marginFormatted(margin)
    }

    var totalSoldFormatted: String {
        portfolioCurrencyString(totalSold)
    }

    var totalExpensesFormatted: String {
        portfolioCurrencyString(totalExpenses ?? 0)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(totalSold + (netProfit ?? totalProfit))
    }
}

extension Sale {
    var saleDateFormatted: String {
        date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    var salePriceFormatted: String {
        portfolioCurrencyString(salePrice)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profit)
    }
}

extension Double {
    var portfolioCurrencyText: String {
        formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
    }

    var portfolioSignedCurrencyText: String {
        let amount = abs(self).formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
        return self >= 0 ? "+\(amount)" : "-\(amount)"
    }

    var portfolioSignedPercentText: String {
        String(format: "%+.1f%%", self)
    }
}

private func portfolioSignedCurrencyString(_ value: Double) -> String {
    let amount = portfolioCurrencyString(abs(value))
    return value >= 0 ? "+\(amount)" : "-\(amount)"
}

private func portfolioSignedPercentString(_ value: Double) -> String {
    String(format: "%+.1f%%", value)
}

private func portfolioDisplayDate(from rawValue: String) -> String {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
        return "—"
    }

    let date = portfolioParseDate(trimmed) ?? .distantPast
    guard date != .distantPast else {
        return trimmed
    }

    return date.formatted(.dateTime.month(.abbreviated).day())
}

private func portfolioParseISO(_ rawValue: String) -> Date? {
    portfolioParseDate(rawValue)
}

private func portfolioParseDate(_ rawValue: String) -> Date? {
    let parser = ISO8601DateFormatter()
    if let date = parser.date(from: rawValue) {
        return date
    }

    let fractionalParser = ISO8601DateFormatter()
    fractionalParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractionalParser.date(from: rawValue) {
        return date
    }

    let dateOnlyFormatter = DateFormatter()
    dateOnlyFormatter.locale = Locale(identifier: "en_US_POSIX")
    dateOnlyFormatter.dateFormat = "yyyy-MM-dd"
    return dateOnlyFormatter.date(from: rawValue)
}

// MARK: - Shared Enums

enum PortfolioInventoryMode: String, CaseIterable, Identifiable {
    case rows = "Rows"
    case grid = "Grid"

    var id: String { rawValue }
    var title: String { rawValue }
}

enum PortfolioInventoryFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case gainers = "Gainers"
    case losers = "Losers"
    case sellWatch = "Sell Watch"
    case stale = "Stale"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "All"
        case .gainers: return Labels.gainers
        case .losers: return Labels.losers
        case .sellWatch: return Labels.sellWatch
        case .stale: return Labels.stale
        }
    }
}

enum PortfolioInventorySort: String, CaseIterable, Identifiable {
    case value = "Value"
    case profit = "Profit"
    case roi = "ROI"
    case recent = "Recent"
    case name = "Name"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .roi: return Labels.roi
        default: return rawValue
        }
    }
}

// MARK: - Shared View Modifiers

struct PortfolioSectionShellModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.18), radius: 18, x: 0, y: 10)
    }
}

struct PortfolioCardSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(12)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.88))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

extension View {
    func portfolioSectionShell() -> some View {
        modifier(PortfolioSectionShellModifier())
    }

    func portfolioCardSurface(cornerRadius: CGFloat = HobbyIQTheme.Radius.large) -> some View {
        modifier(PortfolioCardSurfaceModifier(cornerRadius: cornerRadius))
    }
}

// MARK: - Shared Helper Functions

func detailRow(title: String, value: String, valueColor: Color = .white, subtitle: String? = nil) -> some View {
    HStack(alignment: .top, spacing: 12) {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .frame(width: 120, alignment: .leading)

        VStack(alignment: .trailing, spacing: 2) {
            Text(value)
                .font(.caption.weight(.medium))
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
            if let subtitle, subtitle.isEmpty == false {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .multilineTextAlignment(.trailing)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.vertical, 2)
}

func portfolioSignalBadgeText(_ rawValue: String?) -> String {
    let trimmed = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard trimmed.isEmpty == false else {
        return "N/A"
    }

    return trimmed
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .uppercased()
}

func portfolioCurrencyString(_ value: Double) -> String {
    value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
}

// MARK: - Shared Detail Sheet Components

struct PortfolioHoldingDetailSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onUpdated: () -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared
    @State private var showingEditSheet = false
    @State private var showingSoldSheet = false
    @State private var showingEbayListingSheet = false
    @State private var showingRemoveModal = false
    // CF-IOS-DIRECTION-SWEEP (2026-06-18): re-added after CompIQ
    // direction strip. PortfolioCompIQBridgeView destination is now
    // comp-only (zones + confidence; no predictedPrice / trendIQ /
    // broaderTrend / buyWindow). Routes the Pricing Context "View
    // comp analysis" footer button.
    @State private var showingCompIQAnalysis = false
    @State private var lastEbayListingResponse: PortfolioEbayListingResponse?
    @State private var localError: String?

    init(viewModel: PortfolioIQViewModel, card: InventoryCard, onUpdated: @escaping () -> Void) {
        self.viewModel = viewModel
        self.card = card
        self.onUpdated = onUpdated
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        PortfolioHoldingHeroCard(card: card) {
                            showingEditSheet = true
                        }

                        PortfolioDetailPhotosCard(viewModel: viewModel, card: card, onUpdated: onUpdated)

                        // CF-IOS-DIRECTION-CLEANUP (2026-06-18): direction
                        // sites pruned. Removed Predicted Price, Predicted
                        // Range, Verdict (statusChipText reads the backend
                        // action recommendation — direction-class). Movement
                        // Signal card entirely removed; backtest established
                        // direction is at-chance. Fair Market row's `method`
                        // subtitle is comp-status (from the null-FMV PR) and
                        // stays.
                        PortfolioContextCard(title: "Pricing Context") {
                            detailRow(
                                title: "Fair Market",
                                value: card.displayValueFormatted,
                                subtitle: card.isUnpriced ? card.method : nil
                            )
                            detailRow(title: "Quick Sale", value: card.lowValue.map { portfolioCurrencyString($0) } ?? "—")
                            detailRow(title: "Suggested List", value: card.highValue.map { portfolioCurrencyString($0) } ?? "—")

                            // CF-IOS-DIRECTION-SWEEP (2026-06-18): footer
                            // entry into the now-comp-only CompIQ bridge.
                            Button {
                                showingCompIQAnalysis = true
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "doc.text.magnifyingglass")
                                        .font(.caption.weight(.semibold))
                                    Text("View comp analysis")
                                        .font(.caption.weight(.semibold))
                                }
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                                .clipShape(Capsule(style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }

                        PortfolioContextCard(title: "Actionability") {
                            // Trend / Risk read profitLoss sign (historical
                            // P/L, not direction). Freshness is comp-data
                            // age. Expected Days was direction-in-days-to-
                            // sell clothing (gated on status sell_now/hold/
                            // watch) and was pruned with Verdict.
                            detailRow(title: "Trend", value: card.trendChipText)
                            detailRow(title: "Risk", value: card.profitLoss < 0 ? "Review" : "Low")
                            detailRow(title: "Freshness", value: card.freshnessChipText)

                            VStack(alignment: .leading, spacing: 8) {
                                Text("Explanation")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(Color(hex: 0x9CA3AF))

                                ForEach(card.actionabilityBullets.indices, id: \.self) { index in
                                    HStack(alignment: .top, spacing: 8) {
                                        Text("•")
                                            .foregroundStyle(Color(hex: 0x3B82F6))
                                        Text(card.actionabilityBullets[index])
                                            .foregroundStyle(Color(hex: 0xE8EAF0))
                                    }
                                    .font(.caption)
                                }
                            }
                        }

                        PortfolioContextCard(title: "Card Details") {
                            detailRow(title: "Purchase Price", value: card.costFormatted)
                            detailRow(title: "Profit / Loss", value: card.profitFormatted, valueColor: card.profitLoss >= 0 ? .green : .red)
                            detailRow(title: Labels.roi, value: card.roiFormatted, valueColor: card.profitLoss >= 0 ? .green : .red)
                            detailRow(title: "Purchase Date", value: card.purchaseDateFormatted)
                            detailRow(title: "Purchase Location", value: card.purchasePlatformText)
                            detailRow(title: "Year", value: card.year.isEmpty ? "—" : card.year)
                            detailRow(title: "Set", value: card.setName.isEmpty ? "—" : card.setName)
                            detailRow(title: "Parallel", value: card.parallel.isEmpty ? "—" : card.parallel)
                            detailRow(title: "Grade", value: card.grade.isEmpty ? "—" : card.grade)
                            detailRow(title: "Auto", value: card.isAuto ? "Yes" : "No")
                            detailRow(title: "Quantity", value: card.quantity.map { String(format: "%.0f", $0) } ?? "—")
                            detailRow(title: "Notes", value: card.notes?.isEmpty == false ? card.notes! : "—")
                            detailRow(title: Labels.confidence, value: card.confidence.map { String(format: "%.0f%%", $0 * 100) } ?? "—")
                            detailRow(title: "Method", value: card.method?.isEmpty == false ? card.method! : "—")
                            detailRow(title: "Summary", value: card.summary?.isEmpty == false ? card.summary! : "—")
                        }

                        if let lastEbayListingResponse {
                            PortfolioContextCard(title: "Latest eBay Result") {
                                detailRow(title: "Listing ID", value: lastEbayListingResponse.listingId ?? "—")
                                detailRow(title: "URL", value: lastEbayListingResponse.listingURL ?? "—")
                                detailRow(title: "Status", value: lastEbayListingResponse.status ?? "—")
                                detailRow(title: "Message", value: lastEbayListingResponse.message ?? "—")
                            }
                        }

                        if let localError {
                            Text(localError)
                                .font(.footnote)
                                .foregroundStyle(Color.red)
                        }

                        VStack(spacing: 12) {
                            if ebayStore.connectionState != .connected {
                                Button {
                                    localError = nil
                                    ebayStore.startConnect()
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: ebayStore.isConnecting ? "hourglass" : "person.crop.circle.badge.checkmark")
                                        Text(ebayStore.isConnecting ? "Connecting..." : "Connect eBay")
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(ebayStore.isConnecting)
                            }

                            Button {
                                showingEbayListingSheet = true
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "cart.badge.plus")
                                    Text(ebayStore.connectionState == .connected ? "List on eBay" : "Open eBay Draft")
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(ebayStore.isConnecting)

                            Button("Mark Sold") {
                                showingSoldSheet = true
                            }
                            .buttonStyle(PrimaryButtonStyle())

                            Button(role: .destructive) {
                                showingRemoveModal = true
                            } label: {
                                Text("Remove from Portfolio")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .tint(.red)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 20)
                }
                .background { HobbyIQBackground() }
                .navigationTitle("Card Details")
                .navigationBarTitleDisplayMode(.inline)
                .themedNavigationSurface()
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                            .foregroundStyle(AppColors.textSecondary)
                    }
                }
                .sheet(isPresented: $showingSoldSheet) {
                    PortfolioHoldingSoldSheet(viewModel: viewModel, card: card) {
                        onUpdated()
                        dismiss()
                    }
                }
                .sheet(isPresented: $showingEditSheet) {
                    AddPortfolioCardView(viewModel: AddPortfolioCardViewModel(existingCard: card)) {
                        onUpdated()
                        dismiss()
                    }
                }
                .sheet(isPresented: $showingEbayListingSheet) {
                    EbayListingDraftView(viewModel: viewModel, card: card) {
                        lastEbayListingResponse = $0
                        onUpdated()
                    }
                }
                .sheet(isPresented: $showingCompIQAnalysis) {
                    NavigationStack {
                        PortfolioCompIQBridgeView(holding: card)
                    }
                }

                if showingRemoveModal {
                    CenteredRemoveConfirmationModal(
                        title: "Remove this card?",
                        message: "This will remove the holding from your portfolio.",
                        confirmTitle: "Remove",
                        isConfirming: viewModel.isLoading,
                        onCancel: {
                            showingRemoveModal = false
                        },
                        onConfirm: {
                            showingRemoveModal = false
                            Task {
                                let didRemove = await viewModel.removeHolding(card)
                                if didRemove {
                                    onUpdated()
                                    dismiss()
                                } else {
                                    localError = viewModel.errorMessage ?? "Could not remove that card."
                                }
                            }
                        }
                    )
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    .zIndex(10)
                }
            }
        }
        .task {
            await ebayStore.refreshConnectionStatus()
        }
        .onChange(of: ebayStore.lastErrorMessage) { _, newValue in
            if let newValue {
                localError = newValue
            }
        }
    }
}

struct PortfolioHoldingHeroCard: View {
    let card: InventoryCard
    let onEdit: () -> Void

    private var plColor: Color {
        if card.profitLoss > 0 { return HobbyIQTheme.Colors.successGreen }
        if card.profitLoss < 0 { return .red }
        return .white
    }

    private var cardSubtitle: String {
        var parts: [String] = []
        if !card.year.isEmpty { parts.append(card.year) }
        if !card.setName.isEmpty { parts.append(card.setName) }
        if !card.parallel.isEmpty { parts.append(card.parallel) }
        if card.isAuto { parts.append("Auto") }
        return parts.joined(separator: " ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Top row: name + edit
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.playerName)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.white)

                    if !cardSubtitle.isEmpty {
                        Text(cardSubtitle)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }

                Spacer(minLength: 8)

                Button(action: onEdit) {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil")
                            .font(.caption2.weight(.bold))
                        Text("Edit")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.2))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1)
                    )
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
            }

            // Price stats row: Purchase Price | Current Value | P/L
            HStack(spacing: 0) {
                heroStat(label: "Purchase Price", value: card.costFormatted, color: .white)
                Spacer()
                heroStat(label: "Current Value", value: card.displayValueFormatted, color: .white)
                Spacer()
                heroStat(label: "P/L", value: portfolioCurrencyString(card.profitLoss), color: plColor)
            }
        }
        .padding(18)
        .background(
            LinearGradient(
                colors: [Color(hex: 0x141821), Color(hex: 0x1A1F2E)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.25), Color.white.opacity(0.06)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1.2
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func heroStat(label: String, value: String, color: Color) -> some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
            Text(label.uppercased())
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.5)
        }
    }
}

struct PortfolioContextCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)

            VStack(alignment: .leading, spacing: 10, content: content)
        }
        .padding(16)
        .background(Color(hex: 0x141821))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

struct PortfolioHoldingSoldSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var salePriceText: String
    @State private var feesText = "0"
    @State private var saleDate = Date()
    @State private var localError: String?

    init(viewModel: PortfolioIQViewModel, card: InventoryCard, onSaved: @escaping () -> Void) {
        self.viewModel = viewModel
        self.card = card
        self.onSaved = onSaved
        _salePriceText = State(initialValue: String(format: "%.2f", card.currentValue))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Mark Sold")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(.white)

                    Text("\(card.playerName) - \(card.cardName)")
                        .font(.subheadline)
                        .foregroundStyle(Color(hex: 0x9CA3AF))

                    soldField(title: "Sold For", text: $salePriceText, keyboard: .decimalPad)
                    soldField(title: "Fees", text: $feesText, keyboard: .decimalPad)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Sale Date")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)

                        DatePicker("", selection: $saleDate, displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .tint(Color(hex: 0x3B82F6))
                            .padding(12)
                            .background(Color(hex: 0x1A1D24))
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }

                    soldPreview

                    if let localError {
                        Text(localError)
                            .font(.footnote)
                            .foregroundStyle(Color.red)
                    }

                    Button("Save Sold") {
                        Task {
                            guard let salePrice = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)), salePrice > 0 else {
                                localError = "Add a sale price."
                                return
                            }

                            let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
                            let didSave = await viewModel.markHoldingSold(card, salePrice: salePrice, fees: fees, date: saleDate)
                            if didSave {
                                onSaved()
                                dismiss()
                            } else {
                                localError = viewModel.errorMessage ?? "Could not save sale. Try again."
                            }
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Mark Sold")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(AppColors.textSecondary)
                }
            }
        }
    }

    private func soldField(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.words)
                .padding(14)
                .background(Color(hex: 0x1A1D24))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 2)
                )
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .foregroundStyle(.white)
        }
    }

    private var soldPreview: some View {
        let soldFor = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let profit = soldFor > 0 ? soldFor - card.cost - fees : 0
        let margin = soldFor > 0 ? profit / soldFor : 0

        return VStack(alignment: .leading, spacing: 10) {
            Text("Profit")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            Text(profit.portfolioSignedCurrencyText)
                .font(.headline.weight(.bold))
                .foregroundStyle(profit >= 0 ? Color(hex: 0x4ADE80) : .red)

            Text("Margin")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            Text(margin.portfolioSignedPercentText)
                .font(.headline.weight(.bold))
                .foregroundStyle(profit >= 0 ? Color(hex: 0x4ADE80) : .red)
        }
        .padding(12)
        .background(Color(hex: 0x1A1D24))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct CenteredRemoveConfirmationModal: View {
    let title: String
    let message: String
    let confirmTitle: String
    let isConfirming: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.62)
                .ignoresSafeArea()
                .onTapGesture(perform: onCancel)

            VStack(spacing: 14) {
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Color(hex: 0xC7CEDB))
                    .multilineTextAlignment(.center)

                HStack(spacing: 12) {
                    Button("Cancel", action: onCancel)
                        .buttonStyle(PortfolioSecondaryButtonStyle())

                    Button(confirmTitle, action: onConfirm)
                        .buttonStyle(PortfolioDestructiveButtonStyle())
                        .disabled(isConfirming)
                }
            }
            .padding(20)
            .frame(maxWidth: 320)
            .background(Color(hex: 0x171B24))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2)
            )
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.35), radius: 22, x: 0, y: 12)
            .padding(.horizontal, 24)
        }
    }
}

struct PortfolioSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color(hex: 0x3B82F6).opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: Color(hex: 0x3B82F6).opacity(0.22), radius: 10, x: 0, y: 6)
            .opacity(configuration.isPressed ? 0.95 : 1)
    }
}

struct PortfolioDestructiveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color(hex: 0x3B82F6).opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: Color(hex: 0x3B82F6).opacity(0.22), radius: 10, x: 0, y: 6)
            .opacity(configuration.isPressed ? 0.95 : 1)
    }
}

// MARK: - Shared Inventory Card Components

struct PortfolioCardRow: View {
    let card: InventoryCard

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                inventoryRowThumbnail(urlString: card.imageFrontUrl, playerName: card.playerName)

                VStack(alignment: .leading, spacing: 6) {
                    Text(card.playerName)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    if let details = inventoryCardSubtitle(for: card) {
                        Text(details)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    inventoryGradePill(text: card.gradeChipText)
                }

                Spacer(minLength: 8)

                inventoryRightColumn(card: card)
            }

            // CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): CardHedge headline
            // + model line + lean badge. Self-suppresses when all three
            // blocks are absent (legacy holdings, or non-CardHedge cards).
            CardHedgeModelSignalView(
                lastSalePrice: card.lastSaleSurface?.price,
                lastSaleCompCount: card.lastSaleSurface?.compCount,
                modelExpectation: card.modelExpectation,
                modelSignal: card.modelSignal
            )
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
    }
}

struct PortfolioCardGridCard: View {
    let card: InventoryCard

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            inventoryGridThumbnail(urlString: card.imageFrontUrl, playerName: card.playerName)

            VStack(alignment: .leading, spacing: 4) {
                Text(card.playerName)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                if let details = inventoryCardSubtitle(for: card) {
                    Text(details)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }

                inventoryGradePill(text: card.gradeChipText)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)

            Spacer(minLength: 6)

            HStack(alignment: .center, spacing: 4) {
                Text(card.displayValueText)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Spacer(minLength: 4)
                inventoryGridMovement(card: card)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
    }
}

// MARK: - Inventory row helpers (private to the inventory rows above)

/// Composes the muted secondary line: "Year · Set". Falls back to the legacy
/// cardName when neither structured field is present so we never render a
/// blank line in legacy data.
// MARK: - CF-IOS-MODEL-SIGNAL-RENDER list-cell preview (2026-06-26)

#Preview("PortfolioCardRow · Hartman sell (model-signal on list)") {
    let card = InventoryCard(
        playerName: "Eric Hartman",
        cardName: "Green Shimmer Refractor /99 Auto",
        cost: 0,
        currentValue: 450,
        status: "active",
        year: "2026",
        setName: "Bowman",
        parallel: "Green Shimmer Refractor",
        grade: "",
        isAuto: true,
        lastSaleSurface: CardHedgeLastSaleSurface(price: 450, date: "2026-06-20T12:00:00Z", compCount: 1),
        modelExpectation: CardHedgeModelExpectation(
            value: 262, range: [250, 273], multiplier: 3.20, multiplierRange: [3.05, 3.33],
            basis: "prices_by_card_honest", n: 11, baseAutoMedian: 82, baseAutoCount: 69
        ),
        modelSignal: CardHedgeModelSignal(
            lean: "sell", deltaPct: 72, expectation: 262, effectiveMultiplier: 3.20
        )
    )
    return VStack(spacing: 12) {
        Text("List row — Hartman Green Shimmer /99 Auto (sell signal)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        PortfolioCardRow(card: card)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
    .padding()
    .background(HobbyIQTheme.Colors.appBackground)
    .preferredColorScheme(.dark)
}

private func inventoryCardSubtitle(for card: InventoryCard) -> String? {
    let parts = [card.year, card.setName]
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    if parts.isEmpty {
        let fallback = card.cardName.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? nil : fallback
    }
    return parts.joined(separator: " · ")
}

/// Single grade pill — sentence-case label, soft surface, neutral by default.
@ViewBuilder
private func inventoryGradePill(text: String) -> some View {
    Text(text)
        .font(.caption2.weight(.medium))
        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
        .clipShape(Capsule(style: .continuous))
}

/// Row right column — value (no cents) + single movement indicator, OR the
/// "Set cost" affordance when the user hasn't entered a cost basis yet.
@ViewBuilder
private func inventoryRightColumn(card: InventoryCard) -> some View {
    VStack(alignment: .trailing, spacing: 3) {
        Text(card.displayValueText)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .monospacedDigit()

        if let (icon, label, color) = inventoryMovementDescriptor(for: card) {
            HStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.caption2.weight(.medium))
                Text(label)
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
            }
            .foregroundStyle(color)
        } else if card.cost <= 0 {
            Text("Set cost")
                .font(.caption.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.85))
        }
    }
}

/// Grid-card movement: same source-of-truth as the row, just compact.
@ViewBuilder
private func inventoryGridMovement(card: InventoryCard) -> some View {
    if let (icon, label, color) = inventoryMovementDescriptor(for: card) {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.caption2.weight(.medium))
            Text(label)
                .font(.caption2.weight(.medium))
                .monospacedDigit()
        }
        .foregroundStyle(color)
    } else if card.cost <= 0 {
        Text("Set cost")
            .font(.caption2.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.85))
    }
}

/// Returns the ROI sign chip (`%+.1f%%` from `profitLoss / cost`) for a
/// holding with a cost basis. Returns nil when cost is unset — caller
/// renders the "Set cost" affordance instead of fabricating "+$X / +0.0%".
///
/// CF-IOS-DIRECTION-CLEANUP (2026-06-18): the prior implementation had a
/// `movementDirection`-gated direction branch that rendered a forecast
/// chip when the backend movement signal was present. That branch was
/// removed — backtest established direction is at-chance and unmeasurable.
/// The ROI sign read remaining here is historical P/L, not a forecast,
/// and stays.
private func inventoryMovementDescriptor(for card: InventoryCard) -> (icon: String, label: String, color: Color)? {
    guard card.cost > 0 else { return nil }
    let roi = (card.profitLoss / card.cost) * 100
    let isUp = roi >= 0
    return (
        isUp ? "arrow.up.right" : "arrow.down.right",
        String(format: "%+.1f%%", roi),
        isUp ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
    )
}

/// Whole-dollar currency for inventory rows + header ("$5,903" — no cents).
/// Uses NumberFormatter so locale grouping survives. Internal so the
/// InventoryIQView header reads its total value through the same helper.
func inventoryWholeDollarString(_ value: Double) -> String {
    inventoryWholeDollarFormatter.string(from: NSNumber(value: value)) ?? "$0"
}

private let inventoryWholeDollarFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 0
    formatter.minimumFractionDigits = 0
    return formatter
}()

/// Row thumbnail: 42×56 rounded tile. Shows the player's initials on a
/// slate-gray tile when there is no image OR the AsyncImage fails — never
/// the legacy "broken photo" SF Symbol.
private func inventoryRowThumbnail(urlString: String?, playerName: String) -> some View {
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty, .failure:
                    inventoryInitialsTile(playerName: playerName, fontSize: 14)
                @unknown default:
                    inventoryInitialsTile(playerName: playerName, fontSize: 14)
                }
            }
        } else {
            inventoryInitialsTile(playerName: playerName, fontSize: 14)
        }
    }
    .frame(width: 42, height: 56)
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
}

/// Grid thumbnail: full-width × 90pt tile with the same initials fallback.
private func inventoryGridThumbnail(urlString: String?, playerName: String) -> some View {
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty, .failure:
                    inventoryInitialsTile(playerName: playerName, fontSize: 22)
                @unknown default:
                    inventoryInitialsTile(playerName: playerName, fontSize: 22)
                }
            }
        } else {
            inventoryInitialsTile(playerName: playerName, fontSize: 22)
        }
    }
    .frame(maxWidth: .infinity)
    .frame(height: 90)
    .clipped()
}

private func inventoryInitialsTile(playerName: String, fontSize: CGFloat) -> some View {
    ZStack {
        Rectangle()
            .fill(HobbyIQTheme.Colors.slateGray)
        Text(inventoryInitials(from: playerName))
            .font(.system(size: fontSize, weight: .medium, design: .rounded))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .monospacedDigit()
    }
}

/// Up to two initials from the first two whitespace-separated words.
/// Empty input falls back to "?" so the tile is never blank.
private func inventoryInitials(from name: String) -> String {
    let words = name
        .split(whereSeparator: { $0.isWhitespace })
        .prefix(2)
    let letters = words.compactMap { $0.first }
    if letters.isEmpty { return "?" }
    return letters.map { String($0).uppercased() }.joined()
}

// MARK: - Card Thumbnails

func cardThumbnail(urlString: String?) -> some View {
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty:
                    thumbnailPlaceholder
                case .failure:
                    thumbnailPlaceholder
                @unknown default:
                    thumbnailPlaceholder
                }
            }
        } else {
            thumbnailPlaceholder
        }
    }
    .frame(width: 40, height: 56)
    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
}

func gridThumbnail(urlString: String?) -> some View {
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty:
                    gridThumbnailPlaceholder
                case .failure:
                    gridThumbnailPlaceholder
                @unknown default:
                    gridThumbnailPlaceholder
                }
            }
        } else {
            gridThumbnailPlaceholder
        }
    }
    .frame(maxWidth: .infinity)
    .frame(height: 80)
    .clipped()
}

private var thumbnailPlaceholder: some View {
    ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(HobbyIQTheme.Colors.slateGray)
        Image(systemName: "photo")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }
}

private var gridThumbnailPlaceholder: some View {
    ZStack {
        Rectangle()
            .fill(HobbyIQTheme.Colors.slateGray)
        Image(systemName: "photo.on.rectangle")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }
}

// CF-IOS-DIRECTION-SWEEP (2026-06-18): PortfolioInventoryChips struct
// removed — was dead code (no instantiation in the iOS source) and
// rendered statusChipText as a "Verdict" pill (direction-class).

struct PortfolioChip: View {
    let label: String
    let tint: Color

    var body: some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.12))
            .clipShape(Capsule(style: .continuous))
    }
}

private func portfolioSignalColor(_ rawValue: String?, fallback: Color) -> Color {
    guard let rawValue else {
        return fallback
    }

    let normalized = rawValue
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "-", with: "_")
        .replacingOccurrences(of: " ", with: "_")

    switch normalized {
    case "strong_sell", "sell_now", "sellnow", "sell":
        return .red
    case "hold":
        return Color(hex: 0x3B82F6)
    case "strong_hold":
        return .green
    default:
        return fallback
    }
}
